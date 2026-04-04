/**
 * ============================================================
 * 국민연금 사업장 가입자 조회 서비스
 * ============================================================
 * 실제 API: 공공데이터포털 "국민연금공단_가입사업장 정보"
 * 직원의 국민연금 가입 여부를 통해 실제 운영 중인 사업장 여부를 확인합니다.
 * 직원 수가 많을수록 사업 활성도가 높다고 판단합니다.
 */

const axios = require('axios');

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['1234567890', '9876543210', '1111111111', '2222222222']);

// ── Mock 데이터 ───────────────────────────────────────────────
const MOCK_PENSION_DATA = {
  // 우량 사업자: 직원 12명 (30점 만점)
  '1234567890': { employeeCount: 12, insuredSince: '2019-04', monthlyPayment: 1250000 },
  // 중간 사업자: 직원 3명 (10점)
  '9876543210': { employeeCount: 3, insuredSince: '2023-12', monthlyPayment: 320000 },
  // 신설 사업자: 직원 없음 (0점)
  '2222222222': { employeeCount: 0, insuredSince: null, monthlyPayment: 0 },
  // 폐업 사업자: 직원 없음 (0점)
  '1111111111': { employeeCount: 0, insuredSince: null, monthlyPayment: 0 },
};

/**
 * 국민연금 가입 현황 조회 (Mock)
 * @param {string} businessNumber
 * @returns {Promise<object>}
 */
async function getPensionInfo(businessNumber) {
  await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 300));

  const data = MOCK_PENSION_DATA[businessNumber];
  if (!data) {
    // 미등록 번호: 1~3명 랜덤
    const count = Math.floor(Math.random() * 4);
    return { employeeCount: count, insuredSince: '2022-01', monthlyPayment: count * 105000 };
  }
  return data;
}

/**
 * 국민연금공단 사업장 가입자 조회 (Live)
 * 공공데이터포털 → 국민연금공단_가입사업장 정보
 * API URL: https://apis.data.go.kr/B552015/NpsBplcInfoInqireService/getBplcInfoInqire
 */
async function getPensionInfoLive(businessNumber) {
  const serviceKey = process.env.NPS_API_KEY;
  if (!serviceKey) throw new Error('NPS_API_KEY가 설정되지 않았습니다.');

  const response = await axios.get(
    'https://apis.data.go.kr/B552015/NpsBplcInfoInqireService/getBplcInfoInqire',
    {
      params: {
        serviceKey,
        pageNo: 1,
        numOfRows: 1,
        bizrno: businessNumber,  // 사업자등록번호 10자리
        resultType: 'json',
      },
      timeout: 10000,
    }
  );

  const body = response.data?.response?.body ?? response.data?.body;
  const raw  = body?.items?.item;
  const item = Array.isArray(raw) ? raw[0] : raw;

  if (!item) {
    // 가입 내역 없음 → 직원 0명으로 처리
    return { employeeCount: 0, insuredSince: null, monthlyPayment: 0 };
  }

  // mmnTtCnt: 가입자 수 (사업장 기준)
  // applYmd: 적용 시작일 (YYYYMMDD)
  const employeeCount = parseInt(item.mmnTtCnt ?? item.totPsnCnt ?? '0', 10) || 0;
  const rawDate = item.applYmd ?? item.joinYmd ?? '';
  const insuredSince = rawDate.length >= 6
    ? `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}`
    : null;

  return {
    employeeCount,
    insuredSince,
    monthlyPayment: null,  // 납부액은 비공개 API
    companyName: item.wkplNm ?? null,
  };
}

async function getPensionInfoSafe(businessNumber) {
  const key = process.env.NPS_API_KEY || '';
  if (process.env.USE_MOCK !== 'false' || DEMO_NUMBERS.has(businessNumber) || !key || key.startsWith('your_')) {
    const result = await getPensionInfo(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }
  try {
    const result = await getPensionInfoLive(businessNumber);
    return { ...result, dataSource: 'LIVE' };
  } catch (e) {
    console.warn('[국민연금 Live 실패 → Mock 전환]', e.message);
    const result = await getPensionInfo(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }
}

module.exports = { getPensionInfo: getPensionInfoSafe };
