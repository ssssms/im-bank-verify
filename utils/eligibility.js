/**
 * ============================================================
 * 판단 자격(eligibility) — 실영위를 데이터로 판단할 수 있는가
 * ============================================================
 *
 * 카드매출 6개월 이력이 없으면 점수와 무관하게 실영위를 판단할 수 없다(INELIGIBLE).
 * 이 경우만 현행 절차(영업점 서류 심사)로 안내한다. "서류 내면 뚫리는 보류"를 없애기 위해
 * 보류(PENDING)는 자격이 되는 사업자에게만 남긴다.
 *
 * reason code
 *   NEW_BUSINESS              업력 < MIN_BUSINESS_MONTHS
 *   NO_CARD_DATA              카드 가맹점 미등록 또는 hasData=false
 *   INSUFFICIENT_SALES_MONTHS 최근 6개월 중 매출 발생 월수 < MIN_SALES_MONTHS
 *
 * 등록일이 없어 업력을 알 수 없으면 NEW_BUSINESS 로 보지 않는다 — 매출 발생 월수 6개월이
 * 충족되면 업력도 6개월 이상일 수밖에 없으므로 자격 판단에 구멍이 생기지 않는다.
 */
const { getRules } = require('./rules.config'); // 매 계산마다 읽는다 (관리자 런타임 오버라이드 반영)
const { calcBusinessYears } = require('./businessAge');

function countSalesMonths(sales) {
  const monthly = Array.isArray(sales?.monthly) ? sales.monthly : [];
  // [2026-09-11] 순매출 > 0 또는 결제 건수 > 0 이면 매출 발생 달 (환불 초과로 순매출이 음수인 달도 영업한 달)
  return monthly.filter(m => (m.sales || 0) > 0 || (m.txCount || 0) > 0).length;
}

/**
 * @param {{ nts: object, sales: object }} ctx
 * @returns {{ eligible: boolean, reasons: {code,label,detail}[], businessMonths: number|null, salesMonths: number }}
 */
function checkEligibility({ nts, sales } = {}) {
  const { MIN_BUSINESS_MONTHS, MIN_SALES_MONTHS } = getRules();
  const reasons = [];

  const hasRegDate = !!nts?.registrationDate;
  const businessMonths = hasRegDate
    ? Math.floor(calcBusinessYears(nts.registrationDate) * 12)
    : null;
  const salesMonths = countSalesMonths(sales);

  if (hasRegDate && businessMonths < MIN_BUSINESS_MONTHS) {
    reasons.push({
      code: 'NEW_BUSINESS',
      label: `업력 ${MIN_BUSINESS_MONTHS}개월 미만`,
      detail: `사업자등록 후 ${businessMonths}개월. 카드매출 ${MIN_SALES_MONTHS}개월 이력이 쌓이기 전입니다.`,
    });
  }

  if (sales?.outOfScope) {
    // [2026-09-16] BC 제휴 표본 밖 — '데이터가 없다' 가 아니라 '조회할 수 없다'.
    // 자격 판단 결과(INELIGIBLE)는 NO_CARD_DATA 와 같지만 사유 문구가 달라야 한다.
    reasons.push({
      code: 'OUT_OF_BC_SCOPE',
      label: '카드매출 조회 불가',
      detail: 'BC카드 데이터 제휴 표본에 없는 사업자입니다. 카드매출을 조회할 수 없습니다.',
    });
  } else if (!sales || !sales.hasData || !sales.merchantRegistered) {
    reasons.push({
      code: 'NO_CARD_DATA',
      label: '카드매출 데이터 없음',
      detail: sales?.merchantRegistered
        ? '카드 가맹점으로 등록되어 있으나 카드매출 데이터가 없습니다.'
        : '카드 가맹점 미등록. 카드매출 데이터가 없습니다.',
    });
  } else if (salesMonths < MIN_SALES_MONTHS) {
    reasons.push({
      code: 'INSUFFICIENT_SALES_MONTHS',
      label: `매출 발생 월수 ${MIN_SALES_MONTHS}개월 미만`,
      detail: `최근 ${MIN_SALES_MONTHS}개월 중 ${salesMonths}개월만 카드매출이 있습니다.`,
    });
  }

  return { eligible: reasons.length === 0, reasons, businessMonths, salesMonths };
}

module.exports = { checkEligibility, countSalesMonths };
