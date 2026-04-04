/**
 * ============================================================
 * [6단계] 건물현황 검증 서비스 (국토교통부 건축물대장)
 * ============================================================
 * 실제 API: 국토교통부 건축물대장 정보 서비스
 * 엔드포인트: https://apis.data.go.kr/1613000/BldRgstService_v2/getBrTitleInfo
 *
 * 사업자가 신고한 주소에 실제 건물이 존재하는지,
 * 해당 건물의 용도가 상업/사무용인지 확인합니다.
 *
 * [건물 용도 코드]
 * 02000: 공동주택 (아파트 등)
 * 03000: 제1종근린생활시설 (소매점, 휴게음식점 등)
 * 04000: 제2종근린생활시설 (일반음식점 등)
 * 07000: 판매시설
 * 10000: 교육연구시설
 * 14000: 업무시설 (오피스)
 *
 * [검증 로직]
 * - 건물 존재: 사업장 주소의 건물이 건축물대장에 등재되어 있는지
 * - 용도 적합성: 상업·업무 용도인지 (주거 전용이면 감점)
 * - 면적 확인: 사업장 규모 적정성 간접 확인
 */

const axios = require('axios');

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['1234567890', '9876543210', '1111111111', '2222222222']);

// ── Mock 데이터 ───────────────────────────────────────────────
const MOCK_BUILDING_DATA = {
  // 시나리오 A: 상업용 건물 — 제2종근린생활시설 (식당에 적합)
  '1234567890': {
    exists: true,
    mainPurpose: '제2종근린생활시설',
    purposeCode: '04000',
    isCommercial: true,
    floorArea: 185.4,       // ㎡
    totalFloors: 5,
    address: '서울특별시 강남구 테헤란로 123',
    approvalDate: '2005-08-12',
    detail: '건축물대장 확인 완료 — 제2종근린생활시설 (일반음식점 적합 용도)',
  },
  // 시나리오 B: 건물 있음, 주거+상업 복합 (소규모 사업장)
  '9876543210': {
    exists: true,
    mainPurpose: '제1종근린생활시설',
    purposeCode: '03000',
    isCommercial: true,
    floorArea: 62.1,
    totalFloors: 2,
    address: '경기도 성남시 분당구 판교로 45',
    approvalDate: '2012-04-03',
    detail: '건축물대장 확인 완료 — 제1종근린생활시설 (소형 사업장)',
  },
  // 시나리오 C: 건물 정보 없음 (폐업 후 등재 말소 또는 주소 불일치)
  '1111111111': {
    exists: false,
    mainPurpose: null,
    purposeCode: null,
    isCommercial: false,
    floorArea: null,
    totalFloors: null,
    address: null,
    approvalDate: null,
    detail: '건축물대장 미등재 — 사업장 주소 확인 불가',
  },
};

// ── Mock 조회 ─────────────────────────────────────────────────
async function getBuildingInfoMock(businessNumber) {
  await new Promise(r => setTimeout(r, 600 + Math.random() * 400));

  const data = MOCK_BUILDING_DATA[businessNumber];
  if (!data) {
    const exists = Math.random() > 0.2;
    return {
      exists,
      mainPurpose: exists ? '제2종근린생활시설' : null,
      purposeCode: exists ? '04000' : null,
      isCommercial: exists,
      floorArea: exists ? Math.floor(Math.random() * 200 + 50) : null,
      totalFloors: exists ? Math.floor(Math.random() * 8 + 1) : null,
      address: exists ? '서울특별시 중구 명동 1' : null,
      approvalDate: exists ? '2010-06-15' : null,
      detail: exists
        ? '건축물대장 확인 완료 — 상업용 건물'
        : '건축물대장 미등재 — 주소 확인 불가',
    };
  }
  return data;
}

// ── Live 조회 (국토교통부 건축HUB 건축물대장 API) ────────────
const { parseAddressToCode } = require('../utils/addressCodes');

// ── bjdongCd 캐시 (한번 찾으면 저장) ──────────────────────────
const dongCodeCache = {};

/**
 * 지번 주소에서 동 이름을 추출하고, bjdongCd를 찾음
 * 5개씩 배치 요청 (Rate Limit 방지)
 */
async function findBjdongCd(serviceKey, sigunguCd, dongName) {
  if (!dongName) return null;

  // 캐시 확인
  const cacheKey = `${sigunguCd}_${dongName}`;
  if (dongCodeCache[cacheKey]) return dongCodeCache[cacheKey];

  // 5개씩 배치로 10100~13000 범위 탐색
  for (let start = 10100; start <= 13000; start += 500) {
    const batch = [];
    for (let code = start; code < start + 500 && code <= 13000; code += 100) {
      batch.push(String(code));
    }

    const results = await Promise.allSettled(
      batch.map(code =>
        axios.get('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo', {
          params: { serviceKey, sigunguCd, bjdongCd: code, numOfRows: 1, pageNo: 1, _type: 'json' },
          timeout: 5000,
        }).then(r => {
          const item = r.data?.response?.body?.items?.item;
          const rec = Array.isArray(item) ? item[0] : item;
          return rec?.platPlc?.includes(dongName) ? code : null;
        })
      )
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        dongCodeCache[cacheKey] = r.value;  // 캐시 저장
        return r.value;
      }
    }
  }
  return null;
}

async function getBuildingInfoLive(address) {
  const serviceKey = process.env.MOLIT_API_KEY;
  if (!serviceKey || serviceKey.startsWith('your_')) {
    throw new Error('MOLIT_API_KEY 미설정');
  }

  const codes = parseAddressToCode(address);
  if (!codes || !codes.sigunguCd) {
    throw new Error('주소에서 시군구코드 추출 실패: ' + address);
  }

  // 지번 주소에서 동 이름 추출: "인천광역시 서구 가정동 645-1" → "가정동"
  const dongMatch = address.match(/[가-힣]+[동리가]\d*가?\s/);
  const dongName = dongMatch ? dongMatch[0].trim() : '';

  // bjdongCd 탐색 (동 이름으로)
  let bjdongCd = '';
  if (dongName) {
    bjdongCd = await findBjdongCd(serviceKey, codes.sigunguCd, dongName) || '';
  }
  // bjdongCd를 못 찾으면 첫 번째 동(10100)으로 폴백
  if (!bjdongCd) bjdongCd = '10100';

  const params = {
    serviceKey,
    sigunguCd: codes.sigunguCd,
    bjdongCd,
    pageNo: 1,
    numOfRows: 3,
    _type: 'json',
  };
  if (codes.bun) params.bun = codes.bun;
  if (codes.ji) params.ji = codes.ji;

  const response = await axios.get(
    'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo',
    { params, timeout: 10000 }
  );

  const items = response.data?.response?.body?.items?.item;
  const records = Array.isArray(items) ? items : items ? [items] : [];

  if (records.length === 0) {
    return {
      exists: false,
      mainPurpose: null,
      purposeCode: null,
      isCommercial: false,
      floorArea: null,
      totalFloors: null,
      address: null,
      approvalDate: null,
      detail: '건축물대장 미등재',
    };
  }

  // 상업용 건물 우선 선택, 없으면 첫 번째
  const commercialCodes = ['03', '04', '07', '14'];
  const record = records.find(r => {
    const code = (r.mainPurpsCd || '').substring(0, 2);
    return commercialCodes.includes(code);
  }) || records[0];

  const mainPurpose = record.mainPurpsCdNm || '';
  const purposeCode = record.mainPurpsCd || '';
  const isCommercial = commercialCodes.includes(purposeCode.substring(0, 2));

  return {
    exists: true,
    mainPurpose,
    purposeCode,
    isCommercial,
    floorArea: parseFloat(record.totArea || '0'),
    totalFloors: parseInt(record.grndFlrCnt || '0', 10),
    address: record.platPlc || address,
    approvalDate: record.useAprDay || '',
    detail: `건축물대장 확인 완료 — ${mainPurpose} (${record.totArea || '?'}㎡)`,
  };
}

// ── 외부 노출 ─────────────────────────────────────────────────
async function getBuildingInfo(businessNumber, address) {
  const useMock = process.env.USE_MOCK !== 'false';
  const key = process.env.MOLIT_API_KEY || '';

  if (useMock || DEMO_NUMBERS.has(businessNumber) || !address || !key || key.startsWith('your_')) {
    const result = await getBuildingInfoMock(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }

  try {
    const result = await getBuildingInfoLive(address);
    return { ...result, dataSource: 'LIVE' };
  } catch (e) {
    console.warn('[건물현황 Live 실패 → Mock 전환]', e.message);
    const result = await getBuildingInfoMock(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }
}

module.exports = { getBuildingInfo };
