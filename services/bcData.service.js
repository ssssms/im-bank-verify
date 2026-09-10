/**
 * ============================================================
 * BC카드 실데이터 샘플 서비스 (2026-09-10 · 프롬프트 6 구현)
 * ============================================================
 *
 * 서버 시작 시 `data/bc_sample.json`(scripts/bc_import.js 가 엑셀에서 변환한 정규화 JSON)을 읽어
 * 사업자번호별로 메모리에 올린다. 파일이 없으면 조용히 비활성 — 나머지 동작은 종전과 같다.
 *
 *  경로 우선순위: BC_SAMPLE_PATH 환경변수 → data/bc_sample.json
 *  Render 배포: 원본을 git 에 올리지 않는다. 대시보드 Environment → Secret Files 에 bc_sample.json 을 올리고
 *               BC_SAMPLE_PATH=/etc/secrets/bc_sample.json 으로 가리킨다.
 *
 *  getBcSales(bizno)  → mockSales.getSalesData() 와 같은 형태의 객체 (없으면 null)
 *                        + bc: { … 화면·근거용 부가 정보 … }, alarms: negativeGate ALARM_RULES 키
 *  getMerchantName(bizno) → 가맹점명 (없으면 null) — /lookup 상호명 폴백용
 *  listSamples()      → 시연 선택용 목록 (마스킹 번호 · 지역 · 가맹 기간, 상호명 없음)
 *  isEnabled()        → 파일이 읽혔는가
 *
 * [매핑 — BC 항목 → getSalesData 필드]
 *   monthly[] (오래된 달 → 최근 달, 6개월)
 *     sales           = 직전N개월전 총매출금액   (SC040001~6, M-N)
 *     txCount         = 직전N개월전 총매출건수   (SC040013~18)
 *     uniqueCustomers = 최근1개월전체고객이용회원수 (SD010007, M-1)
 *     activeDays      = 최근30일내매출발생일수   (SB030002, 당월) — DCNT_MMN 은 신뢰 불가라 미사용
 *   industryAvgSales  = 최근6개월 월평균 총매출금액(SC130003) ÷ 동일업종평균매출금액대비비중(SG030003)
 *                       ※ SG030003 은 정수(1·3·4…)로 와서 배수로 해석. 0 이면 업종 평균 미상(null)
 *   repeatedAmountRatio = 0 (53번 「동일금액 반복결제 비중」은 BC 협의로 제외 — ④ 동일금액 규칙은 실데이터에서 발동 안 함)
 *   merchantRegistered = true (배치에 수록됨) · hasData = 6개월 창에 매출 있는 달이 1개 이상
 *   dataType = 'CARD_ONLY' · etaxCount = 0 · anomalyFlag = false
 *
 * [알람 → negativeGate 키] (as-of 스냅샷 값 > 0 이면 true. 열이 없으면 키 자체를 만들지 않는다)
 *   ownerMismatch ← FB00005 · merchantIdError ← FB00004 · badMerchantRegistered ← FE00003
 *   externalReport ← FB00011 · severeTermsViolation ← FC00006 · fdsHighScore10 ← FA00002
 *   abnormalOperationHold ← FF00016 · chargebackHold ← FF00079 · fraudComplaint ← FD00011
 *   overdueHolder ← FB00001|FB00002 · seizureHold ← FF00008|FF00024 (알람 이력 시트에만 있는 열)
 *   highCancelRatio ← SC240003 ≥ rules.BC.CANCEL_RATIO_WATCH · highDeclineRatio ← SC380003 ≥ rules.BC.DECLINE_RATIO_WATCH
 *   accidentCode · corporateCardSkew : 대응 열 없음 → 미생성
 *
 * [채점 창] 매출·건수·순고객·영업일수가 모두 있는 마지막 달(2026-06)에서 거슬러 6개월(2026-01~06).
 *   기준 스냅샷(asOf) 은 그 다음 달(2026-07) — 요약·알람 항목은 여기서 읽는다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getRules } = require('../utils/rules.config');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'bc_sample.json');
const ENC_PATH = path.join(__dirname, '..', 'data', 'bc_sample.enc'); // 암호화본(git 에 포함) — 환경변수 BC_SAMPLE_KEY 로 복호화
const WINDOW = 6;

let store = null; // { meta, merchants, alarmHistory }

// 읽기 순서: ① BC_SAMPLE_PATH 또는 data/bc_sample.json (평문, 로컬·Secret File) ② data/bc_sample.enc + BC_SAMPLE_KEY (배포)
function readStore() {
  const p = process.env.BC_SAMPLE_PATH || DEFAULT_PATH;
  if (fs.existsSync(p)) return { parsed: JSON.parse(fs.readFileSync(p, 'utf8')), from: path.basename(p) };
  if (fs.existsSync(ENC_PATH)) {
    const key = process.env.BC_SAMPLE_KEY;
    if (!key) { console.warn('[BC 샘플] data/bc_sample.enc 는 있으나 BC_SAMPLE_KEY 가 없어 비활성'); return null; }
    const { iv, tag, data } = JSON.parse(fs.readFileSync(ENC_PATH, 'utf8'));
    const k = crypto.createHash('sha256').update(key).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    return { parsed: JSON.parse(plain), from: 'bc_sample.enc(복호화)' };
  }
  return null;
}

function load() {
  try {
    const r = readStore();
    if (!r) { store = null; return; }
    const parsed = r.parsed;
    if (!parsed || typeof parsed.merchants !== 'object') throw new Error('merchants 없음');
    store = parsed;
    const n = Object.keys(parsed.merchants).length;
    const a = Object.keys(parsed.alarmHistory || {}).length;
    console.log(`💳 BC카드 실데이터 샘플 로드: 가맹점 ${n}곳 · 알람 이력 ${a}건 · 기준 ${parsed.meta?.asOf || '?'} (${r.from})`);
  } catch (e) {
    store = null;
    console.warn('[BC 샘플 로드 실패 → 비활성]', e.message);
  }
}
load();

const isEnabled = () => !!store;
const clean = n => String(n || '').replace(/\D/g, '');
const shiftYm = (ym, delta) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + delta, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthsBetween = (fromDate, toYm) => { // 'YYYY-MM-DD' → 'YYYY-MM' 까지 개월수
  if (!fromDate || !toYm) return null;
  const [fy, fm] = fromDate.split('-').map(Number); const [ty, tm] = toYm.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
};
const gt0 = v => typeof v === 'number' && v > 0;

// 채점 창: complete 한 마지막 달부터 6개월. 창 안에 complete 아닌 달은 0 으로 채우지 않고 있는 값만 쓴다.
function pickWindow(merchant) {
  const complete = merchant.completeMonths || [];
  if (!complete.length) return null;
  const last = complete[complete.length - 1];
  const yms = [];
  for (let i = WINDOW - 1; i >= 0; i--) yms.push(shiftYm(last, -i));
  return { last, yms };
}

function buildAlarms(snap, rules) {
  const alarms = {};
  const flag = (key, ...codes) => {
    const present = codes.filter(c => c in snap);
    if (!present.length) return;
    alarms[key] = present.some(c => gt0(snap[c]));
  };
  flag('ownerMismatch', 'FB00005');
  flag('merchantIdError', 'FB00004');
  flag('badMerchantRegistered', 'FE00003');
  flag('externalReport', 'FB00011');
  flag('severeTermsViolation', 'FC00006');
  flag('fdsHighScore10', 'FA00002');
  flag('abnormalOperationHold', 'FF00016');
  flag('chargebackHold', 'FF00079');
  flag('fraudComplaint', 'FD00011');
  flag('overdueHolder', 'FB00001', 'FB00002');
  flag('seizureHold', 'FF00008', 'FF00024');
  const B = rules.BC || {};
  if ('SC240003' in snap) alarms.highCancelRatio = gt0(snap.SC240003) && snap.SC240003 >= (B.CANCEL_RATIO_WATCH ?? 0.1);
  if ('SC380003' in snap) alarms.highDeclineRatio = gt0(snap.SC380003) && snap.SC380003 >= (B.DECLINE_RATIO_WATCH ?? 0.1);
  return alarms;
}

/**
 * getSalesData() 호환 객체. 사업자번호가 샘플에 없으면 null.
 */
function getBcSales(businessNumber) {
  if (!store) return null;
  const bizno = clean(businessNumber);
  const rules = getRules();
  const merchant = store.merchants[bizno];

  if (!merchant) {
    // 알람 이력만 있는 사업자(매출 항목 미수록) — 가맹 등록은 확인되나 매출 데이터 없음
    const hist = store.alarmHistory?.[bizno];
    if (!hist) return null;
    const months = Object.keys(hist.snapshots || {}).sort();
    const asOf = months[months.length - 1];
    const snap = hist.snapshots[asOf] || {};
    return {
      hasData: false, merchantRegistered: true, dataType: 'REGISTERED_NO_SALES',
      recentMonths: 0, avgMonthlySales: 0, etaxCount: 0, monthly: [], industryAvgSales: 0, repeatedAmountRatio: 0,
      salesPattern: null, customerDiversity: null, industryAvgRatio: null, anomalyFlag: false,
      alarms: buildAlarms(snap, rules),
      bc: { asOf, alarmOnly: true, alarmMonths: months.length, regDate: hist.regDate || null },
    };
  }

  const win = pickWindow(merchant);
  const asOf = win ? shiftYm(win.last, 1) : (merchant.snapshotMonths || []).slice(-1)[0];
  const snap = merchant.snapshots[asOf] || merchant.snapshots[(merchant.snapshotMonths || []).slice(-1)[0]] || {};

  const monthly = (win ? win.yms : []).map(ym => {
    const v = merchant.monthly[ym] || {};
    return { ym, sales: v.sales || 0, txCount: v.txCount || 0, activeDays: v.activeDays || 0, uniqueCustomers: v.uniqueCustomers || 0, cardCount: v.cardCount || 0 };
  });
  const active = monthly.filter(m => m.sales > 0);
  const hasData = active.length > 0;

  const avgSales = gt0(snap.SC130003) ? snap.SC130003 : (active.length ? active.reduce((a, m) => a + m.sales, 0) / active.length : 0);
  const ratio = snap.SG030003;
  const industryAvgSales = gt0(ratio) && avgSales > 0 ? Math.round(avgSales / ratio) : 0;

  return {
    hasData,
    merchantRegistered: true,
    dataType: 'CARD_ONLY',
    recentMonths: monthly.length,
    etaxCount: 0,
    industryAvgSales,
    repeatedAmountRatio: 0,
    anomalyFlag: false,
    monthly,
    alarms: buildAlarms(snap, rules),
    bc: {
      asOf,
      window: win ? `${win.yms[0]}~${win.last}` : null,
      joinDate: merchant.joinDate || null,
      joinMonths: typeof snap.SA010008 === 'number' ? snap.SA010008 : monthsBetween(merchant.joinDate, asOf),
      tradeable: snap.SA020004 === '1',
      industryCode: merchant.industryCode || null,
      industryGroup: merchant.industryGroup || null,
      sido: merchant.sido || null,
      sigungu: merchant.sigungu || null,
      salesMonths6: snap.SC310003 ?? null,            // 최근6개월간 가맹점 유실적 개월수
      uniqueCustomers6m: snap.SD010009 ?? null,       // 최근6개월 전체고객 이용회원수(중복 제거)
      cardsUsed6m: snap.SC360003 ?? null,             // 최근6개월 사용카드수
      repeatCustomerRatio: snap.SE060003 ?? null,     // 최근6개월 동일회원 반복이용 비율(%)
      cancelRatio: snap.SC240003 ?? null,             // 최근6개월 취소매출 비율
      declineRatio: snap.SC380003 ?? null,            // 카드거래건수 대비 거절건수 비율
      industrySalesMultiple: ratio ?? null,           // 동일업종 평균 매출 대비 배수(정수)
      industryTxMultiple: snap.SG040003 ?? null,      // 동일업종 평균 건수 대비 배수(정수)
      industryCustomerMultiple: snap.SG110009 ?? null,
      avgUnitPrice: snap.SC110003 ?? null,            // 최근6개월 가맹점 매출 평균단가
    },
  };
}

function getMerchantName(businessNumber) {
  if (!store) return null;
  return store.merchants[clean(businessNumber)]?.name || null;
}

// 가맹점 등록 주소(시도·시군구·행정동) — 위치 단계에서 네이버 후보 선택·교차검증에 쓴다 (2026-09-10)
function getMerchantRegion(businessNumber) {
  if (!store) return null;
  const m = store.merchants[clean(businessNumber)];
  if (!m || !m.sigungu) return null;
  return { sido: m.sido || null, sigungu: m.sigungu, dong: m.dong || null };
}

// 시연 선택 목록 — 상호명·가맹점번호 없이 (전 직원 공개 자료라 식별 정보 최소화)
function listSamples() {
  if (!store) return [];
  const asOf = store.meta?.asOf || null;
  const shortSido = s => (s || '').replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, '');
  const items = Object.values(store.merchants).map((m, i) => {
    const jm = monthsBetween(m.joinDate, asOf);
    const yrs = jm === null ? null : jm >= 12 ? `가맹 ${Math.floor(jm / 12)}년` : `가맹 ${jm}개월`;
    return {
      id: `bc${i + 1}`,
      label: `실데이터 #${i + 1}`,
      number: m.bizno,
      masked: `${m.bizno.slice(0, 3)}-**-*****`,
      hint: [shortSido(m.sido), m.sigungu, yrs].filter(Boolean).join(' · '),
      completeMonths: (m.completeMonths || []).length,
    };
  });
  return { asOf, items };
}

module.exports = { getBcSales, getMerchantName, getMerchantRegion, listSamples, isEnabled, _reload: load };
