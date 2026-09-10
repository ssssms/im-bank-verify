/**
 * ============================================================
 * 인허가 후보 매칭 — 사업체 특정(동일 사업체 판정) 엔진 (2026-09-11)
 * ============================================================
 *
 * 인허가 원장(지방행정인허가)에는 사업자번호가 없다. 상호 LIKE 검색으로 온 후보 중 「입력한 바로 그 사업체」를
 * 고르기 위해 상호·주소·영업 상태로 0~100 점을 매기고 신뢰도 등급을 붙인다. 비슷한 가게를 보여주는 게 아니라
 * 잘못된 가게의 인허가를 보여주는 False Positive 를 막는 것이 목적이다.
 *
 *  배점  상호 40 · 주소 50 · 영업 상태 10
 *  주소  시군구(시도 포함) 20 → 도로명 15 → 건물번호 10 → 행정동 5. 도로명이 같은데 건물번호가 다르면 강감점(주소 20점 상한)
 *  등급  EXACT ≥ 92 (상호 완전 + 건물번호 일치) / HIGH ≥ 75 / MEDIUM ≥ 55 / LOW ≥ 30 / NONE
 *        인허가 20점은 HIGH 이상만. MEDIUM 이하는 「동일 사업체 여부를 추가로 확인해야 합니다」
 *
 *  rankCandidates(candidates, ref) → [{ item, type, name, address, status, active, nameScore, addrScore, statusScore,
 *                                       matchScore, confidence, reasons[], parts }]  (점수 내림차순)
 *  ref = { storeName, region: {sido,sigungu,dong}|null, address: 네이버 도로명주소|null, jibunAddress|null }
 *
 *  normalizeBusinessName / parseAddress / scoreName / scoreAddress 도 export (단위 테스트용)
 */

// ── 상호 정규화 ───────────────────────────────────────────────
//   법인 표기((주)·주식회사·㈜·유한회사·(유)·재단법인·사단법인)·공백·특수문자·괄호(내용 포함)·대소문자 차이를 없앤다.
//   원본은 절대 바꾸지 않는다 — 비교용 문자열만 만든다.
const CORP_WORDS = /(주식회사|유한회사|유한책임회사|합자회사|합명회사|재단법인|사단법인|농업회사법인|영농조합법인|\(주\)|（주）|㈜|\(유\)|（유）|\(재\)|\(사\))/g;
const BRANCH_WORDS = /(본점|본사|직영점|점)$/;
function normalizeBusinessName(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\(（][^\)）]*[\)）]/g, ' ')   // 괄호와 그 안의 병기(영문 등)
    .replace(CORP_WORDS, ' ')
    .replace(/[\s·\-_,.&'"~!@#$%^*+=\[\]{}|\\/:;<>?`]/g, '')
    .toLowerCase();
}
const nameVariants = raw => {
  const n = normalizeBusinessName(raw);
  const out = new Set([n]);
  const noBranch = n.replace(BRANCH_WORDS, '');
  if (noBranch && noBranch !== n && noBranch.length >= 2) out.add(noBranch);
  out.delete('');
  return [...out];
};

/** 상호 점수 0~40 */
function scoreName(candidateName, inputName) {
  const cs = nameVariants(candidateName), is = nameVariants(inputName);
  if (!cs.length || !is.length) return { score: 0, level: 'none' };
  for (const c of cs) for (const i of is) if (c === i) return { score: 40, level: 'exact' };
  let best = { score: 0, level: 'none' };
  for (const c of cs) for (const i of is) {
    const short = c.length <= i.length ? c : i, long = c.length <= i.length ? i : c;
    if (short.length >= 3 && long.includes(short)) {
      // 포함: 짧은 쪽 비율이 클수록 높게 (「나살던고향」⊂「나살던고향집」 0.83 → 30점, 「오군」⊂「오군수제돈까스」는 2글자라 제외)
      const s = Math.round(20 + 15 * (short.length / long.length));
      if (s > best.score) best = { score: s, level: 'contains' };
    }
  }
  return best;
}

// ── 주소 파싱 ─────────────────────────────────────────────────
//   도로명주소 「서울특별시 중구 통일로 10 (남대문로5가)」 / 지번 「서울특별시 중구 남대문로5가 120」
//   → { sido, sidoShort, sigungu, road, building, dong, raw }
const SIDO_SUFFIX = /(특별시|광역시|특별자치시|특별자치도|도)$/;
function parseAddress(addr) {
  const raw = String(addr || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const s = raw.replace(/^(대한민국|한국)\s*/, '').replace(/\(우\)?\s*\d{5}\)?/g, '');
  const parts = s.split(' ');
  const sido = parts[0] || '';
  const sidoShort = sido.replace(SIDO_SUFFIX, '');
  // 시군구: 시도 다음 1~2토큰 (예: 「수원시 장안구」)
  let sigungu = parts[1] || '';
  if (/^[가-힣]+시$/.test(sigungu) && /^[가-힣]+구$/.test(parts[2] || '')) sigungu = `${sigungu} ${parts[2]}`;
  const roadMatch = s.match(/([가-힣A-Za-z0-9·]+(?:대로|로|길))\s*(\d+(?:-\d+)?)/);
  const road = roadMatch ? roadMatch[1] : null;
  const building = roadMatch ? roadMatch[2] : null;
  const dongMatch = s.match(/\(([가-힣0-9]+(?:동|가|읍|면|리))[^)]*\)/) || s.match(/\s([가-힣]+\d*(?:동|읍|면|리))(?:\s|$)/);
  const dong = dongMatch ? dongMatch[1].replace(/\d+(동|가)$/, '$1') : null;
  return { raw, sido, sidoShort, sigungu, road, building, dong };
}

/** 주소 점수 0~50 + 사유. ref.address(네이버)·ref.region(BC) 중 있는 것으로 비교 */
function scoreAddress(candidateAddr, ref) {
  const c = parseAddress(candidateAddr);
  const n = parseAddress(ref?.address);
  const j = parseAddress(ref?.jibunAddress);
  const region = ref?.region || null;
  const reasons = [], misses = [];
  if (!c || (!n && !region && !j)) return { score: null, reasons, misses, parts: null };

  let score = 0;
  // 시군구(시도까지)
  const refSido = n?.sidoShort || (region?.sido || '').replace(SIDO_SUFFIX, '') || j?.sidoShort || '';
  const refSigungu = n?.sigungu || region?.sigungu || j?.sigungu || '';
  const sigunguOk = !!refSigungu && c.sigungu === refSigungu && (!refSido || c.sidoShort === refSido);
  if (sigunguOk) { score += 20; reasons.push(region ? 'BC 등록 시군구 일치' : '시군구 일치'); }
  else if (refSigungu) misses.push('시군구 불일치');

  // 도로명 + 건물번호 (네이버 주소가 있을 때)
  if (n?.road && c.road) {
    if (c.road === n.road) {
      score += 15; reasons.push('도로명 일치');
      if (n.building && c.building) {
        if (c.building === n.building) { score += 10; reasons.push('건물번호 일치'); }
        else { misses.push(`건물번호 불일치(${c.building}≠${n.building})`); score = Math.min(score, 20); }
      }
    } else if (sigunguOk) misses.push('도로명 불일치');
  }
  // 행정동 (BC 등록 행정동 또는 네이버 지번 동)
  const refDong = (region?.dong || '').replace(/\d+동$/, '동') || j?.dong || n?.dong || null;
  if (refDong && c.dong && c.dong.replace(/\d+동$/, '동') === refDong.replace(/\d+동$/, '동')) { score += 5; reasons.push('행정동 일치'); }

  return { score: Math.min(50, score), reasons, misses, parts: c };
}

const isActiveStatus = s => /^(영업|정상)/.test(String(s || '').trim());

function confidenceOf(total, nm, am) {
  if (total >= 92 && nm.level === 'exact' && am.reasons.includes('건물번호 일치')) return 'EXACT';
  if (total >= 75) return 'HIGH';
  if (total >= 55) return 'MEDIUM';
  if (total >= 30) return 'LOW';
  return 'NONE';
}

/**
 * 후보 채점·정렬. candidates = [{ item(원장 행), type(업종명) }]
 */
function rankCandidates(candidates, ref) {
  const rows = candidates.map(c => {
    const i = c.item || {};
    const name = i.BPLC_NM || '';
    const address = i.ROAD_NM_ADDR || i.LOTNO_ADDR || '';
    const status = i.DTL_SALS_STTS_NM || '';
    const active = isActiveStatus(status);
    const nm = scoreName(name, ref.storeName);
    const am = scoreAddress(`${i.ROAD_NM_ADDR || ''} ${i.LOTNO_ADDR ? '(' + i.LOTNO_ADDR + ')' : ''}`.trim() || address, ref);
    // 주소 근거가 전혀 없으면(참조 주소·BC 지역 모두 없음) 주소 점수는 중립 25 로 두되 EXACT/HIGH 는 못 준다
    const addrScore = am.score === null ? 25 : am.score;
    const statusScore = active ? 10 : 0;
    const total = nm.score + addrScore + statusScore;
    const reasons = [
      nm.level === 'exact' ? '상호 일치' : nm.level === 'contains' ? '상호 부분 일치' : null,
      ...am.reasons,
      active ? '영업 중' : `${status || '상태 미확인'}`,
    ].filter(Boolean);
    let confidence = confidenceOf(total, nm, am);
    if (am.score === null && (confidence === 'EXACT' || confidence === 'HIGH')) confidence = 'MEDIUM'; // 주소 근거 없이는 확정 불가
    if (am.misses.some(m => m.startsWith('시군구 불일치'))) confidence = total >= 30 ? 'LOW' : 'NONE';
    return { item: i, type: c.type, name, address, status, active, nameScore: nm.score, addrScore, statusScore, matchScore: total, confidence, reasons, misses: am.misses, parts: am.parts };
  });
  const rank = { EXACT: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };
  return rows.sort((a, b) => rank[b.confidence] - rank[a.confidence] || b.matchScore - a.matchScore || (b.active - a.active));
}

module.exports = { normalizeBusinessName, parseAddress, scoreName, scoreAddress, rankCandidates, isActiveStatus, confidenceOf };
