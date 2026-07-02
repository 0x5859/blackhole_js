/**
 * snapshot.js — 把 DOM 元素栅格化成 canvas 纹理(零依赖)。
 *
 * 原理:深克隆元素 → 递归把 getComputedStyle 逐属性内联 → 包进
 * <svg><foreignObject> → data: URL → <img> → 画到离屏 canvas。
 * 同源、无外链资源时 canvas 不被污染;getImageData 探针验证,
 * 失败(外链图/字体污染、超时)则 reject,调用方回退刚体路径。
 *
 * 限制(如实说明):webfont 在快照里退回系统字体;外链 <img> 会导致污染回退。
 */

function inlineStyles(src, dst) {
  if (dst.nodeType !== 1) return;
  const cs = getComputedStyle(src);
  let css = '';
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    css += `${p}:${cs.getPropertyValue(p)};`;
  }
  dst.setAttribute('style', css);
  dst.removeAttribute('class');
  const sk = src.children, dk = dst.children;
  for (let i = 0; i < sk.length && i < dk.length; i++) inlineStyles(sk[i], dk[i]);
}

/**
 * snapshotElement(el, w, h) → Promise<canvas>
 * w/h 为元素当前 CSS 尺寸(调用方从 rect 提供)。
 */
export function snapshotElement(el, w, h, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (why) => { if (!done) { done = true; reject(new Error(why)); } };
    const timer = setTimeout(() => fail('snapshot timeout'), timeoutMs);

    try {
      const clone = el.cloneNode(true);
      inlineStyles(el, clone);
      // 根节点复位:快照坐标系是自己的,不要带走 fixed/transform/描边
      clone.style.position = 'static';
      clone.style.transform = 'none';
      clone.style.margin = '0';
      clone.style.left = clone.style.top = 'auto';
      clone.style.outline = 'none';
      clone.style.boxShadow = 'none';
      clone.style.opacity = '1';
      clone.style.filter = 'none';

      const wrap = document.createElement('div');
      wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      wrap.style.cssText = `width:${w}px;height:${h}px;overflow:hidden;margin:0;padding:0;`;
      wrap.appendChild(clone);

      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}">` +
        `<foreignObject width="100%" height="100%">` +
        new XMLSerializer().serializeToString(wrap) +
        `</foreignObject></svg>`;
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

      const img = new Image();
      img.onload = () => {
        if (done) return;
        try {
          const scale = Math.min(devicePixelRatio || 1, 2);
          const cv = document.createElement('canvas');
          cv.width = Math.max(2, Math.ceil(w * scale));
          cv.height = Math.max(2, Math.ceil(h * scale));
          const ctx = cv.getContext('2d');
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0);
          ctx.getImageData(0, 0, 1, 1); // 污染探针:被污染则抛异常
          clearTimeout(timer);
          done = true;
          resolve(cv);
        } catch (e) {
          clearTimeout(timer);
          fail('canvas tainted: ' + e.message);
        }
      };
      img.onerror = () => { clearTimeout(timer); fail('svg image load error'); };
      img.src = url;
    } catch (e) {
      clearTimeout(timer);
      fail('snapshot failed: ' + e.message);
    }
  });
}
