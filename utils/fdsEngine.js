/**
 * ============================================================
 * 카드매출 FDS 채점 엔진 (40점) — 제안서 채점 기준 구현
 * ============================================================
 *
 * iM AX 챌린지 제안서 「카드매출 FDS 상세 기준 (40점)」과 1:1 대응하는 가산제.
 *
 *  ① 영업 지속성      10점 : 최근 6개월 중 매출 발생 월수 + 월 매출 발생일수
 *  ② 매출 규모·건수    10점 : 월평균 매출건수(최소 임계치) + 업종 평균 대비 매출 규모
 *  ③ 순고객 분산도     15점 : 순고객수 절대 규모 + 순고객수/매출건수 비율 + 순고객수 추세
 *  ④ 이상패턴 페널티    5점 : 5점에서 시작해 가장매출 의심 패턴 탐지 시 감점 (감점형)
 *                            · 해제 신청 직전 매출 급증
 *                            · 특정일 집중 매출
 *                            · 동일 금액 반복 결제
 *
 * 총점 = ① + ② + ③ + ④ (0~40점으로 클램프)
 *
 * [입력] salesResult.monthly : 최근 6개월 시계열 (오래된 달 → 최근 달 순)
 *   [{ ym:'2026-02', sales: 원, txCount: 건, activeDays: 일, uniqueCustomers: 명 }, ...]
 *   그 외: industryAvgSales(업종 평균 월매출), repeatedAmountRatio(동일금액 반복 결제 비중)
 *
 * [설계 원칙]
 *   - 순고객수(중복 제외)는 조작 비용이 가장 높은 지표 → 15점으로 최고 배점
 *   - 일단위 수신 시 activeDays/급증 탐지가, 월단위 수신 시 추세 분석이 작동하도록
 *     동일 엔진이 두 주기 모두를 커버 (제안서 「판정 연계」)
 *   - 모든 임계값은 utils/rules.config.js 의 FDS 블록에서 가져온다 (2026-09-08)
 *   - 모듈 로드 시 캐시하지 않고 scoreFds() 가 매 계산마다 getRules().FDS 를 읽어 소항목에 넘긴다
 *     (관리자 패널 런타임 오버라이드 반영 · 같은 룰 + 같은 입력 = 같은 결과)
 */

const { getRules } = require('./rules.config');

// ── 구간 점수 헬퍼: [임계값, 점수] 배열을 위에서부터 탐색 ──────
function tier(value, table, fallback = 0) {
  for (const [threshold, score] of table) {
    if (value >= threshold) return score;
  }
  return fallback;
}

const round1 = n => Math.round(n * 10) / 10;

// ── 시계열에서 파생 지표 산출 ─────────────────────────────────
function deriveMetrics(sales) {
  const monthly = Array.isArray(sales.monthly) ? sales.monthly : [];
  // 매출 발생 달 = 순매출 > 0 또는 결제 건수 > 0. [2026-09-11] 환불이 매출을 넘어 순매출이 음수인 달(그린헬스 2026.02, 25건)도 영업한 달로 본다
  const active = monthly.filter(m => (m.sales || 0) > 0 || (m.txCount || 0) > 0);

  const sum = (arr, key) => arr.reduce((a, m) => a + (m[key] || 0), 0);
  const avg = (arr, key) => (arr.length ? sum(arr, key) / arr.length : 0);

  const totalTx = sum(active, 'txCount');
  const totalCustomers = sum(active, 'uniqueCustomers');

  // 순고객수 추세: 최근 3개월 평균 ÷ 이전 3개월 평균 (매출 없는 달도 0으로 포함)
  const half = Math.floor(monthly.length / 2) || 0;
  const older = monthly.slice(0, half);
  const recent = monthly.slice(monthly.length - half);
  const olderCust = avg(older, 'uniqueCustomers');
  const recentCust = avg(recent, 'uniqueCustomers');
  const customerTrend = olderCust > 0 ? recentCust / olderCust : (recentCust > 0 ? 1 : 0);

  // 직전 1개월 매출 급증 배수 (가장매출 급조 의심)
  // [2026-09-11] 비교 기준은 「영업을 시작한 뒤」의 직전 달들만. 첫 매출이 발생한 달(개업) 이전의 0원 달을
  //   평균에 넣으면 개업 2개월째 매장(송담추어탕 5→6월 1.4배)이 「직전 3개월 평균의 4.3배」로 잡혔다.
  //   영업 시작 후 비교할 달이 1~2개뿐이면 그 달들만으로, 하나도 없으면(첫 달) 비교하지 않는다.
  const last = monthly[monthly.length - 1];
  const firstActiveIdx = monthly.findIndex(m => (m.sales || 0) > 0 || (m.txCount || 0) > 0);
  const baseStart = Math.max(firstActiveIdx < 0 ? 0 : firstActiveIdx, monthly.length - 4);
  const spikeBase = monthly.slice(baseStart, monthly.length - 1);
  const spikeBaseAvg = avg(spikeBase, 'sales');
  const spikeRatio = spikeBaseAvg > 0 ? (last?.sales || 0) / spikeBaseAvg : 0;

  const avgMonthlySales = avg(active, 'sales');
  const industryAvgSales = sales.industryAvgSales || 0;

  return {
    monthlyCount: monthly.length,
    activeMonths: active.length,
    avgActiveDays: avg(active, 'activeDays'),
    avgTxCount: avg(active, 'txCount'),
    avgMonthlySales,
    industryAvgSales,
    industryRatio: industryAvgSales > 0 ? avgMonthlySales / industryAvgSales : 0,
    avgUniqueCustomers: avg(active, 'uniqueCustomers'),
    customerRatio: totalTx > 0 ? totalCustomers / totalTx : 0,
    customerTrend,
    spikeRatio,
    spikeBaseMonths: spikeBase.length,
    minActiveDays: active.length ? Math.min(...active.map(m => m.activeDays || 0)) : 0,
    repeatedAmountRatio: sales.repeatedAmountRatio || 0,
  };
}

// ── ① 영업 지속성 (10점) ─────────────────────────────────────
function scoreContinuity(m, R) {
  // 최근 6개월 중 매출 발생 월수 (6개월 연속 시 만점)
  const monthsPt = tier(m.activeMonths, R.CONTINUITY_MONTHS);
  // 월 매출 발생일수 (15일 이상 만점, 5일 미만 0점)
  const daysPt = tier(m.avgActiveDays, R.CONTINUITY_DAYS);
  return {
    key: 'continuity',
    label: '영업 지속성',
    max: 10,
    score: monthsPt + daysPt,
    detail: `최근 ${m.monthlyCount}개월 중 ${m.activeMonths}개월 매출 발생 · 월평균 영업일 ${round1(m.avgActiveDays)}일`,
    items: [
      { name: '매출 발생 월수', value: `${m.activeMonths}/${m.monthlyCount}개월`, score: monthsPt, max: 6 },
      { name: '월 매출 발생일수', value: `${round1(m.avgActiveDays)}일`, score: daysPt, max: 4 },
    ],
  };
}

// ── ② 매출 규모·건수 (10점) ──────────────────────────────────
function scoreVolume(m, R) {
  // 최소 임계치: 월 30건 이상이면 만점
  const txPt = tier(m.avgTxCount, R.VOLUME_TX);
  // 업종 평균 대비 정상 범위(70~150%)면 만점, 과대(250%+)는 가장매출 의심으로 감점
  const I = R.VOLUME_INDUSTRY;
  let ratioPt = 0;
  let ratioNote = '';
  if (m.industryRatio >= I.NORMAL_MIN && m.industryRatio <= I.NORMAL_MAX) ratioPt = I.NORMAL_PT;
  else if (m.industryRatio > I.NORMAL_MAX) {
    // [2026-09-11] 업종평균 상회: 직전 달 급증이 함께 있을 때만 「과대(가장매출 의심)」, 아니면 실적 우수(ABOVE_PT)
    const spike = m.spikeRatio >= R.ANOMALY.SPIKE_RATIO;
    if (m.industryRatio >= I.EXCESS && spike) { ratioPt = I.EXCESS_PT; ratioNote = ' · 과대+급증'; }
    else { ratioPt = I.ABOVE_PT ?? I.LOW_PT; ratioNote = ' · 업종 상회'; }
  }
  else if (m.industryRatio >= I.LOW)      ratioPt = I.LOW_PT;
  else if (m.industryRatio >= I.VERY_LOW) ratioPt = I.VERY_LOW_PT;

  return {
    key: 'volume',
    label: '매출 규모·건수',
    max: 10,
    score: txPt + ratioPt,
    detail: `월평균 ${Math.round(m.avgTxCount)}건 · ${(m.avgMonthlySales / 10000).toFixed(0)}만원 (업종 평균 대비 ${Math.round(m.industryRatio * 100)}%${ratioNote})`,
    items: [
      { name: '월평균 매출건수', value: `${Math.round(m.avgTxCount)}건`, score: txPt, max: 5 },
      { name: '업종 평균 대비', value: `${Math.round(m.industryRatio * 100)}%${ratioNote}`, score: ratioPt, max: 5 },
    ],
  };
}

// ── ③ 순고객 분산도 (15점 · 최고 배점) ───────────────────────
function scoreCustomer(m, R) {
  // 순고객수 절대 규모 (50명 이상 만점)
  const countPt = tier(m.avgUniqueCustomers, R.CUSTOMER_COUNT);
  // 순고객수/매출건수 비율 (0.5 이상 정상 — 소수 고객 반복결제 시 비율 급락)
  const ratioPt = tier(m.customerRatio, R.CUSTOMER_RATIO);
  // 순고객수 추세 (유지·증가)
  const trendPt = tier(m.customerTrend, R.CUSTOMER_TREND);

  return {
    key: 'customer',
    label: '순고객 분산도',
    max: 15,
    score: countPt + ratioPt + trendPt,
    detail: `월평균 순고객 ${Math.round(m.avgUniqueCustomers)}명 · 고객/건수 비율 ${m.customerRatio.toFixed(2)} · 추세 ${m.customerTrend >= 1 ? '증가' : m.customerTrend >= 0.85 ? '유지' : '감소'}`,
    items: [
      { name: '월 순고객수(중복 제외)', value: `${Math.round(m.avgUniqueCustomers)}명`, score: countPt, max: 6 },
      { name: '순고객수/매출건수', value: m.customerRatio.toFixed(2), score: ratioPt, max: 6 },
      { name: '순고객수 추세', value: `${Math.round(m.customerTrend * 100)}%`, score: trendPt, max: 3 },
    ],
  };
}

// ── ④ 이상패턴 페널티 (5점, 감점형) ──────────────────────────
function scoreAnomaly(m, R) {
  const A = R.ANOMALY;
  const flags = [];
  let penalty = 0;

  if (m.spikeRatio >= A.SPIKE_RATIO) {
    penalty += A.PENALTY_PER_FLAG;
    flags.push(`직전 1개월 매출 급증(직전 ${m.spikeBaseMonths || 3}개월 평균의 ${m.spikeRatio.toFixed(1)}배)`);
  }
  if (m.activeMonths > 0 && m.minActiveDays > 0 && m.minActiveDays <= A.MIN_ACTIVE_DAYS) {
    penalty += A.PENALTY_PER_FLAG;
    flags.push(`특정일 집중 매출(최소 영업일 ${m.minActiveDays}일)`);
  }
  if (m.repeatedAmountRatio >= A.REPEATED_AMOUNT_RATIO) {
    penalty += A.PENALTY_PER_FLAG;
    flags.push(`동일 금액 반복 결제 비중 ${Math.round(m.repeatedAmountRatio * 100)}%`);
  }

  const score = Math.max(0, A.BASE - penalty);
  return {
    key: 'anomaly',
    label: '이상패턴 페널티',
    max: 5,
    score,
    penalty,
    flags,
    detail: flags.length ? `가장매출 의심 패턴 ${flags.length}건 — ${flags.join(' / ')}` : '가장매출 의심 패턴 없음',
    items: flags.length
      ? flags.map(f => ({ name: '탐지', value: f, score: -2, max: 0 }))
      : [{ name: '이상패턴', value: '미탐지', score: A.BASE, max: A.BASE }],
  };
}

/**
 * FDS 40점 산출
 * @param {object} sales getSalesData() 결과
 * @returns {{ score, subScores, metrics, riskAlert, summary }}
 */
function scoreFds(sales) {
  const R = getRules().FDS; // 매 계산마다 읽는다
  const metrics = deriveMetrics(sales);

  const continuity = scoreContinuity(metrics, R);
  const volume     = scoreVolume(metrics, R);
  const customer   = scoreCustomer(metrics, R);
  const anomaly    = scoreAnomaly(metrics, R);

  const raw = continuity.score + volume.score + customer.score + anomaly.score;
  const score = Math.max(0, Math.min(40, raw));

  // 감점 4점 이상(패턴 2건 이상) = 가장매출 강한 의심 → 점수 무관 PENDING 강제
  const riskAlert = anomaly.penalty >= R.ANOMALY.RISK_ALERT_PENALTY;

  return {
    score,
    subScores: [continuity, volume, customer, anomaly],
    metrics,
    riskAlert,
    summary: `최근 ${metrics.monthlyCount}개월 · 월평균 ${(metrics.avgMonthlySales / 10000).toFixed(0)}만원 · ${Math.round(metrics.avgTxCount)}건 · 순고객 ${Math.round(metrics.avgUniqueCustomers)}명`,
  };
}

module.exports = { scoreFds };
