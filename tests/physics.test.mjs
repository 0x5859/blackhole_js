import { test } from 'node:test';
import assert from 'node:assert';
import * as P from '../src/physics.js';

// 几何单位 G=c=1,长度=px。测试用黑洞 M=8 → r_s=16px。
const M = 8;
const rs = 2 * M;
const cPx = 1600;
const env = { rs, cPx, dragK: 0 };

// 史瓦西圆轨道角动量:L² = M r² / (r − 3M)
const circL = (r) => Math.sqrt((M * r * r) / (r - 3 * M));

// 从 (r, pr, L) 造 body(绕过 makeBody,直接指定测地线常数)
const bodyOf = (r, pr, L) => ({ r, phi: 0, pr, L });

test('能量守恒:无阻尼偏椭圆轨道积分 5e4 步,约束投影使漂移 < 1e-9', () => {
  const b = bodyOf(10 * M, 0, 1.05 * circL(10 * M));
  const E0 = P.energyOf(b, rs);
  for (let i = 0; i < 50000; i++) {
    const alive = P.stepBody(b, env, 1 / 240);
    assert.ok(alive, `轨道不应坠入 (i=${i}, r=${b.r})`);
  }
  const drift = Math.abs(P.energyOf(b, rs) / E0 - 1);
  assert.ok(drift < 1e-9, `能量漂移 ${drift}`);
});

test('转折点长期稳定:偏心轨道 20 圈,近/远星点无长期漂移(<0.5%)', () => {
  const b = bodyOf(12 * M, 0, 1.06 * circL(12 * M));
  let prevR = b.r, falling = false, orbits = 0;
  let firstMin = null, lastMin = null, rMin = Infinity, rMax = 0;
  for (let i = 0; i < 3000000 && orbits < 20; i++) {
    P.stepBody(b, env, 1 / 240);
    rMin = Math.min(rMin, b.r); rMax = Math.max(rMax, b.r);
    if (falling && b.r > prevR) {
      orbits++;
      if (firstMin === null) firstMin = prevR;
      lastMin = prevR;
      falling = false;
    } else if (b.r < prevR) falling = true;
    prevR = b.r;
  }
  assert.ok(orbits >= 20, `只完成 ${orbits} 圈`);
  assert.ok(Math.abs(lastMin / firstMin - 1) < 5e-3,
    `近星点漂移 ${firstMin} → ${lastMin}`);
});

test('测地偏离(潮汐):坠落中途径向间隔拉伸、横向间隔压缩', () => {
  // 径向:两个静止释放的粒子,坠落中途径向间距增大
  // (近视界后坐标时冻结会把间距重新压小,故取存活期间的最大值)
  const a1 = bodyOf(8 * M, 0, 0);
  const a2 = bodyOf(8 * M + 4, 0, 0);
  const gap0 = a2.r - a1.r;
  let maxGap = gap0;
  for (let i = 0; i < 5000; i++) {
    const alive1 = P.stepBody(a1, env, 1 / 240);
    P.stepBody(a2, env, 1 / 240);
    maxGap = Math.max(maxGap, a2.r - a1.r);
    if (!alive1) break; // 前面的粒子先冻结,停止比较
  }
  assert.ok(maxGap > gap0 * 1.3, `径向最大间距 ${gap0} → ${maxGap},应拉伸`);
  // 横向:同半径、方位角差 δφ 的两粒子纯径向坠落(φ 各自不变),
  // 屏幕距离 r·δφ 随 r 收缩
  const b1 = bodyOf(8 * M, 0, 0);
  const d0 = b1.r * 0.01;
  for (let i = 0; i < 5000; i++) if (!P.stepBody(b1, env, 1 / 240)) break;
  assert.ok(b1.r * 0.01 < d0 * 0.5, `横向间距 ${d0} → ${b1.r * 0.01},应压缩`);
});

test('圆轨道:r=8M 转满一圈,|Δr|/r < 1%', () => {
  const r0 = 8 * M;
  const b = bodyOf(r0, 0, circL(r0));
  let rMin = r0, rMax = r0;
  while (b.phi < 2 * Math.PI) {
    P.stepBody(b, env, 1 / 240);
    rMin = Math.min(rMin, b.r);
    rMax = Math.max(rMax, b.r);
  }
  assert.ok((rMax - rMin) / r0 < 0.01, `Δr/r = ${(rMax - rMin) / r0}`);
});

test('ISCO 内(r=5.5M)圆轨道条件失稳,有限时间坠入', () => {
  const r0 = 5.5 * M;
  // r<6M 无稳定圆轨道;用 r=5.5M 处 dV/dr=0 不可满足,给它 ISCO 的 L 也守不住
  const b = bodyOf(r0, 0, circL(6 * M));
  let swallowed = false;
  for (let i = 0; i < 200000; i++) {
    if (!P.stepBody(b, env, 1 / 240)) { swallowed = true; break; }
  }
  assert.ok(swallowed, `r 终值 ${b.r}`);
});

test('径向坠落:r 单调降、永不过视界、有限坐标时触发吞噬(冻结)', () => {
  const b = bodyOf(10 * M, 0, 0); // 从静止释放:E=√f 自动由状态派生
  let prev = b.r;
  let swallowed = false;
  for (let i = 0; i < 200000; i++) {
    const alive = P.stepBody(b, env, 1 / 240);
    assert.ok(b.r <= prev + 1e-9, '径向坠落 r 必须单调不增');
    assert.ok(b.r > rs, `r=${b.r} 不得越过视界`);
    prev = b.r;
    if (!alive) { swallowed = true; break; }
  }
  assert.ok(swallowed, '应在有限步内达到吞噬红移判据');
  // 吞噬时刻的红移必须低于判据
  assert.ok(Math.sqrt(P.fOf(b.r, rs)) <= P.SWALLOW_REDSHIFT + 1e-6);
});

test('近星点进动 ≈ 6πM/[a(1−e²)],偏差 < 25%', () => {
  // 弱场偏心轨道(一阶进动公式在 p≫M 才准确);记录相邻两次近星点的 φ 差
  const b = bodyOf(40 * M, 0, 1.02 * circL(40 * M));
  let prevR = b.r, falling = false;
  const periPhis = [];
  let rMin = Infinity, rMax = 0;
  for (let i = 0; i < 2000000 && periPhis.length < 3; i++) {
    P.stepBody(b, env, 1 / 240);
    rMin = Math.min(rMin, b.r);
    rMax = Math.max(rMax, b.r);
    if (falling && b.r > prevR) { // 由降转升 = 近星点
      periPhis.push(b.phi);
      falling = false;
    } else if (b.r < prevR) falling = true;
    prevR = b.r;
  }
  assert.ok(periPhis.length >= 3, '应捕捉到 ≥3 个近星点');
  const dphi = (periPhis[2] - periPhis[1]) - 2 * Math.PI;
  const a = (rMin + rMax) / 2;
  const e = (rMax - rMin) / (rMax + rMin);
  const predicted = (6 * Math.PI * M) / (a * (1 - e * e));
  assert.ok(Math.abs(dphi / predicted - 1) < 0.25,
    `measured=${dphi}, predicted=${predicted}`);
});

test('makeBody 牛顿极限:远处慢抛 → E≈1,L≈r·v_t', () => {
  const cx = 0, cy = 0;
  const r0 = 200 * M;
  const vt = 0.01; // 0.01c 切向
  const b = P.makeBody({ x: r0, y: 0, vx: 0, vy: vt * cPx, cx, cy, rs, cPx });
  assert.ok(Math.abs(P.energyOf(b, rs) - 1) < 0.01, `E=${P.energyOf(b, rs)}`);
  assert.ok(Math.abs(b.L / (r0 * vt) - 1) < 0.02, `L=${b.L}, 期望≈${r0 * vt}`);
  assert.ok(Math.abs(b.pr) < 1e-9, '纯切向抛掷 pr≈0');
});

test('超光速钳制:巨大速度不产生 NaN,localSpeed ≤ 0.985', () => {
  const b = P.makeBody({ x: 100, y: 50, vx: 99 * cPx, vy: -99 * cPx, cx: 0, cy: 0, rs, cPx });
  for (const v of [b.r, b.phi, b.pr, b.L]) assert.ok(Number.isFinite(v));
  assert.ok(P.localSpeed(b, rs) <= 0.985 + 1e-9, `v_loc=${P.localSpeed(b, rs)}`);
  for (let i = 0; i < 1000; i++) P.stepBody(b, env, 1 / 240);
  assert.ok(Number.isFinite(b.r) && Number.isFinite(b.phi));
});

test('screenState:几何一致性与红移/潮汐量纲', () => {
  const hole = { cx: 300, cy: 200, rs };
  const b = P.makeBody({ x: 400, y: 200, vx: 0, vy: -0.3 * cPx, cx: 300, cy: 200, rs, cPx });
  const s = P.screenState(b, hole);
  assert.ok(Math.abs(s.x - 400) < 1e-6 && Math.abs(s.y - 200) < 1e-6);
  assert.ok(Math.abs(s.redshift - Math.sqrt(P.fOf(100, rs))) < 1e-9);
  assert.ok(s.tidal >= 0 && s.tidal <= 1);
  assert.ok(Number.isFinite(s.vAngle));
});
