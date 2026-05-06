/**
 * ============================================================
 * 보완 검증 서비스 (카드매출 Mock + 행정인허가 Live)
 * ============================================================
 * Live: 행정안전부 지방행정인허가데이터 (localdata.go.kr)
 *   → 상호명으로 영업신고/허가 유효 여부 확인
 *   → 음식점·미용·세탁·이용 등 인허가 업종 대상
 *
 * Mock: 카드매출/전자세금계산서 시연용 데이터
 *   → LOCALDATA_API_KEY 없거나 USE_MOCK=true 시 사용
 */

const axios = require('axios');

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['1234567890', '9876543210', '1111111111', '2222222222']);

// ── 인허가 업종 서비스 코드 (localdata.go.kr) ─────────────────
const LICENSE_CODES = [
  { code: 'GR0', name: '일반음식점' },
  { code: 'GR1', name: '휴게음식점' },
  { code: 'GR2', name: '제과점영업' },
  { code: 'LA0', name: '미용업' },
  { code: 'LB0', name: '이용업' },
  { code: 'LC0', name: '세탁업' },
  { code: 'LD0', name: '목욕장업' },
  { code: 'LF0', name: '안경업' },
];

// ── Mock 데이터 ───────────────────────────────────────────────
// BC카드 매출 패턴 분석 필드 포함 (연동 완료 시 실데이터로 대체)
//   salesPattern: 'STEADY'(꾸준) / 'IRREGULAR'(불규칙) / 'SUDDEN'(급등락)
//   customerDiversity: 'DIVERSE'(다양한 고객) / 'CONCENTRATED'(소수 반복)
//   industryAvgRatio: 업종 평균 대비 매출 비율 (1.0 = 평균)
//   anomalyFlag: 이상거래 의심 여부
const MOCK_SALES_DATA = {
  '1234567890': {
    hasData: true, dataType: 'CARD_AND_ETAX', recentMonths: 6,
    avgMonthlySales: 12500000, etaxCount: 24,
    salesPattern: 'STEADY', customerDiversity: 'DIVERSE',
    industryAvgRatio: 1.1, anomalyFlag: false,
    // FDS 분석 (최근 6개월): 월평균 거래 180건, 고객(카드) 162명(중복제거), 고객비율 90%
  },
  // 기존 데이터 부족 사업자: 카드매출 부분 (불규칙 + 소수 반복) → 부분 점수 (PENDING 보호)
  '9876543210': {
    hasData: true, dataType: 'CARD_ONLY', recentMonths: 6,
    avgMonthlySales: 2500000, etaxCount: 0,
    salesPattern: 'IRREGULAR', customerDiversity: 'CONCENTRATED',
    industryAvgRatio: 0.45, anomalyFlag: false,
    // FDS 분석: 영세 매출 + 소수 반복 결제 (단골 위주) → 데이터 부족 의심
  },
  // 신설 사업자: 매출 데이터 없음 (개업 초기)
  '2222222222': {
    hasData: false, dataType: 'NONE', recentMonths: 0,
    avgMonthlySales: 0, etaxCount: 0,
    salesPattern: null, customerDiversity: null,
    industryAvgRatio: null, anomalyFlag: false,
  },
  '1111111111': {
    hasData: false, dataType: 'NONE', recentMonths: 0,
    avgMonthlySales: 0, etaxCount: 0,
    salesPattern: null, customerDiversity: null,
    industryAvgRatio: null, anomalyFlag: false,
  },
};

function getMockSalesData(businessNumber) {
  const data = MOCK_SALES_DATA[businessNumber];
  if (!data) {
    const hasData = Math.random() > 0.5;
    return {
      hasData,
      dataType: hasData ? 'CARD_ONLY' : 'NONE',
      recentMonths: hasData ? 6 : 0,
      avgMonthlySales: hasData ? Math.floor(Math.random() * 5000000) + 500000 : 0,
      etaxCount: hasData ? Math.floor(Math.random() * 10) : 0,
      salesPattern: hasData ? 'STEADY' : null,
      customerDiversity: hasData ? 'DIVERSE' : null,
      industryAvgRatio: hasData ? (0.7 + Math.random() * 0.6) : null,
      anomalyFlag: false,
    };
  }
  return data;
}

// ── data.go.kr 행정안전부 인허가 API로 영업 활동 확인 ─────────
async function getLicenseLive(storeName) {
  const serviceKey = process.env.LICENSE_API_KEY || process.env.NTS_API_KEY;
  if (!serviceKey) throw new Error('LICENSE_API_KEY 미설정');

  const url = `https://apis.data.go.kr/1741000/general_restaurants/info`
    + `?serviceKey=${encodeURIComponent(serviceKey)}`
    + `&perPage=5&page=1&returnType=json`
    + `&cond%5BBPLC_NM%3A%3ALIKE%5D=${encodeURIComponent(storeName)}`;

  const res = await axios.get(url, { timeout: 8000 });
  const items = res.data?.response?.body?.items?.item;
  if (!items) {
    return { hasData: false, dataType: 'LICENSE_NOT_FOUND', recentMonths: 0, avgMonthlySales: 0, etaxCount: 0 };
  }

  const list = Array.isArray(items) ? items : [items];
  const active = list.find(i => i.DTL_SALS_STTS_NM === '영업') || list[0];
  const isActive = active.DTL_SALS_STTS_NM === '영업';

  if (isActive) {
    return {
      hasData: true,
      dataType: 'LICENSE',
      recentMonths: 0,
      avgMonthlySales: 0,
      etaxCount: 0,
      licenseType: '일반음식점',
      licenseStatus: '영업중',
      licenseDate: active.LCPMT_YMD || '',
      address: active.ROAD_NM_ADDR || active.LOTNO_ADDR || '',
    };
  }

  return { hasData: false, dataType: 'LICENSE_NOT_FOUND', recentMonths: 0, avgMonthlySales: 0, etaxCount: 0 };
}

// ── 외부 노출 함수 ────────────────────────────────────────────
async function getSalesData(businessNumber, storeName) {
  await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 300));

  // 금융활동(카드매출/전자세금계산서)은 카드사 제휴 전용 — 공공 API 없음
  // 항상 Mock 사용
  const useLive = false;

  if (!useLive) {
    const result = getMockSalesData(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }

  try {
    const result = await getLicenseLive(storeName);
    return { ...result, dataSource: 'LIVE' };
  } catch (e) {
    console.warn('[인허가 Live 실패 → Mock 전환]', e.message);
    const result = getMockSalesData(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }
}

module.exports = { getSalesData };
