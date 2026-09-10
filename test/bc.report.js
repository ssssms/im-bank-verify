/**
 * BC카드 실데이터 샘플 결과표 — 샘플 전건을 실제 서비스(4단계)로 돌려 총점·판정·소항목·게이트를 표로 출력한다.
 *
 * 실행: npm run bc:report            (backend/ 에서. data/bc_sample.json 필요)
 *       npm run bc:report -- --json  (표 아래에 요약 JSON 도 출력)
 *
 *  - 1~3단계는 실번호라 Live API(국세청·네이버·소진공·행안부)를 탄다 → 네트워크·.env 키 필요, 결과는 시점에 따라 흔들릴 수 있다.
 *  - 4단계는 BC 실데이터(dataSource=BC_SAMPLE). 이 표의 FDS 열이 실데이터 편차를 보여주는 재료다.
 *  - 상호명은 BC 가맹점명으로 넣는다(위치·인허가 조회용). 출력엔 마스킹 번호만.
 *  - 응답 JSON 은 test/results/bc/<마스킹번호>.json (results/ 는 git 미추적)
 *  - 기대값을 단정하지 않는다(assert 없음). 시연 5건 회귀는 demo.test.js 가 맡는다.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const express = require('express');
const { listSamples, getMerchantName, isEnabled } = require('../services/bcData.service');

const PORT = Number(process.env.BC_REPORT_PORT) || 4098;
const RESULTS_DIR = path.join(__dirname, 'results', 'bc');
const WANT_JSON = process.argv.includes('--json');
const EXTRA = (process.env.BC_REPORT_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean); // 알람 이력만 있는 번호 등 추가 실행

function pad(s, w) {
  const str = String(s ?? '');
  let width = 0;
  for (const ch of str) width += /[ᄀ-ᇿ　-〿가-힯＀-￯]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, w - width));
}
const VERDICT_KO = { APPROVED: '승인', PENDING: '보류', REJECTED: '거절', INELIGIBLE: '판단불가' };

async function run() {
  if (!isEnabled()) { console.error('data/bc_sample.json 이 없습니다. 먼저 npm run bc:import -- "<엑셀 경로>"'); process.exit(1); }
  const { asOf, items } = listSamples();
  const targets = [...items.map(i => i.number), ...EXTRA];

  const app = express();
  app.use(express.json());
  app.use('/api/verify', require('../routes/verify'));
  const server = await new Promise(resolve => { const s = app.listen(PORT, () => resolve(s)); });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const rows = [];
  try {
    for (const num of targets) {
      const masked = `${num.slice(0, 3)}*******`;
      const storeName = getMerchantName(num) || '';
      const t0 = Date.now();
      let body;
      try {
        const res = await axios.post(`http://127.0.0.1:${PORT}/api/verify/business`, { businessNumber: num, consentGiven: true, storeName }, { timeout: 120000 });
        body = res.data;
      } catch (e) {
        rows.push({ masked, error: e.message });
        continue;
      }
      const ts = body.trustScore || {};
      const b = ts.breakdown || [];
      const fds = b.find(x => x.step === 4) || {};
      const sub = Object.fromEntries((fds.subScores || []).map(s => [s.key, s.score]));
      const gate = ts.gate || {};
      const elig = ts.eligibility || {};
      rows.push({
        masked,
        verdict: ts.verdict?.verdict,
        total: ts.totalScore,
        steps: b.map(x => x.score).join('/'),
        fdsSub: fds.subScores ? `${sub.continuity ?? '-'}/${sub.volume ?? '-'}/${sub.customer ?? '-'}/${sub.anomaly ?? '-'}` : '-',
        fdsSrc: fds.dataSource,
        gate: gate.level || '-',
        gateWhy: (gate.reasons || []).map(r => r.label).join(' · '),
        next: ts.verdict?.nextStep?.type,
        eligWhy: (elig.reasons || []).map(r => r.label).join(' · '),
        fdsDetail: fds.detail,
        ms: body.totalElapsedMs ?? (Date.now() - t0),
      });
      fs.writeFileSync(path.join(RESULTS_DIR, `${num.slice(0, 3)}_${num.slice(-2)}_masked.json`), JSON.stringify(body, null, 2), 'utf8');
    }
  } finally {
    server.close();
  }

  console.log(`\nBC카드 실데이터 샘플 ${items.length}곳 (배치 기준 ${asOf}) — 1~3단계 Live · 4단계 BC_SAMPLE\n`);
  console.log([pad('번호', 11), pad('판정', 8), pad('총점', 4), pad('NTS/위치/인허가/FDS', 20), pad('FDS ①/②/③/④', 14), pad('출처', 10), pad('게이트', 7), pad('다음 절차', 24), pad('초', 5), '자격/게이트 사유'].join(' '));
  for (const r of rows) {
    if (r.error) { console.log(`${pad(r.masked, 11)} 오류: ${r.error}`); continue; }
    console.log([pad(r.masked, 11), pad(VERDICT_KO[r.verdict] || r.verdict, 8), pad(r.total, 4), pad(r.steps, 20), pad(r.fdsSub, 14), pad(r.fdsSrc, 10), pad(r.gate, 7), pad(r.next, 24), pad((r.ms / 1000).toFixed(1), 5), [r.eligWhy, r.gateWhy].filter(Boolean).join(' | ')].join(' '));
  }
  console.log('\nFDS 상세');
  for (const r of rows.filter(r => !r.error)) console.log(`  ${r.masked} ${r.fdsDetail || ''}`);
  const counts = rows.reduce((a, r) => { const k = VERDICT_KO[r.verdict] || r.verdict || '오류'; a[k] = (a[k] || 0) + 1; return a; }, {});
  console.log('\n판정 분포:', Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · '));
  console.log(`결과 JSON: ${RESULTS_DIR}`);
  if (WANT_JSON) console.log(JSON.stringify(rows, null, 2));
}

run().catch(e => { console.error(e); process.exit(1); });
