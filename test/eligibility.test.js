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

console.log(process.exitCode ? '\n❌ 실패 있음' : `\n✅ ${passed}건 통과`);
