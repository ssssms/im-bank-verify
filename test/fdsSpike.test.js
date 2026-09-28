/**
 * FDS ④ 「직전 1개월 매출 급증」 비교 기준 단위 테스트 — 외부 의존 없음
 * 실행: npm run test:spike  (backend/ 에서)
 *
 * 2026-09-11: 개업(첫 매출 발생 달) 이전의 0원 달은 비교 평균에 넣지 않는다.
 *   송담추어탕(2026.05 개업, 5월 447만 → 6월 641만 = 1.4배)이 「직전 3개월 평균의 4.3배」로 잡히던 것.
 */
const assert = require('assert');
const { scoreFds } = require('../utils/fdsEngine');

function series(salesList) {
  return {
    hasData: true, merchantRegistered: true, dataType: 'CARD_ONLY',
    industryAvgSales: 2000000, repeatedAmountRatio: 0,
    monthly: salesList.map((sales, i) => ({
      ym: `2026-0${i + 1}`, sales, txCount: sales > 0 ? Math.round(sales / 25000) : 0,
      activeDays: sales > 0 ? 20 : 0, uniqueCustomers: sales > 0 ? Math.round(sales / 30000) : 0,
    })),
  };
}
const spikeFlag = r => (r.subScores.find(s => s.key === 'anomaly')?.flags || []).find(f => f.includes('급증'));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name, '—', e.message); process.exitCode = 1; }
}

console.log('fdsSpike.test.js');

t('개업 2개월째(0/0/0/0/447만/641만) → 전달과만 비교 1.4배, 급증 아님', () => {
  const r = scoreFds(series([0, 0, 0, 0, 4470000, 6410000]));
  assert.strictEqual(Math.round(r.metrics.spikeRatio * 10) / 10, 1.4);
  assert.strictEqual(r.metrics.spikeBaseMonths, 1);
  assert.strictEqual(spikeFlag(r), undefined);
});

t('개업 첫 달(0/0/0/0/0/500만) → 비교할 달 없음, 급증 아님', () => {
  const r = scoreFds(series([0, 0, 0, 0, 0, 5000000]));
  assert.strictEqual(r.metrics.spikeRatio, 0);
  assert.strictEqual(r.metrics.spikeBaseMonths, 0);
  assert.strictEqual(spikeFlag(r), undefined);
});

t('개업 3개월째에 전달들의 3배(0/0/0/100만/120만/330만) → 직전 2개월 평균 기준 3.0배 급증', () => {
  const r = scoreFds(series([0, 0, 0, 1000000, 1200000, 3300000]));
  assert.strictEqual(Math.round(r.metrics.spikeRatio * 10) / 10, 3.0);
  assert.strictEqual(r.metrics.spikeBaseMonths, 2);
  assert.ok(spikeFlag(r) && spikeFlag(r).includes('직전 2개월 평균의 3.0배'), spikeFlag(r));
});

t('영업 중 급증(90/80/100/120/150/3,800만, 5555555555 형) → 종전과 같은 직전 3개월 평균 30.8배', () => {
  const r = scoreFds(series([900000, 800000, 1000000, 1200000, 1500000, 38000000]));
  assert.strictEqual(Math.round(r.metrics.spikeRatio * 10) / 10, 30.8);
  assert.strictEqual(r.metrics.spikeBaseMonths, 3);
  assert.ok(spikeFlag(r) && spikeFlag(r).includes('직전 3개월 평균의 30.8배'), spikeFlag(r));
});

// [2026-09-28] BC 월 배치 누적 — 순고객·영업일수가 비어 온 달(null)은 0 이 아니라 「없음」
//   매월 80명 매장인데 앞 5개월 순고객이 비어 오면, 0 으로 평균하면 13명 → 15명 최소선에 걸려 오보류된다.
function withGaps() {
  const r = series([2400000, 2400000, 2400000, 2400000, 2400000, 2400000]); // 월 96건
  r.monthly.forEach((m, i) => { m.uniqueCustomers = i < 5 ? null : 80; m.activeDays = i < 5 ? null : 20; });
  return r;
}

t('순고객이 최근 1개월만 있고 앞 5개월이 null → 월평균 순고객 80명(0 으로 평균하지 않음)', () => {
  const r = scoreFds(withGaps());
  assert.strictEqual(r.metrics.avgUniqueCustomers, 80);
  assert.strictEqual(r.metrics.customerMonths, 1);
  assert.strictEqual(r.metrics.activeMonths, 6, '매출 발생 월수는 그대로 6');
});

t('영업일수 null 달은 평균·최소 영업일에서 빠진다 → 특정일 집중 오탐 없음', () => {
  const r = scoreFds(withGaps());
  assert.strictEqual(r.metrics.avgActiveDays, 20);
  assert.strictEqual(r.metrics.minActiveDays, 20);
  const flags = r.subScores.find(s => s.key === 'anomaly').flags;
  assert.ok(!flags.some(f => f.includes('특정일')), flags.join(','));
});

t('0 은 여전히 0 — 값이 0 인 달은 평균에 들어간다', () => {
  const r = withGaps();
  r.monthly.forEach((m, i) => { if (i < 5) m.uniqueCustomers = 0; });
  assert.strictEqual(Math.round(scoreFds(r).metrics.avgUniqueCustomers), 13);
});

console.log(process.exitCode ? `❌ ${passed}건 통과, 실패 있음` : `✅ ${passed}건 통과`);
