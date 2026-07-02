/**
 * hud.js — 启动按钮(🕳)与 HUD 面板。
 *
 * HUD 显示:视界半径 r_s、已吞噬数、质量进度条、熵(方程 15 的趣味换算:
 * 若 1px = 1 普朗克长度,S/k_B·ln2 = π r_s²/ln2 bit)。
 *
 * createHud({ onToggle, onSpeed, onReset, corner })
 *   → { setActive(bool), setSpeed(n), update({rsPx, count, massFrac, done}), destroy }
 *
 * 布局:🕳 按钮贴在黑洞所在角;HUD 面板放到水平对侧同一竖直带,
 * 避免挡住黑洞本体(面板不小,洞的阴影又大)。
 */

export function createHud({ onToggle, onSpeed, onReset, corner = 'bottom-right' }) {
  const btn = document.createElement('button');
  btn.className = 'bh-btn';
  btn.type = 'button';
  btn.title = 'Toggle black hole';
  btn.setAttribute('aria-label', 'Toggle black hole');
  btn.textContent = '🕳';
  btn.addEventListener('click', () => onToggle());

  const hud = document.createElement('div');
  hud.className = 'bh-hud';
  hud.innerHTML = `
    <div class="bh-hud-row"><span>Horizon r<sub>s</sub></span><b class="bh-rs">–</b></div>
    <div class="bh-hud-row"><span>Objects consumed</span><b class="bh-count">0</b></div>
    <div class="bh-hud-row"><span>Entropy S <i>(1px=ℓ<sub>P</sub>)</i></span><b class="bh-entropy">–</b></div>
    <div class="bh-bar"><div class="bh-bar-fill"></div></div>
    <div class="bh-hud-ctrl">
      <button type="button" class="bh-speed bh-speed-on" data-s="1" title="Normal speed">1×</button>
      <button type="button" class="bh-speed" data-s="2" title="Double speed">2×</button>
      <button type="button" class="bh-speed" data-s="3" title="Triple speed">3×</button>
      <button type="button" class="bh-restore" title="Restore every consumed element and reset the hole">↺ Restore</button>
    </div>
    <div class="bh-hud-msg"></div>`;

  // 角落自适应:按钮贴洞角,面板去水平对侧
  const [vSide, hSide] = corner.split('-');
  btn.style[hSide === 'left' ? 'left' : 'right'] = '22px';
  btn.style[vSide === 'top' ? 'top' : 'bottom'] = '22px';
  hud.style[hSide === 'left' ? 'right' : 'left'] = '22px';
  hud.style[vSide === 'top' ? 'top' : 'bottom'] = '22px';

  document.body.append(btn, hud);

  hud.querySelectorAll('.bh-speed').forEach((b) =>
    b.addEventListener('click', () => onSpeed?.(Number(b.dataset.s))));
  hud.querySelector('.bh-restore').addEventListener('click', () => onReset?.());

  const $ = (c) => hud.querySelector(c);
  const fmtBits = (b) =>
    b > 1e6 ? (b / 1e6).toFixed(2) + ' Mbit' :
    b > 1e3 ? (b / 1e3).toFixed(1) + ' kbit' : Math.round(b) + ' bit';

  return {
    setActive(on) {
      btn.classList.toggle('bh-btn-on', on);
      hud.classList.toggle('bh-hud-show', on);
    },
    setSpeed(n) {
      hud.querySelectorAll('.bh-speed').forEach((b) =>
        b.classList.toggle('bh-speed-on', Number(b.dataset.s) === n));
    },
    update({ rsPx, count, massFrac, done }) {
      $('.bh-rs').textContent = rsPx.toFixed(1) + ' px';
      $('.bh-count').textContent = String(count);
      // 方程 15:S ∝ 视界面积 ∝ r_s²(把 1px 当普朗克长度的玩笑换算)
      $('.bh-entropy').textContent = fmtBits((Math.PI * rsPx * rsPx) / Math.LN2);
      $('.bh-bar-fill').style.width = Math.min(100, massFrac * 100).toFixed(1) + '%';
      $('.bh-hud-msg').textContent = done ? 'Heat death reached — thanks for feeding ☄' : '';
    },
    destroy() { btn.remove(); hud.remove(); },
  };
}
