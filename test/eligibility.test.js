/**
 * 판단 자격(eligibility) 단위 테스트 — 외부 의존 없음
 * 실행: npm run test:eligibility  (backend/ 에서)
 */
const assert = require('assert');
const { checkEligibility } = require('../utils/eligibility');
const { MIN_BUSINESS_MONTHS, MIN_SALES_MONTHS } = require('../utils/rules.config').getRules(); // 기본값(오버라이드 없음)

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}
function monthly(activeCount, total = 6) {
  return Array.from({ length: total }, (_, i) => ({
    // 매출 없는 달은 결제 건수도 0 — 2026-09-11 부터 「순매출 > 0 또는 결제 > 0」이면 매출 발생 달로 센다
    ym: `2026-0${i + 1}`, sales: i < total - activeCount ? 0 : 1000000, txCount: i < total - activeCount ? 0 : 20, activeDays: 12, uniqueCustomers: 10,
  }));
}
const salesOk = { hasData: true, merchantRegistered: true, monthly: monthly(6) };

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name, '—', e.message); process.exitCode = 1; }
}

console.log('eligibility.test.js');

t('업력 5개월 → NEW_BUSINESS', () => {
  const r = checkEligibility({ nts: { registrationDate: monthsAgo(5) }, sales: salesOk });
  assert.strictEqual(r.eligible, false);
  assert.deepStrictEqual(r.reasons.map(x => x.code), ['NEW_BUSINESS']);
  assert.ok(r.businessMonths < MIN_BUSINESS_MONTHS);
  assert.strictEqual(r.salesMonths, 6);
});

t('매출 월수 4 → INSUFFICIENT_SALES_MONTHS', () => {
  const r = checkEligibility({ nts: { registrationDate: monthsAgo(36) }, sales: { ...salesOk, monthly: monthly(4) } });
  assert.strictEqual(r.eligible, false);
  assert.deepStrictEqual(r.reasons.map(x => x.code), ['INSUFFICIENT_SALES_MONTHS']);
  assert.strictEqual(r.salesMonths, 4);
  assert.ok(r.salesMonths < MIN_SALES_MONTHS);
});

t('정상(업력 36개월 · 매출 6개월) → eligible', () => {
  const r = checkEligibility({ nts: { registrationDate: monthsAgo(36) }, sales: salesOk });
  assert.strictEqual(r.eligible, true);
  assert.deepStrictEqual(r.reasons, []);
  assert.strictEqual(r.businessMonths, 36);
  assert.strictEqual(r.salesMonths, 6);
});

t('카드 가맹점 미등록(hasData=false) → NO_CARD_DATA (매출 월수 사유는 중복 표기 안 함)', () => {
  const r = checkEligibility({ nts: { registrationDate: monthsAgo(36) }, sales: { hasData: false, merchantRegistered: false, monthly: [] } });
  assert.deepStrictEqual(r.reasons.map(x => x.code), ['NO_CARD_DATA']);
});

t('업력 4개월 + 카드매출 없음 → NEW_BUSINESS + NO_CARD_DATA (시연 5142691320 형태)', () => {
  const r = checkEligibility({ nts: { registrationDate: monthsAgo(4) }, sales: { hasData: false, merchantRegistered: false, monthly: [] } });
  assert.deepStrictEqual(r.reasons.map(x => x.code), ['NEW_BUSINESS', 'NO_CARD_DATA']);
});

t('업력 정확히 6개월 → 자격 충족(경계값)', () => {
  const r = checkEligibility({ nts: { registrationDate: monthsAgo(6) }, sales: salesOk });
  assert.strictEqual(r.eligible, true);
});

t('등록일 없음 → NEW_BUSINESS 로 보지 않음(매출 6개월이 업력을 보증)', () => {
  const r = checkEligibility({ nts: { registrationDate: '' }, sales: salesOk });
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.businessMonths, null);
});

t('sales 자체가 없음 → NO_CARD_DATA', () => {
  const r = checkEligibility({ nts: { registrationDate: monthsAgo(36) }, sales: null });
  assert.deepStrictEqual(r.reasons.map(x => x.code), ['NO_CARD_DATA']);
});

// ── BC 제휴 표본 밖 (2026-09-16) ──────────────────────────────
// 전 직원 공개 후, 시연·BC 표본이 아닌 실제 사업자번호가 들어온다.
// 종전에는 사업자번호 해시로 매출을 지어내(generateSeededSales) 평균 29/40점을 매겼다.
// ⚠️ 아래 3건은 비동기라 sync 용 t() 를 쓰면 안 된다(예외가 t 바깥으로 새어 통과로 집계된다).

const { getSalesData } = require('../services/mockSales.service');
const { calculateTrustScore } = require('../utils/scoreEngine');

async function ta(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name, '—', e.message); process.exitCode = 1; }
}

t('제휴 표본 밖 → OUT_OF_BC_SCOPE (NO_CARD_DATA 가 아니다)', () => {
  const r = checkEligibility({
    nts: { registrationDate: monthsAgo(36) },
    sales: { hasData: false, merchantRegistered: false, outOfScope: true, monthly: [] },
  });
  assert.strictEqual(r.eligible, false);
  assert.deepStrictEqual(r.reasons.map(x => x.code), ['OUT_OF_BC_SCOPE']);
  // '카드 가맹점 미등록' 은 실존 업체를 두고 사실이 아닌 말이 된다 — 문구에 들어가면 안 된다
  assert.ok(!r.reasons[0].detail.includes('미등록'), r.reasons[0].detail);
});

(async () => {
  await ta('표본 밖 실제 사업자번호는 카드매출을 만들어 내지 않는다', async () => {
    const s = await getSalesData('3316276030', '테스트상회'); // 시연번호·BC 표본 어디에도 없는 번호
    assert.strictEqual(s.outOfScope, true);
    assert.strictEqual(s.hasData, false);
    assert.strictEqual(s.dataType, 'OUT_OF_SCOPE');
    assert.strictEqual(s.dataSource, 'NOT_LINKED');     // 배지가 '가상 데이터' 가 아니라 '미연동'
    assert.strictEqual((s.monthly || []).length, 0);
  });

  await ta('표본 밖 → 4단계 0점 · noDataCase D · 판정 INELIGIBLE', async () => {
    const sales = await getSalesData('3316276030', '테스트상회');
    const res = calculateTrustScore({
      nts: { businessStatus: 'ACTIVE', registrationDate: monthsAgo(90), companyName: '테스트상회' },
      location: null, license: null, sales,
    });
    const fds = res.breakdown.find(b => b.step === 4);
    assert.strictEqual(fds.score, 0);
    assert.strictEqual(fds.noDataCase, 'D');            // A(카드 미가맹)와 갈라져야 한다
    assert.strictEqual(res.verdict.verdict, 'INELIGIBLE');
    assert.ok(res.verdict.description.includes('조회할 수 없어'), res.verdict.description);
  });

  await ta('BC 표본·시연번호는 종전 그대로', async () => {
    const bc = await getSalesData('1040987277', '초이커피숍'); // BC 실데이터
    assert.strictEqual(bc.hasData, true);
    assert.strictEqual(bc.dataSource, 'BC_SAMPLE');
    assert.ok(!bc.outOfScope);
    const demo = await getSalesData('2208162346', '맛있는식당'); // 시연 우량
    assert.strictEqual(demo.hasData, true);
    assert.strictEqual(demo.dataSource, 'MOCK');
    assert.ok(!demo.outOfScope);
  });

  console.log(process.exitCode ? '\n❌ 실패 있음' : `\n✅ ${passed}건 통과`);
})();
