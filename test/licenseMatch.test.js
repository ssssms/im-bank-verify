/**
 * 인허가 사업체 특정 엔진 단위 테스트 — False Positive 를 특히 본다.
 * 실행: node test/licenseMatch.test.js
 */
const assert = require('assert');
const { normalizeBusinessName, parseAddress, rankCandidates } = require('../utils/licenseMatch');

let n = 0;
const ok = (msg, fn) => { fn(); n++; console.log(`  ✓ ${msg}`); };
const row = (name, road, status = '영업', lot = '') => ({ item: { BPLC_NM: name, ROAD_NM_ADDR: road, LOTNO_ADDR: lot, DTL_SALS_STTS_NM: status }, type: '일반음식점' });
const top = (cands, ref) => rankCandidates(cands, ref)[0];

console.log('licenseMatch');

ok('법인 표기·공백·괄호 정규화: (주) ABC 푸드 = 주식회사 ABC푸드 = ABC푸드', () => {
  assert.strictEqual(normalizeBusinessName('(주) ABC 푸드'), 'abc푸드');
  assert.strictEqual(normalizeBusinessName('주식회사 ABC푸드'), 'abc푸드');
  assert.strictEqual(normalizeBusinessName('㈜ABC푸드'), 'abc푸드');
  assert.strictEqual(normalizeBusinessName('알에스 (RS)다나재활의학과의원'), '알에스다나재활의학과의원');
});

ok('주소 파싱: 시도·시군구·도로명·건물번호·법정동', () => {
  const p = parseAddress('서울특별시 중구 통일로 10 (남대문로5가)');
  assert.deepStrictEqual([p.sidoShort, p.sigungu, p.road, p.building, p.dong], ['서울', '중구', '통일로', '10', '남대문로']);
  assert.strictEqual(parseAddress('대구광역시 중구 달구벌대로447길 58 (삼덕동3가, 지상1층)').dong, '삼덕동');
  const q = parseAddress('경기도 수원시 장안구 서부로 2136, 2층 (율전동)');
  assert.deepStrictEqual([q.sigungu, q.road, q.building, q.dong], ['수원시 장안구', '서부로', '2136', '율전동']);
});

const ref = { storeName: 'ABC치킨', region: { sido: '대구광역시', sigungu: '수성구', dong: '범어1동' }, address: '대구광역시 수성구 동대구로 123' };

ok('상호+주소 완전 일치 → EXACT', () => {
  const r = top([row('ABC치킨', '대구광역시 수성구 동대구로 123 (범어동)')], ref);
  assert.strictEqual(r.confidence, 'EXACT'); assert.ok(r.matchScore >= 92, r.matchScore);
});

ok('(주)/주식회사 차이 → 상호 일치로 본다', () => {
  const r = top([row('주식회사 ABC치킨', '대구광역시 수성구 동대구로 123')], { ...ref, storeName: '(주)ABC치킨' });
  assert.strictEqual(r.nameScore, 40);
});

ok('주소 띄어쓰기 차이 → 동일', () => {
  const r = top([row('ABC치킨', '대구광역시  수성구 동대구로  123')], ref);
  assert.ok(r.confidence === 'EXACT' || r.confidence === 'HIGH', r.confidence);
});

ok('동일 상호 + 다른 시군구 → LOW 이하 (False Positive 차단)', () => {
  const r = top([row('ABC치킨', '부산광역시 해운대구 해운대로 20')], ref);
  assert.ok(r.confidence === 'LOW' || r.confidence === 'NONE', r.confidence);
});

ok('같은 구, 같은 도로, 건물번호 다름 → 강감점, HIGH 미만', () => {
  const r = top([row('ABC치킨', '대구광역시 수성구 동대구로 456')], ref);
  assert.ok(r.confidence !== 'EXACT' && r.confidence !== 'HIGH', `${r.confidence} ${r.matchScore}`);
  assert.ok(r.misses.some(m => m.startsWith('건물번호 불일치')));
});

ok('같은 주소 + 비슷한 상호(본점 접미) → 동일 가능성 HIGH 이상', () => {
  const r = top([row('ABC치킨 본점', '대구광역시 수성구 동대구로 123')], ref);
  assert.ok(r.confidence === 'EXACT' || r.confidence === 'HIGH', r.confidence);
});

ok('같은 주소 + 상호 일부 변경(ABC치킨앤비어) → 부분 일치, MEDIUM~HIGH', () => {
  const r = top([row('ABC치킨앤비어', '대구광역시 수성구 동대구로 123')], ref);
  assert.ok(['HIGH', 'MEDIUM'].includes(r.confidence), r.confidence);
  assert.ok(r.reasons.includes('상호 부분 일치'));
});

ok('폐업 후보는 영업 점수 0, 영업 중 후보가 앞에 온다', () => {
  const rows = rankCandidates([row('ABC치킨', '대구광역시 수성구 동대구로 123', '폐업'), row('ABC치킨', '대구광역시 수성구 동대구로 123', '영업')], ref);
  assert.strictEqual(rows[0].active, true); assert.strictEqual(rows[1].statusScore, 0);
});

ok('동명이업체 다수: 같은 시군구·같은 건물이 1위, 타 지역은 LOW', () => {
  const rows = rankCandidates([
    row('ABC치킨', '서울특별시 강남구 테헤란로 1'),
    row('ABC치킨', '대구광역시 달서구 월배로 30'),
    row('ABC치킨', '대구광역시 수성구 동대구로 123'),
  ], ref);
  assert.strictEqual(rows[0].address, '대구광역시 수성구 동대구로 123');
  assert.ok(rows.slice(1).every(r => r.confidence === 'LOW' || r.confidence === 'NONE'));
});

ok('참조 주소·BC 지역이 전혀 없으면 EXACT/HIGH 를 주지 않는다(MEDIUM 상한)', () => {
  const r = top([row('ABC치킨', '대구광역시 수성구 동대구로 123')], { storeName: 'ABC치킨', region: null, address: null });
  assert.ok(r.confidence !== 'EXACT' && r.confidence !== 'HIGH', r.confidence);
});

ok('BC 지역만 있고 네이버 주소가 없어도 시군구+행정동 일치면 HIGH', () => {
  const r = top([row('ABC치킨', '대구광역시 수성구 동대구로 123 (범어동)')], { storeName: 'ABC치킨', region: ref.region, address: null });
  assert.strictEqual(r.confidence, 'HIGH');
});

ok('인허가 데이터 없음 → 후보 0건', () => {
  assert.deepStrictEqual(rankCandidates([], ref), []);
});

ok('업종 동의어: 삼덕동빵집 = 삼덕동베이커리 = 삼덕동제과점, 검색어 변형 생성', () => {
  const { synonymVariants } = require('../utils/licenseMatch');
  assert.strictEqual(normalizeBusinessName('삼덕동베이커리'), normalizeBusinessName('삼덕동빵집'));
  assert.strictEqual(normalizeBusinessName('삼덕동제과점'), normalizeBusinessName('삼덕동빵집'));
  assert.strictEqual(normalizeBusinessName('초이 커피숍'), normalizeBusinessName('초이카페'));
  const v = synonymVariants('삼덕동빵집');
  assert.ok(v.includes('삼덕동베이커리') && v.includes('삼덕동제과점'), v.join(','));
  assert.deepStrictEqual(synonymVariants('호텔스타'), []);
});

ok('동의어 + 같은 주소 → 「삼덕동베이커리까페」는 「삼덕동빵집」의 HIGH 이상', () => {
  const r = top([row('삼덕동베이커리까페', '대구광역시 중구 달구벌대로447길 58 (삼덕동3가, 지상1층)')], { storeName: '삼덕동빵집', region: { sido: '대구광역시', sigungu: '중구', dong: '삼덕동' }, address: '대구광역시 중구 달구벌대로447길 58 1층' });
  assert.ok(r.confidence === 'EXACT' || r.confidence === 'HIGH', `${r.confidence} ${r.matchScore}`);
});

console.log(`✅ ${n}건 통과`);
