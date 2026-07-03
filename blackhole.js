/**
 * blackhole.js — 模块入口。
 *
 * 用法:
 *   import BlackHole from './blackhole.js';
 *   const bh = BlackHole.init({
 *     corner: 'bottom-right',   // 黑洞落位角
 *     targets: '[data-devour]', // 可吞元素选择器
 *     initialRs: 16,            // 初始视界半径 px
 *     maxRsFraction: 0.2,       // 吞光全部内容后 r_s 占 min(vw,vh) 比例
 *     cPx: 1600,                // 光速的像素速度 px/s(时空平面标度,§3)
 *     dragK: 2.0,               // 辐射阻尼系数(方程 14,0 = 纯测地线)
 *     hud: true,
 *   });
 *   bh.activate(); bh.deactivate(); bh.destroy();
 *
 * 物理记账(设计文档 §3/§5):
 *   M = r_s/2(几何单位);元素质量 m = k_m·面积,k_m 在激活时按
 *   全部可吞元素总面积标定,保证吞光后 r_s 恰达 maxRs。
 *   质量与耀发都随物质流渐进入账:格点冻结在视界上 → M += k_m·dA(方程 7)、
 *   耀发按 ṁ 注入(方程 12,L = η·ṁ·c²)。吞噬完成只触发计数与铃宕
 *   (方程 8):每次吞噬追加一个正弦起振的 QNM 模式,多次吞噬线性叠加,
 *   显示半径与亮度处处连续 —— 没有任何一帧发生阶跃。
 */

// 内部依赖带版本参数:防止浏览器 HTTP 缓存把新旧模块混搭
// (入口新、依赖旧的"半更新"模块图会产生各种静默怪象;改版时同步递增 v)
import { ringdownOffset, QNM, RINGDOWN_TSCALE } from './src/physics.js?v=6';
import { createRenderer } from './src/renderer.js?v=6';
import { createInteraction } from './src/interaction.js?v=6';
import { createHud } from './src/hud.js?v=6';

const DEFAULTS = {
  corner: 'bottom-right',
  targets: '[data-devour]',
  initialRs: 16,
  maxRsFraction: 0.2,
  cPx: 1600,
  dragK: 2.0,
  diskTilt: 1.35, // 吸积盘视觉倾角(rad):0≈正对,1.35≈经典侧视(77°)
  hud: true,
};

function injectCss() {
  if (document.querySelector('link[data-blackhole-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./blackhole.css?v=6', import.meta.url).href;
  link.setAttribute('data-blackhole-css', '');
  document.head.appendChild(link);
}

function init(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  injectCss();

  const canvas = document.createElement('canvas');
  canvas.className = 'bh-canvas';
  canvas.style.display = 'none';
  document.body.appendChild(canvas);
  const renderer = createRenderer(canvas, { cPx: cfg.cPx, tilt: cfg.diskTilt });
  const cv = () => renderer.canvas || canvas; // 2D 降级可能换过节点

  // ---- 状态 ----
  let M = cfg.initialRs / 2;      // 当前质量(几何单位,r_s = 2M)
  let M0 = M, Mmax = M, kM = 0;   // 激活时标定
  let rsShown = 0;                // 展示半径(生长动画 + 铃宕)
  let flare = 0;                  // 耀发储能(随吸积流注入,τ=0.8s 衰减)
  let flareShown = 0;             // 送入渲染的亮度:0.12s 低通(盘的响应时间),
                                  // 即使一帧内多个格点同时冻结也不产生亮度阶跃
  let swallowed = 0, totalTargets = 0;
  const rings = [];               // 在响的 QNM 模式 { t0, amp }:正弦起振,线性叠加
  let active = false, raf = 0, tPrev = 0;
  let timeScale = 1;              // 时间倍速(1×/2×/3×):物理、盘旋转、铃宕一致快进
  let simT = 0;                   // 仿真时钟(秒,已计入倍速)
  let rsPxDrawn = 0;              // 最近一帧实际送入渲染的半径(调试/测试用)
  let center = { x: 0, y: 0 };

  const rs = () => 2 * M;
  const rsMax = () => cfg.maxRsFraction * Math.min(innerWidth, innerHeight);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function placeCenter() {
    const inset = Math.max(140, 0.9 * rsMax() + 80);
    const [v, h] = cfg.corner.split('-'); // e.g. 'bottom', 'right'
    center.x = h === 'left' ? inset : innerWidth - inset;
    center.y = v === 'top' ? inset : innerHeight - inset;
  }

  const getHole = () => ({ cx: center.x, cy: center.y, rs: rs(), cPx: cfg.cPx, dragK: cfg.dragK });

  /** 激发一个 QNM 模式:正弦起振(t=0 位移为零),与在响的模式线性叠加 */
  function exciteRing(amp) {
    if (REDUCED || amp <= 0) return;
    if (rings.length >= 12) rings.shift(); // 吞噬风暴限幅;被挤掉的早已衰减殆尽
    rings.push({ t0: simT, amp });
  }

  /** 所有在响模式的叠加偏移;顺手清理衰减到亚像素的模式 */
  function ringSum() {
    if (!rings.length) return 0;
    const tauD = ((rsShown / 2) * RINGDOWN_TSCALE) / (QNM.im * cfg.cPx);
    let sum = 0;
    for (let i = rings.length - 1; i >= 0; i--) {
      const dt = simT - rings[i].t0;
      if (rings[i].amp * Math.exp(-dt / tauD) < 0.05) { rings.splice(i, 1); continue; }
      sum += ringdownOffset(dt, rsShown, cfg.cPx, rings[i].amp);
    }
    return sum;
  }

  let hudDirty = false;

  const interaction = createInteraction({
    targetsSelector: cfg.targets,
    getHole,
    renderer,
    // 渐进吸积:元素的质量按格点均分,格点冻结在视界上时逐份入账,
    // 黑洞随物体流入而渐进长大(方程 7 的 M += m 以流的方式发生);
    // 耀发同样随质量流注入(方程 12,L = η·ṁ·c²):每份质量按其在
    // 元素中的占比换来亮度,单个元素的总激发量 = 0.35 + 面积/90000,
    // 与旧的整块入账严格相等,只是摊到了坠入的全过程
    onAccrete(area, total) {
      M = Math.min(Mmax, M + kM * area);
      flare = Math.min(1, flare + 0.35 * (area / total) + area / 90000);
      hudDirty = true;
    },
    // 吞噬事件:一个元素完整落入 —— 计数与铃宕(质量、耀发已流式入账)
    onSwallow(area) {
      swallowed += 1;
      exciteRing(Math.min(0.3 * rs(), 4 + area / 4000));
      hudDirty = true;
    },
  });

  const hud = cfg.hud ? createHud({
    onToggle: () => (active ? deactivate() : activate()),
    onSpeed: (n) => setTimeScale(n),
    onReset: () => reset(),
    corner: cfg.corner,
  }) : null;

  // 完整性自检:若浏览器缓存混搭了新旧模块文件,当场把问题喊出来
  if (typeof renderer.createMesh !== 'function'
    || typeof interaction.restoreAll !== 'function'
    || (hud && typeof hud.setSpeed !== 'function')) {
    console.warn('[blackhole] Stale module mix detected (browser served cached old files). '
      + 'Hard-refresh the page (Cmd/Ctrl+Shift+R).');
  }

  function updateHud() {
    hud?.update({
      rsPx: rs(),
      count: swallowed,
      massFrac: Mmax > M0 ? Math.min(1, (M - M0) / (Mmax - M0)) : 0,
      // 热寂判据:页面上不再有可吞元素(而非历史计数,避免重激活后误报)
      done: swallowed > 0 && !document.querySelector(cfg.targets),
    });
  }

  function frame(tMs) {
    const t = tMs / 1000;
    const dtReal = Math.min(0.05, t - tPrev || 0.016); // 后台标签页回来时防大步长
    tPrev = t;
    const dt = dtReal * timeScale; // 倍速统一作用于物理与视觉时钟
    simT += dt;

    interaction.tick(dt);

    // 渐进吸积期间 HUD 每帧只刷一次(脏标记),避免逐格点重复刷
    if (hudDirty) {
      hudDirty = false;
      updateHud();
    }

    // 展示半径:生长动画(时间常数 0.25s)+ 在响 QNM 模式的叠加(方程 8)
    const grow = 1 - Math.exp(-dt / 0.25);
    rsShown += (rs() - rsShown) * grow;
    const ring = ringSum();
    // 耀发:储能按 τ=0.8s 排空;送显亮度再过 0.12s 低通 —— 处处连续
    flare *= Math.exp(-dt / 0.8);
    flareShown += (flare - flareShown) * (1 - Math.exp(-dt / 0.12));

    rsPxDrawn = Math.max(0.01, rsShown + ring);
    renderer.render({
      cx: center.x, cy: center.y,
      rsPx: rsPxDrawn,
      flare: flareShown,
      progress: Mmax > M0 ? (M - M0) / (Mmax - M0) : 0,
    }, simT);

    if (active || interaction.hasWork() || flare > 0.01) {
      raf = requestAnimationFrame(frame);
    } else {
      cv().style.display = 'none';
      raf = 0;
    }
  }

  function calibrate() {
    const els = document.querySelectorAll(cfg.targets);
    totalTargets = els.length;
    let sum = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      sum += r.width * r.height;
    }
    // 视界只增不减(面积定理):窗口缩小后 Mmax 不得低于当前 M,kM 不得为负
    Mmax = Math.max(rsMax() / 2, M);
    kM = sum > 0 ? Math.max(0, Mmax - M) / sum : 0;
  }

  function onKey(e) {
    if (e.key === 'Escape') deactivate();
  }

  function startLoop() {
    if (!raf) {
      tPrev = performance.now() / 1000;
      raf = requestAnimationFrame(frame);
    }
  }

  /** 时间倍速(1/2/3…),同时作用于测地线推进、盘旋转与铃宕 */
  function setTimeScale(n) {
    timeScale = Math.max(0.25, Math.min(5, Number(n) || 1));
    hud?.setSpeed(timeScale);
  }

  /** 恢复页面并重置黑洞:被吞元素原位复活,质量回到初始值 */
  function reset() {
    interaction.restoreAll();
    M = M0;
    swallowed = 0;
    flare = 0;
    flareShown = 0;
    rings.length = 0;
    if (active) {
      calibrate();   // 元素回来了,重新标定 k_m 与目标质量
      updateHud();
    }
  }

  function activate() {
    if (active) return;
    active = true;
    placeCenter();
    calibrate();
    rsShown = 0; // 从零长出,叠加出生铃宕
    exciteRing(0.25 * rs());
    cv().style.display = 'block';
    renderer.resize();
    interaction.activate();
    hud?.setActive(true);
    updateHud();
    addEventListener('keydown', onKey);
    startLoop();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    interaction.deactivate(); // 在轨元素立即吞掉(计入质量)
    hud?.setActive(false);
    removeEventListener('keydown', onKey);
    // 循环自然收尾(耀发衰减后停帧、藏 canvas)
  }

  function onResize() {
    placeCenter();
    renderer.resize();
  }
  addEventListener('resize', onResize);

  return {
    activate,
    deactivate,
    setTimeScale,
    reset,
    destroy() {
      deactivate();
      cancelAnimationFrame(raf);
      raf = 0;
      removeEventListener('resize', onResize);
      interaction.destroy();
      hud?.destroy();
      renderer.destroy();
      cv().remove();
    },
    get state() {
      return {
        active, rs: rs(), swallowed, totalTargets, mode: renderer.mode,
        // 送显量(调试/测试):渲染半径与亮度,二者对帧序列应处处连续
        rsPxDrawn, flare: flareShown,
      };
    },
  };
}

const BlackHole = { init };
export default BlackHole;
