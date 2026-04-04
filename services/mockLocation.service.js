/**
 * ============================================================
 * 상권정보 사업장 위치 교차검증 서비스
 * ============================================================
 * [2단계 교차검증 흐름]
 *
 * 1차: Nominatim(OSM) 키워드 검색
 *   → 상호명으로 검색해 주소/좌표 획득 (API 키 불필요)
 *
 * 2차: 소상공인시장진흥공단 상권정보 API
 *   → 1차에서 얻은 좌표 반경 내 상호 존재 여부 확인
 *
 * 교차 결과: 두 소스 모두 확인되면 '실재 영업장 확인 완료'
 *            한 소스만 확인되면 부분 인정 (감점 없음)
 */

const axios = require('axios');

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['1234567890', '9876543210', '1111111111', '2222222222']);

// ── Mock 데이터 ────────────────────────────────────────────────
const MOCK_LOCATION_DATA = {
  '1234567890': { matched: true,  confidence: 'HIGH',   address: '서울특별시 강남구 테헤란로 123', latitude: 37.5045, longitude: 127.0490, matchedStoreName: '(주)맛있는식당', step1: true, step2: true },
  '9876543210': { matched: true,  confidence: 'MEDIUM', address: '경기도 성남시 분당구 판교로 45',  latitude: 37.3947, longitude: 127.1112, matchedStoreName: '행복마트',       step1: true, step2: false },
  '2222222222': { matched: true,  confidence: 'HIGH',   address: '대구광역시 수성구 동대구로 100', latitude: 35.8562, longitude: 128.6327, matchedStoreName: '새로운분식', step1: true, step2: true },
  '1111111111': { matched: false, confidence: 'NONE',   address: null, latitude: null, longitude: null, matchedStoreName: null, step1: false, step2: false },
};

// ── 1차: 네이버 지역 검색 (한국 사업장 DB, 이름 변형 처리 우수) ──
async function searchByKeyword(storeName) {
  const clientId     = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('NAVER_CLIENT_ID/SECRET 미설정');

  const response = await axios.get('https://openapi.naver.com/v1/search/local.json', {
    params: { query: storeName, display: 5 },
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
    timeout: 6000,
  });

  const items = response.data?.items;
  if (!items || items.length === 0) return null;

  // 네이버 좌표는 KATEC 형식 → WGS84 변환 (간이 변환)
  const best = items[0];
  const longitude = parseInt(best.mapx) / 10000000;
  const latitude  = parseInt(best.mapy) / 10000000;

  return {
    latitude,
    longitude,
    address: best.roadAddress || best.address,
    jibunAddress: best.address || '',               // 지번 주소 (건축물대장 조회용)
    matchedName: best.title.replace(/<[^>]+>/g, ''), // HTML 태그 제거
    category: best.category,
  };
}

// ── 2차: 상권정보 API 반경 내 상호 확인 ───────────────────────
async function verifyInSbiz(latitude, longitude, storeName, radiusMeters = 500) {
  const serviceKey = process.env.SBIZ_API_KEY;
  if (!serviceKey || serviceKey.startsWith('your_')) return { found: false };

  // serviceKey는 반드시 encodeURIComponent 적용 (미적용 시 타임아웃 발생)
  const url = `https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius`
    + `?serviceKey=${encodeURIComponent(serviceKey)}&pageNo=1&numOfRows=10`
    + `&radius=${radiusMeters}&cx=${longitude}&cy=${latitude}&type=json`;

  const response = await axios.get(url, { timeout: 20000 });

  const items = response.data?.body?.items || [];
  if (items.length === 0) return { found: false };

  // 상호명 유사도 매칭
  const normalize = str => str.replace(/[\s\(\)（）]/g, '').toLowerCase();
  const target = normalize(storeName);

  const match = items.find(item => {
    const name = normalize(item.bizesNm || '');
    return name.includes(target) || target.includes(name);
  });

  return {
    found: !!match,
    matchedName: match?.bizesNm || null,
    matchedAddress: match?.rdnmAdr || match?.lnoAdr || null,
    totalNearby: items.length,
  };
}

// ── 실제 교차검증 실행 ─────────────────────────────────────────
async function verifyLocationLive(businessNumber, storeName) {
  if (!storeName) return { matched: false, confidence: 'NONE', reason: '상호명 미입력' };

  let step1Result = null;
  let step2Result = null;

  // 1차: Nominatim 키워드 검색
  try {
    step1Result = await searchByKeyword(storeName);
  } catch (e) {
    console.warn('[위치검증 1차 실패]', e.message);
  }

  // 2차: 소진공 상권정보 교차검증 (1차 성공 시)
  if (step1Result) {
    try {
      step2Result = await verifyInSbiz(step1Result.latitude, step1Result.longitude, storeName);
    } catch (e) {
      console.warn('[위치검증 2차 실패]', e.message);
    }
  }

  // 교차검증 결과 판정
  const step1Pass = !!step1Result;
  const step2Pass = step2Result?.found === true;

  if (step1Pass && step2Pass) {
    return {
      matched: true,
      confidence: 'HIGH',
      address: step2Result.matchedAddress || step1Result.address,
      jibunAddress: step1Result.jibunAddress || '',
      latitude: step1Result.latitude,
      longitude: step1Result.longitude,
      matchedStoreName: step1Result.matchedName || step2Result.matchedName || storeName,
      step1: true,
      step2: true,
      detail: `네이버 + 상권정보 DB 교차검증 완료 (반경 내 ${step2Result.totalNearby}개 상가 중 확인)`,
    };
  } else if (step1Pass) {
    return {
      matched: true,
      confidence: 'MEDIUM',
      address: step1Result.address,
      jibunAddress: step1Result.jibunAddress || '',
      latitude: step1Result.latitude,
      longitude: step1Result.longitude,
      matchedStoreName: step1Result.matchedName || storeName,
      step1: true,
      step2: false,
      detail: `네이버 위치 확인 완료 · ${step1Result.matchedName || storeName} (${step1Result.category || ''})`,
    };
  } else {
    return {
      matched: false,
      confidence: 'NONE',
      address: null,
      latitude: null,
      longitude: null,
      matchedStoreName: null,
      step1: false,
      step2: false,
      detail: '위치 정보를 확인할 수 없습니다',
    };
  }
}

// ── Mock 검증 ──────────────────────────────────────────────────
async function verifyLocationMock(businessNumber, storeName) {
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 500));
  const data = MOCK_LOCATION_DATA[businessNumber];
  if (!data) {
    const matched = Math.random() > 0.25;
    return { matched, confidence: matched ? 'MEDIUM' : 'NONE', address: matched ? '서울특별시 마포구 합정동 100' : null, step1: matched, step2: false };
  }
  return data;
}

// ── 외부 노출 ──────────────────────────────────────────────────
async function verifyLocation(businessNumber, storeName) {
  const useMock = process.env.USE_MOCK !== 'false';
  const naverKey = process.env.NAVER_CLIENT_ID || '';
  if (useMock || DEMO_NUMBERS.has(businessNumber) || !storeName || !naverKey || naverKey.startsWith('your_')) {
    const result = await verifyLocationMock(businessNumber, storeName);
    return { ...result, dataSource: 'MOCK' };
  }
  try {
    const result = await verifyLocationLive(businessNumber, storeName);
    return { ...result, dataSource: 'LIVE' };
  } catch (e) {
    console.warn('[위치검증 Live 실패 → Mock 전환]', e.message);
    const result = await verifyLocationMock(businessNumber, storeName);
    return { ...result, dataSource: 'MOCK' };
  }
}

module.exports = { verifyLocation };
