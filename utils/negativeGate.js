/**
 * ============================================================
 * 네거티브 게이트 — 점수와 독립된 차단 레이어 (2026-08-25 신설)
 * ============================================================
 *
 * [왜 분리했나]
 * 종전에는 이상패턴이 FDS 40점 중 ④ 5점 안에 갇혀 있었다. 즉 「사업자등록번호 오류」나
 * 「대표자/실소유자 불일치」처럼 대포사업자 판별에 결정적인 신호가 들어와도 5점짜리
 * 소항목 안에서만 감점되고, 감점 4점 이상일 때만 riskAlert가 서는 구조였다.
 * 위험 신호는 가점 체계에 섞을 것이 아니라 차단으로 처리해야 한다.
 *
 * [설계 원칙 — 배점 불변]
 * 이 게이트는 점수를 1점도 더하거나 빼지 않는다. 총점 100점·4단계 구조와 제안서
 * 배점표는 그대로 두고, 판정(verdict)만 오버라이드한다.
 *
 * [3단계]
 *   BLOCK : 즉시 차단  → 점수 무관 REJECTED (영업점 방문)
 *   HOLD  : 보류        → 점수 무관 PENDING  (사람이 봐야 하는 신호)
 *   WATCH : 주의        → 판정은 그대로, 사유만 기록·표시
 *
 * [BC 데이터 연동]
 * sales.alarms 는 BC카드 월배치의 알람 항목을 담는 자리다. 배치 수신 전에는
 * undefined 이므로 아래 규칙이 조용히 건너뛰어진다. 배치가 들어오면
 * bcData.service 에서 sales.alarms 를 채워 주기만 하면 그대로 동작한다.
 * 각 필드에 대응하는 BC 항목코드명을 주석으로 적어 둔다.
 */

// ── BC 알람 기반 규칙 (배치 수신 시 자동 활성화) ─────────────
// [{ key, level, label, detail }] — sales.alarms[key] 가 truthy 면 발동
const ALARM_RULES = [
  // ── BLOCK : 즉시 차단 ──────────────────────────────────────
  {
    key: 'ownerMismatch', level: 'BLOCK',
    label: '대표자/실소유자 불일치',
    detail: '카드사 FDS에 대표자와 실소유자가 다른 것으로 등재되어 있습니다. (명의대여 의심)',
    // BC: 1개월내 가맹점FDS M_ASS Rule 선정 이력[R06_대표자/실소유자뷸일치]
  },
  {
    key: 'merchantIdError', level: 'BLOCK',
    label: '사업자등록번호 오류 등재',
    detail: '카드사 FDS에 사업자등록번호 오류로 등재된 이력이 있습니다.',
    // BC: 1개월내 가맹점FDS M_ASS Rule 선정 이력[R04_사업자등록번호오류]
  },
  {
    key: 'badMerchantRegistered', level: 'BLOCK',
    label: '카드업권 불량가맹점 등록',
    detail: '최근 12개월 내 카드업권 불량가맹점 정보에 등록된 이력이 있습니다.',
    // BC: 12개월내 카드업권 불량가맹점 정보 등록 이력 건수
  },
  {
    key: 'externalReport', level: 'BLOCK',
    label: '대외기관 수신 적발이력',
    detail: '최근 12개월 내 외부기관 통보에 의한 FDS 적발 이력이 있습니다.',
    // BC: 12개월 내 가맹점FDS 회원제 Rule 적발 이력[5_수동선정, B_대외기관수신]
  },
  {
    key: 'severeTermsViolation', level: 'BLOCK',
    label: '중대한 가맹점 약관 위반 미해제',
    detail: '해제되지 않은 중대한 가맹점 약관 위반 건이 있습니다.',
    // BC: 60개월내 중대한 가맹점 약관 위반 대상 미해제 건수
  },

  // ── HOLD : 보류 (사람이 확인) ──────────────────────────────
  {
    key: 'fdsHighScore10', level: 'HOLD',
    label: 'FDS 고위험 스코어',
    detail: '카드사 FDS 스코어가 고위험 구간(불량률 10% 이상)입니다.',
    // BC: 가맹점FDS스코어고득점_불량률10%이상
  },
  {
    key: 'accidentCode', level: 'HOLD',
    label: '사고코드 등재',
    detail: '최근 6개월 내 신용에 영향을 주는 사고코드가 등재된 이력이 있습니다.',
    // BC: 최근6개월사고코드등재여부
  },
  {
    key: 'abnormalOperationHold', level: 'HOLD',
    label: '비정상운영 입금보류 미해제',
    detail: '비정상운영을 사유로 한 입금보류가 해제되지 않았습니다.',
    // BC: 24개월내 비정상운영으로 인한 입금보류 미해제 건수
  },
  {
    key: 'fraudComplaint', level: 'HOLD',
    label: '가맹점사위 민원 발생',
    detail: '최근 12개월 내 가맹점사위 관련 민원 발생 이력이 있습니다.',
    // BC: 12개월내 가맹점사위 관련 민원 발생 이력 건수
  },
  {
    key: 'overdueHolder', level: 'HOLD',
    label: '고액·다수 연체 보유',
    detail: '카드사 FDS에 고액 또는 다수 연체 보유로 선정된 이력이 있습니다.',
    // BC: 1개월내 …[R01_고액연체보유] / [R02_다수연체보유]
  },
  {
    key: 'chargebackHold', level: 'HOLD',
    label: '역환 입금보류 장기 미해제',
    detail: '역환으로 인한 입금보류가 90일 이상 해제되지 않았습니다.',
    // BC: 24개월 내 역환으로 인한 입금보류 90일이상 경과 미해제 건수
  },

  // ── WATCH : 주의 (판정 유지, 사유만 기록) ──────────────────
  {
    key: 'highCancelRatio', level: 'WATCH',
    label: '취소매출 비중 이상',
    detail: '최근 6개월 취소매출 비중이 정상 범위를 벗어납니다.',
    // BC: 최근6개월 취소매출비율 / 최근6개월취소매입금액
  },
  {
    key: 'highDeclineRatio', level: 'WATCH',
    label: '카드 거절 비율 이상',
    detail: '카드 거래건수 대비 거절건수 비율이 높습니다.',
    // BC: 최근6개월카드거래건수대비거절건수비율
  },
  {
    key: 'corporateCardSkew', level: 'WATCH',
    label: '법인카드 매출 편중',
    detail: '전체 매출에서 법인카드 비중이 이례적으로 높습니다.',
    // BC: 최근6개월법인카드총매출액비중
  },
];

const LEVEL_RANK = { NONE: 0, WATCH: 1, HOLD: 2, BLOCK: 3 };

/**
 * 네거티브 게이트 평가
 *
 * @param {object}   ctx
 * @param {object}   ctx.sales       getSalesData() 결과 (sales.alarms 있으면 BC 규칙 활성화)
 * @param {object}   ctx.salesScore  calcSalesScore() 결과 (riskAlert / subScores)
 * @param {string}   ctx.noDataCase  'A' | 'B' | 'C' | null — 무데이터 3분해 결과
 * @returns {{ level, override, reasons, summary }}
 *          override = 'REJECTED' | 'PENDING' | null  (판정 오버라이드)
 */
function evaluateGate({ sales, salesScore, noDataCase } = {}) {
  const reasons = [];

  // ① BC 알람 기반 규칙 — sales.alarms 미수신 시 전부 건너뜀
  const alarms = sales?.alarms || {};
  for (const rule of ALARM_RULES) {
    if (alarms[rule.key]) {
      reasons.push({ code: rule.key, level: rule.level, label: rule.label, detail: rule.detail, source: 'BC_ALARM' });
    }
  }

  // ② 이상거래 확정 플래그 (기존 동작 유지)
  if (sales?.anomalyFlag) {
    reasons.push({
      code: 'anomalyFlag', level: 'HOLD',
      label: '카드매출 이상거래 감지',
      detail: '카드매출 패턴에 이상이 감지되었습니다. 추가 확인이 필요합니다.',
      source: 'FDS',
    });
  }

  // ③ 가장매출 의심 패턴 (fdsEngine ④) — 2건 이상이면 보류, 1건이면 주의
  //    종전에는 2건 이상(riskAlert)만 판정에 반영되고 1건은 아무 데도 드러나지 않았다.
  const anomalySub = (salesScore?.subScores || []).find(s => s.key === 'anomaly');
  const flags = anomalySub?.flags || [];
  if (flags.length) {
    reasons.push({
      code: 'salesPattern',
      level: salesScore?.riskAlert ? 'HOLD' : 'WATCH',
      label: `가장매출 의심 패턴 ${flags.length}건`,
      detail: flags.join(' / '),
      source: 'FDS',
    });
  }

  // ④ 무데이터 케이스 B — 가맹점 등록은 했으나 6개월 매출 0
  //    카드 미가맹(A)·신규(C)와 달리 이쪽은 적극적으로 의심해야 한다.
  if (noDataCase === 'B') {
    reasons.push({
      code: 'registeredNoSales', level: 'HOLD',
      label: '가맹점 등록 후 매출 없음',
      detail: '카드 가맹점으로 등록되어 있으나 최근 6개월 카드매출이 확인되지 않습니다.',
      source: 'NO_DATA',
    });
  }

  const level = reasons.reduce((max, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[max] ? r.level : max), 'NONE');
  const override = level === 'BLOCK' ? 'REJECTED' : level === 'HOLD' ? 'PENDING' : null;

  const topReasons = reasons.filter(r => r.level === level);
  const summary = level === 'NONE'
    ? '위험 신호 없음'
    : topReasons.map(r => r.label).join(' · ');

  return { level, override, reasons, summary };
}

module.exports = { evaluateGate, ALARM_RULES };
