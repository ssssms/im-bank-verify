/**
 * ============================================================
 * 신뢰 점수(Trust Score) 산출 엔진 — 5단계 가맹점 본질 모델
 * ============================================================
 *
 * [점수 체계] 총 100점 (가맹점 결제계좌 유치 본질 반영)
 * ┌────────────────────────────────────┬──────┬──────────────────────────────────┐
 * │ 검증 항목                           │ 최대  │ 기준                              │
 * ├────────────────────────────────────┼──────┼──────────────────────────────────┤
 * │ 1. 기본 검증     (국세청)            │ 20점 │ 계속사업자 여부                    │
 * │ 2. 사업장 위치   (네이버+소진공)     │ 20점 │ 좌표 기반 교차검증                 │
 * │ 3. 영업 인허가   (행정안전부)        │ 15점 │ 업종별 인허가 유효 여부             │
 * │ 4. 카드 FDS      (BC카드)            │ 30점 │ 카드매출 패턴 분석 (가맹점 본질)    │
 * │ 5. 홈택스 매출   (국세청)            │ 15점 │ 부가세 신고·세금계산서·체납         │
 * └────────────────────────────────────┴──────┴──────────────────────────────────┘
 *
 * [비중 의도]
 *   - 매장 실재 검증 55점 (국세청 + 위치 + 인허가)
 *   - 카드 결제 검증 45점 (FDS + 홈택스)
 *   - 카드 FDS 30점 = "가맹점 = 카드 결제 받는 매장" 본질 강조
 *
 * [제거 항목]
 *   - 건축물대장 (10점): 위치 검증과 중복 (services/mockBuilding.service.js deprecated)
 *   - 국민연금 (10점): 1인 가맹점 사업자 차별 (services/mockPension.service.js deprecated)
 *
 * [판정 기준]
 *   - APPROVED (승인): 80점 이상 + FDS 정상 → 한도제한계좌 즉시 해제
 *   - PENDING  (보류): 50~79점 또는 FDS 미정상 → 추가 서류 제출
 *   - REJECTED (거절): 49점 이하 → 영업점 방문
 *   - FDS 이상거래 감지: 점수 무관 PENDING
 */

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

// ── 3단계: 행정인허가 (15점) ──────────────────────────────────
function calcLicenseScore(licenseResult) {
  if (!licenseResult || !licenseResult.hasLicense) {
    const detail = licenseResult?.detail || '행정인허가 조회 결과 없음';
    const isClosed = licenseResult?.licenseStatus === '폐업';
    return { score: 0, detail, passed: false, warned: !isClosed };
  }
  return {
    score: 15,
    detail: licenseResult.detail || `${licenseResult.licenseType} 영업허가 유효`,
    passed: true,
  };
}

// ── 4단계: 카드 FDS (30점) — BC카드 ──────────────────────────
// 가맹점 본질: 카드 결제 받는 매장. 최근 6개월 매출 패턴 분석.
// FDS 정상 시 기존 서류 5종(부가세·납세증명서·세금계산서·재무제표·공급계약서) 대체.
//
// [차등 점수 임계값 — 시연 Q&A 룰북]
//   30점 (만점)  : CARD_AND_ETAX + STEADY + DIVERSE
//                  · 카드매출 + 전자세금계산서 둘 다 발행
//                  · 월별 매출 변동계수(CV) ≤ 20%       → STEADY
//                  · 고유 고객수 / 결제건수 ≥ 70%        → DIVERSE
//                  · 업종 평균 매출의 70~150% 범위
//   24점 (양호)  : CARD_ONLY + STEADY + DIVERSE
//                  · 카드매출만, 세금계산서 없음 (B2C 전형: 카페/미용실)
//                  · 감점 -6 = 매출 교차검증 1축 부족
//   16점 (주의)  : CARD_* + (IRREGULAR/SUDDEN OR CONCENTRATED)
//                  · 변동계수 20~50% → IRREGULAR / >50% → SUDDEN
//                  · 또는 고객 비율 < 30% (단골 위주)    → CONCENTRATED
//   8점 (최소)   : 위 분류에 안 맞는 보완 케이스
//   0점 (거절)   : hasData=false (가맹점 미등록) 또는 anomalyFlag=true (이상거래)
//                  · anomalyFlag=true → 점수 무관 PENDING 강제 (verdict 단계)
function calcSalesScore(salesResult) {
  if (!salesResult || !salesResult.hasData) {
    return { score: 0, detail: '카드매출 데이터 없음 (가맹점 미운영 또는 신설)', passed: false };
  }
  if (salesResult.anomalyFlag) {
    return {
      score: 0,
      detail: '카드매출 패턴 이상 감지 — 추가 확인 필요',
      passed: false,
      anomalyFlag: true,
    };
  }

  let patternNote = '';
  if (salesResult.salesPattern) {
    const patternMap = { STEADY: '꾸준한 매출', IRREGULAR: '불규칙 매출', SUDDEN: '급등락 매출' };
    const diversityMap = { DIVERSE: '다양한 고객', CONCENTRATED: '소수 반복 결제' };
    const parts = [];
    if (patternMap[salesResult.salesPattern]) parts.push(patternMap[salesResult.salesPattern]);
    if (diversityMap[salesResult.customerDiversity]) parts.push(diversityMap[salesResult.customerDiversity]);
    if (parts.length > 0) patternNote = ` · ${parts.join(' · ')}`;
  }

  const months = salesResult.recentMonths || 6;
  const avgSales = salesResult.avgMonthlySales
    ? `월평균 ${(salesResult.avgMonthlySales / 10000).toFixed(0)}만원`
    : '확인';

  // 만점 (30점): STEADY + DIVERSE + (CARD_AND_ETAX)
  const isOptimal = salesResult.salesPattern === 'STEADY' && salesResult.customerDiversity === 'DIVERSE';
  if (salesResult.dataType === 'CARD_AND_ETAX' && isOptimal) {
    return {
      score: 30,
      detail: `카드매출 + 전자세금계산서 정상 (최근 ${months}개월 · ${avgSales}${patternNote})`,
      passed: true,
    };
  }
  // 양호 (24점): CARD_ONLY + STEADY + DIVERSE
  if (salesResult.dataType === 'CARD_ONLY' && isOptimal) {
    return {
      score: 24,
      detail: `카드매출 정상 (최근 ${months}개월 · ${avgSales}${patternNote})`,
      passed: true,
    };
  }
  // 부분 (16점): 데이터 있으나 패턴 불규칙 (IRREGULAR/CONCENTRATED 등)
  if (salesResult.dataType === 'CARD_AND_ETAX' || salesResult.dataType === 'CARD_ONLY') {
    return {
      score: 16,
      detail: `카드매출 확인 (최근 ${months}개월 · ${avgSales}${patternNote})`,
      passed: true,
    };
  }
  // 기타 (8점)
  return {
    score: 8,
    detail: salesResult.detail || '보완 데이터 확인',
    passed: true,
  };
}

// ── 5단계: 홈택스 매출 (15점) — 신규 ──────────────────────────
// 부가세 분기별 신고 + 전자세금계산서 + 체납 여부.
// 실연동: 홈택스 오픈 API 미제공 → 민간 API(CODEF 등) 활성화 예정.
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
const BUSINESS_YEARS_THRESHOLD = 2;

function calcBusinessYears(registrationDate) {
  if (!registrationDate) return 0;
  const regDate = new Date(registrationDate);
  if (isNaN(regDate.getTime())) return 0;
  const now = new Date();
  return (now - regDate) / (365.25 * 24 * 60 * 60 * 1000);
}

// ── 판정 ─────────────────────────────────────────────────────
// 가맹점 본질 판정: FDS + 홈택스 + 업력
//
// [80점 이상 판정 흐름]
//   FDS 이상거래 감지 → 무조건 PENDING
//   FDS 정상(STEADY+DIVERSE) + (홈택스 NORMAL OR 업력 2년+) → APPROVED (서류 0건)
//   FDS 정상 + 홈택스/업력 미충족 → PENDING (신설 사업자 서류 2종)
//   FDS 데이터 없음 + 80점 미달 → 일반 PENDING/REJECTED
function getVerdict(totalScore, { ntsResult, salesResult, hometaxResult } = {}) {
  if (salesResult?.anomalyFlag) {
    return {
      verdict: 'PENDING',
      label: '카드매출 패턴 확인 필요',
      description: '카드매출 패턴에 이상이 감지되었습니다. 추가 확인이 필요합니다.',
      color: '#FFB800',
    };
  }
  if (hometaxResult?.taxArrears) {
    return {
      verdict: 'PENDING',
      label: '체납 확인 필요',
      description: '홈택스 체납 이력이 확인되었습니다. 영업점 추가 확인이 필요합니다.',
      color: '#FFB800',
    };
  }

  if (totalScore >= SCORE_THRESHOLDS.APPROVED) {
    const businessYears = calcBusinessYears(ntsResult?.registrationDate);
    const isEstablished = businessYears >= BUSINESS_YEARS_THRESHOLD;
    const fdsNormal = salesResult?.hasData && !salesResult?.anomalyFlag &&
                      salesResult?.salesPattern === 'STEADY' && salesResult?.customerDiversity === 'DIVERSE';
    const hometaxNormal = hometaxResult?.hasData && hometaxResult?.status === 'NORMAL';

    if (fdsNormal && (hometaxNormal || isEstablished)) {
      // 최상: FDS 정상 + (홈택스 정상 OR 업력) → 즉시 해제, 서류 0건
      const reasons = ['카드매출 FDS 정상'];
      if (hometaxNormal) reasons.push('홈택스 신고 정상');
      if (isEstablished) reasons.push(`업력 ${businessYears.toFixed(1)}년`);
      return {
        verdict: 'APPROVED',
        label: '한도 해제 승인',
        description: `정상 운영 가맹점으로 확인되었습니다. 한도제한계좌가 즉시 해제됩니다. (${reasons.join(' · ')})`,
        color: '#00C3A5',
      };
    } else if (fdsNormal || hometaxNormal || isEstablished) {
      // FDS 또는 홈택스 또는 업력 중 하나라도 OK → 승인 (총점이 80이라는 점이 보강)
      const reasons = [];
      if (fdsNormal) reasons.push('카드매출 FDS 정상');
      if (hometaxNormal) reasons.push('홈택스 신고 정상');
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
 * 전체 신뢰 점수 산출 (5단계)
 * @param {{ nts, location, license, sales, hometax }} allResults
 */
function calculateTrustScore(allResults) {
  const { nts, location, license, sales, hometax } = allResults;

  const ntsScore      = calcNtsScore(nts);
  const locationScore = calcLocationScore(location, license);
  const licenseScore  = calcLicenseScore(license);
  const salesScore    = calcSalesScore(sales);
  const hometaxScore  = calcHometaxScore(hometax);

  const totalScore =
    ntsScore.score + locationScore.score + licenseScore.score +
    salesScore.score + hometaxScore.score;

  const businessYears = calcBusinessYears(nts?.registrationDate);

  return {
    totalScore,
    maxScore: 100,
    percentage: totalScore,
    businessYears: businessYears > 0 ? parseFloat(businessYears.toFixed(1)) : null,
    verdict: getVerdict(totalScore, {
      ntsResult: nts,
      salesResult: sales,
      hometaxResult: hometax,
    }),
    breakdown: [
      { step: 1, name: '기본 검증',     icon: '🏛️', source: '국세청',                  maxScore: 20, dataSource: nts?.dataSource      || 'MOCK', ...ntsScore },
      { step: 2, name: '사업장 위치',   icon: '📍', source: '네이버 + 소상공인진흥공단', maxScore: 20, dataSource: location?.dataSource || 'MOCK', ...locationScore },
      { step: 3, name: '영업 인허가',   icon: '📋', source: '행정안전부 지방행정인허가', maxScore: 15, dataSource: license?.dataSource  || 'MOCK', ...licenseScore },
      { step: 4, name: '카드 FDS',      icon: '💳', source: 'BC카드 (민간 API 활성화 예정)', maxScore: 30, dataSource: sales?.dataSource    || 'MOCK', ...salesScore },
      { step: 5, name: '홈택스 매출',   icon: '🧾', source: '홈택스 (민간 API 활성화 예정)', maxScore: 15, dataSource: hometax?.dataSource  || 'MOCK', ...hometaxScore },
    ],
  };
}

/**
 * 단계별 점수 개별 계산 (SSE 스트리밍 중간 전송용) — 5단계
 * step: 1=NTS, 2=Location, 3=License, 4=Sales(FDS), 5=Hometax
 */
function calcStepScore(stepNumber, result, extraResult) {
  switch (stepNumber) {
    case 1: return calcNtsScore(result);
    case 2: return calcLocationScore(result, extraResult); // extraResult = licenseResult
    case 3: return calcLicenseScore(result);
    case 4: return calcSalesScore(result);
    case 5: return calcHometaxScore(result);
    default: return { score: 0, detail: '', passed: false };
  }
}

module.exports = { calculateTrustScore, calcStepScore };
