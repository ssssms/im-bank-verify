/**
 * ============================================================
 * 신뢰 점수(Trust Score) 산출 엔진 — 4단계 가맹점 본질 모델
 * ============================================================
 *
 * [점수 체계] 총 100점 (가맹점 결제계좌 유치 본질 반영)
 * ┌────────────────────────────────────┬──────┬──────────────────────────────────┐
 * │ 검증 항목                           │ 최대  │ 기준                              │
 * ├────────────────────────────────────┼──────┼──────────────────────────────────┤
 * │ 1. 기본 검증     (국세청)            │ 20점 │ 계속사업자 여부                    │
 * │ 2. 사업장 위치   (네이버+소진공)     │ 20점 │ 좌표 기반 교차검증                 │
 * │ 3. 영업 인허가   (행정안전부)        │ 20점 │ 업종별 인허가 유효 여부             │
 * │ 4. 카드 FDS      (BC카드)            │ 40점 │ 카드매출 패턴 분석 (가맹점 본질)    │
 * └────────────────────────────────────┴──────┴──────────────────────────────────┘
 *
 * [비중 의도]
 *   - 매장 실재 검증 60점 (국세청 + 위치 + 인허가)
 *   - 카드 결제 검증 40점 (FDS)
 *   - 카드 FDS 40점 = "가맹점 = 카드 결제 받는 매장" 본질 강조 (단일 결제 검증축)
 *
 * [제거 항목]
 *   - 홈택스 매출 (15점): 카드 FDS와 결제검증 중복 → FDS(+10)·인허가(+5)로 재배분 (services/mockHometax.service.js deprecated)
 *   - 건축물대장 (10점): 위치 검증과 중복 (services/mockBuilding.service.js deprecated)
 *   - 국민연금 (10점): 1인 가맹점 사업자 차별 (services/mockPension.service.js deprecated)
 *
 * [판정 기준 — 4종, 2026-09-08] 기준값은 전부 utils/rules.config.js
 *   ① 국세청 비정상(휴·폐업)        → REJECTED
 *   ② 게이트 BLOCK                  → REJECTED
 *   ③ 판단 자격 미충족(eligibility) → INELIGIBLE (카드매출 6개월 이력 없음 → 현행 절차)
 *   ④ 게이트 HOLD                   → PENDING
 *   ⑤ 총점 80+ → APPROVED / 50~79 → PENDING / 49 이하 → REJECTED
 */

const { getRules } = require('./rules.config'); // 상수 캐시 금지 — 각 함수가 매 계산마다 getRules() 를 읽는다
const { scoreFds } = require('./fdsEngine');
const { evaluateGate } = require('./negativeGate');
const { calcBusinessYears } = require('./businessAge');
const { checkEligibility } = require('./eligibility');

// ── 1단계: 국세청 기본 검증 (20점) ────────────────────────────
function calcNtsScore(ntsResult) {
  if (!ntsResult || ntsResult.businessStatus !== 'ACTIVE') {
    const reason = ntsResult?.businessStatus === 'SUSPENDED' ? '휴업 사업자'
                 : ntsResult?.businessStatus === 'CLOSED'    ? '폐업 사업자'
                 : '미등록 또는 확인 불가';
    return { score: 0, detail: `계속사업자 확인 실패 (${reason})`, passed: false };
  }
  return {
    score: 20,
    detail: `계속사업자 확인 완료 (${ntsResult.businessStatusText || '계속사업자'}${ntsResult.companyName ? ' · ' + ntsResult.companyName : ''})`,
    passed: true,
  };
}

// ── 2단계: 사업장 위치 검증 (20점) ────────────────────────────
function calcLocationScore(locationResult, licenseResult) {
  if (!locationResult || !locationResult.matched) {
    return { score: 0, detail: locationResult?.detail || '사업장 위치 확인 불가', passed: false };
  }
  if (locationResult.confidence === 'HIGH') {
    return {
      score: 20,
      detail: `네이버 + 상권정보 DB 교차검증 완료 · ${locationResult.matchedStoreName || ''}`,
      passed: true,
    };
  }
  // SBIZ 교차검증 실패 시 인허가 주소로 교차검증 시도
  if (licenseResult?.hasLicense && licenseResult?.address && locationResult?.address) {
    const locAddr = locationResult.address || '';
    const licAddr = licenseResult.address || '';
    const extractKeys = addr => (addr.match(/[가-힣]+[구동로길읍면리]/g) || []).filter(k => k.length >= 2);
    const locKeys = extractKeys(locAddr);
    const licKeys = extractKeys(licAddr);
    const overlap = locKeys.some(k => licKeys.includes(k));
    if (overlap) {
      return {
        score: 20,
        detail: `네이버 + 행정인허가 주소 교차검증 완료 · ${locationResult.matchedStoreName || ''}`,
        passed: true,
      };
    }
  }
  return {
    score: 12,
    detail: `위치 확인 완료 (단일 소스 · 교차검증 미완료)`,
    passed: true,
  };
}

// ── 3단계: 행정인허가 (20점) ──────────────────────────────────
function calcLicenseScore(licenseResult) {
  // licenseMatch(사업체 특정 결과: score·confidence·reasons·candidates) 는 세부내용 화면 「인허가 사업체 매칭」 패널용으로 그대로 싣는다 (2026-09-11)
  const licenseMatch = licenseResult?.licenseMatch || null;
  if (!licenseResult || !licenseResult.hasLicense) {
    const detail = licenseResult?.detail || '공개된 인허가 데이터에서 일치하는 정보를 확인하지 못했습니다';
    const isClosed = licenseResult?.licenseStatus === '폐업';
    return { score: 0, detail, passed: false, warned: !isClosed, needsReview: !!licenseResult?.needsReview, ...(licenseMatch ? { licenseMatch } : {}) };
  }
  return {
    score: 20,
    detail: licenseResult.detail || `${licenseResult.licenseType} 영업허가 유효`,
    passed: true,
    ...(licenseMatch ? { licenseMatch } : {}),
  };
}

// ── 4단계: 카드 FDS (40점) — BC카드 ──────────────────────────
// 가맹점 본질: 카드 결제 받는 매장. 최근 6개월 매출 시계열 분석.
// FDS 정상 시 기존 서류 5종(부가세·납세증명서·세금계산서·재무제표·공급계약서) 대체.
//
// [채점 방식] 제안서 「카드매출 FDS 상세 기준(40점)」 그대로의 가산제.
//   ① 영업 지속성    10점 : 매출 발생 월수 + 월 매출 발생일수
//   ② 매출 규모·건수 10점 : 월평균 매출건수(최소 월 30건) + 업종 평균 대비 규모
//   ③ 순고객 분산도  15점 : 순고객수 규모 + 순고객수/매출건수 비율 + 추세  ← 최고 배점
//   ④ 이상패턴 페널티 5점 : 급증·특정일 집중·동일금액 반복 탐지 시 건당 -2 (감점형)
//   세부 임계값은 utils/fdsEngine.js 참조.
//
//   0점 : hasData=false (가맹점 미등록·신설) 또는 anomalyFlag=true (이상거래 확정)
//   ④ 감점 4점 이상(패턴 2건 이상) → riskAlert=true → 점수 무관 PENDING 강제
// ── 무데이터 3분해 (2026-08-25 신설) ──────────────────────────
// 종전에는 hasData=false 를 전부 '가맹점 미운영 또는 신설' 한 줄로 뭉쳐 똑같이 0점 처리했다.
// 원인이 셋이고 위험도가 정반대라 구분한다.
//   A. 카드 미가맹    : 가맹점 등록 자체가 없음 + 개업 1년 초과 → B2B 도소매·용역 등.
//   B. 가맹 후 무실적 : 가맹점 등록은 되어 있으나 6개월 매출 0 → 가장 의심. 게이트 HOLD.
//   C. 진짜 신규      : 개업 1년 이내 → 데이터 부족이지 위험신호가 아니다.
//   ※ 2026-09-08 부터 세 경우 모두 판단 자격 미충족(INELIGIBLE) → 현행 절차. noDataCase 는 detail 문구용.

function resolveNoDataCase(salesResult, ntsResult) {
  const RULES = getRules();
  if (!salesResult || salesResult.hasData) return null;
  if (salesResult.merchantRegistered) return 'B';
  const months = calcBusinessYears(ntsResult?.registrationDate) * 12;
  return months <= RULES.NO_DATA_NEW_BUSINESS_MONTHS ? 'C' : 'A';
}

const NO_DATA_DETAIL = {
  A: '카드 가맹점 미등록. 카드 결제를 받지 않는 업종으로 추정',
  B: '카드 가맹점 등록 확인 · 최근 6개월 카드매출 없음. 추가 확인 필요',
  C: '신규 개업. 카드매출 이력이 쌓이기 전 단계',
};

function calcSalesScore(salesResult, ntsResult) {
  const RULES = getRules();
  const noDataCase = resolveNoDataCase(salesResult, ntsResult);
  if (!salesResult || !salesResult.hasData) {
    return {
      score: 0,
      detail: NO_DATA_DETAIL[noDataCase] || '카드매출 데이터 없음',
      passed: false,
      subScores: [],
      noDataCase,
    };
  }
  if (salesResult.anomalyFlag) {
    return {
      score: 0,
      detail: '카드매출 패턴 이상 감지. 추가 확인 필요',
      passed: false,
      anomalyFlag: true,
      subScores: [],
    };
  }

  const fds = scoreFds(salesResult);

  // 표기용 요약 라벨 (꾸준한 매출 / 다양한 고객 등)
  const patternMap = { STEADY: '꾸준한 매출', IRREGULAR: '불규칙 매출', SUDDEN: '급등락 매출' };
  const diversityMap = { DIVERSE: '다양한 고객', CONCENTRATED: '소수 반복 결제' };
  const labels = [patternMap[salesResult.salesPattern], diversityMap[salesResult.customerDiversity]].filter(Boolean);
  const patternNote = labels.length ? ` · ${labels.join(' · ')}` : '';
  const etaxNote = salesResult.dataType === 'CARD_AND_ETAX' ? '카드매출 + 전자세금계산서' : '카드매출';

  return {
    score: fds.score,
    detail: `${etaxNote} 분석 (${fds.summary}${patternNote})`,
    passed: fds.score >= RULES.FDS.PASS_SCORE,
    riskAlert: fds.riskAlert,
    subScores: fds.subScores,
    metrics: fds.metrics,
    monthly: salesResult.monthly || [],
  };
}

// ── [DEPRECATED] 홈택스 매출 (15점) — 4단계 모델에서 제거 ─────────
// ⚠️ 미사용: calculateTrustScore/calcStepScore에서 호출 제거됨. 롤백 대비 함수만 보존.
// 부가세 분기별 신고 + 전자세금계산서 + 체납 여부.
//
// [차등 점수 임계값 — 시연 Q&A 룰북]
//   15점 (NORMAL) : 최근 4분기 모두 부가세 신고 (vatFilingCount = 4)
//                   · 분기당 전자세금계산서 평균 5건 이상 권장
//                   · 체납 없음 (taxArrears = false)
//   7점 (PARTIAL) : 최근 4분기 중 2~3분기만 신고 (vatFilingCount 2~3)
//                   · 또는 직전 분기 대비 매출 50% 이상 급감 의심
//                   · 체납 없음
//   5점 (NEW)     : 1분기만 신고 (vatFilingCount = 1)
//                   · 사업자 등록 후 12개월 미만 (첫 분기 신고만 도래)
//                   · 체납 없음
//   0점 (NONE)    : 신고 이력 전무 (vatFilingCount = 0, hasData=false)
//                   · 또는 체납 이력 (taxArrears=true)
//                     → 점수 무관 PENDING 강제 + "한도 해제 불가"
function calcHometaxScore(hometaxResult) {
  if (!hometaxResult || !hometaxResult.hasData) {
    return { score: 0, detail: hometaxResult?.detail || '홈택스 신고 이력 없음', passed: false };
  }
  if (hometaxResult.taxArrears) {
    return { score: 0, detail: '체납 이력 확인. 한도 해제 불가', passed: false };
  }
  // status: NORMAL(만점 15) / PARTIAL(부분 7) / NEW(신설 5) / NONE(0)
  if (hometaxResult.status === 'NORMAL') {
    return {
      score: 15,
      detail: hometaxResult.detail || `최근 4분기 부가세 신고 정상 · 체납 없음`,
      passed: true,
    };
  }
  if (hometaxResult.status === 'PARTIAL') {
    return {
      score: 7,
      detail: hometaxResult.detail || `부가세 신고 일부 누락 또는 매출 급감 의심`,
      passed: true,
    };
  }
  if (hometaxResult.status === 'NEW') {
    return {
      score: 5,
      detail: hometaxResult.detail || `신설 사업자. 검증 데이터 부족`,
      passed: true,
    };
  }
  return { score: 0, detail: hometaxResult.detail || '홈택스 신고 이력 없음', passed: false };
}

// ── 업력 산출 (연 단위) — utils/businessAge.js 공용 (eligibility 와 같은 함수) ──
// 제안서 「단계적 추진 전략 — 1차(단기·우선 적용)」 기준:
//   '업력 6개월 이상 + 카드매출 발생' 사업자를 자동해제 대상으로 한다.
//   → 2026-09-08 부터 판단 자격(eligibility)으로 승격. 기준값은 rules.config.js

// ── 판정 (4종) ───────────────────────────────────────────────
// [판정 순서 — 2026-09-08 확정]
//   ① 국세청 비정상(휴·폐업)        → REJECTED
//   ② 게이트 BLOCK                  → REJECTED (점수 무관)
//   ③ 판단 자격 미충족(eligibility) → INELIGIBLE (카드매출 6개월 이력 없음 → 현행 절차)
//   ④ 게이트 HOLD                   → PENDING  (점수 무관)
//   ⑤ 총점 ≥ APPROVED_CUT → APPROVED / ≥ PENDING_CUT → PENDING / 그 외 → REJECTED
//
// 삭제된 분기(둘 다 INELIGIBLE 로 흡수):
//   - 「카드 미가맹(noDataCase A) → 매출 증빙 서류로 대체 PENDING」 완화
//   - 「80점 이상이지만 신설이라 실사 서류 PENDING」
//   noDataCase 는 4단계 detail 문구용으로만 남는다.
//
// [nextStep] 판정별 다음 절차. 프론트 NextStep 패널이 그대로 그린다.
//   [2026-09-12] 사람이 개입하는 경로를 현실에 맞춤 — 본부 원격 확인·실사·재검증 예약은 지금 은행 인프라에 없는 절차라 전부 삭제.
//   [2026-09-12 저녁 확정] 이 화면은 앱 비대면 계좌 개설 시 보이지 않게 도는 자동해제 과정을 눈으로 보이게 펼친 것(사용자: "원래는 결과만 나온다.
//   시연이 안 되니 눈에 보이는 서비스처럼 만든 것"). 결과는 둘뿐 — 자동해제 / 서류 지참 영업점 방문(직원이 이 결과와 서류를 보고 판단·부결).
//   nextStep 은 현재형으로 그 결과를 말한다. 본부·실사·재검증 예약·승인부결 기록 같은 없는 인프라는 쓰지 않는다.
//   AUTO_RELEASE         승인 — 즉시 해제, 서류·영업점 방문 없음(앱에서는 개설 직후 이 결과가 바로 적용)
//   REAPPLY_AFTER_REMEDY 보류(자동해제 기준 미달) — 미달 항목 ↔ 지참 서류 표(통과 항목은 다시 안 봄), FDS 패턴 이상은 서류로 대체 불가
//   RELEASE_UNAVAILABLE  거절 — 서류로 바뀌지 않는 사유 + 해소 후 다시 조회
//   REAPPLY_AFTER_MONTHS 보류(카드매출 6개월 미만) — 현행 서류 5종 지참 영업점 방문 + 「빠르면 YYYY년 M월 이후 다시 조회하면 자동해제 대상」(reapplyFrom)

const VERDICT_UI = {
  APPROVED:   { label: '한도 해제 승인',            color: '#00C3A5' },
  PENDING:    { label: '보류 · 자동해제 기준 미달',  color: '#FFB800' },
  REJECTED:   { label: '비대면 해제 불가',          color: '#FF4D4F' },
  INELIGIBLE: { label: '보류 · 카드매출 6개월 미만', color: '#FFB800' },
};

// 현행 절차(영업점 서류 심사) 서류 — INELIGIBLE 에만 붙는다 (영업점이 가까운 신설 사업자가 창구 판단을 받을 때)
const CURRENT_PROCESS_DOCS = [
  '사업자등록증 원본',
  '대표자 신분증',
  '사업장 임대차계약서',
  '부가가치세 과세표준증명원 또는 납세증명서',
  '(전자)세금계산서 또는 매출 증빙 자료',
];

const NO_DOC_SUBSTITUTE = '서류로 대체 불가 · 거래 패턴이 정상화된 뒤 다시 조회';
const LOCATION_REMEDY   = '임대차계약서 또는 간판·매장 사진';

// 보류 시 잃은 점수 단계별 검토 서류 — 영업점 직원이 그 항목만 서류로 확인한다(통과한 항목은 다시 안 봄).
// 등록 서류(사업자등록증·부가세 증명)는 넣지 않는다.
function buildRemedies({ locationScore, licenseScore, salesScore, gate }) {
  const RULES = getRules();
  const remedies = [];
  const sub = key => (salesScore?.subScores || []).find(s => s.key === key);

  if (!locationScore?.passed) {
    remedies.push({ cause: '사업장 위치 미확인', evidence: LOCATION_REMEDY });
  } else if (locationScore.score < 20) {
    remedies.push({ cause: '사업장 위치 교차검증 미완료 (단일 소스만 확인)', evidence: LOCATION_REMEDY });
  }
  if (!licenseScore?.passed) {
    remedies.push({ cause: '영업 인허가 미확인', evidence: '영업신고증(허가증)' });
  }

  const volume = sub('volume');
  if (volume && volume.score < RULES.REMEDY.VOLUME_WEAK_BELOW) {
    remedies.push({
      cause: `카드매출 규모·건수 약함 (${volume.score}/${volume.max}점 · ${volume.detail})`,
      evidence: '세금계산서 발행내역 또는 POS 단말기 설치 확인서',
    });
  }

  const customer = sub('customer');
  const anomaly  = sub('anomaly');
  const causes = [];
  if (customer && customer.score < RULES.REMEDY.CUSTOMER_WEAK_BELOW) {
    causes.push(`순고객 분산 낮음 (${customer.score}/${customer.max}점 · ${customer.detail})`);
  }
  if (anomaly && (anomaly.flags || []).length >= 1) {
    causes.push(`이상패턴 ${anomaly.flags.length}건 (${anomaly.flags.join(' / ')})`);
  }
  if (causes.length) remedies.push({ cause: causes.join(' · '), evidence: NO_DOC_SUBSTITUTE });

  if (gate?.level === 'HOLD') {
    remedies.push({ cause: `위험 신호 보류: ${gate.summary}`, evidence: '서류로 대체 불가 · 신호 해소 후 다시 검증' });
  }
  return remedies;
}

// 다시 신청할 수 있는 시점 — 업력 기준(등록일 + 필수 개월)과 매출 월수 기준(지금 + 부족 개월) 중 늦은 쪽.
// 카드 미가맹은 첫 매출 시점을 알 수 없어 날짜를 내지 않는다(업력 미달이 같이 있으면 그 날짜를 "빠르면" 으로).
function reapplyFrom(elig, ntsResult) {
  const { MIN_BUSINESS_MONTHS, MIN_SALES_MONTHS } = getRules();
  const codes = new Set((elig?.reasons || []).map(r => r.code));
  const candidates = [];
  if (codes.has('NEW_BUSINESS') && ntsResult?.registrationDate) {
    const reg = new Date(ntsResult.registrationDate);
    if (!isNaN(reg.getTime())) {
      reg.setMonth(reg.getMonth() + Math.max(MIN_BUSINESS_MONTHS, MIN_SALES_MONTHS));
      candidates.push(reg);
    }
  }
  if (codes.has('INSUFFICIENT_SALES_MONTHS')) {
    const d = new Date();
    d.setMonth(d.getMonth() + Math.max(1, MIN_SALES_MONTHS - (elig.salesMonths || 0)));
    candidates.push(d);
  }
  if (!candidates.length) return null;
  const d = new Date(Math.max(...candidates.map(c => c.getTime())));
  const y = d.getFullYear(); const m = d.getMonth() + 1;
  return { ym: `${y}-${String(m).padStart(2, '0')}`, label: `${y}년 ${m}월` };
}

function nextStepApproved() {
  return {
    type: 'AUTO_RELEASE',
    title: '자동해제 · 서류·영업점 방문 없음',
    lines: [
      '4단계 검증을 통과해 한도제한계좌가 즉시 해제됩니다. 서류 제출도 영업점 방문도 없습니다.',
      '앱 비대면 계좌 개설 시에는 이 검증이 개설 직후 자동으로 실행되어 이 결과가 바로 적용되고, 고객 연락처로 SMS 알림이 발송됩니다.',
    ],
    remedies: [], docs: [], reverifyAvailable: false,
  };
}

function nextStepPending(ctx) {
  const RULES = getRules();
  const gate = ctx?.gate;
  const first = gate?.level === 'HOLD'
    ? `위험 신호(${gate.summary})가 확인되어 자동해제되지 않습니다. 서류로 대체되지 않는 항목입니다.`
    : `자동해제 기준(${RULES.APPROVED_CUT}점) 미달 항목이 있어 자동해제되지 않습니다. 아래 미달 항목의 서류를 지참해 영업점을 방문하면 직원이 이 결과와 서류를 보고 판단합니다.`;
  return {
    type: 'REAPPLY_AFTER_REMEDY',
    title: '서류 지참 영업점 방문 · 미달 항목만 확인',
    lines: [
      first,
      '이미 통과한 항목은 다시 확인하지 않습니다. 등록 서류(사업자등록증·부가가치세 증명)는 요구하지 않습니다.',
    ],
    remedies: buildRemedies(ctx), docs: [],
  };
}

function nextStepRejected(kind, gate) {
  if (kind === 'NTS_INACTIVE') {
    return {
      type: 'RELEASE_UNAVAILABLE', reasonCode: kind,
      title: '자동해제 불가 · 해제 대상 아님',
      lines: [
        '국세청 사업자등록 상태가 휴업 또는 폐업으로 확인되어 한도 해제 대상이 아닙니다.',
        '영업점을 방문해도 서류로 바뀌지 않는 판정입니다. 실제와 다르면 홈택스에서 사업자등록 상태를 정정한 뒤 다시 조회합니다.',
      ],
      remedies: [], docs: [],
    };
  }
  if (kind === 'GATE_BLOCK') {
    return {
      type: 'RELEASE_UNAVAILABLE', reasonCode: kind,
      title: '자동해제 불가 · 서류로 바뀌지 않음',
      lines: [
        `부정 신호가 확인되어 자동해제되지 않습니다. (${gate?.summary || '위험 신호'})`,
        '영업점을 방문해도 서류로 바뀌지 않는 판정입니다. 직원은 이 사유를 고객에게 설명하고, 해당 신호가 해소된 뒤 다시 조회하면 최신 데이터로 다시 판정됩니다.',
      ],
      remedies: [], docs: [],
    };
  }
  return {
    type: 'RELEASE_UNAVAILABLE', reasonCode: 'SCORE_BELOW_CUT',
    title: '자동해제 불가 · 서류로 바뀌지 않음',
    lines: [
      '자동 검증 기준에 크게 미달해 자동해제되지 않습니다.',
      '영업점을 방문해도 서류로 바뀌지 않는 판정입니다. 매장 실재와 카드매출이 데이터로 확인된 뒤 다시 조회합니다.',
    ],
    remedies: [], docs: [],
  };
}

function nextStepIneligible(eligibility, ntsResult) {
  const RULES = getRules();
  const reasonText = (eligibility?.reasons || []).map(r => r.label).join(' · ') || '카드매출 이력 없음';
  const from = reapplyFrom(eligibility, ntsResult);
  const when = from
    ? `빠르면 ${from.label}부터 카드매출 ${RULES.MIN_SALES_MONTHS}개월이 쌓여 다시 조회하면 자동해제 대상이 될 수 있습니다.`
    : `카드 가맹 후 카드매출이 ${RULES.MIN_SALES_MONTHS}개월 쌓인 뒤 다시 조회하면 자동해제 대상이 될 수 있습니다.`;
  return {
    type: 'REAPPLY_AFTER_MONTHS',
    title: '서류 지참 영업점 방문 · 현행 절차',
    lines: [
      `카드매출 ${RULES.MIN_SALES_MONTHS}개월 이력이 없어 자동으로 판단할 수 없습니다. (사유: ${reasonText})`,
      '현행 절차대로 아래 서류를 지참해 영업점을 방문하면 직원이 매장 실재 3단계(국세청·위치·인허가) 결과와 서류를 보고 판단합니다.',
      when,
    ],
    remedies: [], docs: CURRENT_PROCESS_DOCS.slice(), reapplyFrom: from?.ym || null,
  };
}

function withUi(verdict, extra) {
  return { verdict, ...VERDICT_UI[verdict], ...extra };
}

function getVerdict(totalScore, {
  ntsResult, salesResult, salesScore, gate, locationScore, licenseScore, eligibility,
} = {}) {
  const RULES = getRules();
  const remedyCtx = { locationScore, licenseScore, salesScore, gate };

  // ① 국세청 비정상(휴·폐업·미등록) — 서류로 해결되는 문제가 아니다
  if (!ntsResult || ntsResult.businessStatus !== 'ACTIVE') {
    const status = ntsResult?.businessStatus === 'SUSPENDED' ? '휴업'
                 : ntsResult?.businessStatus === 'CLOSED'    ? '폐업'
                 : '미등록 또는 확인 불가';
    return withUi('REJECTED', {
      description: `국세청 사업자 상태가 ${status}으로 확인되어 한도 해제 대상이 아닙니다.`,
      nextStep: nextStepRejected('NTS_INACTIVE'),
    });
  }

  // ② 네거티브 게이트 BLOCK — 점수 무관 차단
  if (gate?.level === 'BLOCK') {
    return withUi('REJECTED', {
      description: `위험 신호가 확인되었습니다 (${gate.summary}). 자동해제되지 않습니다.`,
      gateLevel: gate.level,
      gateReasons: gate.reasons,
      nextStep: nextStepRejected('GATE_BLOCK', gate),
    });
  }

  // ③ 판단 자격 미충족 — 카드매출 6개월 이력이 없어 실영위를 판단할 수 없다
  const elig = eligibility || checkEligibility({ nts: ntsResult, sales: salesResult });
  if (!elig.eligible) {
    return withUi('INELIGIBLE', {
      description: `카드매출 ${RULES.MIN_SALES_MONTHS}개월 이력이 없어 자동으로 판단할 수 없습니다. 현행 서류를 지참해 영업점을 방문합니다.`,
      reasons: elig.reasons,
      businessMonths: elig.businessMonths,
      salesMonths: elig.salesMonths,
      nextStep: nextStepIneligible(elig, ntsResult),
    });
  }

  // ④ 네거티브 게이트 HOLD — 점수 무관 보류 (신호가 해소되기 전엔 자동해제 안 함)
  if (gate?.level === 'HOLD') {
    return withUi('PENDING', {
      description: `${gate.summary}. 해소 전에는 자동해제되지 않습니다.`,
      gateLevel: gate.level,
      gateReasons: gate.reasons,
      nextStep: nextStepPending(remedyCtx),
    });
  }

  // ⑤ 총점 구간
  if (totalScore >= RULES.APPROVED_CUT) {
    const reasons = [];
    const fdsScore = salesScore?.score || 0;
    if (fdsScore >= RULES.FDS_NORMAL_THRESHOLD) reasons.push(`카드매출 FDS ${fdsScore}/40점`);
    if (elig.businessMonths != null) reasons.push(`업력 ${(elig.businessMonths / 12).toFixed(1)}년`);
    return withUi('APPROVED', {
      description: `정상 운영 가맹점으로 확인되었습니다. 한도제한계좌가 즉시 해제됩니다.${reasons.length ? ` (${reasons.join(' · ')})` : ''}`,
      nextStep: nextStepApproved(),
    });
  }
  if (totalScore >= RULES.PENDING_CUT) {
    return withUi('PENDING', {
      description: `총점 ${totalScore}점. 자동해제 기준(${RULES.APPROVED_CUT}점) 미달 항목이 있어 자동해제되지 않습니다. 미달 항목의 서류를 지참해 영업점을 방문합니다.`,
      nextStep: nextStepPending(remedyCtx),
    });
  }
  return withUi('REJECTED', {
    description: '검증 기준을 충족하지 못했습니다. 자동해제되지 않습니다.',
    nextStep: nextStepRejected('SCORE_BELOW_CUT'),
  });
}

/**
 * 전체 신뢰 점수 산출 (4단계)
 * @param {{ nts, location, license, sales }} allResults
 */
function calculateTrustScore(allResults) {
  const { nts, location, license, sales } = allResults;

  const ntsScore      = calcNtsScore(nts);
  const locationScore = calcLocationScore(location, license);
  const licenseScore  = calcLicenseScore(license);
  const salesScore    = calcSalesScore(sales, nts);

  const totalScore =
    ntsScore.score + locationScore.score + licenseScore.score +
    salesScore.score;

  const businessYears = calcBusinessYears(nts?.registrationDate);

  // 네거티브 게이트 — 점수와 독립된 차단 레이어
  const gate = evaluateGate({ sales, salesScore, noDataCase: salesScore.noDataCase });

  // 판단 자격 — 카드매출 6개월 이력 (점수와 독립)
  const eligibility = checkEligibility({ nts, sales });

  return {
    totalScore,
    maxScore: 100,
    percentage: totalScore,
    businessYears: businessYears > 0 ? parseFloat(businessYears.toFixed(1)) : null,
    gate,
    eligibility,
    verdict: getVerdict(totalScore, {
      ntsResult: nts,
      salesResult: sales,
      salesScore,
      gate,
      locationScore,
      licenseScore,
      eligibility,
    }),
    breakdown: [
      { step: 1, name: '기본 검증',     icon: '🏛️', source: '국세청',                  maxScore: 20, dataSource: nts?.dataSource      || 'MOCK', ...ntsScore },
      { step: 2, name: '사업장 위치',   icon: '📍', source: '네이버 + 소상공인진흥공단', maxScore: 20, dataSource: location?.dataSource || 'MOCK', ...locationScore },
      { step: 3, name: '영업 인허가',   icon: '📋', source: '행정안전부 지방행정인허가', maxScore: 20, dataSource: license?.dataSource  || 'MOCK', ...licenseScore },
      { step: 4, name: '카드 FDS',      icon: '💳', source: 'BC카드 (민간 API 활성화 예정)', maxScore: 40, dataSource: sales?.dataSource    || 'MOCK', ...salesScore },
    ],
  };
}

/**
 * 단계별 점수 개별 계산 (SSE 스트리밍 중간 전송용) — 4단계
 * step: 1=NTS, 2=Location, 3=License, 4=Sales(FDS)
 */
function calcStepScore(stepNumber, result, extraResult) {
  switch (stepNumber) {
    case 1: return calcNtsScore(result);
    case 2: return calcLocationScore(result, extraResult); // extraResult = licenseResult
    case 3: return calcLicenseScore(result);
    case 4: return calcSalesScore(result, extraResult); // extraResult = ntsResult (무데이터 3분해용)
    default: return { score: 0, detail: '', passed: false };
  }
}

module.exports = { calculateTrustScore, calcStepScore, calcBusinessYears, getVerdict };
