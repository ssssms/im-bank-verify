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
const { getMerchantRegion } = require('./bcData.service'); // BC 가맹점 등록 주소(시도·시군구·행정동) — 샘플에 없으면 null (2026-09-10)
const { synonymVariants, normalizeBusinessName } = require('../utils/licenseMatch'); // 업종 표현 동의어·상호 정규화 (2026-09-11)

// ── 상호 정규화·유사도 (2026-09-10) ───────────────────────────
//   normalizeName : 공백·괄호·특수문자 제거, 소문자
//   nameSimilar   : 완전 일치 → 2점, 한쪽이 다른 쪽을 포함(짧은 쪽 3글자 이상) → 1점, 그 외 0
//   ※ 종전 「양방향 includes」는 상호가 한 글자인 가게(「나」)가 「나살던고향」과 일치로 잡혔다.
// 상호 정규화는 licenseMatch.normalizeBusinessName(법인 표기·괄호·특수문자 제거 + 업종 동의어 통일)으로 통일 (2026-09-11)
const normalizeName = s => normalizeBusinessName(s);
const nameVariants = s => { const raw = String(s || ''); const stripped = raw.replace(/[\(（][^\)）]*[\)）]/g, ''); return [...new Set([normalizeName(raw), normalizeName(stripped)].filter(Boolean))]; };
function nameSimilar(a, b) {
  let best = 0;
  for (const x of nameVariants(a)) for (const y of nameVariants(b)) {
    if (x === y) return 2;
    const short = x.length <= y.length ? x : y, long = x.length <= y.length ? y : x;
    if (short.length >= 3 && long.includes(short)) best = Math.max(best, 1);
  }
  return best;
}
// 주소가 BC 가맹점 등록 지역(시군구·행정동)과 맞는가 → { sigungu, dong }
function regionMatch(address, region) {
  if (!region || !address) return { sigungu: false, dong: false };
  const addr = String(address);
  const sidoShort = (region.sido || '').replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, ''); // '중구' 는 서울·대구·부산에 다 있어 시도까지 본다
  const sigungu = !!region.sigungu && addr.includes(region.sigungu) && (!sidoShort || addr.includes(sidoShort));
  const dong = sigungu && !!region.dong && addr.includes(region.dong.replace(/\d+동$/, '')); // '서초2동' 은 도로명 주소에 '서초' 로만 나올 수 있다
  return { sigungu, dong };
}

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['2208162346', '1293284715', '2144028530', '5142691320', '6211957068']);

// ── Mock 데이터 ────────────────────────────────────────────────
const MOCK_LOCATION_DATA = {
  '2208162346': { matched: true,  confidence: 'HIGH',   address: '서울특별시 강남구 테헤란로 123', latitude: 37.5045, longitude: 127.0490, matchedStoreName: '(주)맛있는식당', step1: true, step2: true },
  '1293284715': { matched: true,  confidence: 'MEDIUM', address: '경기도 성남시 분당구 판교로 45',  latitude: 37.3947, longitude: 127.1112, matchedStoreName: '행복마트',       step1: true, step2: false },
  '5142691320': { matched: true,  confidence: 'HIGH',   address: '대구광역시 수성구 동대구로 100', latitude: 35.8562, longitude: 128.6327, matchedStoreName: '새로운분식', step1: true, step2: true },
  '2144028530': { matched: false, confidence: 'NONE',   address: null, latitude: null, longitude: null, matchedStoreName: null, step1: false, step2: false },
  // 시나리오 E: 가장매출 의심 — 매장은 실재(위치·인허가 만점), 카드 흐름만 이상
  '6211957068': { matched: true,  confidence: 'HIGH',   address: '부산광역시 해운대구 해운대해변로 200', latitude: 35.1587, longitude: 129.1604, matchedStoreName: '스마일카페', step1: true, step2: true },
};

// ── 1차: 네이버 지역 검색 (한국 사업장 DB, 이름 변형 처리 우수) ──
async function searchByKeyword(storeName, region = null) {
  const clientId     = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('NAVER_CLIENT_ID/SECRET 미설정');

  const call = q => axios.get('https://openapi.naver.com/v1/search/local.json', {
    params: { query: q, display: 5 },
    headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
    timeout: 6000,
  }).then(r => r.data?.items || []);

  // [2026-09-10] 종전엔 상호만 검색해 첫 번째 결과를 그대로 썼다(「초이커피숍」→「초이커피 신길점」).
  // BC 등록 지역이 있으면 검색어를 바꿔 가며(시군구+상호 → 시도+시군구+상호 → 접미사 뗀 상호 → 상호만) 같은 지역 후보를 찾고,
  // 후보 5개를 상호 유사도(0~2) + 지역 일치(시군구 +2 · 행정동 +1) 로 점수 매겨 가장 높은 것을 고른다. 동점이면 네이버 순서.
  // 실측: 「중구 초이커피숍」 0건 → 「서울 중구 초이커피」 가 중구 통일로 10(행안부 소재지와 같은 곳)을 찾는다.
  const sidoShort = (region?.sido || '').replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, '');
  const bare = storeName.replace(/\s*\(.*\)\s*$/, '').replace(/(커피숍|커피샵|뷰티샵|뷰티숍|헤어샵|헤어숍|숍|샵|점|집|카페)$/, '').trim();
  const queries = [];
  const push = q => { if (q && !queries.includes(q)) queries.push(q); };
  if (region?.sigungu) {
    push(`${region.sigungu} ${storeName}`);
    push(`${sidoShort} ${region.sigungu} ${storeName}`.trim());
    // 업종 표현 동의어(「삼덕동빵집」→「삼덕동베이커리」) — BC 가맹점명이 간판과 다른 표현일 때 (2026-09-11)
    for (const alt of synonymVariants(storeName)) push(`${sidoShort} ${region.sigungu} ${alt}`.trim());
    if (bare && bare !== storeName && bare.length >= 2) push(`${sidoShort} ${region.sigungu} ${bare}`.trim());
  }
  push(storeName);
  for (const alt of synonymVariants(storeName)) push(alt);

  const scoreItems = items => items.map((it, i) => {
    const rm = regionMatch(`${it.roadAddress || ''} ${it.address || ''}`, region);
    return { it, i, score: nameSimilar(it.title, storeName) + (rm.sigungu ? 2 : 0) + (rm.dong ? 1 : 0), rm };
  }).sort((a, b) => b.score - a.score || a.i - b.i);

  // 검색어를 차례로 시도하며 최고 점수 후보를 유지. 지역 일치 + 상호 유사(≥1) 후보가 나오면 그 즉시 채택.
  //   (종전엔 지역만 맞으면 채택해 「중구 삼덕동빵집」→「인더매스 삼덕」(다른 가게)이 잡혔다 — 2026-09-11)
  let scored = null;
  for (const q of queries) {
    const items = await call(q);
    if (!items.length) continue;
    const s = scoreItems(items);
    if (!scored || s[0].score > scored[0].score) scored = s;
    if (s[0].rm.sigungu && nameSimilar(s[0].it.title, storeName) >= 1) { scored = s; break; }
    if (!region && nameSimilar(s[0].it.title, storeName) >= 1) break; // 지역 정보가 없으면 상호가 맞는 첫 결과로 끝
  }
  if (!scored) return null;
  const best = scored[0].it;

  // 네이버 좌표는 KATEC 형식 → WGS84 변환 (간이 변환)
  const longitude = parseInt(best.mapx) / 10000000;
  const latitude  = parseInt(best.mapy) / 10000000;

  return {
    latitude,
    longitude,
    address: best.roadAddress || best.address,
    jibunAddress: best.address || '',               // 지번 주소 (건축물대장 조회용)
    matchedName: best.title.replace(/<[^>]+>/g, ''), // HTML 태그 제거
    category: best.category,
    regionMatched: scored[0].rm.sigungu,             // BC 등록 시군구와 일치
    regionMatchedDong: scored[0].rm.dong,
    candidates: scored.length,
  };
}

// ── 2차: 상권정보 API 반경 내 상호 확인 ───────────────────────
// [2026-09-10] 종전 반경 500m · 10건: 도심은 반경 안 상가가 900~4,500곳인데 10곳만 받아 비교했으니 사실상 항상 실패(12점).
//   실측(스크래치 sbiz_probe): 반경 100m · 1,000건이면 0.1~0.4초에 전부 받고 오군·호텔스타가 바로 일치.
async function verifyInSbiz(latitude, longitude, storeName, radiusMeters = 100) {
  const serviceKey = process.env.SBIZ_API_KEY;
  if (!serviceKey || serviceKey.startsWith('your_')) return { found: false };

  // serviceKey는 반드시 encodeURIComponent 적용 (미적용 시 타임아웃 발생)
  const url = `https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius`
    + `?serviceKey=${encodeURIComponent(serviceKey)}&pageNo=1&numOfRows=1000`
    + `&radius=${radiusMeters}&cx=${longitude}&cy=${latitude}&type=json`;

  const response = await axios.get(url, { timeout: 20000 });

  const items = response.data?.body?.items || [];
  if (items.length === 0) return { found: false };

  // 상호명 유사도 매칭 — 완전 일치 우선, 그다음 포함(짧은 쪽 3글자 이상)
  const exact = items.find(item => nameSimilar(item.bizesNm, storeName) === 2);
  const match = exact || items.find(item => nameSimilar(item.bizesNm, storeName) >= 1);

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

  // BC 가맹점 등록 주소(시도·시군구·행정동) — 샘플에 있는 번호만. 네이버 후보 선택 + 두 번째 교차 근거로 쓴다 (2026-09-10)
  const region = getMerchantRegion(businessNumber);

  // 1차: 네이버 지역 검색
  try {
    step1Result = await searchByKeyword(storeName, region);
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

  // 교차검증 결과 판정 — 두 번째 근거는 소진공 반경 일치 또는 BC 가맹점 등록 주소(시군구) 일치
  const step1Pass = !!step1Result;
  const step2Pass = step2Result?.found === true;
  const bcAddress = region && step1Result
    ? { sido: region.sido, sigungu: region.sigungu, dong: region.dong, matched: !!step1Result.regionMatched, dongMatched: !!step1Result.regionMatchedDong }
    : null;
  const bcPass = bcAddress?.matched === true;

  if (step1Pass && (step2Pass || bcPass)) {
    const sources = [step2Pass ? `상권정보 DB(반경 내 ${step2Result.totalNearby}개 상가 중 확인)` : null, bcPass ? 'BC 가맹점 등록 주소' : null].filter(Boolean);
    return {
      matched: true,
      confidence: 'HIGH',
      address: (step2Pass && step2Result.matchedAddress) || step1Result.address,
      jibunAddress: step1Result.jibunAddress || '',
      latitude: step1Result.latitude,
      longitude: step1Result.longitude,
      matchedStoreName: step1Result.matchedName || step2Result?.matchedName || storeName,
      step1: true,
      step2: step2Pass,
      bcAddress,
      detail: `네이버 + ${sources.join(' + ')} 교차검증 완료`,
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
      bcAddress,
      detail: `네이버 위치 확인 완료 · ${step1Result.matchedName || storeName} (${step1Result.category || ''})${bcAddress ? ' · BC 등록 지역과 불일치' : ''}`,
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
