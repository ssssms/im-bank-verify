/**
 * ============================================================
 * 단계별 조회 근거(evidence) · 데이터 출처 라벨 · 폴백 감지 — 2026-09-08
 * ============================================================
 *
 * 시연에서 "실제로 무엇이 조회되었는지"를 한 줄씩 보여주기 위한 유틸.
 * 서비스 결과 객체만 읽고, 서비스 파일(Mock·Live 로직)은 건드리지 않는다.
 *
 *  buildEvidence(step, result)         → string[] (최대 3줄, 필드 없으면 그 줄 생략)
 *  describeSource(step, result, ctx)   → { dataSource, sourceLabel, fallback, fallbackNote }
 *  stepMeta(step, result, ctx, ms)     → 위 둘 + elapsedMs (SSE 단계 이벤트에 그대로 spread)
 *  decorateBreakdown(trustScore, results, ctx, elapsed) → breakdown 각 항목에 같은 메타 부착 (REST·done)
 *
 * [폴백 감지] 서비스 Safe 래퍼는 Live 실패 시 console.warn 만 남기고 dataSource='MOCK' 으로
 * 돌려주므로 결과만 봐서는 "처음부터 Mock" 과 "Live 실패 → Mock" 을 구분할 수 없다.
 * 각 래퍼가 Live 를 시도했을 조건(USE_MOCK=false · 시연번호 아님 · 키 유효 · 상호명 있음)을
 * 여기서 똑같이 판정해, 그 조건인데 MOCK 이 돌아왔으면 폴백으로 본다.
 */
const { calcBusinessYears } = require('./businessAge');

const DEMO_NUMBERS = new Set(['1234567890', '9876543210', '1111111111', '2222222222', '5555555555']);

const SOURCE_LABEL = {
  LIVE:      '실제 연동',
  MOCK:      '가상 데이터',
  BC_SAMPLE: 'BC 실데이터(샘플)',
};
function sourceLabel(dataSource) {
  return SOURCE_LABEL[dataSource] || SOURCE_LABEL.MOCK;
}

// '2019-03-15' | '20190315' | '2019.03' → '2019.03'
function ym(dateStr) {
  if (!dateStr) return null;
  const d = String(dateStr).replace(/[^0-9]/g, '');
  if (d.length < 6) return null;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}`;
}

const validKey = k => !!k && !String(k).startsWith('your_');

// 각 서비스 Safe 래퍼와 같은 조건 — 이 조건이면 Live 를 시도했어야 한다
function liveExpected(step, { businessNumber, storeName } = {}) {
  if (process.env.USE_MOCK !== 'false') return false;
  if (DEMO_NUMBERS.has(businessNumber)) return false;
  switch (step) {
    case 1: return validKey(process.env.NTS_API_KEY);
    case 2: return !!storeName && validKey(process.env.NAVER_CLIENT_ID);
    case 3: return !!storeName && validKey(process.env.LICENSE_API_KEY || process.env.NTS_API_KEY);
    default: return false; // 4단계 BC카드: 민간 API 없음 — 항상 Mock, 폴백 아님
  }
}

// ── 1단계 국세청 ──
function evidenceNts(r) {
  if (!r) return [];
  const lines = [];
  const statusText = r.businessStatusText
    || ({ ACTIVE: '계속사업자', SUSPENDED: '휴업자', CLOSED: '폐업자', NOT_FOUND: '미등록', UNKNOWN: '확인 불가' })[r.businessStatus]
    || r.businessStatus || '';
  const typeLabel = r.dataSource === 'LIVE' ? '과세유형' : '업종'; // Live 는 tax_type, Mock 은 업종명
  const parts = [`국세청: ${statusText}`];
  if (r.businessType) parts.push(`${typeLabel} ${r.businessType}`);
  const open = ym(r.registrationDate);
  if (open) {
    const months = Math.floor(calcBusinessYears(r.registrationDate) * 12);
    parts.push(`개업 ${open} (업력 ${months}개월)`);
  }
  lines.push(parts.join(' · '));
  if (r.businessStatus === 'CLOSED' && ym(r.closedDate)) lines.push(`국세청: 폐업일 ${ym(r.closedDate)}`);
  if (r.companyName) lines.push(`국세청: 상호 ${r.companyName}`);
  return lines.slice(0, 3);
}

// ── 2단계 위치 ──
function evidenceLocation(r) {
  if (!r) return [];
  const lines = [];
  const name = r.matchedStoreName || null;
  if (r.step1) {
    lines.push(`네이버: ${[name, r.address].filter(Boolean).join(' · ')} — 일치`);
  } else {
    lines.push('네이버: 검색 결과 없음 — 불일치');
  }
  if (r.step1) {
    lines.push(r.step2
      ? `소진공: ${name || '상권정보'} — 반경 내 일치`
      : `소진공: ${name || '상권정보'} — 미등록`);
  }
  if (r.confidence) lines.push(`교차검증 신뢰도: ${({ HIGH: '높음(2개 소스)', MEDIUM: '보통(1개 소스)', NONE: '없음' })[r.confidence] || r.confidence}`);
  return lines.slice(0, 3);
}

// ── 3단계 인허가 ──
function evidenceLicense(r) {
  if (!r) return [];
  const lines = [];
  if (r.licenseType) {
    const parts = [`행안부: ${r.licenseType}`];
    if (ym(r.licenseDate)) parts.push(`허가 ${ym(r.licenseDate)}`);
    if (r.licenseStatus) parts.push(`상태 ${r.licenseStatus}`);
    lines.push(parts.join(' · '));
  } else {
    lines.push(`행안부: 인허가 조회 결과 없음${r.licenseStatus ? ` (${r.licenseStatus})` : ''}`);
  }
  if (r.address) lines.push(`행안부: 소재지 ${r.address}`);
  if (r.expiryDate && ym(r.expiryDate)) lines.push(`행안부: 폐업·말소 ${ym(r.expiryDate)}`);
  return lines.slice(0, 3);
}

// ── 4단계 카드매출 ──
function evidenceSales(r) {
  if (!r) return [];
  const lines = [];
  if (!r.hasData) {
    lines.push(r.merchantRegistered
      ? 'BC: 카드 가맹점 등록 · 최근 6개월 매출 없음'
      : 'BC: 카드 가맹점 미등록 · 매출 데이터 없음');
    return lines;
  }
  const monthly = Array.isArray(r.monthly) ? r.monthly : [];
  const active = monthly.filter(m => (m.sales || 0) > 0);
  const avg = (arr, k) => (arr.length ? arr.reduce((a, m) => a + (m[k] || 0), 0) / arr.length : 0);
  const total = monthly.length || 6;
  lines.push(`BC: 최근 ${total}개월 매출 발생 ${active.length}/${total}개월 · 월평균 ${Math.round(avg(active, 'txCount'))}건 · 순고객 ${Math.round(avg(active, 'uniqueCustomers'))}명`);
  const avgSales = avg(active, 'sales');
  if (avgSales > 0) {
    const ratio = r.industryAvgSales > 0 ? ` · 업종 평균 대비 ${Math.round(avgSales / r.industryAvgSales * 100)}%` : '';
    lines.push(`BC: 월평균 매출 ${(avgSales / 10000).toFixed(0)}만원${ratio}${r.dataType === 'CARD_AND_ETAX' ? ' · 전자세금계산서 병행' : ''}`);
  }
  const alarmKeys = Object.keys(r.alarms || {}).filter(k => r.alarms[k]);
  if (alarmKeys.length) lines.push(`BC 알람: ${alarmKeys.length}건 (${alarmKeys.join(', ')})`);
  return lines.slice(0, 3);
}

function buildEvidence(step, result) {
  switch (step) {
    case 1: return evidenceNts(result);
    case 2: return evidenceLocation(result);
    case 3: return evidenceLicense(result);
    case 4: return evidenceSales(result);
    default: return [];
  }
}

function describeSource(step, result, ctx) {
  if (!result) return { dataSource: null, sourceLabel: '미조회', fallback: false, fallbackNote: null };
  const dataSource = result.dataSource || 'MOCK';
  const fallback = dataSource === 'MOCK' && liveExpected(step, ctx);
  return {
    dataSource,
    sourceLabel: sourceLabel(dataSource),
    fallback,
    fallbackNote: fallback ? '실시간 조회 실패 → 가상 데이터로 대체' : null,
  };
}

function stepMeta(step, result, ctx, elapsedMs) {
  return { evidence: buildEvidence(step, result), elapsedMs: elapsedMs ?? null, ...describeSource(step, result, ctx) };
}

/**
 * breakdown 각 항목에 evidence·출처·소요시간 부착 (원본 객체를 수정하지 않고 새 객체 반환)
 * @param results {1: nts, 2: location, 3: license, 4: sales}
 * @param elapsed {1: ms, 2: ms, 3: ms, 4: ms}
 */
function decorateBreakdown(trustScore, results, ctx, elapsed = {}) {
  return {
    ...trustScore,
    breakdown: trustScore.breakdown.map(b => ({ ...b, ...stepMeta(b.step, results[b.step], ctx, elapsed[b.step]) })),
  };
}

module.exports = { buildEvidence, describeSource, stepMeta, decorateBreakdown, sourceLabel, liveExpected, SOURCE_LABEL };
