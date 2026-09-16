/**
 * ============================================================
 * [5단계] 행정인허가 검증 서비스
 * ============================================================
 * 실제 API: 행정안전부 지방행정인허가데이터 (localdata.go.kr)
 * 엔드포인트: https://www.localdata.go.kr/platform/rest/{serviceCode}/openDataApi
 *
 * 업종별 영업허가 유효 여부를 확인합니다.
 * 인허가 없이는 합법적으로 사업을 영위할 수 없으므로
 * 실재 영업장 여부의 핵심 증거입니다.
 *
 * [지원 업종 코드]
 * GR0: 일반음식점 / GR1: 휴게음식점 / GR2: 제과점영업
 * LA0: 미용업 / LB0: 이용업 / LC0: 세탁업 / LD0: 목욕장업
 * LD1: 숙박업 / LF0: 안경업 / MK0: 의약품 판매업
 */

const axios = require('axios');
const { getMerchantRegion } = require('./bcData.service');
const { rankCandidates, parseAddress, synonymVariants } = require('../utils/licenseMatch'); // 사업체 특정(상호·주소·상태 채점, 2026-09-11) // BC 가맹점 등록 지역 — 샘플에 없으면 null (2026-09-11)

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['2208162346', '1293284715', '2144028530', '5142691320', '5555555555']);

// ── 인허가 업종 서비스 코드 ────────────────────────────────────
const LICENSE_SERVICE_CODES = [
  { code: 'GR0', name: '일반음식점' },
  { code: 'GR1', name: '휴게음식점' },
  { code: 'GR2', name: '제과점영업' },
  { code: 'LA0', name: '미용업' },
  { code: 'LB0', name: '이용업' },
  { code: 'LC0', name: '세탁업' },
  { code: 'LD0', name: '목욕장업' },
  { code: 'LD1', name: '숙박업' },
  { code: 'LF0', name: '안경업' },
];

// ── Mock 데이터 ───────────────────────────────────────────────
const MOCK_LICENSE_DATA = {
  // 시나리오 A: 음식업 허가 정상 (만점)
  '2208162346': {
    hasLicense: true,
    licenseType: '일반음식점',
    licenseStatus: '영업',
    licenseDate: '2019-03-20',
    expiryDate: null,       // 일반음식점은 만료일 없음
    address: '서울특별시 강남구 테헤란로 123',
    detail: '식품위생법 일반음식점 영업허가 유효 (2019.03 취득)',
  },
  // 시나리오 B: 신규 사업자 — 인허가 미취득 (신청 진행 중)
  '1293284715': {
    hasLicense: false,
    licenseType: null,
    licenseStatus: '미취득',
    licenseDate: null,
    expiryDate: null,
    address: null,
    detail: '인허가 조회 결과 없음 (신규 또는 인허가 불필요 업종)',
  },
  // 시나리오 C: 신설 사업자 — 인허가 신규 취득
  '5142691320': {
    hasLicense: true,
    licenseType: '일반음식점',
    licenseStatus: '영업',
    licenseDate: '2025-09-15',
    expiryDate: null,
    address: '대구광역시 수성구 동대구로 100',
    detail: '일반음식점 영업허가 유효 (2025.09 취득) — 새로운분식',
  },
  // 시나리오 E: 가장매출 의심 — 인허가는 정상(매장 실재), 카드 흐름만 이상
  '5555555555': {
    hasLicense: true,
    licenseType: '휴게음식점',
    licenseStatus: '영업',
    licenseDate: '2025-01-20',
    expiryDate: null,
    address: '부산광역시 해운대구 해운대해변로 200',
    detail: '식품위생법 휴게음식점 영업신고 유효 (2025.01 취득) — 스마일카페',
  },
  // 시나리오 D: 폐업으로 허가 취소
  '2144028530': {
    hasLicense: false,
    licenseType: '일반음식점',
    licenseStatus: '폐업',
    licenseDate: '2020-05-25',
    expiryDate: '2024-01-31',
    address: null,
    detail: '인허가 폐업 처리 확인 (2024.01.31 말소)',
  },
};

// ── Mock 조회 ─────────────────────────────────────────────────
async function getLicenseMock(businessNumber) {
  await new Promise(r => setTimeout(r, 700 + Math.random() * 400));

  const data = MOCK_LICENSE_DATA[businessNumber];
  if (!data) {
    // 미등록 번호: 70% 확률로 인허가 있음
    const hasLicense = Math.random() > 0.3;
    return {
      hasLicense,
      licenseType: hasLicense ? '일반음식점' : null,
      licenseStatus: hasLicense ? '영업' : '미취득',
      licenseDate: hasLicense ? '2021-07-01' : null,
      expiryDate: null,
      address: hasLicense ? '서울특별시 종로구 종로 1' : null,
      detail: hasLicense
        ? '행정인허가 조회 완료 — 영업 상태 확인'
        : '행정인허가 조회 결과 없음',
    };
  }
  return data;
}

// ── data.go.kr 행정안전부 인허가 API (195종) ─────────────────
// 검색 파라미터: cond[BPLC_NM::LIKE]=상호명, cond[DTL_SALS_STTS_NM::EQ]=영업
// 페이징: perPage, page / 응답: returnType=json
const DATA_GO_KR_LICENSE_APIS = [
  { url: '/1741000/general_restaurants/info', name: '일반음식점' },
  { url: '/1741000/rest_cafes/info', name: '휴게음식점' },
  { url: '/1741000/bakeries/info', name: '제과점' },
  // 이용업(barber_shops)·체력단련장(fitness_centers)·병의원(hospitals·clinics)은 data.go.kr 활용신청 후 여기에 추가 (2026-09-11 확인: 403)
  { url: '/1741000/beauty_salons/info', name: '미용업' },
  { url: '/1741000/laundries/info', name: '세탁업' },
  { url: '/1741000/lodgings/info', name: '숙박업' },
  // 2026-09-11 추가 — data.go.kr 활용신청(자동승인) 후 같은 인증키로 동작. 승인 전엔 403 → 조용히 제외
  //   이용업      https://www.data.go.kr/data/15154922/openapi.do
  //   체력단련장업 https://www.data.go.kr/data/15155077/openapi.do
  //   의원        https://www.data.go.kr/data/15154874/openapi.do
  //   병원        https://www.data.go.kr/data/15154458/openapi.do
  { url: '/1741000/barber_shops/info', name: '이용업' },
  { url: '/1741000/fitness_centers/info', name: '체력단련장업' },
  { url: '/1741000/clinics/info', name: '의원' },
  { url: '/1741000/hospitals/info', name: '병원' },
  // 2026-09-12 추가 — 그린헬스(사우나) 용. 목욕장업 https://www.data.go.kr/data/15155091/openapi.do (endpoint 존재 확인: 403 SERVICE_KEY_IS_NOT_REGISTERED), 활용신청 전엔 조용히 제외
  { url: '/1741000/public_baths/info', name: '목욕장업' },
];

// ── 인허가 응답 캐시 (2026-09-16 신설) ────────────────────────
// 전 직원 공개로 조회량이 늘었다. 인허가는 조회 1건에 업종 12종 × 검색어 라운드(최대 4)까지 돌아
// data.go.kr 일일 트래픽 한도를 네 단계 중 가장 먼저 소진한다.
// 같은 URL = 같은 응답이므로 그대로 돌려준다(원장은 월 단위로 갱신되어 12시간이면 결과가 안 바뀐다).
// 판정 로직·응답 형태는 건드리지 않는다 — 콜 수만 줄인다.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX = 3000;
const pageCache = new Map();
function cacheGet(key) {
  const hit = pageCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { pageCache.delete(key); return null; }
  // 호출부가 항목을 만질 수 있으므로 사본을 준다 (캐시가 오염되면 다음 조회가 달라진다)
  return { list: hit.value.list.map(o => ({ ...o })), total: hit.value.total };
}
function cacheSet(key, value) {
  if (pageCache.size >= CACHE_MAX) pageCache.delete(pageCache.keys().next().value); // 가장 오래된 것부터 버린다
  pageCache.set(key, { at: Date.now(), value: { list: value.list.map(o => ({ ...o })), total: value.total } });
  return value;
}

// 주소에서 매칭용 키워드 추출 (구/동/로 단위)
function extractAddressKeys(addr) {
  if (!addr) return [];
  // "대구광역시 달서구 성서로 123" → ["달서구", "성서로"] 등
  const tokens = addr.replace(/[,\s]+/g, ' ').split(' ').filter(Boolean);
  return tokens.filter(t => /[구동로길읍면리]$/.test(t) && t.length >= 2);
}

function matchAddress(candidateAddr, referenceAddr) {
  if (!referenceAddr) return 0;
  const refKeys = extractAddressKeys(referenceAddr);
  if (refKeys.length === 0) return 0;
  const candAddr = candidateAddr || '';
  return refKeys.filter(k => candAddr.includes(k)).length / refKeys.length;
}

// ── 상호 정규화·유사도 + BC 등록 지역 대조 (2026-09-11, mockLocation.service.js 와 같은 규칙) ──
//   인허가 API 에는 사업자번호 항목이 없다(상호 LIKE 검색뿐). 그래서 동명 다른 가게가 섞여 오고,
//   종전 코드는 첫 업종 API 에 결과가 하나라도 있으면 폐업이어도 거기서 반환했다(호텔스타 → 「호텔스타건대(폐업)」).
const normalizeName = s => String(s || '').replace(/<[^>]+>/g, '').replace(/[\s\(\)（）\[\]·\-_,.&'"]/g, '').toLowerCase();
// 괄호 속 내용(영문 병기 등)을 뗀 변형도 함께 비교 — 「알에스 (RS)다나재활의학과의원」 ↔ 「알에스다나재활의학과의원」
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
// 영업 상태 판정 — 업종마다 표기가 다르다: 일반음식점 「영업」, 의원·병원 「영업중」, 「정상」 등. 「영업」으로 시작하거나 「정상」이면 영업 중
const isActiveStatus = s => /^(영업|정상)/.test(String(s || '').trim());
function regionMatch(address, region) {
  if (!region || !address) return { sigungu: false, dong: false };
  const addr = String(address);
  const sidoShort = (region.sido || '').replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, '');
  const sigungu = !!region.sigungu && addr.includes(region.sigungu) && (!sidoShort || addr.includes(sidoShort));
  const dong = sigungu && !!region.dong && addr.includes(region.dong.replace(/\d+동$/, ''));
  return { sigungu, dong };
}

/**
 * 업종 API 6종을 **동시에** 조회해 후보를 모으고, 상호 유사도 + 영업 상태 + BC 등록 지역 + 네이버 주소로 골라낸다.
 *  - 타임아웃 8초, 타임아웃은 재시도하지 않는다(미용업 API 가 응답 없이 20초를 끌던 것이 33초의 원인). 최대 대기 = 8초.
 *  - BC 등록 지역(시군구)이 있으면 그 지역 밖의 후보는 버린다 — 인허가 원장에 사업자번호가 없어 지역이 유일한 식별 근거.
 *  - 영업 중 일치가 있으면 그것, 없고 동명 폐업만 있으면 폐업으로, 아무것도 없으면 조회 결과 없음.
 */
async function getLicenseLive(storeName, address, businessNumber, altNames = []) {
  const serviceKey = process.env.LICENSE_API_KEY || process.env.NTS_API_KEY;
  if (!serviceKey) throw new Error('LICENSE_API_KEY 미설정');

  const region = getMerchantRegion(businessNumber);
  const LICENSE_TIMEOUT = 10000; // data.go.kr 응답 편차(일반음식점 1.4~9.6초 실측) 반영. 확정 후보가 나오면 조기 종료하므로 보통 2~4초

  // API 는 perPage 를 얼마로 주든 최대 10건만 준다(실측). 동명이 많은 상호(「오군」 40건)는 뒤 페이지에 진짜 매장이 있으므로
  // totalCount 만큼(최대 MAX_PAGES 페이지) 이어 받는다. 첫 페이지 뒤의 페이지는 동시에 요청.
  const PAGE_SIZE = 10, MAX_PAGES = 1; // 실측: page=2~4 도 1페이지와 같은 10건을 돌려준다(API 가 page 무시) → 이어받기 실효 없음, 1페이지만
  // ★ 10건 제한 우회(2026-09-11 실측): BC 등록 지역이 있으면 도로명주소 LIKE 「시도 시군구」 조건을 상호 조건과 함께 보낸다.
  //   「오군」은 동명 40건 중 10건만 오던 것이 「서울특별시 중구」 조건으로 2건(중구 다동길 20 영업)으로 좁혀진다.
  const regionCond = region?.sido && region?.sigungu
    ? `&cond%5BROAD_NM_ADDR%3A%3ALIKE%5D=${encodeURIComponent(`${region.sido} ${region.sigungu}`)}`
    : '';
  // query = { name } 상호 LIKE (+ BC 시군구 조건) / { road } 도로명주소 LIKE 만 (상호 조건 없음 — 주소 검색 폴백)
  const getPage = async (path, page, query = { name: storeName }) => {
    const cond = query.road
      ? `&cond%5BROAD_NM_ADDR%3A%3ALIKE%5D=${encodeURIComponent(query.road)}`
      : `&cond%5BBPLC_NM%3A%3ALIKE%5D=${encodeURIComponent(query.name)}` + regionCond;
    const url = `https://apis.data.go.kr${path}`
      + `?serviceKey=${encodeURIComponent(serviceKey)}`
      + `&perPage=${PAGE_SIZE}&page=${page}&returnType=json`
      + cond;
    const cached = cacheGet(url);
    if (cached) return cached;
    let res;
    try {
      res = await axios.get(url, { timeout: LICENSE_TIMEOUT });
    } catch (e) {
      // 정상 응답 코드(403 등)·타임아웃은 재시도 무의미. 연결 끊김 같은 일시 오류만 1회 재시도
      if (e.response || e.code === 'ECONNABORTED') throw e;
      res = await axios.get(url, { timeout: LICENSE_TIMEOUT });
    }
    const body = res.data?.response?.body || {};
    const items = body.items?.item;
    // 실패는 캐시하지 않는다(위 throw). 성공 응답만 담는다 — 한도 소진 시 빈 결과가 굳는 것을 막는다
    return cacheSet(url, { list: items ? (Array.isArray(items) ? items : [items]) : [], total: Number(body.totalCount) || 0 });
  };
  const fetchOne = async ({ url: path, name }, query) => {
    const first = await getPage(path, 1, query);
    const pages = Math.min(MAX_PAGES, Math.ceil(first.total / PAGE_SIZE));
    const rest = pages > 1
      ? (await Promise.allSettled(Array.from({ length: pages - 1 }, (_, i) => getPage(path, i + 2, query)))).flatMap(r => (r.status === 'fulfilled' ? r.value.list : []))
      : [];
    return [...first.list, ...rest].map(item => ({ item, type: name }));
  };

  // 검색어 변형 라운드(2026-09-11): 원장 상호는 「알에스다나재활의학과의원」인데 입력이 「알에스 (RS)다나재활의학과의원」이면 LIKE 가 0건.
  //   원문 → 괄호 병기 제거 → 공백까지 제거 순으로, 후보가 하나라도 나오면 멈춘다(보통 1라운드).
  const noParen = storeName.replace(/[\(（][^\)）]*[\)）]/g, '').replace(/\s+/g, ' ').trim();
  // + 업종 표현 동의어 변형(「삼덕동빵집」→「삼덕동베이커리」·「삼덕동제과점」) — 원장·간판이 다른 표현을 쓰는 경우
  const queryVariants = [...new Set([storeName, noParen, noParen.replace(/\s+/g, ''), ...synonymVariants(noParen)].filter(q => q.length >= 2))].map(name => ({ name }));
  // ★ 주소 검색 폴백(2026-09-11): 원장 상호가 「나 살던 고향」처럼 띄어쓰기·표기가 달라 상호 LIKE 로는 못 찾는 경우,
  //   네이버 도로명주소의 「도로명 건물번호」(예: 강남대로37길 28)로 그 주소에 등록된 업체를 받아 정규화 상호로 대조한다.
  const parsedRef = parseAddress(address);
  // [2026-09-12] 주소 검색은 상호 라운드와 분리 — 상호 라운드에서 후보가 나와도 「영업 중 + HIGH 이상」이 없으면 주소 라운드를 이어 돈다.
  //   (그린헬스: 체력단련장 원장의 「그린헬스클럽(폐업, 다른 가게)」이 먼저 잡혀 주소 검색까지 못 가던 것. 원장 상호는 「그린사우나」)
  const roadQuery = parsedRef?.road && parsedRef?.building ? { road: `${parsedRef.road} ${parsedRef.building}` } : null;
  const matchRef = { storeName, altNames, region, address: address || null };

  const candidates = [];
  const failed = [];      // 응답 없음(타임아웃·네트워크) — 조회 결과 없음 detail 에 표기
  const unavailable = []; // HTTP 오류(403 미승인·400 등) — 활용신청 전 업종. 로그만 남기고 detail 엔 안 쓴다
  // 조기 종료(2026-09-11): 어느 업종 API 에서든 영업 중 + EXACT 후보가 오면 남은 API 응답을 기다리지 않는다.
  //   data.go.kr 응답이 1.4~9.6초로 들쭉날쭉해(일반음식점) 타임아웃을 10초로 두되, 확정이 나오면 그 시점에 끝낸다.
  const settleWithEarlyExit = promises => new Promise(resolve => {
    const states = promises.map(() => ({ status: 'pending' }));
    let left = promises.length;
    const finish = () => resolve(states);
    promises.forEach((p, i) => {
      p.then(value => {
        states[i] = { status: 'fulfilled', value };
        const hit = rankCandidates(value, matchRef).find(c => c.active && c.confidence === 'EXACT');
        if (hit) finish();
      }).catch(reason => { states[i] = { status: 'rejected', reason }; })
        .finally(() => { if (--left === 0) finish(); });
    });
  });
  for (const query of queryVariants) {
    const settled = await settleWithEarlyExit(DATA_GO_KR_LICENSE_APIS.map(ep => fetchOne(ep, query)));
    failed.length = 0; unavailable.length = 0;
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') candidates.push(...s.value);
      else if (s.status === 'rejected' && s.reason?.response) unavailable.push(`${DATA_GO_KR_LICENSE_APIS[i].name}(${s.reason.response.status})`);
      else if (s.status === 'rejected') failed.push(DATA_GO_KR_LICENSE_APIS[i].name);
      // pending = 확정 후보가 먼저 나와 기다리지 않은 API
    });
    if (candidates.length) break;
  }
  const hasConfirmed = () => rankCandidates(candidates, matchRef).some(c => c.active && (c.confidence === 'EXACT' || c.confidence === 'HIGH'));
  if (roadQuery && !hasConfirmed()) {
    const settled = await settleWithEarlyExit(DATA_GO_KR_LICENSE_APIS.map(ep => fetchOne(ep, roadQuery)));
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') candidates.push(...s.value);
      else if (s.status === 'rejected' && s.reason?.response) unavailable.push(`${DATA_GO_KR_LICENSE_APIS[i].name}(${s.reason.response.status})`);
      else if (s.status === 'rejected') failed.push(DATA_GO_KR_LICENSE_APIS[i].name);
    });
  }
  if (failed.length) console.warn(`[인허가] 응답 없음: ${failed.join(', ')}`);
  if (unavailable.length) console.warn(`[인허가] 미승인·오류 API 제외: ${unavailable.join(', ')}`);

  // ── 사업체 특정(2026-09-11): utils/licenseMatch.js — 상호 40 · 주소 50 · 영업 상태 10, 등급 EXACT/HIGH/MEDIUM/LOW/NONE ──
  //   HIGH 이상만 「이 사업체의 인허가」로 인정(20점). MEDIUM 이하는 「동일 사업체 여부 추가 확인 필요」로 0점 + 후보 표.
  const ranked = rankCandidates(candidates, { ...matchRef, jibunAddress: null })
    .filter(c => c.nameScore > 0)
    .filter(c => !region || !c.misses.some(m => m.startsWith('시군구 불일치'))); // BC 등록 지역 밖은 다른 가게
  const toCandidate = c => ({ name: c.name, address: c.address, type: c.type, status: c.status, matchScore: c.matchScore, confidence: c.confidence, reasons: c.reasons, misses: c.misses });
  const CONFIRMED = new Set(['EXACT', 'HIGH']);
  const best = ranked.find(c => c.active && CONFIRMED.has(c.confidence)) || null;
  const topAny = ranked[0] || null;
  const bcRegion = region ? { sido: region.sido, sigungu: region.sigungu, dong: region.dong, matched: !!(best || topAny)?.reasons.some(r => r.includes('시군구 일치')), dongMatched: !!(best || topAny)?.reasons.includes('행정동 일치') } : null;
  const licenseMatch = { score: (best || topAny)?.matchScore ?? 0, confidence: best ? best.confidence : (topAny ? (CONFIRMED.has(topAny.confidence) ? 'MEDIUM' : topAny.confidence) : 'NONE'), reasons: (best || topAny)?.reasons || [], misses: (best || topAny)?.misses || [], candidates: ranked.slice(0, 5).map(toCandidate) };

  if (best) {
    const a = best.item;
    return {
      hasLicense: true,
      licenseType: best.type,
      licenseStatus: a.DTL_SALS_STTS_NM || '영업',
      licenseDate: a.LCPMT_YMD || '',
      expiryDate: a.CLSBIZ_YMD || null,
      address: a.ROAD_NM_ADDR || a.LOTNO_ADDR || '',
      bcRegion,
      licenseMatch,
      detail: `${best.type} 영업허가 유효 (${a.LCPMT_YMD || '취득일 미상'}) — ${a.BPLC_NM}`,
    };
  }

  // 영업 중 확정(HIGH+) 후보가 없음. 상호 완전 일치·주소 근거가 있는 폐업 후보면 「폐업」, 후보는 있는데 확신이 안 되면 「추가 확인 필요」, 아니면 조회 결과 없음
  const closed = ranked.find(c => !c.active && c.nameScore === 40 && c.matchScore >= 65 && (c.reasons.includes('행정동 일치') || c.reasons.includes('건물번호 일치'))) || null;
  if (closed) {
    const a = closed.item;
    return {
      hasLicense: false,
      licenseType: closed.type,
      licenseStatus: a.DTL_SALS_STTS_NM || '미확인',
      licenseDate: a.LCPMT_YMD || '',
      expiryDate: a.CLSBIZ_YMD || null,
      address: a.ROAD_NM_ADDR || a.LOTNO_ADDR || '',
      bcRegion,
      licenseMatch,
      detail: `${closed.type} ${a.DTL_SALS_STTS_NM || '미확인'} — ${a.BPLC_NM} (영업 중인 동일 사업체 없음)`,
    };
  }
  if (topAny && (topAny.confidence === 'MEDIUM' || topAny.confidence === 'LOW')) {
    return {
      hasLicense: false,
      licenseType: null,
      licenseStatus: '추가 확인 필요',
      licenseDate: null,
      expiryDate: null,
      address: null,
      bcRegion,
      licenseMatch,
      needsReview: true,
      detail: `동일 사업체 여부를 추가로 확인해야 합니다 (유사 후보 ${ranked.length}건, 최고 ${topAny.matchScore}점 ${topAny.confidence})`,
    };
  }

  return {
    hasLicense: false,
    licenseType: null,
    licenseStatus: '미확인',
    licenseDate: null,
    expiryDate: null,
    address: null,
    bcRegion: bcRegion ? { ...bcRegion, matched: false, dongMatched: false } : null,
    licenseMatch: { ...licenseMatch, confidence: 'NONE', candidates: [] },
    detail: `공개된 인허가 데이터에서 일치하는 정보를 확인하지 못했습니다${failed.length ? ` (${failed.join('·')} API 응답 없음)` : ''}`,
  };
}

// ── 외부 노출 ─────────────────────────────────────────────────
async function getLicenseInfo(businessNumber, storeName, address, altNames = []) {
  const useMock = process.env.USE_MOCK !== 'false';
  const key = process.env.LICENSE_API_KEY || process.env.NTS_API_KEY || '';

  if (useMock || DEMO_NUMBERS.has(businessNumber) || !storeName || !key || key.startsWith('your_')) {
    const result = await getLicenseMock(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }

  try {
    const result = await getLicenseLive(storeName, address, businessNumber, (altNames || []).filter(n => n && n !== storeName));
    return { ...result, dataSource: 'LIVE' };
  } catch (e) {
    console.warn('[행정인허가 Live 실패 → Mock 전환]', e.message);
    const result = await getLicenseMock(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }
}

module.exports = { getLicenseInfo };
