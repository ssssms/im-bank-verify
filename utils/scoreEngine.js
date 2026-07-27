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
 * [판정 기준]
 *   - APPROVED (승인): 80점 이상 + (FDS 24점+ OR 업력 6개월+) → 한도제한계좌 즉시 해제
 *   - PENDING  (보류): 50~79점 또는 신설(FDS 미정상+업력 부족) → 추가 서류 제출
 *   - REJECTED (거절): 49점 이하 → 영업점 방문
 *   - FDS 이상거래 감지: 점수 무관 PENDING
 */

const { scoreFds } = require('./fdsEngine');

const SCORE_THRESHOLDS = { APPROVED: 80, PENDING: 50 };

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
  if (!licenseResult || !licenseResult.hasLicense) {
    const detail = licenseResult?.detail || '행정인허가 조회 결과 없음';
    const isClosed = licenseResult?.licenseStatus === '폐업';
    return { score: 0, detail, passed: false, warned: !isClosed };
  }
  return {
    score: 20,
    detail: licenseResult.detail || `${licenseResult.licenseType} 영업허가 유효`,
    passed: true,
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
function calcSalesScore(salesResult) {
  if (!salesResult || !salesResult.hasData) {
    return { score: 0, detail: '카드매출 데이터 없음 (가맹점 미운영 또는 신설)', passed: false, subScores: [] };
  }
  if (salesResult.anomalyFlag) {
    return {
      score: 0,
      detail: '카드매출 패턴 이상 감지 — 추가 확인 필요',
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
    passed: fds.score >= 20,
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
    return { score: 0, detail: '체납 이력 확인 — 한도 해제 불가', passed: false };
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
      detail: hometaxResult.detail || `신설 사업자 — 검증 데이터 부족`,
      passed: true,
    };
  }
  return { score: 0, detail: hometaxResult.detail || '홈택스 신고 이력 없음', passed: false };
}

// ── 업력 산출 (연 단위) — APPROVED 분기 판정용 ────────────────
// 제안서 「단계적 추진 전략 — 1차(단기·우선 적용)」 기준:
//   '업력 6개월 이상 + 카드매출 발생' 사업자를 자동해제 대상으로 한다.
const BUSINESS_YEARS_THRESHOLD = 0.5;

function calcBusinessYears(registrationDate) {
  if (!registrationDate) return 0;
  const regDate = new Date(registrationDate);
  if (isNaN(regDate.getTime())) return 0;
  const now = new Date();
  return (now - regDate) / (365.25 * 24 * 60 * 60 * 1000);
}

// ── 판정 ─────────────────────────────────────────────────────
// 가맹점 본질 판정: FDS + 업력
//
// [80점 이상 판정 흐름]
//   FDS 이상거래 감지(anomalyFlag) 또는 가장매출 패턴 2건 이상(riskAlert) → 무조건 PENDING
//   FDS 정상(24/40점 이상) OR 업력 6개월+ → APPROVED (서류 0건)
//   FDS 정상·업력 모두 미충족 → PENDING (신설 사업자 서류)
//   FDS 데이터 없음 + 80점 미달 → 일반 PENDING/REJECTED
const FDS_NORMAL_THRESHOLD = 24; // 40점의 60% — 카드매출 검증 통과 기준

function getVerdict(totalScore, { ntsResult, salesResult, salesScore } = {}) {
  if (salesResult?.anomalyFlag || salesScore?.riskAlert) {
    return {
      verdict: 'PENDING',
      label: '카드매출 패턴 확인 필요',
      description: '카드매출 패턴에 이상이 감지되었습니다. 추가 확인이 필요합니다.',
      color: '#FFB800',
    };
  }

  if (totalScore >= SCORE_THRESHOLDS.APPROVED) {
    const businessYears = calcBusinessYears(ntsResult?.registrationDate);
    const isEstablished = businessYears >= BUSINESS_YEARS_THRESHOLD;
    const fdsNormal = salesResult?.hasData && !salesResult?.anomalyFlag &&
                      (salesScore?.score || 0) >= FDS_NORMAL_THRESHOLD;

    if (fdsNormal || isEstablished) {
      // FDS 정상 또는 업력 충족 → 즉시 해제, 서류 0건 (총점 80+가 보강)
      const reasons = [];
      if (fdsNormal) reasons.push(`카드매출 FDS ${salesScore.score}/40점`);
      if (isEstablished) reasons.push(`업력 ${businessYears.toFixed(1)}년`);
      return {
        verdict: 'APPROVED',
        label: '한도 해제 승인',
        description: `정상 운영 가맹점으로 확인되었습니다. 한도제한계좌가 즉시 해제됩니다. (${reasons.join(' · ')})`,
        color: '#00C3A5',
      };
    } else {
      return {
        verdict: 'PENDING',
        label: '추가 서류 필요',
        description: '점수 기준은 통과했으나, 신설 사업자로 분류되어 실사 서류가 필요합니다.',
        color: '#FFB800',
      };
    }
  } else if (totalScore >= SCORE_THRESHOLDS.PENDING) {
    return {
      verdict: 'PENDING',
      label: '추가 서류 필요',
      description: '일부 검증을 통과하지 못했습니다. 추가 서류를 제출하면 한도 해제가 가능합니다.',
      color: '#FFB800',
    };
  } else {
    return {
      verdict: 'REJECTED',
      label: '비대면 해제 불가',
      description: '검증 기준을 충족하지 못했습니다. 가까운 iM Bank 영업점을 방문해 주세요.',
      color: '#FF4D4F',
    };
  }
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
  const salesScore    = calcSalesScore(sales);

  const totalScore =
    ntsScore.score + locationScore.score + licenseScore.score +
    salesScore.score;

  const businessYears = calcBusinessYears(nts?.registrationDate);

  return {
    totalScore,
    maxScore: 100,
    percentage: totalScore,
    businessYears: businessYears > 0 ? parseFloat(businessYears.toFixed(1)) : null,
    verdict: getVerdict(totalScore, {
      ntsResult: nts,
      salesResult: sales,
      salesScore,
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
    case 4: return calcSalesScore(result);
    default: return { score: 0, detail: '', passed: false };
  }
}

module.exports = { calculateTrustScore, calcStepScore };
