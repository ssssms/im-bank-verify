/**
 * ============================================================
 * 신뢰 점수(Trust Score) 산출 엔진 — 6단계 버전
 * ============================================================
 *
 * [점수 체계] 총 100점
 * ┌────────────────────────────────────┬──────┬──────────────────────────────────┐
 * │ 검증 항목                           │ 최대  │ 기준                              │
 * ├────────────────────────────────────┼──────┼──────────────────────────────────┤
 * │ 1. 기본 검증      (국세청)           │ 30점 │ 계속사업자 여부                    │
 * │ 2. 활동성 검증    (국민연금)          │ 10점 │ 직장가입자 수 기반 가점             │
 * │ 3. 실재성 검증    (상권정보/소진공)   │ 15점 │ 좌표 기반 교차검증                 │
 * │ 4. 행정인허가     (행정안전부)        │ 15점 │ 업종별 인허가 유효 여부             │
 * │ 5. 건물현황       (국토교통부)        │ 10점 │ 건축물대장 주소 확인               │
 * │ 6. 금융활동 검증  (BC카드 FDS)       │ 20점 │ 카드매출 패턴 분석 (FDS)           │
 * └────────────────────────────────────┴──────┴──────────────────────────────────┘
 *
 * [판정 기준]
 * - APPROVED (승인): 80점 이상 → 한도제한계좌 즉시 해제
 * - PENDING  (보류): 50~79점  → 추가 서류 제출 요청
 * - REJECTED (거절): 49점 이하 → 비대면 해제 불가, 영업점 방문 안내
 */

const SCORE_THRESHOLDS = { APPROVED: 80, PENDING: 50 };

// ── 1단계: 국세청 기본 검증 ───────────────────────────────────
function calcNtsScore(ntsResult) {
  if (!ntsResult || ntsResult.businessStatus !== 'ACTIVE') {
    const reason = ntsResult?.businessStatus === 'SUSPENDED' ? '휴업 사업자'
                 : ntsResult?.businessStatus === 'CLOSED'    ? '폐업 사업자'
                 : '미등록 또는 확인 불가';
    return { score: 0, detail: `계속사업자 확인 실패 (${reason})`, passed: false };
  }
  return {
    score: 30,
    detail: `계속사업자 확인 완료 (${ntsResult.businessStatusText || '계속사업자'}${ntsResult.companyName ? ' · ' + ntsResult.companyName : ''})`,
    passed: true,
  };
}

// ── 2단계: 국민연금 활동성 검증 (10점) ───────────────────────
function calcPensionScore(pensionResult) {
  if (!pensionResult || !pensionResult.employeeCount) {
    return { score: 0, detail: '국민연금 가입 내역 없음 (1인 사업자 또는 미가입)', passed: false };
  }
  const count = pensionResult.employeeCount;
  if (count >= 10) return { score: 10, detail: `직원 ${count}명 국민연금 가입 확인 (10명 이상)`, passed: true };
  if (count >= 5)  return { score: 7,  detail: `직원 ${count}명 국민연금 가입 확인 (5~9명)`, passed: true };
  if (count >= 1)  return { score: 4,  detail: `직원 ${count}명 국민연금 가입 확인 (1~4명)`, passed: true };
  return { score: 0, detail: '등록 직원 없음', passed: false };
}

// ── 3단계: 상권정보 실재성 검증 ──────────────────────────────
// licenseResult를 받아 인허가 주소로도 교차검증 가능
function calcLocationScore(locationResult, licenseResult) {
  if (!locationResult || !locationResult.matched) {
    return { score: 0, detail: locationResult?.detail || '사업장 위치 확인 불가', passed: false };
  }
  if (locationResult.confidence === 'HIGH') {
    return {
      score: 15,
      detail: `네이버 + 상권정보 DB 교차검증 완료 · ${locationResult.matchedStoreName || ''}`,
      passed: true,
    };
  }
  // SBIZ 교차검증 실패 시 인허가 주소로 교차검증 시도
  if (licenseResult?.hasLicense && licenseResult?.address && locationResult?.address) {
    // 주소에서 구/동 단위 겹치면 교차검증 인정
    const locAddr = locationResult.address || '';
    const licAddr = licenseResult.address || '';
    const extractKeys = addr => (addr.match(/[\uAC00-\uD7A3]+[구동로길읍면리]/g) || []).filter(k => k.length >= 2);
    const locKeys = extractKeys(locAddr);
    const licKeys = extractKeys(licAddr);
    const overlap = locKeys.some(k => licKeys.includes(k));
    if (overlap) {
      return {
        score: 15,
        detail: `네이버 + 행정인허가 주소 교차검증 완료 · ${locationResult.matchedStoreName || ''}`,
        passed: true,
      };
    }
  }
  return {
    score: 9,
    detail: `위치 확인 완료 (단일 소스 · 교차검증 미완료)`,
    passed: true,
  };
}

// ── 4단계: 행정인허가 합법성 검증 ────────────────────────────
function calcLicenseScore(licenseResult) {
  if (!licenseResult || !licenseResult.hasLicense) {
    const detail = licenseResult?.detail || '행정인허가 조회 결과 없음';
    // 폐업으로 인한 말소는 실패, 미취득은 warning
    const isClosed = licenseResult?.licenseStatus === '폐업';
    return { score: 0, detail, passed: false, warned: !isClosed };
  }
  return {
    score: 15,
    detail: licenseResult.detail || `${licenseResult.licenseType} 영업허가 유효`,
    passed: true,
  };
}

// ── 5단계: 건물현황 검증 ──────────────────────────────────────
function calcBuildingScore(buildingResult) {
  if (!buildingResult || !buildingResult.exists) {
    return { score: 0, detail: buildingResult?.detail || '건축물대장 미등재', passed: false };
  }
  if (buildingResult.isCommercial) {
    return {
      score: 10,
      detail: buildingResult.detail || `건축물대장 확인 완료 — ${buildingResult.mainPurpose}`,
      passed: true,
    };
  }
  // 건물은 있지만 주거 전용인 경우 부분 인정
  return {
    score: 5,
    detail: `건물 존재 확인 (${buildingResult.mainPurpose || '용도 미분류'}) — 상업용 아님`,
    passed: false,
  };
}

// ── 6단계: 금융활동 검증 (20점) — BC카드 FDS ────────────────
// 최근 6개월 카드매출 패턴 분석: 거래건수, 거래금액, 고객수(중복제거), 월별 추이
// FDS 정상 시 기존 서류 5종(부가세·납세증명서·세금계산서·재무제표·공급계약서) 대체
function calcSalesScore(salesResult) {
  if (!salesResult || !salesResult.hasData) {
    return { score: 0, detail: '금융 활동 데이터 없음 (매출 이력 미확인)', passed: false };
  }

  // 이상거래 탐지 (BC카드 FDS)
  if (salesResult.anomalyFlag) {
    return {
      score: 0,
      detail: '매출 패턴 이상 감지 — 추가 확인 필요',
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

  if (salesResult.dataType === 'CARD_AND_ETAX') {
    return {
      score: 20,
      detail: `카드매출 + 전자세금계산서 확인 (최근 ${months}개월 · ${avgSales}${patternNote})`,
      passed: true,
    };
  }
  if (salesResult.dataType === 'CARD_ONLY') {
    return {
      score: 14,
      detail: `카드매출 확인 (최근 ${months}개월 · ${avgSales}${patternNote})`,
      passed: true,
    };
  }
  // 기타
  return {
    score: 8,
    detail: salesResult.detail || '보완 데이터 확인',
    passed: true,
  };
}

// ── 업력 산출 (연 단위) ──────────────────────────────────────
const BUSINESS_YEARS_THRESHOLD = 2; // 업력 기준: 2년

function calcBusinessYears(registrationDate) {
  if (!registrationDate) return 0;
  const regDate = new Date(registrationDate);
  if (isNaN(regDate.getTime())) return 0;
  const now = new Date();
  return (now - regDate) / (365.25 * 24 * 60 * 60 * 1000);
}

// ── 판정 ─────────────────────────────────────────────────────
// 대포통장 방지: BC카드 FDS + 국민연금/업력 복합 판정
//
// [80점 이상 판정 흐름]
//   FDS 이상거래 감지 → 무조건 PENDING
//   FDS 정상 + (국민연금 1명+ OR 업력 2년+) → APPROVED (서류 0건)
//   FDS 정상 + 국민연금 0명 + 업력 짧음 → PENDING (신설사업자 서류 2종)
//   카드매출 없음 + 국민연금 0명 + 업력 짧음 → PENDING (서류 제출)
//
// [기존 사업자 서류 대체]
//   BC카드 FDS 최근 6개월 매출 패턴 분석으로
//   부가세과세표준증명원·납세증명서·세금계산서·재무제표·물품공급계약서 5종 대체
function getVerdict(totalScore, { pensionResult, ntsResult, salesResult } = {}) {
  // 매출 이상거래 감지 시 무조건 PENDING
  if (salesResult?.anomalyFlag) {
    return {
      verdict: 'PENDING',
      label: '매출 패턴 확인 필요',
      description: '매출 패턴에 이상이 감지되었습니다. 추가 확인이 필요합니다.',
      color: '#FFB800',
    };
  }

  if (totalScore >= SCORE_THRESHOLDS.APPROVED) {
    const hasEmployees = (pensionResult?.employeeCount || 0) >= 1;
    const businessYears = calcBusinessYears(ntsResult?.registrationDate);
    const isEstablished = businessYears >= BUSINESS_YEARS_THRESHOLD;
    const hasSalesData = salesResult?.hasData && !salesResult?.anomalyFlag;
    const fdsNormal = hasSalesData && salesResult?.salesPattern === 'STEADY' && salesResult?.customerDiversity === 'DIVERSE';

    if (fdsNormal && (hasEmployees || isEstablished)) {
      // 최상: FDS 정상 + (국민연금 OR 업력) → 즉시 해제, 서류 0건
      const reasons = [];
      if (hasEmployees) reasons.push(`국민연금 ${pensionResult.employeeCount}명`);
      if (isEstablished) reasons.push(`업력 ${businessYears.toFixed(1)}년`);
      reasons.push('카드매출 FDS 정상');
      return {
        verdict: 'APPROVED',
        label: '한도 해제 승인',
        description: `모든 검증을 통과했습니다. 한도제한계좌가 즉시 해제됩니다. (${reasons.join(' · ')})`,
        color: '#00C3A5',
      };
    } else if ((hasEmployees || isEstablished) && hasSalesData) {
      // FDS 데이터는 있으나 패턴 미확인 + 국민연금/업력 OK → 승인
      const reason = hasEmployees
        ? `국민연금 ${pensionResult.employeeCount}명 확인`
        : `업력 ${businessYears.toFixed(1)}년 확인`;
      return {
        verdict: 'APPROVED',
        label: '한도 해제 승인',
        description: `모든 검증을 통과했습니다. 한도제한계좌가 즉시 해제됩니다. (${reason})`,
        color: '#00C3A5',
      };
    } else if (hasEmployees || isEstablished) {
      // 카드매출 없지만 국민연금/업력 OK → 승인 (현금 위주 업종)
      const reason = hasEmployees
        ? `국민연금 ${pensionResult.employeeCount}명 확인`
        : `업력 ${businessYears.toFixed(1)}년 확인`;
      return {
        verdict: 'APPROVED',
        label: '한도 해제 승인',
        description: `모든 검증을 통과했습니다. 한도제한계좌가 즉시 해제됩니다. (${reason})`,
        color: '#00C3A5',
      };
    } else {
      // 국민연금 0명 + 업력 짧음 → 신설사업자 서류 필요
      return {
        verdict: 'PENDING',
        label: '추가 서류 필요',
        description: `점수 기준은 통과했으나, 신설 사업자로 분류되어 실사 서류가 필요합니다. (업력 ${businessYears.toFixed(1)}년)`,
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
 * 전체 신뢰 점수 산출
 * @param {{ nts, pension, location, license, building, sales }} allResults
 */
function calculateTrustScore(allResults) {
  const { nts, pension, location, license, building, sales } = allResults;

  const ntsScore      = calcNtsScore(nts);
  const pensionScore  = calcPensionScore(pension);
  const locationScore = calcLocationScore(location, license);
  const licenseScore  = calcLicenseScore(license);
  const buildingScore = calcBuildingScore(building);
  const salesScore    = calcSalesScore(sales);

  const totalScore =
    ntsScore.score + pensionScore.score + locationScore.score +
    licenseScore.score + buildingScore.score + salesScore.score;

  // 업력 정보
  const businessYears = calcBusinessYears(nts?.registrationDate);

  return {
    totalScore,
    maxScore: 100,
    percentage: totalScore,
    businessYears: businessYears > 0 ? parseFloat(businessYears.toFixed(1)) : null,
    verdict: getVerdict(totalScore, {
      pensionResult: pension,
      ntsResult: nts,
      salesResult: sales,
    }),
    breakdown: [
      { step: 1, name: '기본 검증',    icon: '🏛️', source: '국세청',                   maxScore: 30, dataSource: nts?.dataSource      || 'MOCK', ...ntsScore },
      { step: 2, name: '활동성 검증',  icon: '👥', source: '국민연금공단',               maxScore: 10, dataSource: pension?.dataSource   || 'MOCK', ...pensionScore },
      { step: 3, name: '실재성 검증',  icon: '📍', source: '소상공인시장진흥공단',       maxScore: 15, dataSource: location?.dataSource  || 'MOCK', ...locationScore },
      { step: 4, name: '행정인허가',   icon: '📋', source: '행정안전부 지방행정인허가',  maxScore: 15, dataSource: license?.dataSource   || 'MOCK', ...licenseScore },
      { step: 5, name: '건물현황',     icon: '🏢', source: '국토교통부 건축물대장',      maxScore: 10, dataSource: building?.dataSource  || 'MOCK', ...buildingScore },
      { step: 6, name: '금융활동 검증',icon: '💳', source: 'BC카드 FDS',                 maxScore: 20, dataSource: sales?.dataSource     || 'MOCK', ...salesScore },
    ],
  };
}

/**
 * 단계별 점수를 개별적으로 계산 (SSE 스트리밍 중간 전송용)
 */
function calcStepScore(stepNumber, result, extraResult) {
  switch (stepNumber) {
    case 1: return calcNtsScore(result);
    case 2: return calcPensionScore(result);
    case 3: return calcLocationScore(result, extraResult); // extraResult = licenseResult
    case 4: return calcLicenseScore(result);
    case 5: return calcBuildingScore(result);
    case 6: return calcSalesScore(result);
    default: return { score: 0, detail: '', passed: false };
  }
}

module.exports = { calculateTrustScore, calcStepScore };
