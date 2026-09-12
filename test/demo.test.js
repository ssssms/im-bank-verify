/**
 * 시연번호 회귀 테스트 — CLAUDE.md "수정 전 반드시 테스트" 스니펫의 정식 스크립트판.
 *
 * 실행: npm run demo:test                      (backend/ 에서)
 *       npm run demo:test -- --update-baseline (기준선 JSON 을 현재 결과로 갱신 — 정책 변경을 확정할 때만)
 *
 *  - 서버를 임시 포트(기본 4099)에 직접 띄우고 POST /api/verify/business 로 5건 호출
 *  - 총점·판정·4단계 점수·게이트 레벨·다음 절차 유형을 표로 출력
 *  - 현재 응답 JSON 전체를 test/results/<번호>.json 에 저장
 *  - test/baseline/<번호>.json 은 비교 기준선(정책 변경 전 스냅샷). 갱신은 --update-baseline 으로만.
 *  - 기대 판정·총점·게이트·nextStep 이 다르면 FAIL, 종료코드 1
 *
 * [기대값 — 2026-09-08 판정 4종 정책]
 *   2208162346 APPROVED   100  총점 불변(기준선 100)
 *   1293284715 PENDING     55  6개월 매출 채움(mock 예외 수정) → 보류(자동해제 기준 미달) 시연
 *   5142691320 INELIGIBLE  60  업력 4개월 + 카드매출 없음 → 보류(카드매출 6개월 미만, 다시 신청 시점 안내)
 * [2026-09-12] nextStep 유형 개명: REMOTE_REVIEW→REAPPLY_AFTER_REMEDY · BRANCH_INSPECTION→RELEASE_UNAVAILABLE · BRANCH_CURRENT_PROCESS→REAPPLY_AFTER_MONTHS
 *   6211957068 REJECTED    75  게이트 BLOCK, 총점 불변(기준선 75)
 *   2144028530 REJECTED     0  폐업, 총점 불변(기준선 0)
 */
require('dotenv').config();
const path  = require('path');
const fs    = require('fs');
const assert = require('assert');
const axios = require('axios');
const express = require('express');

const PORT = Number(process.env.DEMO_TEST_PORT) || 4099;
const BASELINE_DIR = path.join(__dirname, 'baseline');
const RESULTS_DIR  = path.join(__dirname, 'results');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

// 시연 5건 기대값. baselineTotal = 정책 변경 전 스냅샷과 같아야 하는 총점(null 이면 변경 허용)
const CASES = [
  { num: '2208162346', label: '우량 사업자',              verdict: 'APPROVED',   total: 100, gate: 'NONE',  next: 'AUTO_RELEASE',           baselineTotal: 100 },
  { num: '1293284715', label: '기존 사업자·규모 약함',     verdict: 'PENDING',    total: 55,  gate: 'WATCH', next: 'REAPPLY_AFTER_REMEDY',   baselineTotal: null },
  { num: '5142691320', label: '신설(업력 4개월·카드매출 없음)', verdict: 'INELIGIBLE', total: 60, gate: 'NONE', next: 'REAPPLY_AFTER_MONTHS',   baselineTotal: null },
  { num: '6211957068', label: '가장매출 의심(게이트 BLOCK)', verdict: 'REJECTED',   total: 75,  gate: 'BLOCK', next: 'RELEASE_UNAVAILABLE',    baselineTotal: 75 },
  { num: '2144028530', label: '폐업 사업자',              verdict: 'REJECTED',   total: 0,   gate: 'NONE',  next: 'RELEASE_UNAVAILABLE',    baselineTotal: 0 },
];

function pad(s, w) {
  const str = String(s);
  let width = 0;
  for (const ch of str) width += /[ᄀ-ᇿ　-〿가-힯＀-￯]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, w - width));
}

function readBaseline(num) {
  try { return JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, `${num}.json`), 'utf8')); }
  catch { return null; }
}

async function run() {
  const app = express();
  app.use(express.json());
  app.use('/api/verify', require('../routes/verify'));
  const server = await new Promise((resolve) => { const s = app.listen(PORT, () => resolve(s)); });

  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const rows = [];
  const failures = [];

  try {
    for (const c of CASES) {
      let data;
      try {
        const r = await axios.post(`http://localhost:${PORT}/api/verify/business`, {
          businessNumber: c.num, consentGiven: true, storeName: 'test',
        });
        data = r.data;
      } catch (e) {
        failures.push(`${c.num}: 요청 실패 — ${e.response?.data?.error || e.message}`);
        rows.push({ num: c.num, label: c.label, error: e.response?.data?.error || e.message });
        continue;
      }

      fs.writeFileSync(path.join(RESULTS_DIR, `${c.num}.json`), JSON.stringify(data, null, 2), 'utf8');
      if (UPDATE_BASELINE) {
        fs.writeFileSync(path.join(BASELINE_DIR, `${c.num}.json`), JSON.stringify(data, null, 2), 'utf8');
      }

      const ts = data.trustScore;
      const steps = [1, 2, 3, 4].map((n) => ts.breakdown.find((b) => b.step === n)?.score ?? '-');
      const gateLevel = ts.gate?.level ?? 'NONE';
      const verdict = ts.verdict.verdict;
      const next = ts.verdict.nextStep?.type ?? '-';
      const base = readBaseline(c.num);
      const baseTotal = base?.trustScore?.totalScore ?? '-';

      // ── assert ──
      const errs = [];
      try { assert.strictEqual(verdict, c.verdict, `판정 ${verdict} ≠ ${c.verdict}`); } catch (e) { errs.push(e.message); }
      try { assert.strictEqual(ts.totalScore, c.total, `총점 ${ts.totalScore} ≠ ${c.total}`); } catch (e) { errs.push(e.message); }
      try { assert.strictEqual(gateLevel, c.gate, `게이트 ${gateLevel} ≠ ${c.gate}`); } catch (e) { errs.push(e.message); }
      try { assert.strictEqual(next, c.next, `nextStep ${next} ≠ ${c.next}`); } catch (e) { errs.push(e.message); }
      if (c.baselineTotal != null && base) {
        try { assert.strictEqual(ts.totalScore, base.trustScore.totalScore, `기준선 총점 ${base.trustScore.totalScore} 와 다름`); } catch (e) { errs.push(e.message); }
      }
      if (verdict !== 'APPROVED' && verdict !== 'PENDING' && verdict !== 'REJECTED' && verdict !== 'INELIGIBLE') errs.push(`알 수 없는 판정 ${verdict}`);
      if (!ts.verdict.nextStep) errs.push('nextStep 없음');
      if (verdict === 'PENDING' && (ts.verdict.nextStep.docs || []).length) errs.push('보류에 서류 목록이 붙음');
      if (verdict === 'REJECTED' && (ts.verdict.nextStep.docs || []).length) errs.push('거절에 서류 목록이 붙음');
      if (verdict === 'INELIGIBLE' && !ts.verdict.nextStep.reapplyFrom && (ts.verdict.reasons || []).some(r => r.code !== 'NO_CARD_DATA')) errs.push('다시 신청 시점(reapplyFrom) 없음');
      if (verdict === 'INELIGIBLE' && !(ts.verdict.reasons || []).length) errs.push('카드매출 6개월 미만 보류에 사유 없음');

      if (errs.length) failures.push(`${c.num}: ${errs.join(' / ')}`);
      rows.push({
        num: c.num, label: c.label, total: ts.totalScore, baseTotal, verdict, steps, gateLevel, next,
        reasons: verdict === 'INELIGIBLE' ? (ts.verdict.reasons || []).map(r => r.code).join(',') : '',
        ok: errs.length === 0,
      });
    }
  } finally {
    server.close();
  }

  const header = [
    pad('사업자번호', 12), pad('구분', 30), pad('총점', 5), pad('기준선', 7), pad('판정', 11),
    pad('NTS', 4), pad('위치', 5), pad('인허가', 7), pad('FDS', 4), pad('게이트', 7), pad('다음 절차', 24), '결과',
  ].join(' | ');
  console.log('\n' + header);
  console.log('-'.repeat(140));
  for (const r of rows) {
    if (r.error) { console.log([pad(r.num, 12), pad(r.label, 30), 'ERROR: ' + r.error].join(' | ')); continue; }
    console.log([
      pad(r.num, 12), pad(r.label, 30), pad(r.total, 5), pad(r.baseTotal, 7), pad(r.verdict, 11),
      pad(r.steps[0], 4), pad(r.steps[1], 5), pad(r.steps[2], 7), pad(r.steps[3], 4),
      pad(r.gateLevel, 7), pad(r.next + (r.reasons ? ` (${r.reasons})` : ''), 24), r.ok ? 'OK' : 'FAIL',
    ].join(' | '));
  }
  console.log(`\n결과 저장: ${path.relative(process.cwd(), RESULTS_DIR)}/<번호>.json · 기준선: ${path.relative(process.cwd(), BASELINE_DIR)}/<번호>.json${UPDATE_BASELINE ? ' (갱신됨)' : ''}`);
  if (failures.length) {
    console.log(`\n❌ ${failures.length}건 불일치`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(`\n✅ ${CASES.length}건 모두 기대값과 일치`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
