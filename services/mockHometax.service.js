/**
 * ============================================================
 * 홈택스 매출 검증 서비스 (Mock)
 * ============================================================
 * 검증 항목:
 *   - 부가세 분기별 신고 이력 (최근 4분기)
 *   - 전자세금계산서 발행 이력
 *   - 납세 이력 (체납 여부)
 *
 * 실연동 시: 홈택스 직접 API는 오픈 API 아님 → 민간 API(CODEF 등) 또는
 *            마이데이터 연동을 통한 활성화 예정. 현재는 시연용 Mock.
 *
 * mockSales.service.js 패턴 참고. 시연 사업자번호별 결과 차별화.
 */

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────
const DEMO_NUMBERS = new Set(['1234567890', '9876543210', '1111111111', '2222222222']);

// ── Mock 데이터 ───────────────────────────────────────────────
// vatFilingCount: 최근 4분기 부가세 신고 횟수 (만점 4회)
// etaxIssueCount: 전자세금계산서 발행 건수 (최근 12개월)
// totalRevenue: 최근 1년 매출 (홈택스 신고 기준)
// taxArrears: 체납 여부 (true = 체납 있음)
// status: 'NORMAL'(정상) / 'PARTIAL'(일부 누락) / 'NEW'(신설 데이터 부족) / 'NONE'(이력 없음)
const MOCK_HOMETAX_DATA = {
  // 우량 사업자: 모든 신고 정상, 체납 없음 → 만점
  '1234567890': {
    hasData: true,
    status: 'NORMAL',
    vatFilingCount: 4,
    vatFilingPeriods: ['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4'],
    etaxIssueCount: 87,
    totalRevenue: 480000000,
    taxArrears: false,
    detail: '최근 4분기 부가세 신고 정상 · 전자세금계산서 87건 · 매출 4.8억 · 체납 없음',
  },
  // 기존 데이터 부족 사업자: 매출 급감 + 신고 누락 → 부분 점수 (PENDING 보호)
  '9876543210': {
    hasData: true,
    status: 'PARTIAL',
    vatFilingCount: 2,
    vatFilingPeriods: ['2025-Q3', '2025-Q4'],
    etaxIssueCount: 8,
    totalRevenue: 38000000,
    taxArrears: false,
    detail: '최근 4분기 중 2분기만 부가세 신고 · 전자세금계산서 8건 · 매출 급감 의심 (3,800만)',
  },
  // 신설 사업자: 신고 이력 1회 (개업 초기) → 부분 점수
  '2222222222': {
    hasData: true,
    status: 'NEW',
    vatFilingCount: 1,
    vatFilingPeriods: ['2025-Q4'],
    etaxIssueCount: 4,
    totalRevenue: 9500000,
    taxArrears: false,
    detail: '신설 사업자 — 부가세 신고 이력 1회 · 전자세금계산서 4건 (검증 데이터 부족)',
  },
  // 폐업 사업자: 신고 이력 없음
  '1111111111': {
    hasData: false,
    status: 'NONE',
    vatFilingCount: 0,
    vatFilingPeriods: [],
    etaxIssueCount: 0,
    totalRevenue: 0,
    taxArrears: false,
    detail: '홈택스 신고 이력 없음',
  },
};

function getMockHometaxData(businessNumber) {
  const data = MOCK_HOMETAX_DATA[businessNumber];
  if (data) return data;
  // 미등록 번호: 임의 생성 (테스트용)
  const filings = Math.floor(Math.random() * 5);
  if (filings === 0) {
    return { hasData: false, status: 'NONE', vatFilingCount: 0, vatFilingPeriods: [], etaxIssueCount: 0, totalRevenue: 0, taxArrears: false, detail: '신고 이력 미확인' };
  }
  return {
    hasData: true,
    status: filings >= 4 ? 'NORMAL' : (filings >= 2 ? 'PARTIAL' : 'NEW'),
    vatFilingCount: filings,
    vatFilingPeriods: Array.from({ length: filings }, (_, i) => `2025-Q${4 - i}`).reverse(),
    etaxIssueCount: filings * (5 + Math.floor(Math.random() * 15)),
    totalRevenue: filings * (10000000 + Math.floor(Math.random() * 80000000)),
    taxArrears: false,
    detail: `최근 4분기 중 ${filings}분기 부가세 신고 (Mock)`,
  };
}

/**
 * 홈택스 매출 정보 조회
 * 현재는 항상 Mock (홈택스 오픈 API 미제공, 민간 API 활성화 예정)
 */
async function getHometaxData(businessNumber) {
  await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 300));
  const result = getMockHometaxData(businessNumber);
  return { ...result, dataSource: 'MOCK' };
}

module.exports = { getHometaxData };
