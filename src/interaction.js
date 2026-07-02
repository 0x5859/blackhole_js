/**
 * interaction.js — 拖拽捕获、试验粒子管理、坠落渲染(设计文档 §7 + 网格化升级)。
 *
 * 拖拽中:元素刚体跟随指针 + 朝洞的悬停力偏置(方程 13)。
 * 松手后(时空扭曲开始):
 *   1. 立刻为元素内部 (gx+1)×(gy+1) 个格点各建一条测地线(相同初速度,
 *      不同初位置 → 之后的分化即测地偏离/潮汐,方程 2/6 的直接可视化);
 *   2. 异步把元素快照成纹理(snapshot.js),就绪后隐藏 DOM,改由 WebGL
 *      网格体逐顶点形变绘制 —— 近端先坠、远端滞后、被时空拉着流进黑洞;
 *      每顶点红移 √f 驱动变暗淡出(方程 5);
 *   3. 快照失败 / 2D 降级 → 回退刚体路径(整体 transform + 颜色滤镜,无 blur)。
 * 全部顶点冻结于视界(坐标时冻结)→ 吞噬:移除元素、占位符折叠、onSwallow。
 *
 * createInteraction({ targetsSelector, getHole, onSwallow, renderer })
 *   getHole() => { cx, cy, rs, cPx, dragK }
 * → { activate, deactivate, tick(dtSec), fallingCount, hasWork, destroy }
 */

import { makeBody, stepBody, screenState, hoverAccel } from './physics.js?v=4';
import { snapshotElement } from './snapshot.js?v=4';

const PULL_GAIN = 900;  // 拖拽中悬停力→位移偏置的视觉增益
const PULL_MAX = 26;    // 偏置上限 px

const smooth = (z) => {
  const s = Math.min(1, Math.max(0, (z - 0.12) / 0.18));
  return s * s * (3 - 2 * s);
};

export function createInteraction({ targetsSelector, getHole, onSwallow, renderer }) {
  let active = false;
  let targets = [];
  const falling = []; // item 见 releaseItem()
  const consumed = []; // { el, mark(原位注释锚点), prevStyle } —— 供 restoreAll 复原
  let drag = null;

  /**
   * 文档级委托 + 近邻宽容抓取。
   * 为什么不用逐元素监听:元素被吞时占位符折叠会引发页面回流,正在"瞄准"
   * 下一个元素的用户按下的瞬间,目标可能刚好被回流从指针下抽走 —— 按空了,
   * 表现为"松手后元素留在原地"。委托 + 半径 48px 的最近可吞元素兜底,
   * 让抓取对回流免疫(顺带让小元素更好抓)。
   */
  const GRAB_RADIUS = 64;
  const PAST_RECT_MS = 450; // "旧布局"命中的有效期

  // 每 250ms 快照全部目标的矩形:吞噬回流把元素从指针下抽走时,
  // 按在"它刚才在的位置"仍能命中(人手对突发位移的跟随延迟 ~200-300ms)
  let pastRects = null, pastAt = 0, pastTimer = 0;
  const snapshotRects = () => {
    pastRects = targets.map((t) => (t.isConnected ? [t, t.getBoundingClientRect()] : null));
    pastAt = performance.now();
  };

  const grabbable = (t) => t && t.isConnected && targets.includes(t)
    && !falling.some((f) => f.el === t);

  const onDocDown = (e) => {
    if (!active || drag) return;
    if (e.button !== undefined && e.button !== 0) return;
    // 真实控件优先:HUD、链接、表单等绝不被抓取劫持
    if (e.target.closest && e.target.closest('a, button, input, select, textarea, [contenteditable], .bh-hud, .bh-btn')) return;

    // 第一层:直接命中
    let el = e.target.closest ? e.target.closest('.bh-devour') : null;
    if (!grabbable(el)) el = null;

    // 第二层:旧布局命中(400ms 内的矩形快照)
    if (!el && pastRects && performance.now() - pastAt < PAST_RECT_MS) {
      for (const pair of pastRects) {
        if (!pair || !grabbable(pair[0])) continue;
        const r = pair[1];
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          el = pair[0];
          break;
        }
      }
    }

    // 第三层:近邻兜底(64px 内最近的可吞元素)
    if (!el) {
      let bestD = GRAB_RADIUS;
      for (const t of targets) {
        if (!grabbable(t)) continue;
        const r = t.getBoundingClientRect();
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
        const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; el = t; }
      }
    }
    if (el) beginDrag(el, e);
  };

  const beginDrag = (el, e) => {
    e.preventDefault();

    const rect = el.getBoundingClientRect();
    const ghost = makeGhost(el, rect);
    el.parentNode.insertBefore(ghost, el);

    const prevStyle = el.getAttribute('style'); // 复原用:拖拽前的内联样式
    Object.assign(el.style, {
      position: 'fixed', left: '0px', top: '0px', margin: '0',
      width: rect.width + 'px', height: rect.height + 'px',
      zIndex: '9999', willChange: 'transform, filter, opacity',
      transform: `translate(${rect.left}px, ${rect.top}px)`,
    });
    el.classList.add('bh-dragging');

    drag = {
      el, ghost, prevStyle, w: rect.width, h: rect.height, pointerId: e.pointerId,
      // 近邻兜底抓取时指针可能在元素框外:把持点钳回框内,元素顺滑贴到指针下
      gx: Math.min(rect.width, Math.max(0, e.clientX - rect.left)),
      gy: Math.min(rect.height, Math.max(0, e.clientY - rect.top)),
      px: rect.left, py: rect.top, rx: rect.left, ry: rect.top, vx: 0, vy: 0,
      lastX: e.clientX, lastY: e.clientY, lastT: performance.now(),
    };
    try { el.setPointerCapture?.(e.pointerId); } catch { /* 合成事件无活动指针,忽略 */ }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return; // 多指:只认发起拖拽的指针
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT);
    // 80ms 时间常数的速度 EMA
    const a = 1 - Math.exp(-dt / 80);
    drag.vx += a * (((e.clientX - drag.lastX) / dt) * 1000 - drag.vx);
    drag.vy += a * (((e.clientY - drag.lastY) / dt) * 1000 - drag.vy);
    drag.lastX = e.clientX; drag.lastY = e.clientY; drag.lastT = now;
    drag.px = e.clientX - drag.gx;
    drag.py = e.clientY - drag.gy;
  };

  const onUp = (e) => {
    if (!drag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    d.el.classList.remove('bh-dragging');
    d.el.classList.add('bh-falling');
    d.el.removeEventListener('pointermove', onMove);
    d.el.removeEventListener('pointerup', onUp);
    d.el.removeEventListener('pointercancel', onUp);

    // 按住不动再松手:EMA 速度是陈旧值,按静止时长衰减(50ms 宽限,τ=100ms)
    const gap = performance.now() - d.lastT;
    const stale = Math.exp(-Math.max(0, gap - 50) / 100);
    releaseItem(d, d.vx * stale, d.vy * stale);
  };

  /** 松手:建中心刚体 + 顶点粒子网格,异步快照 → 网格体接管 */
  function releaseItem(d, vx, vy) {
    const hole = getHole();
    const { el, ghost, w, h, rx, ry } = d;

    const mkAt = (x, y) => makeBody({
      x, y, vx, vy, cx: hole.cx, cy: hole.cy, rs: hole.rs, cPx: hole.cPx,
    });

    // 顶点网格(时空扭曲的分辨率):每 ~40px 一格,4..12 × 3..10
    const gx = Math.min(12, Math.max(4, Math.round(w / 40)));
    const gy = Math.min(10, Math.max(3, Math.round(h / 40)));
    const nx = gx + 1, ny = gy + 1;
    const verts = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        verts.push({ body: mkAt(rx + (w * i) / gx, ry + (h * j) / gy), frozen: false, x: 0, y: 0, z: 1 });
      }
    }

    const item = {
      mode: 'rigid', el, ghost, prevStyle: d.prevStyle, w, h, rot: 0, done: false,
      center: mkAt(rx + w / 2, ry + h / 2),
      verts, nx, ny, gx, gy,
      mesh: null,
      pos: new Float32Array(nx * ny * 2),
      fx: new Float32Array(nx * ny * 2),
    };
    falling.push(item);

    // 异步快照 → WebGL 网格体(失败 / 2D 降级 → 保持刚体)
    if (renderer && renderer.mode === 'webgl') {
      snapshotElement(el, w, h).then((cv) => {
        if (item.done) return;
        const mesh = renderer.createMesh(cv, gx, gy);
        if (!mesh) return;
        item.mesh = mesh;
        item.mode = 'mesh';
        el.style.visibility = 'hidden';
        el.style.filter = '';
      }).catch(() => { item.verts = null; /* 刚体路径,顶点粒子不再需要 */ });
    } else {
      item.verts = null;
    }
  }

  function makeGhost(el, rect) {
    const cs = getComputedStyle(el);
    const g = document.createElement(el.tagName === 'LI' ? 'li' : 'div');
    g.className = 'bh-ghost';
    g.style.width = rect.width + 'px';
    g.style.height = rect.height + 'px';
    g.style.margin = cs.margin;
    g.style.display = cs.display === 'inline' ? 'inline-block' : cs.display;
    g.style.flex = cs.flex;
    g.setAttribute('aria-hidden', 'true');
    return g;
  }

  // 待折叠的占位符:吞噬风暴期间(有拖拽/在轨)布局必须纹丝不动,
  // 否则回流会把用户正瞄准的目标从指针下抽走;等系统静默再级联折叠
  const pendingGhosts = [];

  function swallow(item) {
    if (item.done) return;
    item.done = true;
    const { el, ghost, w, h } = item;
    item.mesh?.dispose();
    // 原位留注释锚点 + 记录拖拽前样式,restoreAll 可精确复原
    if (el.parentNode) {
      const mark = document.createComment('bh-slot');
      el.parentNode.insertBefore(mark, el);
      consumed.push({ el, mark, prevStyle: item.prevStyle });
    }
    el.remove();
    pendingGhosts.push(ghost); // 折叠推迟到 flushGhosts(静默时)
    onSwallow(w * h, el);
  }

  /** 系统静默(无拖拽、无在轨)时把积压的占位符级联折叠 */
  function flushGhosts() {
    const batch = pendingGhosts.splice(0);
    batch.forEach((g, i) => {
      setTimeout(() => {
        if (!g.isConnected) return;
        g.style.height = g.offsetHeight + 'px'; // 固定当前高度以触发过渡
        requestAnimationFrame(() => g.classList.add('bh-ghost-collapse'));
        setTimeout(() => g.remove(), 1000); // ≥ 0.9s 过渡,避免中途硬移除的布局跳变
      }, i * 90);
    });
  }

  /** 由入口 rAF 每帧调用 */
  function tick(dtSec) {
    const hole = getHole();
    const env = { rs: hole.rs, cPx: hole.cPx, dragK: hole.dragK };

    // 拖拽中:指针位置 + 朝洞方向的悬停力偏置(方程 13,"越近越拽不住")
    if (drag) {
      const ex = drag.px + drag.w / 2, ey = drag.py + drag.h / 2;
      const dx = hole.cx - ex, dy = hole.cy - ey;
      const dist = Math.max(Math.hypot(dx, dy), 1.05 * hole.rs);
      const pull = Math.min(hoverAccel(dist, hole.rs) * PULL_GAIN, PULL_MAX);
      const ux = dx / dist, uy = dy / dist;
      drag.rx = drag.px + ux * pull;
      drag.ry = drag.py + uy * pull;
      drag.el.style.transform = `translate(${drag.rx}px, ${drag.ry}px)`;
    }

    for (let i = falling.length - 1; i >= 0; i--) {
      const it = falling[i];

      // —— 顶点粒子:每个格点一条独立测地线 ——
      if (it.verts) {
        let frozenCount = 0;
        for (let k = 0; k < it.verts.length; k++) {
          const vt = it.verts[k];
          if (!vt.frozen) {
            if (!stepBody(vt.body, env, dtSec)) vt.frozen = true;
            const s = screenState(vt.body, hole);
            vt.x = s.x; vt.y = s.y; vt.z = s.redshift;
          }
          if (vt.frozen) frozenCount++;
          it.pos[k * 2] = vt.x;
          it.pos[k * 2 + 1] = vt.y;
          it.fx[k * 2] = vt.z;
          it.fx[k * 2 + 1] = vt.frozen ? 0 : smooth(vt.z);
        }
        if (it.mode === 'mesh') {
          it.mesh.update(it.pos, it.fx);
          if (frozenCount === it.verts.length) {
            falling.splice(i, 1);
            swallow(it);
          }
          continue;
        }
      }

      // —— 刚体路径(快照未就绪或已回退)——
      const alive = stepBody(it.center, env, dtSec);
      const s = screenState(it.center, hole);
      let dd = s.vAngle - it.rot;
      while (dd > Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      it.rot += dd * Math.min(1, (0.8 + 4 * s.tidal) * dtSec);

      const z = s.redshift;
      const stretch = 1 + 2 * s.tidal;
      it.el.style.transform =
        `translate(${s.x - it.w / 2}px, ${s.y - it.h / 2}px) ` +
        `rotate(${it.rot}rad) scale(${stretch}, ${1 / (1 + s.tidal)})`;
      // 不用 blur():大面积元素每帧重栅格化是近洞卡顿的元凶;
      // 颜色矩阵类滤镜(brightness/sepia/hue-rotate)走 GPU,开销恒定
      it.el.style.filter =
        `brightness(${0.25 + 0.75 * z}) sepia(${(1 - z) * 0.85}) ` +
        `hue-rotate(${-25 * (1 - z)}deg)`;
      it.el.style.opacity = String(smooth(z));

      if (!alive && it.mode === 'rigid') {
        falling.splice(i, 1);
        swallow(it);
      }
    }

    // 静默检测:轰炸结束后再让页面塌缩
    if (!drag && falling.length === 0 && pendingGhosts.length) flushGhosts();
  }

  function activate() {
    if (active) return;
    active = true;
    targets = [...document.querySelectorAll(targetsSelector)];
    if (!targets.length) {
      console.warn(`[blackhole] selector "${targetsSelector}" matched nothing; falling back to default content blocks`);
      targets = [...document.querySelectorAll('main h1, main h2, main p, main img, main li, main pre')];
    }
    for (const el of targets) el.classList.add('bh-devour');
    document.addEventListener('pointerdown', onDocDown);
    snapshotRects();
    pastTimer = setInterval(snapshotRects, 250);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    if (drag) onUp();
    // 在轨元素立即吞掉(白洞不在本项目范围)
    while (falling.length) swallow(falling.pop());
    flushGhosts(); // 退出即静默,立刻塌缩
    for (const el of targets) el.classList.remove('bh-devour');
    document.removeEventListener('pointerdown', onDocDown);
    clearInterval(pastTimer);
    pastRects = null;
    targets = [];
  }

  function restoreEl(el, prevStyle) {
    if (prevStyle == null) el.removeAttribute('style');
    else el.setAttribute('style', prevStyle);
    el.classList.remove('bh-falling', 'bh-dragging');
  }

  /** 恢复页面:拖拽中/在轨/已吞噬的元素全部原位复原(白洞时刻 :-)*/
  function restoreAll() {
    if (drag) {
      const d = drag;
      drag = null;
      d.el.removeEventListener('pointermove', onMove);
      d.el.removeEventListener('pointerup', onUp);
      d.el.removeEventListener('pointercancel', onUp);
      restoreEl(d.el, d.prevStyle);
      d.ghost.remove();
    }
    while (falling.length) {
      const it = falling.pop();
      it.done = true; // 阻断迟到的快照回调
      it.mesh?.dispose();
      restoreEl(it.el, it.prevStyle);
      it.ghost.remove();
    }
    while (pendingGhosts.length) pendingGhosts.pop().remove();
    for (const c of consumed) {
      if (c.mark.parentNode) c.mark.parentNode.insertBefore(c.el, c.mark);
      c.mark.remove();
      restoreEl(c.el, c.prevStyle);
    }
    consumed.length = 0;
  }

  return {
    activate, deactivate, tick, restoreAll,
    fallingCount: () => falling.length,
    hasWork: () => falling.length > 0 || !!drag,
    destroy() { deactivate(); },
  };
}
