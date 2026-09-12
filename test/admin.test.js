/**
 * 관리자 룰 조정 테스트 — 기준값을 바꾸면 같은 번호의 판정이 바뀌는지, 되돌리면 원래대로인지.
 *
 * 실행: npm run admin:test   (backend/ 에서)
 *  - ADMIN_ENABLED/ADMIN_TOKEN 을 이 프로세스 안에서만 설정하고 verify + admin 라우터를 임시 포트에 띄운다.
 *  - 룰 오버라이드는 메모리라 이 프로세스가 끝나면 사라진다 (demo.test.js 와 격리).
 *
 * [확인 항목]
 *   인증: 토큰 없음/틀림 → 401
 *   범위: 승인 컷 101, 보류 컷 ≥ 승인 컷, 모르는 키 → 400 (아무것도 안 바뀜)
 *   시연 A: 1293284715(55 보류) — 보류 컷 50→60 → 거절 / 승인 컷 80→55 → 승인 / 사용자 제안 "보류 컷 50→40" 은 55 ≥ 40 이라 보류 유지(기록)
 *   시연 B: 2208162346(100 승인) — 순고객 기준 50→200 → 98점 승인 유지(③ 6→4) / 업력 필수 개월 6→96 → 보류(카드매출 6개월 미만, INELIGIBLE)
 *   이력: { at, key, from, to } 가 쌓이고, reset 후 5건 기대값 복원
 */
require('dotenv').config();
process.env.ADMIN_ENABLED = 'true';
process.env.ADMIN_TOKEN = 'test-token-' + Date.now();

const assert = require('assert');
const axios = require('axios');
const express = require('express');

const PORT = Number(process.env.ADMIN_TEST_PORT) || 4097;
const BASE = `http://localhost:${PORT}`;
const H = { headers: { 'x-admin-token': process.env.ADMIN_TOKEN } };

const EXPECTED = { '2208162346': ['APPROVED', 100], '1293284715': ['PENDING', 55], '5142691320': ['INELIGIBLE', 60], '6211957068': ['REJECTED', 75], '2144028530': ['REJECTED', 0] };

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; }
}
async function verify(num) {
  const r = await axios.post(`${BASE}/api/verify/business`, { businessNumber: num, consentGiven: true, storeName: 'test' });
  const ts = r.data.trustScore;
  const fds = ts.breakdown.find(b => b.step === 4);
  return { verdict: ts.verdict.verdict, total: ts.totalScore, fds: fds.score, customerPt: (fds.subScores || []).find(s => s.key === 'customer')?.score ?? null, reasons: (ts.verdict.reasons || []).map(x => x.code) };
}
async function put(body, opts = H) {
  try { return (await axios.put(`${BASE}/api/admin/rules`, body, opts)).data; }
  catch (e) { return { status: e.response?.status, ...(e.response?.data || {}) }; }
}
async function reset() { return (await axios.post(`${BASE}/api/admin/rules/reset`, {}, H)).data; }
async function get(opts = H) {
  try { return (await axios.get(`${BASE}/api/admin/rules`, opts)).data; }
  catch (e) { return { status: e.response?.status, ...(e.response?.data || {}) }; }
}
const field = (snap, key) => snap.fields.find(f => f.key === key);

async function run() {
  const app = express();
  app.use(express.json());
  app.use('/api/verify', require('../routes/verify'));
  app.use('/api/admin', require('../routes/admin'));
  const server = await new Promise(res => { const s = app.listen(PORT, () => res(s)); });
  console.log('admin.test.js');

  try {
    // ── 인증 ──
    const noTok = await get({});
    check('토큰 없음 → 401', () => assert.strictEqual(noTok.status, 401));
    const badTok = await get({ headers: { 'x-admin-token': 'wrong' } });
    check('토큰 틀림 → 401', () => assert.strictEqual(badTok.status, 401));
    const snap0 = await get();
    check('GET: 7개 필드 · 기본값 = 현재값 · 이력 0', () => {
      assert.strictEqual(snap0.fields.length, 7);
      assert.ok(snap0.fields.every(f => f.value === f.defaultValue && !f.overridden));
      assert.strictEqual(snap0.history.length, 0);
      assert.strictEqual(field(snap0, 'CUSTOMER_MIN').value, 50);
      assert.strictEqual(field(snap0, 'CUSTOMER_RATIO_MIN').value, 0.5);
      assert.strictEqual(field(snap0, 'TX_MIN').value, 30);
    });

    // ── 범위 검증 ──
    const r1 = await put({ APPROVED_CUT: 101 });
    check('승인 컷 101 → 400', () => assert.strictEqual(r1.status, 400));
    const r2 = await put({ PENDING_CUT: 80 });
    check('보류 컷 80 (승인 컷 80 이상) → 400', () => assert.strictEqual(r2.status, 400));
    const r3 = await put({ FOO: 1 });
    check('모르는 키 → 400', () => assert.strictEqual(r3.status, 400));
    const r4 = await put({ APPROVED_CUT: 90, PENDING_CUT: 95 });
    check('일괄 갱신 중 하나가 틀리면 전부 거부', () => assert.strictEqual(r4.status, 400));
    const r5 = await put({ CUSTOMER_MIN: 10.5 });
    check('정수 키에 소수 → 400', () => assert.strictEqual(r5.status, 400));
    const snapAfterBad = await get();
    check('거부된 요청은 아무것도 안 바꿈', () => assert.ok(snapAfterBad.fields.every(f => !f.overridden)) && assert.strictEqual(snapAfterBad.history.length, 0));

    // ── 시연 A: 1293284715 (55 보류) ──
    const a0 = await verify('1293284715');
    check('A0 기본: 1293284715 = PENDING 55', () => assert.deepStrictEqual([a0.verdict, a0.total], ['PENDING', 55]));
    await put({ PENDING_CUT: 40 });
    const a1 = await verify('1293284715');
    check('A1 보류 컷 50→40 (사용자 제안): 55 ≥ 40 이라 PENDING 유지 — 판정 안 바뀜(기록)', () => assert.deepStrictEqual([a1.verdict, a1.total], ['PENDING', 55]));
    await put({ PENDING_CUT: 60 });
    const a2 = await verify('1293284715');
    check('A2 보류 컷 50→60: PENDING → REJECTED (총점 55 불변)', () => assert.deepStrictEqual([a2.verdict, a2.total], ['REJECTED', 55]));
    await reset();
    await put({ APPROVED_CUT: 55 });
    const a3 = await verify('1293284715');
    check('A3 승인 컷 80→55: PENDING → APPROVED (총점 55 불변)', () => assert.deepStrictEqual([a3.verdict, a3.total], ['APPROVED', 55]));
    await reset();
    const a4 = await verify('1293284715');
    check('A4 기본값 복원 → PENDING 55', () => assert.deepStrictEqual([a4.verdict, a4.total], ['PENDING', 55]));

    // ── 시연 B: 2208162346 (100 승인) ──
    await put({ CUSTOMER_MIN: 200 });
    const b1 = await verify('2208162346');
    check('B1 순고객 기준 50→200 (사용자 제안): 순고객 162명 → ③ 6→4점, 총점 98, APPROVED 유지 — 판정 안 바뀜(기록)', () =>
      assert.deepStrictEqual([b1.verdict, b1.total, b1.fds, b1.customerPt], ['APPROVED', 98, 38, 13]));
    await reset();
    await put({ MIN_BUSINESS_MONTHS: 96 });
    const b2 = await verify('2208162346');
    check('B2 업력 필수 개월 6→96: 업력 7.4년(88개월) → INELIGIBLE(NEW_BUSINESS)', () => {
      assert.strictEqual(b2.verdict, 'INELIGIBLE'); assert.ok(b2.reasons.includes('NEW_BUSINESS'));
    });
    await reset();
    await put({ APPROVED_CUT: 99, CUSTOMER_MIN: 200 });
    const b3 = await verify('2208162346');
    check('B3 승인 컷 99 + 순고객 기준 200: 98점 → PENDING', () => assert.deepStrictEqual([b3.verdict, b3.total], ['PENDING', 98]));
    await reset();
    await put({ CUSTOMER_RATIO_MIN: 0.95, TX_MIN: 200 });
    const b4 = await verify('2208162346');
    check('B4 비율 0.5→0.95 · 결제건수 30→200: 비율 0.90→4점, 180건→3점 → 총점 96 APPROVED', () => assert.deepStrictEqual([b4.verdict, b4.total], ['APPROVED', 96]));
    await reset();

    // ── 카드매출 필수 월수 ──
    await put({ MIN_SALES_MONTHS: 7 });
    const c1 = await verify('2208162346');
    check('카드매출 필수 월수 6→7: 시연 데이터 최대 6개월 → INELIGIBLE(INSUFFICIENT_SALES_MONTHS)', () => {
      assert.strictEqual(c1.verdict, 'INELIGIBLE'); assert.ok(c1.reasons.includes('INSUFFICIENT_SALES_MONTHS'));
    });
    await reset();

    // ── 이력 ──
    const snapH = await get();
    check('이력에 { at, key, from, to } 가 쌓임 (최근 것이 앞)', () => {
      assert.ok(snapH.history.length >= 10);
      const h = snapH.history[0];
      assert.ok(h.at && h.key && 'from' in h && 'to' in h && h.label);
      assert.ok(snapH.history.some(x => x.key === 'PENDING_CUT' && x.from === 50 && x.to === 40)); // 첫 변경
      assert.ok(snapH.history.some(x => x.key === 'PENDING_CUT' && x.from === 40 && x.to === 60)); // from 은 직전 값
      assert.ok(snapH.history.some(x => x.key === 'CUSTOMER_MIN' && x.from === 50 && x.to === 200));
      assert.ok(snapH.history.some(x => x.reset === true));
    });
    check('reset 뒤 오버라이드 0', () => assert.ok(snapH.fields.every(f => !f.overridden && f.value === f.defaultValue)));
    const same = await put({ APPROVED_CUT: 80 });
    check('같은 값으로 PUT → 이력 안 쌓임', () => assert.strictEqual(same.changed.length, 0));

    // ── 최종: 5건 기대값 복원 ──
    for (const [num, [v, t]] of Object.entries(EXPECTED)) {
      const r = await verify(num);
      check(`복원 확인 ${num} = ${v} ${t}`, () => assert.deepStrictEqual([r.verdict, r.total], [v, t]));
    }
  } finally {
    server.close();
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass}건 통과${fail ? ` · ${fail}건 실패` : ''}`);
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
