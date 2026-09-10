/**
 * ============================================================
 * BC카드 샘플 엑셀 → 정규화 JSON 변환 (2026-09-10)
 * ============================================================
 *
 * 실행: npm run bc:import -- "<엑셀 경로>"      (backend/ 에서)
 *       인자를 생략하면 data/bc_sample.xlsx 를 읽는다.
 * 출력: data/bc_sample.json  (★ 실데이터 — git 추적 금지, backend/.gitignore 에 등록)
 *
 * [입력 엑셀 구성 — IM뱅크_비씨카드 샘플 데이터_260910.xlsx]
 *   시트1 「레이아웃」 : 64항목 코드·한글명
 *   시트2 「사업자번호 샘플 10개(26.1~7월)」 : 사업자×기준년월 = 1행 (스냅샷), 10곳 × 7개월
 *   시트3 「알람서비스 선정 현황(도시어부)」 : 알람 항목 × 기준월(2024.10~2025.11) 전치 표, 매출 항목 없음
 *
 * [정렬 규칙 — BC 항목 명세 확인]
 *   · 「직전N개월전 …」(SC04000N / SC0400(12+N)) = 기준월 M 의 M-N 월 값
 *   · 「최근1개월 …」(SD010007 이용회원수 · SC360001 사용카드수) = M-1
 *   · 「최근30일내매출발생일수」(SB030002) = D-30~D-1, 기준일자가 말일이므로 ≈ 당월 M
 *   · 「직전N개월전 매출발생일수」(DCNT_MMN) 는 같은 달을 여러 스냅샷에서 대조하면 값이 맞지 않고
 *     (개업 전 달에도 값이 있고, 월 240건 매장이 0일) 신뢰할 수 없어 원본만 보존하고 채점엔 쓰지 않는다.
 *
 * [출력 JSON]
 *   meta       : 원본 파일명 · 변환 시각 · 기준 스냅샷(asOf) · 정렬 규칙 요약
 *   layout     : [{ no, code, name }]
 *   merchants  : { <사업자번호10자리>: { bizno, merNo, name, regDate, joinDate, closeDate, isIndividual, tradeable,
 *                    industryCode, industryGroup, hasOffline, sido, sigungu, dong,
 *                    snapshots: { 'YYYY-MM': { …64항목 원본… } },
 *                    monthly:   { 'YYYY-MM': { sales, txCount, uniqueCustomers, cardCount, activeDays, activeDaysSource, dcntRaw } } } }
 *   alarmHistory : { <사업자번호>: { regDate, snapshots: { 'YYYY-MM': { <알람코드>: 값 } }, alarmNames: { 코드: 한글명 } } }
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'bc_sample.json');
const ENC_PATH = path.join(DATA_DIR, 'bc_sample.enc'); // 암호화본 — 이것만 git 에 올린다 (키는 .env / Render 환경변수 BC_SAMPLE_KEY)
const ENV_PATH = path.join(__dirname, '..', '.env');

const src = process.argv[2] || path.join(DATA_DIR, 'bc_sample.xlsx');
if (!fs.existsSync(src)) {
  console.error(`엑셀 파일이 없습니다: ${src}`);
  process.exit(1);
}

const wb = XLSX.readFile(src, { cellDates: false });
const sheetNames = wb.SheetNames;
const rowsOf = name => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true });

const str = v => (v === null || v === undefined) ? '' : String(v).trim();
const num = v => {
  if (v === null || v === undefined || v === '' || v === 'x') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ymOf = yyyymm => { const s = str(yyyymm).replace(/\D/g, ''); return s.length >= 6 ? `${s.slice(0, 4)}-${s.slice(4, 6)}` : null; };
const dateOf = yyyymmdd => { const s = str(yyyymmdd).replace(/\D/g, ''); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null; };
const shiftYm = (ym, delta) => { // 'YYYY-MM' + delta 개월
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// ── 시트1 레이아웃 ─────────────────────────────────────────────
const layoutSheet = sheetNames.find(n => n.includes('레이아웃')) || sheetNames[0];
const layout = rowsOf(layoutSheet)
  .slice(1)
  .filter(r => num(r[0]) !== null && str(r[1]))
  .map(r => ({ no: num(r[0]), code: str(r[1]), name: str(r[2]) }));
const nameOf = Object.fromEntries(layout.map(l => [l.code, l.name]));

// ── 시트2 스냅샷 (사업자 × 기준년월) ───────────────────────────
const dataSheet = sheetNames.find(n => n.includes('샘플')) || sheetNames[1];
const dataRows = rowsOf(dataSheet);
const header = dataRows[0].map(str);
const records = dataRows.slice(1).filter(r => str(r[0]).length === 10).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));

const merchants = {};
const warnings = [];

for (const rec of records) {
  const bizno = str(rec.BIZNO);
  const ym = ymOf(rec.STRD_YYMM);
  if (!bizno || !ym) continue;
  const m = merchants[bizno] || (merchants[bizno] = {
    bizno,
    merNo: str(rec.MER_NO) || null,
    name: str(rec.SA010010) || null,
    regDate: dateOf(rec.REG_DATE),
    joinDate: dateOf(rec.SA010003),
    closeDate: dateOf(rec.SA010011),
    isIndividual: str(rec.SA010005) === '1',
    industryCode: str(rec.SA010009) || null,
    industryGroup: str(rec.SA020001) || null,
    hasOffline: str(rec.SZ010001) || null,
    sido: str(rec.SIDO_NM) || null,
    sigungu: str(rec.CCG_NM) || null,
    dong: str(rec.ADNG_NM) || null,
    snapshots: {},
    monthly: {},
  });

  // 원본 64항목 그대로 (숫자는 숫자로, 'x' 는 null)
  const snap = {};
  for (const h of header) snap[h] = ['BIZNO', 'MER_NO', 'SA010010', 'SIDO_NM', 'CCG_NM', 'ADNG_NM', 'SA010011', 'SA020004', 'SA010005', 'SA010009', 'SA020001', 'SZ010001'].includes(h) ? (str(rec[h]) || null) : num(rec[h]);
  m.snapshots[ym] = snap;
  if (str(rec.SA020004) === '1') m.tradeable = true;

  // 월별 사실 — 직전 1~6개월 매출액·건수 (M-1 … M-6)
  for (let k = 1; k <= 6; k++) {
    const target = shiftYm(ym, -k);
    const sales = num(rec[`SC04000${k}`]);
    const tx = num(rec[`SC0400${12 + k}`]);
    const dcnt = num(rec[`DCNT_MM${k}`]);
    const cur = m.monthly[target] || (m.monthly[target] = { sales: null, txCount: null, uniqueCustomers: null, cardCount: null, activeDays: null, activeDaysSource: null, dcntRaw: null });
    // 여러 스냅샷이 같은 달을 가리키면 값이 같아야 한다 — 다르면 경고, 최신 스냅샷(짧은 거리) 우선
    if (cur.sales !== null && sales !== null && cur.sales !== sales) warnings.push(`${bizno} ${target} 매출액 불일치: ${cur.sales} vs ${sales} (스냅샷 ${ym} M-${k})`);
    if (cur._dist === undefined || k < cur._dist) { cur.sales = sales; cur.txCount = tx; cur.dcntRaw = dcnt; cur._dist = k; }
  }
  // 최근1개월 이용회원수·사용카드수 = M-1
  const prev = shiftYm(ym, -1);
  const cp = m.monthly[prev] || (m.monthly[prev] = { sales: null, txCount: null, uniqueCustomers: null, cardCount: null, activeDays: null, activeDaysSource: null, dcntRaw: null });
  cp.uniqueCustomers = num(rec.SD010007);
  cp.cardCount = num(rec.SC360001);
  // 최근30일 매출발생일수 = 당월 M
  const cm = m.monthly[ym] || (m.monthly[ym] = { sales: null, txCount: null, uniqueCustomers: null, cardCount: null, activeDays: null, activeDaysSource: null, dcntRaw: null });
  cm.activeDays = num(rec.SB030002);
  cm.activeDaysSource = 'SB030002';
}

// 정리: 내부 필드 제거 · 월 정렬 · 신뢰 가능한 달 표시
for (const m of Object.values(merchants)) {
  const sorted = {};
  for (const ym of Object.keys(m.monthly).sort()) {
    const v = m.monthly[ym];
    delete v._dist;
    // complete = 매출·건수·순고객·영업일수가 모두 있는 달 (채점에 쓸 수 있는 달)
    v.complete = v.sales !== null && v.txCount !== null && v.uniqueCustomers !== null && v.activeDays !== null;
    sorted[ym] = v;
  }
  m.monthly = sorted;
  m.snapshotMonths = Object.keys(m.snapshots).sort();
  m.completeMonths = Object.keys(sorted).filter(k => sorted[k].complete);
}

// ── 시트3 알람 이력 (전치 표) ──────────────────────────────────
const alarmHistory = {};
const alarmSheet = sheetNames.find(n => n.includes('알람'));
if (alarmSheet) {
  const rows = rowsOf(alarmSheet);
  const codeRow = i => rows.find(r => str(r[0]) === i);
  const ymRow = codeRow('STRD_YYMM');
  const biznoRow = codeRow('BIZNO');
  const regRow = codeRow('REG_DATE');
  if (ymRow && biznoRow) {
    const cols = [];
    for (let c = 2; c < ymRow.length; c++) if (ymOf(ymRow[c])) cols.push(c);
    const bizno = str(biznoRow[cols[0]]);
    const entry = alarmHistory[bizno] = { bizno, regDate: regRow ? dateOf(regRow[cols[0]]) : null, snapshots: {}, alarmNames: {} };
    for (const c of cols) entry.snapshots[ymOf(ymRow[c])] = {};
    for (const r of rows) {
      const code = str(r[0]);
      if (!/^F[A-Z]\d{5}$/.test(code)) continue;
      entry.alarmNames[code] = str(r[1]);
      for (const c of cols) entry.snapshots[ymOf(ymRow[c])][code] = num(r[c]);
    }
  }
}

// ── 출력 ─────────────────────────────────────────────────────
const snapshotMonths = [...new Set(Object.values(merchants).flatMap(m => m.snapshotMonths))].sort();
const out = {
  meta: {
    source: path.basename(src),
    importedAt: new Date().toISOString(),
    asOf: snapshotMonths[snapshotMonths.length - 1] || null,
    snapshotMonths,
    merchantCount: Object.keys(merchants).length,
    alarmCaseCount: Object.keys(alarmHistory).length,
    alignment: '직전N개월전 = M-N · 최근1개월 = M-1 · 최근30일 매출발생일수 = 당월 M · DCNT_MMN 은 채점 미사용',
    excludedItems: ['최근6개월 동일금액 반복결제 비중(53번, BC 협의로 제외)'],
  },
  layout,
  merchants,
  alarmHistory,
};
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');

// ── 암호화본 (AES-256-GCM) — 저장소가 공개라 평문은 올리지 않고, 이 파일 + 환경변수 키로 서버가 복호화해 읽는다 ──
let key = process.env.BC_SAMPLE_KEY;
if (!key) {
  key = crypto.randomBytes(32).toString('hex');
  fs.appendFileSync(ENV_PATH, `\n# BC 실데이터 암호화 키 (scripts/bc_import.js 가 생성). Render 환경변수에도 같은 값을 넣는다\nBC_SAMPLE_KEY=${key}\n`, 'utf8');
  console.log('BC_SAMPLE_KEY 가 없어 새로 만들어 .env 에 추가했습니다 (Render 환경변수에도 같은 값 필요)');
}
const k = crypto.createHash('sha256').update(key).digest();
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(out), 'utf8')), cipher.final()]);
fs.writeFileSync(ENC_PATH, JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64') }), 'utf8');
console.log(`암호화본: ${ENC_PATH} (${Math.round(fs.statSync(ENC_PATH).size / 1024)}KB)`);

// 요약 출력 (식별값은 앞 3자리만)
console.log(`원본: ${src}`);
console.log(`출력: ${OUT_PATH}`);
console.log(`레이아웃 ${layout.length}항목 · 스냅샷 ${records.length}행 · 가맹점 ${Object.keys(merchants).length}곳 · 기준 ${out.meta.asOf}`);
for (const m of Object.values(merchants)) {
  const months = Object.keys(m.monthly);
  console.log(`  ${m.bizno.slice(0, 3)}******* 스냅샷 ${m.snapshotMonths[0]}~${m.snapshotMonths.at(-1)} (${m.snapshotMonths.length}) · 월별 ${months[0]}~${months.at(-1)} (${months.length}) · 채점 가능 ${m.completeMonths[0]}~${m.completeMonths.at(-1)} (${m.completeMonths.length})`);
}
for (const a of Object.values(alarmHistory)) {
  const ms = Object.keys(a.snapshots);
  console.log(`  알람 이력 ${a.bizno.slice(0, 3)}******* ${ms[0]}~${ms.at(-1)} (${ms.length}개월 · 항목 ${Object.keys(a.alarmNames).length})`);
}
if (warnings.length) { console.log(`경고 ${warnings.length}건:`); warnings.slice(0, 20).forEach(w => console.log('  - ' + w)); }
else console.log('스냅샷 간 월별 값 불일치 없음');
