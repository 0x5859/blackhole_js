/**
 * renderer.js — 黑洞视觉渲染器(真实光线回溯版)。
 *
 * WebGL fragment shader 内逐像素反向积分史瓦西零测地线(方程 9/10 的精确形式):
 *   以 M=1 几何单位,光子轨道满足 d²x/dλ² = −3M·h²·x/r⁵(h=|x×v| 守恒),
 *   等价于 Binet 方程 u″+u = 3Mu² —— 精确的史瓦西光子方程,非近似。
 *   从相机(无穷远,正交投影)向场景反向发射光线:
 *     · 落入 r<2M → 事件视界捕获 → 阴影(方程 10,b_c=3√3M 自然涌现)
 *     · 穿过倾斜薄盘平面 → 采样吸积盘发射(方程 11):
 *         T(r) ∝ [(1−√(6M/r))/r³]^{1/4}(Shakura–Sunyaev,内缘 ISCO=6M)
 *         g 因子 = √(1−3M/r)/(1−β·μ)(圆轨道引力+多普勒红移,β=1/√(r−2)),
 *         亮度 ∝ g³ → 近侧接近端增亮、远端压暗(经典不对称)
 *         上下光弧 = 光线绕洞弯折后二次/三次穿盘的像 —— 从积分中自然出现
 *     · 逃逸 → 按最终方向采样程序化星场(真实引力透镜)
 *   光子环:近临界撞击参数的光线多次绕行穿盘堆积 —— 同样自然涌现。
 *
 * 另含"网格体"通道:坠落元素的快照纹理按 N×N 试验粒子网格逐顶点形变绘制
 * (每个顶点独立测地线,时空扭曲直接可见),红移驱动逐顶点变暗淡出。
 *
 * 接口:
 *   createRenderer(canvas, { cPx, tilt }) →
 *     { mode:'webgl'|'2d', canvas, render(state,tSec), resize(), destroy(),
 *       createMesh(srcCanvas, gx, gy) → { update(posPx, shade), dispose() } | null }
 *   state: { cx, cy, rsPx, flare, progress }
 * WebGL 不可用时降级 2D(无透镜、无网格体 → 调用方回退刚体路径)。
 */

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2  u_res;      // 画布尺寸(设备 px)
uniform float u_dpr;
uniform vec2  u_center;   // 黑洞中心(CSS px,y 向下)
uniform float u_rs;       // 视界半径(CSS px)→ 像素/M = u_rs/2
uniform float u_time;     // 秒
uniform float u_flare;
uniform float u_progress;
uniform float u_cpx;      // 光速像素速度 px/s
uniform float u_reduced;
uniform float u_tilt;     // 盘倾角(视线与盘法线夹角,0=正对,~1.35=经典侧视)

#define MAXSTEP 168
#define R_HORIZON 2.0
#define R_ESC 44.0
#define DISK_IN 6.0
#define DISK_OUT 13.0
#define MARCH_R 20.0      // 超出此撞击半径(M)的像素走廉价弱场路径
#define DISK_SPEED 0.35   // 盘图样时间缩放(艺术减速,保持差速结构)

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

float starLayer(vec2 q, float cell, float t) {
  vec2 g = floor(q / cell), f = fract(q / cell);
  float h = hash(g);
  if (h > 0.06) return 0.0;
  vec2 sp = vec2(hash(g + 7.13), hash(g + 3.71)) * 0.8 + 0.1;
  float d = length(f - sp) * cell;
  float tw = 0.75 + 0.25 * sin(t * (1.0 + h * 40.0) + h * 300.0);
  return smoothstep(1.6, 0.0, d) * tw * (0.4 + 10.0 * h);
}

// 按(透镜后的)天球方向采样星场;dir 为单位向量,相机系
vec3 skyColor(vec3 dir, float t) {
  float tt = u_reduced > 0.5 ? 0.0 : t;
  // 立体投影到 2D,避免极向接缝进入视野
  vec2 q = dir.xy / (1.2 + abs(dir.z)) * 900.0;
  float rot = u_reduced > 0.5 ? 0.0 : t * 0.004;
  float c = cos(rot), s = sin(rot);
  q = mat2(c, -s, s, c) * q;
  vec3 col = vec3(0.0);
  col += vec3(0.9, 0.95, 1.0) * starLayer(q, 42.0, tt);
  col += vec3(1.0, 0.9, 0.8) * starLayer(q + 137.0, 23.0, tt * 1.3) * 0.6;
  col += vec3(0.30, 0.26, 0.52) * fbm(q * 0.012 + 3.7) * 0.10;
  return col;
}

// 方程 11:归一化盘温(M=1,内缘 6,峰值在 r = 6·49/36)
float diskTemp(float r) {
  if (r <= DISK_IN) return 0.0;
  float x = (1.0 - sqrt(DISK_IN / r)) / (r * r * r);
  float rp = DISK_IN * 49.0 / 36.0;
  float xp = (1.0 - sqrt(DISK_IN / rp)) / (rp * rp * rp);
  return pow(max(x / xp, 0.0), 0.25);
}

vec3 blackbodyRamp(float tn) {
  vec3 red    = vec3(0.55, 0.10, 0.03);
  vec3 orange = vec3(1.05, 0.55, 0.16);
  vec3 white  = vec3(1.40, 1.30, 1.10);
  return tn < 0.5 ? mix(red, orange, tn * 2.0) : mix(orange, white, tn * 2.0 - 1.0);
}

// 盘平面(世界 y=0)一次穿越的发射:premultiplied (rgb, a)
vec4 diskEmission(vec3 pc, vec3 vdir, float tM) {
  float rd = length(pc);
  if (rd < DISK_IN || rd > DISK_OUT) return vec4(0.0);
  float tn = diskTemp(rd);

  // 差速旋转湍流:把盘面坐标按 Ω(r)=r^{-3/2} 反转后取 fbm(笛卡尔,无接缝)
  float omega = inversesqrt(rd * rd * rd);
  float ang = -omega * tM * DISK_SPEED;
  float ca = cos(ang), sa = sin(ang);
  vec2 dxz = mat2(ca, -sa, sa, ca) * pc.xz;
  float sw = fbm(dxz * 1.05) * 0.72 + 0.28 * fbm(dxz * 0.38 + 40.0);

  // g 因子:引力红移 √(1−3/r) × 多普勒 1/(1−β·μ)(方程 5/11)
  float beta = inversesqrt(max(rd - 2.0, 0.25));       // 圆轨道局部速度
  vec3 orbitDir = normalize(vec3(pc.z, 0.0, -pc.x));   // 开普勒流方向
  float mu = dot(orbitDir, -normalize(vdir));          // 光子传播方向 = −行进方向
  float g = sqrt(max(1.0 - 3.0 / rd, 0.02)) / max(1.0 - beta * mu, 0.22);
  g = clamp(g, 0.35, 2.2);

  float edge = smoothstep(DISK_IN, DISK_IN * 1.08, rd)
             * (1.0 - smoothstep(DISK_OUT * 0.72, DISK_OUT, rd));
  float bright = tn * edge * (0.30 + 1.25 * sw) * pow(g, 3.0);
  bright *= 1.0 + 3.0 * u_flare;

  vec3 col = blackbodyRamp(clamp(tn * g, 0.0, 1.0)) * bright;
  float a = clamp(bright * 1.35, 0.0, 1.0);
  return vec4(col, a); // 已按 premultiplied 语义使用
}

void main() {
  vec2 posCss = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_dpr;
  float uM = max(u_rs, 0.02) * 0.5;                 // 像素/M
  vec2 s = vec2(posCss.x - u_center.x, u_center.y - posCss.y) / uM; // y 向上,M 单位
  float tM = u_cpx * u_time / uM;                    // 坐标时(M 单位)
  float starAlpha = 0.12 + 0.88 * u_progress;

  // 相机基(倾角 u_tilt):F 视线方向,R 屏幕右,U 屏幕上。
  // U 的符号检验:世界 +y(盘轴上方)须映到屏幕上方(U·(0,1,0)=si>0 ✓),
  // 近侧盘沿 (0,0,+r) 须映到屏幕下方(U·(0,0,r)=−ci·r<0 ✓)——
  // 否则整幅像上下镜像,近侧盘带会跑到光弧同侧,阴影看似与盘脱位。
  float ci = cos(u_tilt), si = sin(u_tilt);
  vec3 F = vec3(0.0, -ci, -si);
  vec3 R = vec3(1.0, 0.0, 0.0);
  vec3 U = vec3(0.0, si, -ci);

  float b = length(s);

  // —— 远场廉价路径:弱场偏转 α=4M/b 的屏幕空间星场 ——
  if (b > MARCH_R) {
    float defl = 4.0 / b;
    vec3 dir = normalize(F + (R * (s.x / b) + U * (s.y / b)) * defl * 1.2);
    // 把方向近似映射回屏幕星场坐标(远场直接用像素坐标最稳)
    vec2 q = (posCss - u_res * 0.5 / u_dpr);
    float rot = u_reduced > 0.5 ? 0.0 : u_time * 0.004;
    float c = cos(rot), sn = sin(rot);
    q = mat2(c, -sn, sn, c) * (q + dir.xy * 40.0);
    vec3 col = vec3(0.9, 0.95, 1.0) * starLayer(q, 42.0, u_time)
             + vec3(1.0, 0.9, 0.8) * starLayer(q + 137.0, 23.0, u_time * 1.3) * 0.6;
    float a = starAlpha * clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
    gl_FragColor = vec4(col * starAlpha, a);
    return;
  }

  // —— 反向光线回溯(精确史瓦西零测地线)——
  vec3 p = -F * 40.0 + R * s.x + U * s.y;
  vec3 v = F;
  vec3 hv = cross(p, v);
  float h2 = dot(hv, hv);

  vec4 acc = vec4(0.0);      // premultiplied 前向累积(盘的多重像)
  float captured = 0.0;
  vec3 sky = vec3(0.0);
  float escaped = 0.0;
  float prevY = p.y;
  float minR = 1e5;

  for (int i = 0; i < MAXSTEP; i++) {
    float r2 = dot(p, p);
    float r = sqrt(r2);
    minR = min(minR, r);
    if (r < R_HORIZON * 1.01) { captured = 1.0; break; }
    if (r > R_ESC && dot(p, v) > 0.0) { escaped = 1.0; break; }

    float dl = 0.22 * r / (1.0 + 8.0 / r);          // 近洞小步、远处大步
    // 半隐式 Euler:a = −3M·h²·x/r⁵,M=1 单位下系数为 3.0
    // (常见的 −(3/2)h²x/r⁵ 是 r_s=1 单位的写法;本 shader 全程 M=1,
    //  视界=2、ISCO=6、b_c=3√3,系数若用 1.5 弯折力减半 → 阴影缩水一半)
    vec3 a = -3.0 * h2 * p / (r2 * r2 * r);
    v += a * dl;
    p += v * dl;

    // 穿盘检测(世界 y=0 平面),线性插值到平面上
    if (p.y * prevY < 0.0 && acc.a < 0.98) {
      float t = prevY / (prevY - p.y);
      vec3 pc = mix(p - v * dl, p, t); // 近似:用步内线性插值
      vec4 em = diskEmission(pc, v, tM);
      acc.rgb += (1.0 - acc.a) * em.rgb;
      acc.a   += (1.0 - acc.a) * em.a;
    }
    prevY = p.y;
  }
  if (captured < 0.5 && escaped < 0.5) {
    // 步数耗尽(贴着光子球缠绕):按捕获处理,正是阴影边缘
    captured = 1.0;
  }
  if (escaped > 0.5) sky = skyColor(normalize(v), u_time);

  // 组装(premultiplied):盘像在前,背景(天空或阴影)在后
  vec3 col = acc.rgb;
  float aOut = acc.a;
  if (captured > 0.5) {
    aOut = 1.0; // 阴影不透明(纯黑)
  } else {
    col += (1.0 - acc.a) * sky * starAlpha;
    aOut = max(aOut, starAlpha * clamp(max(sky.r, max(sky.g, sky.b)), 0.0, 1.0));
  }

  // 阴影外微弱引力辉光(耀发时增强),补足小盘时期的存在感;
  // 刻意压低:阴影边光应主要来自真实的光子环/盘光,均匀光晕会让阴影
  // 看起来像独立于盘的"贴纸"
  float glow = exp(-max(b - 5.196, 0.0) / 1.9) * (0.055 + 0.30 * u_flare);
  col += vec3(0.95, 0.62, 0.35) * glow;
  aOut = clamp(aOut + glow * 0.7, 0.0, 1.0);

  gl_FragColor = vec4(col, aOut);
}
`;

/* ---------------- 网格体(坠落元素)着色器 ---------------- */

const MESH_VERT = `
attribute vec2 a_pos;    // CSS px
attribute vec2 a_uv;
attribute vec2 a_fx;     // x: 红移 z,y: alpha
uniform vec2 u_vres;     // CSS 视口尺寸
varying vec2 v_uv;
varying vec2 v_fx;
void main() {
  v_uv = a_uv;
  v_fx = a_fx;
  vec2 clip = vec2(a_pos.x / u_vres.x * 2.0 - 1.0, 1.0 - a_pos.y / u_vres.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const MESH_FRAG = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
varying vec2 v_fx;
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  float z = clamp(v_fx.x, 0.0, 1.0);
  // 红移观感:变暗 + 向余烬红褪色(方程 5)
  vec3 ember = vec3(1.0, 0.36, 0.14) * dot(c.rgb, vec3(0.35, 0.5, 0.15));
  vec3 rgb = mix(ember, c.rgb, 0.25 + 0.75 * z) * (0.2 + 0.8 * z);
  float a = c.a * clamp(v_fx.y, 0.0, 1.0);
  gl_FragColor = vec4(rgb * a, a); // premultiplied
}
`;

export function createRenderer(canvas, { cPx = 1600, tilt = 1.35 } = {}) {
  try {
    return createWebGLRenderer(canvas, cPx, tilt);
  } catch (err) {
    console.warn('[blackhole] WebGL 不可用,降级 2D 渲染:', err && err.message);
    return create2DRenderer(canvas, cPx);
  }
}

/* ------------------------------- WebGL ------------------------------- */

function createWebGLRenderer(canvas, cPx, tilt) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) throw new Error('no webgl context');

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0;
  let holeProg = null, meshProg = null, uni = {}, muni = {}, lost = false;
  const meshes = new Set();

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function link(vsSrc, fsSrc) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  function build() {
    holeProg = link(VERT, FRAG);
    gl.useProgram(holeProg);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(holeProg, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['u_res', 'u_dpr', 'u_center', 'u_rs', 'u_time', 'u_flare', 'u_progress', 'u_cpx', 'u_reduced', 'u_tilt']) {
      uni[n] = gl.getUniformLocation(holeProg, n);
    }
    holeProg.quadBuf = buf;

    meshProg = link(MESH_VERT, MESH_FRAG);
    for (const n of ['u_vres', 'u_tex']) muni[n] = gl.getUniformLocation(meshProg, n);
    meshProg.aPos = gl.getAttribLocation(meshProg, 'a_pos');
    meshProg.aUv = gl.getAttribLocation(meshProg, 'a_uv');
    meshProg.aFx = gl.getAttribLocation(meshProg, 'a_fx');
  }
  build();

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => {
    meshes.forEach((m) => (m.dead = true));
    meshes.clear();
    build();
    resize();
    lost = false;
  });

  const dpr = () => Math.min(devicePixelRatio || 1, 2);

  // 自适应渲染分辨率:黑洞越大,全屏光线回溯的像素成本越高
  // (r_s≈180 时 20M 行进区覆盖整屏,dpr=2 即 ~4.6M 像素 × ≤168 步)。
  // 大黑洞画面本就柔和,降采样渲染 + 合成器放大在视觉上不可辨,
  // GPU 负载最多降 4 倍,避免端游帧率崩塌导致"坠落像冻住"。
  let renderScale = 1;
  let scaleRs = 0; // r_s 的慢速 EMA(滤掉铃宕振荡,防止缓冲区反复重建)

  function resize() {
    const d = dpr() * renderScale;
    canvas.width = Math.max(2, Math.round(innerWidth * d));
    canvas.height = Math.max(2, Math.round(innerHeight * d));
    // 元素盒尺寸与 innerWidth/innerHeight 一致(移动端 100vh ≠ innerHeight)
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();

  function adaptScale(rsPx) {
    scaleRs += (rsPx - scaleRs) * 0.05; // ~0.5s 平滑
    const want = Math.max(0.5, Math.min(1, 110 / Math.max(scaleRs, 1)));
    const wantQ = Math.round(want * 8) / 8; // 1/8 步进量化
    if (wantQ !== renderScale) {
      renderScale = wantQ;
      resize();
    }
  }

  /**
   * 创建坠落元素网格体:srcCanvas 为元素快照,gx×gy 个单元。
   * update(posPx, shade):posPx = Float32Array((gx+1)(gy+1)·2) CSS px 顶点位置;
   *                      shade = Float32Array((gx+1)(gy+1)·2) [红移 z, alpha]。
   */
  function createMesh(srcCanvas, gx, gy) {
    if (lost) return null;
    const nx = gx + 1, ny = gy + 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // 静态 UV 与索引
    const uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        uv[(j * nx + i) * 2] = i / gx;
        uv[(j * nx + i) * 2 + 1] = j / gy;
      }
    }
    const idx = new Uint16Array(gx * gy * 6);
    let k = 0;
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
    }
    const posBuf = gl.createBuffer();
    const uvBuf = gl.createBuffer();
    const fxBuf = gl.createBuffer();
    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    const mesh = {
      tex, posBuf, uvBuf, fxBuf, idxBuf, count: idx.length,
      pos: null, fx: null, dead: false,
      update(posPx, shade) { mesh.pos = posPx; mesh.fx = shade; },
      dispose() {
        if (mesh.dead) return;
        mesh.dead = true;
        meshes.delete(mesh);
        gl.deleteTexture(tex);
        gl.deleteBuffer(posBuf); gl.deleteBuffer(uvBuf);
        gl.deleteBuffer(fxBuf); gl.deleteBuffer(idxBuf);
      },
    };
    meshes.add(mesh);
    return mesh;
  }

  function drawMeshes() {
    if (!meshes.size) return;
    gl.useProgram(meshProg);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over
    gl.uniform2f(muni.u_vres, innerWidth, innerHeight);
    gl.uniform1i(muni.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const m of meshes) {
      if (m.dead || !m.pos) continue;
      gl.bindTexture(gl.TEXTURE_2D, m.tex);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(meshProg.aPos);
      gl.vertexAttribPointer(meshProg.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.uvBuf);
      gl.enableVertexAttribArray(meshProg.aUv);
      gl.vertexAttribPointer(meshProg.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.fxBuf);
      gl.bufferData(gl.ARRAY_BUFFER, m.fx, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(meshProg.aFx);
      gl.vertexAttribPointer(meshProg.aFx, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idxBuf);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.disable(gl.BLEND);
    // 必须禁用网格属性数组:属性启用状态是全局的,若网格体 dispose 后
    // 属性 1/2 仍启用且指向已删除缓冲,下一帧黑洞通道的 drawArrays 会以
    // INVALID_OPERATION 静默失败 → 黑洞消失,直到新网格重新绑定缓冲才恢复
    gl.disableVertexAttribArray(meshProg.aPos);
    gl.disableVertexAttribArray(meshProg.aUv);
    gl.disableVertexAttribArray(meshProg.aFx);
  }

  function render(state, tSec) {
    if (lost) return;
    adaptScale(state.rsPx || 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(holeProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, holeProg.quadBuf);
    const loc = gl.getAttribLocation(holeProg, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(uni.u_res, canvas.width, canvas.height);
    // 有效 dpr = 设备像素比 × 自适应缩放(shader 用它把 gl_FragCoord 还原为 CSS px)
    gl.uniform1f(uni.u_dpr, canvas.width / innerWidth);
    gl.uniform2f(uni.u_center, state.cx, state.cy);
    gl.uniform1f(uni.u_rs, Math.max(state.rsPx, 0.01));
    gl.uniform1f(uni.u_time, tSec);
    gl.uniform1f(uni.u_flare, state.flare || 0);
    gl.uniform1f(uni.u_progress, state.progress || 0);
    gl.uniform1f(uni.u_cpx, cPx);
    gl.uniform1f(uni.u_reduced, reduced);
    gl.uniform1f(uni.u_tilt, tilt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    drawMeshes();
  }

  return {
    mode: 'webgl', canvas, render, resize, createMesh,
    destroy() {
      meshes.forEach((m) => m.dispose());
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/* ----------------------------- 2D 降级 ----------------------------- */

function create2DRenderer(canvas, cPx) {
  let ctx = canvas.getContext('2d');
  if (!ctx) {
    // canvas 已进入 webgl 上下文模式(建上下文成功但 shader 编译失败的降级路径),
    // 同一 canvas 拿不到 2d 上下文 —— 换一个等价的新 canvas
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    canvas = fresh;
    ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
  }
  const BC = (3 * Math.sqrt(3)) / 2;
  let stars = [];

  function resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * d);
    canvas.height = Math.round(innerHeight * d);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    ctx.setTransform(d, 0, 0, d, 0, 0);
    stars = [];
    const n = Math.round((innerWidth * innerHeight) / 6000);
    let seed = 12345;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      stars.push({ x: rnd() * innerWidth, y: rnd() * innerHeight, s: 0.5 + rnd() * 1.4, a: 0.3 + rnd() * 0.7 });
    }
  }
  resize();

  function render(state, tSec) {
    const { cx, cy, rsPx: rs, flare = 0, progress = 0 } = state;
    const bc = BC * rs;
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    // 星场(无透镜)
    ctx.save();
    ctx.fillStyle = '#dfe8ff';
    for (const st of stars) {
      const d = Math.hypot(st.x - cx, st.y - cy);
      if (d < bc) continue; // 捕获
      ctx.globalAlpha = (0.12 + 0.88 * progress) * st.a;
      ctx.fillRect(st.x, st.y, st.s, st.s);
    }
    ctx.restore();

    // 吸积盘:倾斜椭圆环(2D 近似,双 conic 差速渐变;旧 Safari 无则跳过图样)
    const rIn = 3 * rs, rOut = 6.5 * rs;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.36); // 倾斜投影
    for (let k = 0; k < 2 && ctx.createConicGradient; k++) {
      const omega = cPx * Math.sqrt((0.5 * rs) / Math.pow(rIn * (1.5 + k), 3)) * 0.22;
      const g = ctx.createConicGradient(omega * tSec * (k ? 0.6 : 1), 0, 0);
      const base = k ? 'rgba(255,150,60,' : 'rgba(255,90,30,';
      for (let i = 0; i <= 12; i++) {
        g.addColorStop(i / 12, base + (0.12 + 0.5 * Math.abs(Math.sin(i * 2.1 + k))) * (1 + 2 * flare) * 0.28 + ')');
      }
      ctx.beginPath();
      ctx.arc(0, 0, rOut, 0, Math.PI * 2);
      ctx.arc(0, 0, rIn, 0, Math.PI * 2, true);
      ctx.clip('evenodd');
      ctx.fillStyle = g;
      ctx.fillRect(-rOut, -rOut, rOut * 2, rOut * 2);
    }
    ctx.restore();

    // 光子环 + 阴影
    ctx.save();
    ctx.strokeStyle = `rgba(255,240,215,${0.9 + flare * 0.1})`;
    ctx.lineWidth = Math.max(1.2, rs * 0.06);
    ctx.shadowColor = 'rgba(255,210,150,0.9)';
    ctx.shadowBlur = rs * 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, bc, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const sh = ctx.createRadialGradient(cx, cy, 0, cx, cy, bc);
    sh.addColorStop(0, 'rgba(0,0,0,1)');
    sh.addColorStop(0.92, 'rgba(0,0,0,1)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.arc(cx, cy, bc, 0, Math.PI * 2);
    ctx.fill();
  }

  return {
    mode: '2d', canvas, render, resize,
    createMesh() { return null; }, // 2D 无网格体 → 调用方回退刚体路径
    destroy() {},
  };
}
