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
 */

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
  const active = monthly.filter(m => (m.sales || 0) > 0);

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
  const last = monthly[monthly.length - 1];
  const prev3 = monthly.slice(Math.max(0, monthly.length - 4), monthly.length - 1);
  const prev3Avg = avg(prev3, 'sales');
  const spikeRatio = prev3Avg > 0 ? (last?.sales || 0) / prev3Avg : 0;

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
    minActiveDays: active.length ? Math.min(...active.map(m => m.activeDays || 0)) : 0,
    repeatedAmountRatio: sales.repeatedAmountRatio || 0,
  };
}

// ── ① 영업 지속성 (10점) ─────────────────────────────────────
function scoreContinuity(m) {
  // 최근 6개월 중 매출 발생 월수 (6개월 연속 시 만점)
  const monthsPt = tier(m.activeMonths, [[6, 6], [5, 4], [4, 3], [3, 2], [2, 1]]);
  // 월 매출 발생일수 (15일 이상 만점, 5일 미만 0점)
  const daysPt = tier(m.avgActiveDays, [[15, 4], [10, 3], [5, 1]]);
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
function scoreVolume(m) {
  // 최소 임계치: 월 30건 이상이면 만점
  const txPt = tier(m.avgTxCount, [[30, 5], [15, 3], [5, 1]]);
  // 업종 평균 대비 정상 범위(70~150%)면 만점, 과대(250%+)는 가장매출 의심으로 감점
  let ratioPt = 0;
  if (m.industryRatio >= 0.7 && m.industryRatio <= 1.5) ratioPt = 5;
  else if (m.industryRatio >= 2.5) ratioPt = 1;
  else if (m.industryRatio >= 0.4) ratioPt = 3;
  else if (m.industryRatio >= 0.2) ratioPt = 1;

  return {
    key: 'volume',
    label: '매출 규모·건수',
    max: 10,
    score: txPt + ratioPt,
    detail: `월평균 ${Math.round(m.avgTxCount)}건 · ${(m.avgMonthlySales / 10000).toFixed(0)}만원 (업종 평균 대비 ${Math.round(m.industryRatio * 100)}%)`,
    items: [
      { name: '월평균 매출건수', value: `${Math.round(m.avgTxCount)}건`, score: txPt, max: 5 },
      { name: '업종 평균 대비', value: `${Math.round(m.industryRatio * 100)}%`, score: ratioPt, max: 5 },
    ],
  };
}

// ── ③ 순고객 분산도 (15점 · 최고 배점) ───────────────────────
function scoreCustomer(m) {
  // 순고객수 절대 규모 (50명 이상 만점)
  const countPt = tier(m.avgUniqueCustomers, [[50, 6], [30, 4], [15, 2]]);
  // 순고객수/매출건수 비율 (0.5 이상 정상 — 소수 고객 반복결제 시 비율 급락)
  const ratioPt = tier(m.customerRatio, [[0.5, 6], [0.35, 4], [0.2, 2]]);
  // 순고객수 추세 (유지·증가)
  const trendPt = tier(m.customerTrend, [[1.0, 3], [0.85, 2], [0.7, 1]]);

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
function scoreAnomaly(m) {
  const flags = [];
  let penalty = 0;

  if (m.spikeRatio >= 2.5) {
    penalty += 2;
    flags.push(`직전 1개월 매출 급증(직전 3개월 평균의 ${m.spikeRatio.toFixed(1)}배)`);
  }
  if (m.activeMonths > 0 && m.minActiveDays > 0 && m.minActiveDays <= 3) {
    penalty += 2;
    flags.push(`특정일 집중 매출(최소 영업일 ${m.minActiveDays}일)`);
  }
  if (m.repeatedAmountRatio >= 0.4) {
    penalty += 2;
    flags.push(`동일 금액 반복 결제 비중 ${Math.round(m.repeatedAmountRatio * 100)}%`);
  }

  const score = Math.max(0, 5 - penalty);
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
      : [{ name: '이상패턴', value: '미탐지', score: 5, max: 5 }],
  };
}

/**
 * FDS 40점 산출
 * @param {object} sales getSalesData() 결과
 * @returns {{ score, subScores, metrics, riskAlert, summary }}
 */
function scoreFds(sales) {
  const metrics = deriveMetrics(sales);

  const continuity = scoreContinuity(metrics);
  const volume     = scoreVolume(metrics);
  const customer   = scoreCustomer(metrics);
  const anomaly    = scoreAnomaly(metrics);

  const raw = continuity.score + volume.score + customer.score + anomaly.score;
  const score = Math.max(0, Math.min(40, raw));

  // 감점 4점 이상(패턴 2건 이상) = 가장매출 강한 의심 → 점수 무관 PENDING 강제
  const riskAlert = anomaly.penalty >= 4;

  return {
    score,
    subScores: [continuity, volume, customer, anomaly],
    metrics,
    riskAlert,
    summary: `최근 ${metrics.monthlyCount}개월 · 월평균 ${(metrics.avgMonthlySales / 10000).toFixed(0)}만원 · ${Math.round(metrics.avgTxCount)}건 · 순고객 ${Math.round(metrics.avgUniqueCustomers)}명`,
  };
}

module.exports = { scoreFds };
