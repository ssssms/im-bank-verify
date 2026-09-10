/**
 * ============================================================
 * 판정 규칙 — 기본값 + 런타임 오버라이드 (2026-09-08)
 * ============================================================
 *
 * 값을 바꾸면 scoreEngine(판정) · eligibility(판단 자격) · fdsEngine(FDS 40점)에
 * 동시에 반영된다. 기본값(DEFAULTS)은 2026-09-08 이전 동작과 동일하다(점수 변화 0).
 *
 * [구조]
 *   DEFAULTS      : 기본값. 코드에 고정. 절대 직접 수정하지 않는다(deep-freeze).
 *   overrides     : 관리자 패널(routes/admin.js)이 메모리에 올리는 오버라이드. 서버 재시작 시 초기화.
 *   getRules()    : DEFAULTS 에 overrides 를 합쳐 돌려준다. 채점·판정 코드는 모듈 로드 시 상수를
 *                   캐시하지 말고 **매 계산마다** getRules() 를 읽는다.
 *                   결정론 유지: 같은 룰 + 같은 입력 = 같은 결과. 오버라이드가 없으면 DEFAULTS 그대로.
 *
 * [관리자가 조정할 수 있는 키 — ADJUSTABLE]
 *   APPROVED_CUT / PENDING_CUT / MIN_SALES_MONTHS / MIN_BUSINESS_MONTHS  → 최상위 키 그대로
 *   CUSTOMER_MIN / CUSTOMER_RATIO_MIN / TX_MIN → FDS 구간표의 "만점선". 아래 구간은 만점선에
 *     고정 비율을 곱해 만든다(기본값 50/30/15 = 1 · 0.6 · 0.3 이 정확히 그 비율이라 기본 동작 불변).
 *
 * [판정 4종]  APPROVED / PENDING / REJECTED / INELIGIBLE
 * [판정 순서] ① 국세청 비정상 → REJECTED
 *             ② 게이트 BLOCK  → REJECTED
 *             ③ 판단 자격 미충족(eligibility) → INELIGIBLE
 *             ④ 게이트 HOLD   → PENDING
 *             ⑤ 총점 ≥ APPROVED_CUT → APPROVED / ≥ PENDING_CUT → PENDING / 그 외 REJECTED
 */

const DEFAULTS = {
  // ── 총점 구간 ────────────────────────────────────────────
  APPROVED_CUT: 80,   // 이상이면 승인
  PENDING_CUT:  50,   // 이상이면 보류, 미만이면 거절

  // ── 판단 자격(eligibility) — 카드매출 6개월 이력 필수 ────
  MIN_BUSINESS_MONTHS: 6, // 업력(개월). 미만이면 NEW_BUSINESS
  MIN_SALES_MONTHS:    6, // 최근 6개월 중 매출 발생 월수. 미만이면 INSUFFICIENT_SALES_MONTHS

  // ── FDS 정상 기준 (40점 중) — 승인 사유 표기용 ───────────
  FDS_NORMAL_THRESHOLD: 24, // 40점의 60%

  // ── 무데이터 3분해: 개업 후 이 개월수 이내면 '진짜 신규(C)', 초과면 '카드 미가맹(A)' ──
  NO_DATA_NEW_BUSINESS_MONTHS: 12,

  // ── BC카드 실데이터 샘플 → 게이트 WATCH 알람 파생 임계값 (services/bcData.service.js, 2026-09-10) ──
  //   최근6개월 취소매출비율(SC240003) · 카드거래건수 대비 거절건수비율(SC380003) 이 이 값 이상이면
  //   negativeGate 의 highCancelRatio / highDeclineRatio (WATCH — 판정 불변, 사유만 표시)
  BC: {
    CANCEL_RATIO_WATCH:  0.10,
    DECLINE_RATIO_WATCH: 0.10,
  },

  // ── FDS 40점 채점 임계값 (utils/fdsEngine.js) ─────────────
  // tier 표는 [임계값, 점수] 를 위에서부터 탐색한다 (value >= 임계값 이면 그 점수).
  FDS: {
    PASS_SCORE: 20, // breakdown.passed 기준 (40점 중)

    // ① 영업 지속성 10점
    CONTINUITY_MONTHS: [[6, 6], [5, 4], [4, 3], [3, 2], [2, 1]], // 매출 발생 월수 → 최대 6
    CONTINUITY_DAYS:   [[15, 4], [10, 3], [5, 1]],               // 월 매출 발생일수 → 최대 4

    // ② 매출 규모·건수 10점
    VOLUME_TX: [[30, 5], [15, 3], [5, 1]], // 월평균 매출건수 → 최대 5  (만점선 TX_MIN)
    VOLUME_INDUSTRY: {                     // 업종 평균 대비 비율 → 최대 5
      NORMAL_MIN: 0.7, NORMAL_MAX: 1.5, NORMAL_PT: 5, // 정상 범위
      // [2026-09-11] BC 실데이터에서 건강한 매장 5곳이 업종평균 3~4배(BC 는 정수 배수로 제공)라 「과대=가장매출 의심」 1점에 걸렸다.
      //   과대 감점은 직전 달 급증(ANOMALY.SPIKE_RATIO)이 같이 있을 때만. 급증 없이 업종을 상회하면 실적 우수로 보고 ABOVE_PT.
      EXCESS: 2.5, EXCESS_PT: 1,                      // 과대 + 급증 → 가장매출 의심
      ABOVE_PT: 4,                                     // 업종 상회(NORMAL_MAX 초과), 급증 없음
      LOW: 0.4, LOW_PT: 3,
      VERY_LOW: 0.2, VERY_LOW_PT: 1,
    },

    // ③ 순고객 분산도 15점 (최고 배점)
    CUSTOMER_COUNT: [[50, 6], [30, 4], [15, 2]],     // 월평균 순고객수 → 최대 6      (만점선 CUSTOMER_MIN)
    CUSTOMER_RATIO: [[0.5, 6], [0.35, 4], [0.2, 2]], // 순고객수/매출건수 → 최대 6    (만점선 CUSTOMER_RATIO_MIN)
    CUSTOMER_TREND: [[1.0, 3], [0.85, 2], [0.7, 1]], // 최근 3개월/이전 3개월 → 최대 3

    // ④ 이상패턴 페널티 5점 (감점형)
    ANOMALY: {
      BASE: 5,
      PENALTY_PER_FLAG: 2,
      SPIKE_RATIO: 2.5,           // 직전 1개월 매출 / 직전 3개월 평균
      MIN_ACTIVE_DAYS: 3,         // 최소 영업일 이하면 특정일 집중
      REPEATED_AMOUNT_RATIO: 0.4, // 동일 금액 반복 결제 비중
      RISK_ALERT_PENALTY: 4,      // 감점 이 값 이상(패턴 2건+) → riskAlert
    },
  },

  // ── 보류(PENDING) 맞춤 보완 안내 생성 기준 ────────────────
  REMEDY: {
    VOLUME_WEAK_BELOW:   8,  // ② 매출 규모·건수 점수 미만이면 '규모·건수 약함'
    CUSTOMER_WEAK_BELOW: 10, // ③ 순고객 분산도 점수 미만이면 '분산 낮음'
  },

  // ── 자동 재검증 예약 ──────────────────────────────────────
  REVERIFY_AFTER_MONTHS: 1,
};

// ── 관리자가 조정할 수 있는 키 정의 (패널·검증·이력 공용) ─────
// value 는 getRules() 결과에서 읽고(read), 오버라이드는 apply 로 합친다.
// help: 값을 바꾸면 어떤 판정이 영향을 받는지 한 줄.
const ADJUSTABLE = [
  {
    key: 'APPROVED_CUT', label: '승인 컷', unit: '점', min: 1, max: 100, step: 1, integer: true,
    help: '총점이 이 값 이상이면 승인. 낮추면 보류였던 사업자가 승인으로, 높이면 승인이 보류로 바뀔 수 있습니다.',
    read: r => r.APPROVED_CUT, apply: (r, v) => { r.APPROVED_CUT = v; },
  },
  {
    key: 'PENDING_CUT', label: '보류 컷', unit: '점', min: 0, max: 99, step: 1, integer: true,
    help: '총점이 이 값 이상이면 보류, 미만이면 거절. 높이면 보류였던 사업자가 거절로 바뀔 수 있습니다.',
    read: r => r.PENDING_CUT, apply: (r, v) => { r.PENDING_CUT = v; },
  },
  {
    key: 'MIN_SALES_MONTHS', label: '카드매출 필수 월수', unit: '개월', min: 0, max: 12, step: 1, integer: true,
    help: '최근 6개월 중 매출 발생 월수가 이 값 미만이면 판단 불가(영업점 안내). 시연 데이터는 최대 6개월이라 7 이상이면 전부 판단 불가.',
    read: r => r.MIN_SALES_MONTHS, apply: (r, v) => { r.MIN_SALES_MONTHS = v; },
  },
  {
    key: 'MIN_BUSINESS_MONTHS', label: '업력 필수 개월', unit: '개월', min: 0, max: 120, step: 1, integer: true,
    help: '사업자등록 후 개월수가 이 값 미만이면 판단 불가(영업점 안내). 올리면 승인·보류였던 사업자가 판단 불가로 바뀔 수 있습니다.',
    read: r => r.MIN_BUSINESS_MONTHS, apply: (r, v) => { r.MIN_BUSINESS_MONTHS = v; },
  },
  {
    key: 'CUSTOMER_MIN', label: '순고객 기준', unit: '명', min: 1, max: 1000, step: 1, integer: true,
    help: '월평균 순고객수 만점선(6점). 60%·30% 지점에서 4점·2점. 올리면 FDS 점수가 내려가 승인이 보류로 바뀔 수 있습니다.',
    read: r => r.FDS.CUSTOMER_COUNT[0][0],
    apply: (r, v) => { r.FDS.CUSTOMER_COUNT = [[v, 6], [v * 0.6, 4], [v * 0.3, 2]]; },
  },
  {
    key: 'CUSTOMER_RATIO_MIN', label: '고객/건수 비율', unit: '', min: 0.05, max: 1, step: 0.05, integer: false,
    help: '순고객수 ÷ 결제건수 만점선(6점). 70%·40% 지점에서 4점·2점. 올리면 단골 위주 매장의 FDS 점수가 내려갑니다.',
    read: r => r.FDS.CUSTOMER_RATIO[0][0],
    apply: (r, v) => { r.FDS.CUSTOMER_RATIO = [[v, 6], [v * 0.7, 4], [v * 0.4, 2]]; },
  },
  {
    key: 'TX_MIN', label: '월 결제건수 기준', unit: '건', min: 1, max: 1000, step: 1, integer: true,
    help: '월평균 결제건수 만점선(5점). 50%·1/6 지점에서 3점·1점. 올리면 소규모 매장의 FDS 점수가 내려갑니다.',
    read: r => r.FDS.VOLUME_TX[0][0],
    apply: (r, v) => { r.FDS.VOLUME_TX = [[v, 5], [v * 0.5, 3], [v / 6, 1]]; },
  },
];

// ── 런타임 상태 (메모리 · 서버 재시작 시 초기화) ───────────────
const overrides = {};   // { [key]: value } — ADJUSTABLE.key 만 들어온다
const history = [];     // { at, key, from, to } — 감사 추적. 서버 재시작 시 사라진다.

function deepFreeze(obj) {
  Object.values(obj).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(obj);
}
deepFreeze(DEFAULTS);

// 구조적 복제 — 배열·중첩 객체까지 새로 만든다 (DEFAULTS 오염 방지)
function clone(obj) {
  if (Array.isArray(obj)) return obj.map(clone);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = clone(obj[k]);
    return out;
  }
  return obj;
}

/**
 * 현재 유효한 룰 — 기본값 + 오버라이드. 매 계산마다 호출한다.
 * 오버라이드가 없으면 DEFAULTS(불변 객체) 를 그대로 돌려주므로 기존 동작과 100% 같다.
 */
function getRules() {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return DEFAULTS;
  const r = clone(DEFAULTS);
  for (const def of ADJUSTABLE) {
    if (keys.includes(def.key)) def.apply(r, overrides[def.key]);
  }
  return r;
}

// ── 관리자 API 가 쓰는 조작 함수 (routes/admin.js) ────────────

function findDef(key) { return ADJUSTABLE.find(d => d.key === key); }

/** 값 검증 — 형식·범위. 통과하면 정규화된 숫자를, 실패하면 { error } */
function validateValue(def, raw) {
  const v = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(v)) return { error: `${def.label}: 숫자가 아닙니다` };
  if (def.integer && !Number.isInteger(v)) return { error: `${def.label}: 정수여야 합니다` };
  if (v < def.min || v > def.max) return { error: `${def.label}: ${def.min}~${def.max} 범위여야 합니다` };
  return { value: v };
}

/** 관리자 패널용 스냅샷: 조정 가능 키의 현재값·기본값·오버라이드 여부 + 이력 */
function snapshot() {
  const cur = getRules();
  return {
    fields: ADJUSTABLE.map(d => ({
      key: d.key, label: d.label, unit: d.unit, min: d.min, max: d.max, step: d.step, help: d.help,
      value: d.read(cur), defaultValue: d.read(DEFAULTS), overridden: Object.prototype.hasOwnProperty.call(overrides, d.key),
    })),
    history: history.slice().reverse(), // 최근 것이 앞
  };
}

/**
 * 부분 갱신. patch = { key: value, ... }. 전부 검증한 뒤 한 번에 적용한다(하나라도 틀리면 아무것도 안 바꿈).
 * 바뀐 키마다 history 에 { at, key, from, to } 를 남긴다.
 */
function updateRules(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: '본문은 { 키: 값 } 객체여야 합니다' };
  const staged = {};
  for (const [key, raw] of Object.entries(patch)) {
    const def = findDef(key);
    if (!def) return { error: `조정할 수 없는 키: ${key}` };
    const res = validateValue(def, raw);
    if (res.error) return { error: res.error };
    staged[key] = res.value;
  }
  // 교차 검증: 보류 컷 < 승인 컷
  const cur = getRules();
  const nextApproved = staged.APPROVED_CUT ?? cur.APPROVED_CUT;
  const nextPending  = staged.PENDING_CUT  ?? cur.PENDING_CUT;
  if (nextPending >= nextApproved) return { error: `보류 컷(${nextPending})은 승인 컷(${nextApproved})보다 작아야 합니다` };

  const at = new Date().toISOString();
  const changed = [];
  for (const [key, value] of Object.entries(staged)) {
    const def = findDef(key);
    const from = def.read(cur);
    if (from === value) continue; // 같은 값이면 이력 없음
    overrides[key] = value;
    history.push({ at, key, label: def.label, from, to: value });
    changed.push(key);
  }
  return { changed, ...snapshot() };
}

/** 전부 기본값으로. 되돌린 키마다 이력을 남긴다. */
function resetRules() {
  const cur = getRules();
  const at = new Date().toISOString();
  const changed = [];
  for (const def of ADJUSTABLE) {
    if (!Object.prototype.hasOwnProperty.call(overrides, def.key)) continue;
    const from = def.read(cur);
    const to = def.read(DEFAULTS);
    delete overrides[def.key];
    if (from !== to) history.push({ at, key: def.key, label: def.label, from, to, reset: true });
    changed.push(def.key);
  }
  return { changed, ...snapshot() };
}

module.exports = {
  getRules,
  DEFAULTS,
  ADJUSTABLE,
  snapshot,
  updateRules,
  resetRules,
};
