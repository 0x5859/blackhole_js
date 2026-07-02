/**
 * physics.js — 史瓦西黑洞赤道面测地线物理核(零 DOM,纯函数,可 node 单测)
 *
 * 单位制:几何单位 G = c = 1,长度单位 = CSS 像素,时间单位 = 像素(坐标时)。
 * 真实秒 dtSec 通过光速像素速度 cPx(px/s)换算:Δt_坐标 = cPx · dtSec。
 * 黑洞质量 M = r_s / 2。
 *
 * body 状态:{ r, phi, pr, L }
 *   r   — 史瓦西径向坐标(px)
 *   phi — 方位角(屏幕 y 向下,atan2(dy,dx) 约定,顺时针为正)
 *   pr  — dr/dτ(固有时径向速度)
 *   L   — 守恒角动量 r²·dφ/dτ
 * 能量 E 不入状态,每步由约束 E² = pr² + f·(1 + L²/r²) 派生,保证归一化自洽。
 *
 * 方程编号对应设计文档 §5(docs/superpowers/specs/2026-07-02-blackhole-module-design.md)。
 */

// l=2 基模准正则模 Mω = 0.37367 − 0.08896i(方程 8)
export const QNM = { re: 0.37367, im: 0.08896 };
// ISCO 结合能效率 η = 1 − √(8/9) ≈ 0.0572(方程 12)
export const ETA_ISCO = 1 - Math.sqrt(8 / 9);
// 吞噬判据:红移因子 √f 低于此值即视为冻结于视界(方程 5)
export const SWALLOW_REDSHIFT = 0.12;
// 铃宕展示用时间放大倍数(真实 QNM 周期 ~ms 级,肉眼不可见;科普页如实标注)
export const RINGDOWN_TSCALE = 20;

export const fOf = (r, rs) => 1 - rs / r;                 // 方程 1:f(r)
export const bCrit = (rs) => (3 * Math.sqrt(3) / 2) * rs; // 方程 10:阴影半径
export const isco = (rs) => 3 * rs;                       // 方程 11:内缘

const VMAX_LOCAL = 0.985; // 局部静止观察者测速钳制上限

/** E = √(pr² + f(1+L²/r²)) */
export function energyOf(body, rs) {
  const f = fOf(body.r, rs);
  if (f <= 0) return 0;
  const w = 1 + (body.L * body.L) / (body.r * body.r);
  return Math.sqrt(Math.max(0, body.pr * body.pr + f * w));
}

/** 局部静止观察者测得速度 v = √(1 − f/E²) ∈ [0,1) */
export function localSpeed(body, rs) {
  const E = energyOf(body, rs);
  if (E <= 0) return 1;
  const f = fOf(body.r, rs);
  return Math.sqrt(Math.max(0, 1 - f / (E * E)));
}

/**
 * 方程 4:初条件。屏幕位置 (x,y) px、抛掷速度 (vx,vy) px/s → 测地线状态。
 * 归一化 u·u=−1:(dt/dτ)² = 1/[f − ṙ²/f − r²φ̇²] = 1/[f(1−v_loc²)];
 * 局部超光速时等比缩小 (ṙ,φ̇) 使 v_loc = 0.985。
 */
export function makeBody({ x, y, vx, vy, cx, cy, rs, cPx }) {
  const dx = x - cx, dy = y - cy;
  let r = Math.hypot(dx, dy);
  r = Math.max(r, 1.05 * rs); // 释放点最深不越过近视界(视觉上也早已吞掉)
  const phi = Math.atan2(dy, dx);
  const f = fOf(r, rs);

  // 坐标时导数(时间单位换成 px):ṙ = dr/dt, φ̇ = dφ/dt
  let rdot = (dx * vx + dy * vy) / (r * cPx);
  let phidot = (dx * vy - dy * vx) / (r * r * cPx);

  // v_loc² = ṙ²/f² + r²φ̇²/f,对 (ṙ,φ̇) 是齐次二次型 → 等比钳制
  let vloc2 = (rdot * rdot) / (f * f) + (r * r * phidot * phidot) / f;
  if (vloc2 > VMAX_LOCAL * VMAX_LOCAL) {
    const s = VMAX_LOCAL / Math.sqrt(vloc2);
    rdot *= s; phidot *= s;
    vloc2 = VMAX_LOCAL * VMAX_LOCAL;
  }

  const ut = 1 / Math.sqrt(f * (1 - vloc2)); // dt/dτ
  return { r, phi, pr: rdot * ut, L: r * r * phidot * ut };
}

/** 方程 2 径向加速度:d²r/dτ² = −M/r² + L²/r³ − 3M L²/r⁴ */
function accel(r, L, M) {
  const r2 = r * r;
  const L2 = L * L;
  return -M / r2 + L2 / (r2 * r) - (3 * M * L2) / (r2 * r2);
}

/**
 * RK4 单步:(r, pr, phi) 推进固有时 h;dφ/dτ = L/r²。
 * 热路径(倍速+多元素时每帧上万次调用):标量内联、零分配、无闭包,
 * 结果写入模块级暂存 _r/_pr/_phi(单线程安全)。
 */
let _r = 0, _pr = 0, _phi = 0;
function rk4Step(r0, p0, q0, L, M, h) {
  const a1 = accel(r0, L, M), w1 = L / (r0 * r0);
  const rb = r0 + 0.5 * h * p0, pb = p0 + 0.5 * h * a1;
  const a2 = accel(rb, L, M), w2 = L / (rb * rb);
  const rc = r0 + 0.5 * h * pb, pc = p0 + 0.5 * h * a2;
  const a3 = accel(rc, L, M), w3 = L / (rc * rc);
  const rd = r0 + h * pc, pd = p0 + h * a3;
  const a4 = accel(rd, L, M), w4 = L / (rd * rd);
  _r = r0 + (h / 6) * (p0 + 2 * pb + 2 * pc + pd);
  _pr = p0 + (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
  _phi = q0 + (h / 6) * (w1 + 2 * w2 + 2 * w3 + w4);
}

const STEP_TOL = 1e-7; // 步长加倍误差控制的相对容差

/**
 * 推进真实 dtSec 秒(方程 3:按坐标时推进,dτ = f·Δt/E → 视界处冻结)。
 *
 * 稳健性设计(两道保险,消除长期漂移与瞬时失稳):
 *  1. 能量约束投影:E、L 是测地线守恒量(只被阻尼与黑洞增质修改)。
 *     每个接受步后把 pr 精确投影回约束面 pr² = E² − f·(1+L²/r²),
 *     使能量守恒到机器精度,轨道无长期漂移(转折点附近 P<0 时不投影,
 *     由动力学自然折返)。
 *  2. 步长加倍误差控制:每步用 (h) 与 (h/2+h/2) 双算,相对差超容差则减半重试,
 *     接受更准的双半步结果;h 随误差自适应放大/缩小(按 RK4 的 5 阶局部误差)。
 *
 * dragK > 0 时施加辐射阻尼(方程 14):pr、L 各乘 (1 − dragK·v_loc⁴·dτ),
 * 随后按新状态重置 E(阻尼合法地耗散能量)。
 * 黑洞质量中途增长(rs 变化)时按新度规从状态重推 E(绝热重校准)。
 * 返回 false = 已达吞噬判据(√f < SWALLOW_REDSHIFT 或进入近视界带)。
 */
export function stepBody(body, { rs, cPx, dragK = 0 }, dtSec) {
  const M = rs / 2;
  let remaining = cPx * dtSec; // 本帧坐标时预算(px)
  let guard = 0;

  // E 的惰性初始化与度规变化重校准
  if (body.E === undefined || body.rsRef !== rs) {
    body.E = energyOf(body, rs);
    body.rsRef = rs;
  }

  while (remaining > 1e-9 && guard++ < 4000) {
    const f = fOf(body.r, rs);
    if (body.r <= 1.001 * rs || f <= 1e-6) return false;
    const E = body.E;
    if (E <= 1e-9) return false;

    // 特征步长上限:h ≤ 0.02·r / v_char(近洞自动变小)。
    // 上限 24 而非 1:远处轨道特征时间上千,死板的小上限会让倍速+多元素时
    // 每帧子步数爆炸(实测 3×、500 粒子时纯物理 ~14ms/帧);精度由下方
    // 步长加倍误差控制器保证,过大的首步会被自动减半。
    const vchar = Math.abs(body.pr) + Math.abs(body.L) / body.r
      + Math.sqrt(M / body.r) + 1e-6;
    const hmax = Math.min(24, (0.02 * body.r) / vchar);

    let dt = remaining;
    let h = Math.min((f * dt) / E, hmax, body.hAdapt || hmax);
    if (h <= 0) break;

    // —— 步长加倍误差控制(最多减半 8 次;零分配标量比较)——
    for (let k = 0; k < 8; k++) {
      rk4Step(body.r, body.pr, body.phi, body.L, M, h);
      const ra = _r, pa = _pr, qa = _phi;                    // 整步
      rk4Step(body.r, body.pr, body.phi, body.L, M, h / 2);
      rk4Step(_r, _pr, _phi, body.L, M, h / 2);              // 两个半步 → _r/_pr/_phi
      const err = Math.max(
        Math.abs(ra - _r) / (Math.abs(body.r) + 1),
        Math.abs(pa - _pr) / (1 + Math.abs(body.pr)),
        Math.abs(qa - _phi) / (2 * Math.PI),
      );
      if (err <= STEP_TOL || h <= 1e-6) {
        // 按 5 阶局部误差自适应下一步长
        body.hAdapt = h * Math.min(2, Math.max(0.2,
          0.9 * Math.pow(STEP_TOL / (err + 1e-16), 0.2)));
        break;
      }
      h *= 0.5;
    }
    body.r = _r; body.pr = _pr; body.phi = _phi;

    // —— 能量约束投影(转折点附近 P≤0 则交给动力学自然折返)——
    {
      const fp = fOf(body.r, rs);
      if (fp > 0) {
        const P = E * E - fp * (1 + (body.L * body.L) / (body.r * body.r));
        if (P >= 0) body.pr = Math.sign(body.pr || 1) * Math.sqrt(P);
      }
    }

    if (dragK > 0) {
      const dtau = h;
      const v = localSpeed(body, rs);
      const d = Math.max(0, 1 - dragK * v * v * v * v * dtau);
      body.pr *= d; body.L *= d;
      body.E = energyOf(body, rs); // 阻尼耗散后重置守恒量
    }

    remaining -= (h * E) / f;

    const fNew = fOf(body.r, rs);
    if (body.r <= 1.001 * rs || fNew <= 0
      || Math.sqrt(Math.max(fNew, 0)) < SWALLOW_REDSHIFT) return false;
  }
  return true;
}

/**
 * 屏幕状态:坐标 + 视觉驱动量。
 *   redshift = √f(方程 5,驱动变暗/偏红/淡出)
 *   tidal ∈ [0,1](方程 6,潮汐拉伸强度,∝ (r_s/r)³ 截断)
 *   vAngle — 屏幕速度方向(rad),驱动元素朝向
 */
export function screenState(body, { cx, cy, rs }) {
  const c = Math.cos(body.phi), s = Math.sin(body.phi);
  const f = Math.max(0, fOf(body.r, rs));
  const E = energyOf(body, rs);
  // 屏幕(坐标时)速度:vr = pr·f/E(径向),vt = L·f/(r·E)(切向)
  const vr = E > 0 ? (body.pr * f) / E : 0;
  const vt = E > 0 ? (body.L * f) / (body.r * E) : 0;
  const vx = vr * c - vt * s;
  const vy = vr * s + vt * c;
  const q = rs / body.r;
  return {
    x: cx + body.r * c,
    y: cy + body.r * s,
    redshift: Math.sqrt(f),
    tidal: Math.min(1, 4 * q * q * q),
    vAngle: (vx * vx + vy * vy) > 1e-12 ? Math.atan2(vy, vx) : body.phi,
  };
}

/** 方程 13:静止悬停所需固有加速度 a = M/(r²√f),视界处发散(截断由调用方定)*/
export function hoverAccel(r, rs) {
  const f = fOf(r, rs);
  if (f <= 1e-4) return (rs / 2) / (r * r * 1e-2);
  return (rs / 2) / (r * r * Math.sqrt(f));
}

/**
 * 方程 8:铃宕。吞噬后视界显示半径的阻尼振荡偏移(px)。
 * ω = QNM.re·cPx/(M·TSCALE) rad/s,τ_d = M·TSCALE/(QNM.im·cPx) s,M = rsPx/2。
 * 频率 ∝ 1/M、衰减时间 ∝ M:黑洞越大,铃声越低沉、余音越长。
 */
export function ringdownOffset(tSec, rsPx, cPx, amp) {
  // rsPx→0 时 ω→∞,cos(∞·0) 会得 NaN;黑洞尚未长出时铃宕无意义,直接 0
  if (tSec < 0 || amp === 0 || rsPx < 1) return 0;
  const M = rsPx / 2;
  const omega = (QNM.re * cPx) / (M * RINGDOWN_TSCALE);
  const tauD = (M * RINGDOWN_TSCALE) / (QNM.im * cPx);
  return amp * Math.exp(-tSec / tauD) * Math.cos(omega * tSec);
}
