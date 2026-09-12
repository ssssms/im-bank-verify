/**
 * SSE 이벤트 로그 — /api/verify/stream 을 돌려 단계별 evidence·elapsedMs·출처 라벨·폴백, done 의 totalElapsedMs 를 콘솔에 찍는다.
 *
 * 실행: npm run demo:sse                       (시연 5건 + 실제 번호 1건)
 *       npm run demo:sse -- 5028107740 또이스치킨 (번호 [상호명] 지정)
 *
 * 실제 번호는 .env 의 USE_MOCK=false + 키가 있어야 Live 를 시도한다. Live 실패 시 fallback=true 로 표시된다.
 */
require('dotenv').config();
const express = require('express');

const PORT = Number(process.env.DEMO_TEST_PORT) || 4097;

const DEFAULT_CASES = [
  { num: '2208162346', name: '(주)맛있는식당' },
  { num: '1293284715', name: '행복마트' },
  { num: '5142691320', name: '새로운분식' },
  { num: '5555555555', name: '스마일카페' },
  { num: '2144028530', name: '옛날서비스' },
  { num: '5028107740', name: '또이스치킨' }, // 실제 번호 — CLAUDE.md 테스트 케이스
];

const argNum = process.argv[2];
const CASES = argNum ? [{ num: argNum, name: process.argv[3] || '' }] : DEFAULT_CASES;

const sec = ms => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);

async function streamOne(base, { num, name }) {
  const url = `${base}/api/verify/stream?businessNumber=${num}&consentGiven=true&storeName=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const summary = { num, name, steps: {}, done: null, ok: true, problems: [] };

  console.log(`\n━━ ${num} ${name ? `(${name})` : ''} ━━`);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));

      if (typeof ev.step === 'number') {
        if (ev.status === 'loading') { console.log(`  [${ev.step}] loading  ${ev.message}`); continue; }
        const tag = `${ev.sourceLabel}${ev.fallback ? ' ⚠ ' + ev.fallbackNote : ''}`;
        console.log(`  [${ev.step}] ${ev.status.padEnd(8)} +${ev.score}점  ${sec(ev.elapsedMs).padStart(5)}  [${tag}]`);
        (ev.evidence || []).forEach(l => console.log(`        · ${l}`));
        summary.steps[ev.step] = { elapsedMs: ev.elapsedMs, evidence: ev.evidence, sourceLabel: ev.sourceLabel, fallback: ev.fallback };
        if (!Array.isArray(ev.evidence) || ev.evidence.length === 0) summary.problems.push(`step ${ev.step}: evidence 비어 있음`);
        if (typeof ev.elapsedMs !== 'number') summary.problems.push(`step ${ev.step}: elapsedMs 없음`);
        if (!ev.sourceLabel) summary.problems.push(`step ${ev.step}: sourceLabel 없음`);
      } else if (ev.step === 'done') {
        const ts = ev.trustScore;
        console.log(`  [done] ${ts.verdict.verdict} ${ts.totalScore}점 · totalElapsedMs=${ev.totalElapsedMs} (${sec(ev.totalElapsedMs)})`);
        const missing = ts.breakdown.filter(b => b.evidence === undefined || b.sourceLabel === undefined).map(b => b.step);
        if (missing.length) summary.problems.push(`done.breakdown evidence/sourceLabel 누락: step ${missing.join(',')}`);
        if (typeof ev.totalElapsedMs !== 'number') summary.problems.push('totalElapsedMs 없음');
        summary.done = { verdict: ts.verdict.verdict, total: ts.totalScore, totalElapsedMs: ev.totalElapsedMs };
      } else if (ev.step === 'error') {
        console.log(`  [error] ${ev.message}`);
        summary.problems.push(`error: ${ev.message}`);
      }
    }
  }
  if (!summary.done) summary.problems.push('done 이벤트 없음');
  summary.ok = summary.problems.length === 0;
  return summary;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/verify', require('../routes/verify'));
  const server = await new Promise(r => { const s = app.listen(PORT, () => r(s)); });
  const base = `http://localhost:${PORT}`;

  const results = [];
  try {
    for (const c of CASES) results.push(await streamOne(base, c));
  } finally {
    server.close();
  }

  console.log('\n━━ 요약 ━━');
  for (const r of results) {
    const stepMs = Object.entries(r.steps).map(([s, v]) => `${s}:${sec(v.elapsedMs)}`).join(' ');
    const fb = Object.entries(r.steps).filter(([, v]) => v.fallback).map(([s]) => s);
    console.log(`  ${r.num.padEnd(11)} ${r.done ? `${r.done.verdict.padEnd(10)} ${String(r.done.total).padStart(3)}점  총 ${sec(r.done.totalElapsedMs)}` : '(미완료)'}  단계 ${stepMs}${fb.length ? `  폴백 step ${fb.join(',')}` : ''}  ${r.ok ? 'OK' : 'PROBLEM: ' + r.problems.join(' / ')}`);
  }
  const bad = results.filter(r => !r.ok).length;
  console.log(bad ? `\n❌ ${bad}건 문제` : `\n✅ ${results.length}건 evidence·elapsedMs·totalElapsedMs 모두 채워짐`);
  process.exit(bad ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
