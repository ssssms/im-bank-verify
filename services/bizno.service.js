/**
 * ============================================================
 * [보조] 비즈노(BIZNO) 상호명 조회 서비스
 * ============================================================
 * 국세청 사업자상태 API는 상호명을 주지 않으므로, 민간 기업정보 DB(비즈노)로
 * 상호명만 병렬 보완한다. **참고용**이며 휴/폐업 판정에는 절대 사용하지 않는다
 * (판정은 국세청 결과 기준 유지).
 *
 * API: 비즈노 무료 RESTful API (단일 키)
 *   요청주소: https://bizno.net/api/fapi
 *   파라미터: key(서비스키) / gb(검색구분 1=사업자번호,2=법인번호,3=상호명)
 *            / q(검색어) / type(json|xml)
 *   예) https://bizno.net/api/fapi?key=KEY&gb=1&q=8156100363&type=json
 *   응답(json): { resultCode:0, items:[ { company:"상호", bno, bstt, ... }, ... ] }
 *   무료: 1일 200건. 키 발급: https://bizno.net (마이페이지 → 무료 API)
 *   ※ 엔드포인트는 BIZNO_API_URL 로 override 가능
 *
 * 설계 원칙(요구사항):
 *   - 상호명은 병렬 조회, 기존 검증 흐름에 영향 없음
 *   - 비즈노에 없는 번호 → null("상호명 미확인"으로 표시)
 *   - 오류/타임아웃(3초) → 조용히 null 반환, 기존 조회 무영향
 *   - 무료 200건/일 → 같은 번호 당일 캐시로 재조회 차단
 */

const axios = require('axios');

const BIZNO_ENDPOINT = process.env.BIZNO_API_URL || 'https://bizno.net/api/fapi';
const TIMEOUT_MS = 3000;

// ── 시연용 사업자번호 (항상 Mock 상호 사용 — 비즈노 조회 금지) ──────
// 이 번호들도 비즈노 DB에 실재 등록돼 있어 엉뚱한 상호가 나오므로 차단.
// 상호는 국세청 Mock(scoreEngine/mockNts) 값이 그대로 표시된다.
const DEMO_NUMBERS = new Set(['2208162346', '1293284715', '2144028530', '5142691320', '5555555555']);

// 응답 스키마 변형 대비, 상호명 후보 필드를 방어적으로 탐색(비즈노는 'company').
const NAME_KEYS = [
  'company', 'companyName', 'company_nm', 'companyNm', 'corpNm', 'corpName',
  'bizNm', 'name', '상호', '상호명', '회사명',
];

// ── 당일 캐시 (200건/일 보호) ─────────────────────────────────
// Map<bno, { name: string|null, date: 'YYYY-MM-DD' }>
const cache = new Map();
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// 응답 객체(중첩/배열 포함)에서 상호명으로 보이는 첫 문자열 필드를 재귀 탐색
function pickCompanyName(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const k of NAME_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = pickCompanyName(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── 비즈노 라이브 조회 ────────────────────────────────────────
async function fetchCompanyNameLive(bno) {
  const key = process.env.BIZNO_API_KEY;
  if (!key || key.startsWith('your_')) {
    return { companyName: null, found: false, dataSource: 'NONE' };
  }

  const res = await axios.get(BIZNO_ENDPOINT, {
    params: { key, gb: 1, q: bno, type: 'json' },
    timeout: TIMEOUT_MS,
  });

  const name = pickCompanyName(res.data);
  return { companyName: name, found: !!name, dataSource: 'LIVE' };
}

/**
 * 상호명 조회 (절대 throw 하지 않음 — 병렬 실행 시 기존 흐름 보호)
 * @param {string} businessNumber 하이픈 포함/미포함 사업자번호
 * @returns {Promise<{companyName: string|null, found: boolean, dataSource: string}>}
 */
async function getCompanyName(businessNumber) {
  const bno = (businessNumber || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(bno)) {
    return { companyName: null, found: false, dataSource: 'NONE' };
  }
  // 시연번호는 비즈노 조회 금지 → 라우트에서 국세청 Mock 상호로 폴백
  if (DEMO_NUMBERS.has(bno)) {
    return { companyName: null, found: false, dataSource: 'DEMO' };
  }

  // 당일 캐시 히트 (성공 응답만 캐시됨 — 오류는 캐시 안 함)
  const today = todayStr();
  const hit = cache.get(bno);
  if (hit && hit.date === today) {
    return { companyName: hit.name, found: !!hit.name, dataSource: 'CACHE' };
  }

  try {
    const result = await fetchCompanyNameLive(bno);
    // 성공(없음 포함) 결과만 당일 캐시. 오류는 캐시하지 않아 재시도 여지 유지.
    if (result.dataSource === 'LIVE') {
      cache.set(bno, { name: result.companyName, date: today });
    }
    return result;
  } catch (e) {
    console.warn('[BIZNO 상호명 조회 실패 → 미확인 처리]', e.code || e.message);
    return { companyName: null, found: false, dataSource: 'ERROR' };
  }
}

module.exports = { getCompanyName };
