/**
 * ============================================================
 * 보완 검증 서비스 (카드매출 Mock + 행정인허가 Live)
 * ============================================================
 * Live: 행정안전부 지방행정인허가데이터 (localdata.go.kr)
 *   → 상호명으로 영업신고/허가 유효 여부 확인
 *   → 음식점·미용·세탁·이용 등 인허가 업종 대상
 *
 * Mock: 카드매출/전자세금계산서 시연용 데이터
 *   → LOCALDATA_API_KEY 없거나 USE_MOCK=true 시 사용
 */

const axios = require('axios');
const { getBcSales } = require('./bcData.service'); // BC카드 실데이터 샘플 (2026-09-10, 파일 없으면 항상 null)

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['2208162346', '1293284715', '2144028530', '5142691320', '5555555555']);

// ── 인허가 업종 서비스 코드 (localdata.go.kr) ─────────────────
const LICENSE_CODES = [
  { code: 'GR0', name: '일반음식점' },
  { code: 'GR1', name: '휴게음식점' },
  { code: 'GR2', name: '제과점영업' },
  { code: 'LA0', name: '미용업' },
  { code: 'LB0', name: '이용업' },
  { code: 'LC0', name: '세탁업' },
  { code: 'LD0', name: '목욕장업' },
  { code: 'LF0', name: '안경업' },
];

// ── Mock 데이터 ───────────────────────────────────────────────
// BC카드 매출 패턴 분석 필드 포함 (연동 완료 시 실데이터로 대체)
//
// [2026-07-27 확장] 제안서 「카드매출 FDS 상세 기준(40점)」 채점을 위해
// 최근 6개월 시계열(monthly)을 보유한다. utils/fdsEngine.js가 이 시계열에서
// ①영업지속성 ②매출규모·건수 ③순고객분산도 ④이상패턴 을 직접 산출한다.
//
//   monthly[]         : [{ ym, sales(원), txCount(건), activeDays(일), uniqueCustomers(명) }]
//                       배열 순서 = 오래된 달 → 최근 달
//   industryAvgSales  : 업종 평균 월매출 (규모 정상범위 판정 기준)
//   repeatedAmountRatio : 동일 금액 반복 결제 비중 (가장매출 탐지)
//   anomalyFlag       : 이상거래 확정 플래그 (점수 무관 PENDING 강제)
//   salesPattern / customerDiversity : 화면 표기용 요약 라벨 (fdsEngine이 자동 산출)

// 시연용 6개월 시계열 [매출액, 매출건수, 영업일수, 순고객수] — 오래된 달 → 최근 달
const DEMO_SERIES = {
  // 우량 가맹점: 6개월 연속 · 월 180건 · 순고객 162명(비율 0.9) · 업종평균 110% → FDS 40점
  '2208162346': {
    dataType: 'CARD_AND_ETAX', etaxCount: 24,
    industryAvgSales: 11363636, repeatedAmountRatio: 0.08,
    rows: [
      [11800000, 170, 25, 152],
      [12000000, 174, 26, 156],
      [12200000, 178, 26, 160],
      [12600000, 182, 27, 164],
      [12900000, 186, 26, 168],
      [13500000, 190, 27, 172],
    ],
  },
  // 기존 데이터 부족 사업자: 6개월 연속 매출(판단 자격 충족)이지만 규모·순고객이 약함 ·
  // 월 25건 · 순고객 11명(비율 0.42, 감소 추세) · 업종평균 45% · 동일금액 반복 45% → FDS 23점, 총점 55 → PENDING
  // [2026-09-08 수정] 종전 6개월 중 4개월(2개월 공백)은 새 정책에서 INELIGIBLE 이 되어 '보류' 시연이 사라지므로 6개월을 채움.
  '1293284715': {
    dataType: 'CARD_ONLY', etaxCount: 0,
    industryAvgSales: 6666667, repeatedAmountRatio: 0.45,
    rows: [
      [3600000, 30, 14, 13],
      [3300000, 28, 13, 12],
      [3200000, 27, 13, 12],
      [2800000, 24, 12, 10],
      [2600000, 22, 11, 9],
      [2400000, 21, 11, 8],
    ],
  },
  // 가장매출(카드깡) 의심 가맹점: 5개월 미미한 매출 → 해제 신청 직전 달 30배 급증 ·
  // 월 영업일 2~3일 · 순고객 9명이 260건 결제(비율 0.09) · 동일금액 반복 72%
  // → fdsEngine ④ 3종 동시 탐지(감점 6 → riskAlert) + BC 알람 「불량가맹점 등록」 → 게이트 BLOCK.
  // 매장 실재(위치·인허가)는 만점이라 총점 75(PENDING 구간)인데도 점수 무관 REJECTED — 게이트 시연용.
  '5555555555': {
    dataType: 'CARD_ONLY', etaxCount: 0,
    industryAvgSales: 2500000, repeatedAmountRatio: 0.72,
    alarms: { badMerchantRegistered: true }, // BC 배치 알람 자리(negativeGate ALARM_RULES) — 시연용 Mock
    rows: [
      [900000, 6, 2, 3],
      [800000, 5, 2, 3],
      [1000000, 7, 3, 3],
      [1200000, 8, 2, 4],
      [1500000, 10, 3, 4],
      [38000000, 260, 3, 9],
    ],
  },
};

// ── 매출 없음 두 종류 (2026-08-25 분리) ───────────────────────
//   merchantRegistered = 카드 가맹점으로 등록되어 있는가 (BC 배치 수록 여부에 대응)
//   · NOT_REGISTERED      : 배치에 사업자번호 자체가 없음 → 카드 미가맹(B2B 도소매·용역 등) 또는 진짜 신규
//   · REGISTERED_NO_SALES : 가맹점 등록은 되어 있으나 6개월 매출 0 → 가맹만 하고 영업하지 않음(의심)
//   기존에는 둘 다 hasData:false 하나로 뭉쳐 동일하게 0점 처리했다.
const NO_SALES = { hasData: false, merchantRegistered: false, dataType: 'NOT_REGISTERED', recentMonths: 0, avgMonthlySales: 0, etaxCount: 0, monthly: [], industryAvgSales: 0, repeatedAmountRatio: 0, salesPattern: null, customerDiversity: null, industryAvgRatio: null, anomalyFlag: false };
const REGISTERED_NO_SALES = { ...NO_SALES, merchantRegistered: true, dataType: 'REGISTERED_NO_SALES' };

// ── 최근 6개월 라벨(YYYY-MM) 생성 ─────────────────────────────
function recentYearMonths(count = 6) {
  const now = new Date();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function buildSeries(rows) {
  const yms = recentYearMonths(rows.length);
  return rows.map(([sales, txCount, activeDays, uniqueCustomers], i) => ({
    ym: yms[i], sales, txCount, activeDays, uniqueCustomers,
  }));
}

// ── 결정론적 난수 (사업자번호 시드) ───────────────────────────
// 같은 사업자번호는 언제 조회해도 항상 같은 매출 데이터를 반환한다.
// (심사위원이 임의의 실제 사업자번호를 반복 입력해도 결과가 흔들리지 않도록)
function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 미등록(시연 외) 사업자번호용 시뮬레이션 데이터 — 사업자번호 해시 기반 고정값
function generateSeededSales(businessNumber) {
  const rnd = mulberry32(seedFrom(businessNumber));

  // 약 8%는 카드매출 없음 — 원인이 둘이라 분리한다
  //   6% 카드 가맹점 미등록(B2B 도소매·용역·현금영수증 전용 등)
  //   2% 가맹점 등록은 했으나 6개월 매출 0 (가맹만 하고 영업 안 함 — 의심 케이스)
  const noSalesRoll = rnd();
  if (noSalesRoll < 0.06) return { ...NO_SALES };
  if (noSalesRoll < 0.08) return { ...REGISTERED_NO_SALES };

  const r = rnd();
  const activeMonths = r < 0.45 ? 6 : r < 0.7 ? 5 : r < 0.88 ? 4 : 3;
  const baseTx      = 5 + Math.floor(rnd() * 175);         // 월 5~180건
  const custRatio   = 0.15 + rnd() * 0.75;                 // 고객/건수 0.15~0.90
  const baseDays    = 3 + Math.floor(rnd() * 24);          // 월 3~26일
  const unitPrice   = 15000 + Math.floor(rnd() * 45000);   // 건당 1.5~6만원
  const baseSales   = baseTx * unitPrice;
  const industryRatio    = 0.3 + rnd() * 1.3;              // 업종평균 대비 30~160%
  const industryAvgSales = Math.round(baseSales / industryRatio);
  const growth      = 0.95 + rnd() * 0.1;                  // 월별 증감

  const rows = [];
  const zeroCount = 6 - activeMonths;
  for (let i = 0; i < 6; i++) {
    if (i < zeroCount) { rows.push([0, 0, 0, 0]); continue; }
    const f = Math.pow(growth, i - zeroCount) * (0.92 + rnd() * 0.16);
    const tx = Math.max(1, Math.round(baseTx * f));
    rows.push([
      Math.round(unitPrice * tx),
      tx,
      Math.max(1, Math.min(28, Math.round(baseDays * (0.9 + rnd() * 0.2)))),
      Math.max(1, Math.round(tx * custRatio)),
    ]);
  }

  return {
    hasData: true,
    merchantRegistered: true,
    dataType: rnd() < 0.4 ? 'CARD_AND_ETAX' : 'CARD_ONLY',
    recentMonths: 6,
    etaxCount: Math.floor(rnd() * 20),
    industryAvgSales,
    repeatedAmountRatio: 0.05 + rnd() * 0.45,
    anomalyFlag: false,
    monthly: buildSeries(rows),
  };
}

function getMockSalesData(businessNumber) {
  const demo = DEMO_SERIES[businessNumber];
  if (demo) {
    return {
      hasData: true,
      merchantRegistered: true,
      dataType: demo.dataType,
      recentMonths: demo.rows.length,
      etaxCount: demo.etaxCount,
      industryAvgSales: demo.industryAvgSales,
      repeatedAmountRatio: demo.repeatedAmountRatio,
      anomalyFlag: false,
      monthly: buildSeries(demo.rows),
      ...(demo.alarms ? { alarms: demo.alarms } : {}), // BC 알람 Mock(게이트 시연) — 없으면 필드 자체를 안 만든다
    };
  }
  // 시연번호 중 매출 없는 케이스 (신설 5142691320 / 폐업 2144028530)
  if (DEMO_NUMBERS.has(businessNumber)) return { ...NO_SALES };

  return generateSeededSales(businessNumber);
}

// ── data.go.kr 행정안전부 인허가 API로 영업 활동 확인 ─────────
async function getLicenseLive(storeName) {
  const serviceKey = process.env.LICENSE_API_KEY || process.env.NTS_API_KEY;
  if (!serviceKey) throw new Error('LICENSE_API_KEY 미설정');

  const url = `https://apis.data.go.kr/1741000/general_restaurants/info`
    + `?serviceKey=${encodeURIComponent(serviceKey)}`
    + `&perPage=5&page=1&returnType=json`
    + `&cond%5BBPLC_NM%3A%3ALIKE%5D=${encodeURIComponent(storeName)}`;

  const res = await axios.get(url, { timeout: 8000 });
  const items = res.data?.response?.body?.items?.item;
  if (!items) {
    return { hasData: false, dataType: 'LICENSE_NOT_FOUND', recentMonths: 0, avgMonthlySales: 0, etaxCount: 0 };
  }

  const list = Array.isArray(items) ? items : [items];
  const active = list.find(i => i.DTL_SALS_STTS_NM === '영업') || list[0];
  const isActive = active.DTL_SALS_STTS_NM === '영업';

  if (isActive) {
    return {
      hasData: true,
      dataType: 'LICENSE',
      recentMonths: 0,
      avgMonthlySales: 0,
      etaxCount: 0,
      licenseType: '일반음식점',
      licenseStatus: '영업중',
      licenseDate: active.LCPMT_YMD || '',
      address: active.ROAD_NM_ADDR || active.LOTNO_ADDR || '',
    };
  }

  return { hasData: false, dataType: 'LICENSE_NOT_FOUND', recentMonths: 0, avgMonthlySales: 0, etaxCount: 0 };
}

// ── 표기용 요약 필드 산출 (기존 화면·SSE 문구 호환) ───────────
//   avgMonthlySales : 매출 발생 월의 평균 매출액
//   salesPattern    : 월별 매출 변동계수(CV) 기준 STEADY / IRREGULAR / SUDDEN
//   customerDiversity : 순고객수/매출건수 비율 기준 DIVERSE / CONCENTRATED
function withSummaryFields(result) {
  const monthly = result.monthly || [];
  const active = monthly.filter(m => m.sales > 0);
  if (!result.hasData || active.length === 0) {
    return { ...result, avgMonthlySales: 0, salesPattern: null, customerDiversity: null, industryAvgRatio: null };
  }

  const avgSales = active.reduce((a, m) => a + m.sales, 0) / active.length;
  const variance = active.reduce((a, m) => a + Math.pow(m.sales - avgSales, 2), 0) / active.length;
  const cv = avgSales > 0 ? Math.sqrt(variance) / avgSales : 0;

  const totalTx = active.reduce((a, m) => a + m.txCount, 0);
  const totalCust = active.reduce((a, m) => a + m.uniqueCustomers, 0);
  const custRatio = totalTx > 0 ? totalCust / totalTx : 0;

  return {
    ...result,
    avgMonthlySales: Math.round(avgSales),
    salesPattern: cv <= 0.2 ? 'STEADY' : cv <= 0.5 ? 'IRREGULAR' : 'SUDDEN',
    customerDiversity: custRatio >= 0.5 ? 'DIVERSE' : 'CONCENTRATED',
    industryAvgRatio: result.industryAvgSales > 0 ? avgSales / result.industryAvgSales : null,
  };
}

// ── 외부 노출 함수 ────────────────────────────────────────────
async function getSalesData(businessNumber, storeName) {
  await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 300));

  // [2026-09-10] BC카드 실데이터 샘플 — 시연 번호가 아니고 샘플에 있는 번호면 실데이터를 돌려준다.
  // 시연 번호 5개와 아래 Mock 로직은 무수정(CLAUDE.md 규칙). 샘플 파일이 없으면 getBcSales 는 항상 null.
  if (!DEMO_NUMBERS.has(businessNumber)) {
    const bc = getBcSales(businessNumber);
    if (bc) return { ...withSummaryFields(bc), dataSource: 'BC_SAMPLE' };
  }

  // 금융활동(카드매출/전자세금계산서)은 카드사 제휴 전용 — 공공 API 없음
  // 항상 Mock 사용
  const useLive = false;

  if (!useLive) {
    const result = getMockSalesData(businessNumber);
    return { ...withSummaryFields(result), dataSource: 'MOCK' };
  }

  try {
    const result = await getLicenseLive(storeName);
    return { ...result, dataSource: 'LIVE' };
  } catch (e) {
    console.warn('[인허가 Live 실패 → Mock 전환]', e.message);
    const result = getMockSalesData(businessNumber);
    return { ...withSummaryFields(result), dataSource: 'MOCK' };
  }
}

module.exports = { getSalesData };
