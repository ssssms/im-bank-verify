/**
 * ============================================================
 * [보조] 비즈노(BIZNO / 머니핀) 상호명 조회 서비스
 * ============================================================
 * 국세청 사업자상태 API는 상호명을 주지 않으므로, 민간 기업정보 DB(머니핀
 * 비즈노)로 상호명만 병렬 보완한다. **참고용**이며 휴/폐업 판정에는 절대
 * 사용하지 않는다(판정은 국세청 결과 기준 유지).
 *
 * API: 머니핀 비즈노 OPEN API (OAuth 토큰 방식)
 *   문서: https://docs.bizno.moneypin.biz  (호스트: https://api.moneypin.biz)
 *   1) 토큰:   POST /bizno/v1/auth/token
 *              body { grantType:'client_credentials', clientId, clientSecret }
 *   2) 기본정보: POST /bizno/v1/biz/info/base
 *              header Authorization: Bearer <token>, body { 사업자번호 }
 *   자격증명: 환경변수 BIZNO_CLIENT_ID / BIZNO_CLIENT_SECRET (하드코딩 금지)
 *   ※ 호스트는 BIZNO_API_BASE 로 override 가능
 *   Rate limit: 1 req/sec (기본정보/전체정보)
 *
 * 설계 원칙(요구사항):
 *   - 상호명은 병렬 조회, 기존 검증 흐름에 영향 없음
 *   - 비즈노에 없는 번호 → null("상호명 미확인"으로 표시)
 *   - 오류/타임아웃(3초) → 조용히 null 반환, 기존 조회 무영향
 *   - 무료 200건/일 → 같은 번호 당일 캐시로 재조회 차단
 *   - 토큰은 만료 전까지 재사용(메모리 캐시)
 */

const axios = require('axios');

const BASE       = process.env.BIZNO_API_BASE || 'https://api.moneypin.biz';
const TOKEN_PATH = '/bizno/v1/auth/token';
const INFO_PATH  = '/bizno/v1/biz/info/base';
const TIMEOUT_MS = 3000;

// 상호명 후보 필드(응답 스키마 변형 대비 방어적 탐색)
const NAME_KEYS = [
  'company', 'companyName', 'company_nm', 'companyNm', 'corpNm', 'corpName',
  'bizNm', 'trueName', 'name', 'enterprise', '상호', '상호명', '회사명',
];
// 토큰 후보 필드
const TOKEN_KEYS = ['accessToken', 'access_token', 'token', 'authToken', 'jwt'];

// ── 캐시 ──────────────────────────────────────────────────────
let tokenCache = { token: null, exp: 0 };          // 토큰 캐시(만료시각 ms)
const nameCache = new Map();                        // Map<bno,{name,date}> 당일 캐시

function todayStr() { return new Date().toISOString().slice(0, 10); }
function nowMs()    { return new Date().getTime(); }

function creds() {
  return {
    clientId:     process.env.BIZNO_CLIENT_ID     || '',
    clientSecret: process.env.BIZNO_CLIENT_SECRET || '',
  };
}
function hasCreds() {
  const { clientId, clientSecret } = creds();
  return !!clientId && !!clientSecret
    && !clientId.startsWith('your_') && !clientSecret.startsWith('your_');
}

// 응답 객체에서 후보 키의 첫 문자열 값을 재귀 탐색
function pickString(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const found = pickString(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── 1) 토큰 발급(캐시) ────────────────────────────────────────
async function getToken() {
  if (tokenCache.token && tokenCache.exp > nowMs() + 5000) return tokenCache.token;
  if (!hasCreds()) return null;

  const { clientId, clientSecret } = creds();
  const r = await axios.post(BASE + TOKEN_PATH,
    { grantType: 'client_credentials', clientId, clientSecret },
    { timeout: TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } });

  const token = pickString(r.data, TOKEN_KEYS);
  if (token) {
    const ttlSec = r.data?.expiresIn || r.data?.expires_in || r.data?.data?.expiresIn || 1800;
    tokenCache = { token, exp: nowMs() + ttlSec * 1000 };
  }
  return token;
}

// ── 2) 기본정보 조회 → 상호명 파싱 ────────────────────────────
async function fetchName(bno, token) {
  // 사업자번호 필드명이 확정 전이라 후보 키를 함께 전송(미사용 필드는 서버가 무시).
  const body = { bizNumber: bno, businessNumber: bno, bizNo: bno, bno };
  const r = await axios.post(BASE + INFO_PATH, body, {
    timeout: TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  if (r.status !== 200) {
    const msg = (r.data && (r.data.message || r.data.error)) || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.httpStatus = r.status;
    throw err;
  }
  return pickString(r.data, NAME_KEYS);
}

// ── 라이브 조회 ───────────────────────────────────────────────
async function fetchCompanyNameLive(bno) {
  if (!hasCreds()) return { companyName: null, found: false, dataSource: 'NONE' };
  const token = await getToken();
  if (!token) return { companyName: null, found: false, dataSource: 'NOTOKEN' };
  const name = await fetchName(bno, token);
  return { companyName: name, found: !!name, dataSource: 'LIVE' };
}

/**
 * 상호명 조회 (절대 throw 하지 않음 — 병렬 실행 시 기존 흐름 보호)
 * @returns {Promise<{companyName: string|null, found: boolean, dataSource: string}>}
 */
async function getCompanyName(businessNumber) {
  const bno = (businessNumber || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(bno)) return { companyName: null, found: false, dataSource: 'NONE' };

  const today = todayStr();
  const hit = nameCache.get(bno);
  if (hit && hit.date === today) {
    return { companyName: hit.name, found: !!hit.name, dataSource: 'CACHE' };
  }

  try {
    const result = await fetchCompanyNameLive(bno);
    // 성공(없음 포함)만 당일 캐시. 오류/토큰없음은 캐시 안 함(재시도 여지).
    if (result.dataSource === 'LIVE') {
      nameCache.set(bno, { name: result.companyName, date: today });
    }
    return result;
  } catch (e) {
    console.warn('[BIZNO 상호명 조회 실패 → 미확인 처리]', e.code || e.message);
    return { companyName: null, found: false, dataSource: 'ERROR' };
  }
}

module.exports = { getCompanyName };
