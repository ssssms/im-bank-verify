/**
 * ============================================================
 * 사업자 검증 API 라우터 — 4단계 가맹점 본질 모델
 * ============================================================
 * GET  /api/verify/lookup       - 사업자번호 빠른 조회
 * GET  /api/verify/autocomplete - 상호명 자동완성
 * POST /api/verify/business     - 전체 검증 (REST 폴백)
 * GET  /api/verify/stream       - 단계별 실시간 검증 (SSE)
 *
 * 4단계: 1)NTS → 2)Location → 3)License → 4)Sales(FDS)
 * (구) Pension·Building 단계 제거 (deprecated, 서비스 파일은 보존)
 */

const express = require('express');
const router = express.Router();

const { checkBusinessStatus } = require('../services/mockNts.service');
const { verifyLocation }      = require('../services/mockLocation.service');
const { getLicenseInfo }      = require('../services/mockLicense.service');
const { getSalesData }        = require('../services/mockSales.service');
const { getCompanyName }      = require('../services/bizno.service'); // 상호명 병렬 보완(참고용)
// 홈택스(5단계) 제거 — 4단계 모델. mockHometax.service.js는 롤백 대비 보존, import 안 함.
const { calculateTrustScore, calcStepScore } = require('../utils/scoreEngine');

function validateBusinessNumber(raw) {
  const cleaned = (raw || '').replace(/-/g, '').replace(/\s/g, '');
  if (!/^\d{10}$/.test(cleaned)) {
    return { valid: false, error: '사업자 번호는 10자리 숫자여야 합니다.' };
  }
  return { valid: true, cleaned };
}

// ── 사업자번호 빠른 조회 ──────────────────────────────────────
router.get('/lookup', async (req, res) => {
  const validation = validateBusinessNumber(req.query.businessNumber);
  if (!validation.valid) return res.json({ found: false });

  try {
    // 국세청(상태) + 비즈노(상호명) 병렬 조회 → 번호 입력 즉시 상호명 표시
    const [ntsResult, biznoResult] = await Promise.all([
      checkBusinessStatus(validation.cleaned),
      getCompanyName(validation.cleaned),
    ]);
    // 상호명: 비즈노(민간 DB) 우선 → 국세청 Mock 상호(시연) → ''
    const companyName = biznoResult.companyName || ntsResult.companyName || '';
    return res.json({
      found: ntsResult.businessStatus === 'ACTIVE',
      businessStatus: ntsResult.businessStatus,
      businessStatusText: ntsResult.businessStatusText || '',
      companyName,
      companyNameSource: biznoResult.found ? 'BIZNO' : (ntsResult.companyName ? 'NTS' : 'NONE'),
      businessType: ntsResult.businessType || '',
    });
  } catch {
    return res.json({ found: false });
  }
});

// ── 상호명 자동완성 (인허가 API 검색) ─────────────────────────
const axios = require('axios');

const AUTOCOMPLETE_APIS = [
  { url: '/1741000/general_restaurants/info', name: '일반음식점' },
  { url: '/1741000/rest_cafes/info', name: '휴게음식점' },
  { url: '/1741000/bakeries/info', name: '제과점' },
  { url: '/1741000/beauty_salons/info', name: '미용업' },
  { url: '/1741000/laundries/info', name: '세탁업' },
  { url: '/1741000/lodgings/info', name: '숙박업' },
];

router.get('/autocomplete', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  const serviceKey = process.env.LICENSE_API_KEY || process.env.NTS_API_KEY;
  if (!serviceKey) return res.json({ results: [] });

  const results = [];
  await Promise.allSettled(
    AUTOCOMPLETE_APIS.map(async (api) => {
      try {
        const url = `https://apis.data.go.kr${api.url}`
          + `?serviceKey=${encodeURIComponent(serviceKey)}`
          + `&perPage=5&page=1&returnType=json`
          + `&cond%5BBPLC_NM%3A%3ALIKE%5D=${encodeURIComponent(q)}`
          + `&cond%5BDTL_SALS_STTS_NM%3A%3AEQ%5D=${encodeURIComponent('영업')}`;

        const r = await axios.get(url, { timeout: 5000 });
        const items = r.data?.response?.body?.items?.item;
        if (!items) return;
        const list = Array.isArray(items) ? items : [items];

        list.forEach(item => {
          results.push({
            name: item.BPLC_NM || '',
            type: api.name,
            status: item.DTL_SALS_STTS_NM || '',
            address: item.ROAD_NM_ADDR || item.LOTNO_ADDR || '',
            jibunAddress: item.LOTNO_ADDR || '',
            licenseDate: item.LCPMT_YMD || '',
          });
        });
      } catch { /* 403 등 무시 */ }
    })
  );

  const seen = new Set();
  const unique = results.filter(r => {
    const key = r.name + r.address;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);

  return res.json({ results: unique });
});

// ── REST API ──────────────────────────────────────────────────
router.post('/business', async (req, res) => {
  const { businessNumber, consentGiven, storeName } = req.body;

  if (!consentGiven) {
    return res.status(400).json({ success: false, error: '데이터 수집에 동의해야 합니다.' });
  }

  const validation = validateBusinessNumber(businessNumber);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }
  const cleanBizNum = validation.cleaned;
  const name = storeName || '';

  console.log(`[검증 시작] 사업자번호: ${cleanBizNum.substring(0, 3)}*******`);

  // 상호명은 국세청 검증과 병렬로 조회(참고용). 실패해도 아래 흐름에 영향 없음.
  const companyNamePromise = getCompanyName(cleanBizNum);

  try {
    const ntsResult = await checkBusinessStatus(cleanBizNum);

    let locationResult = null;
    let licenseResult  = null;
    let salesResult    = null;

    if (ntsResult.businessStatus === 'ACTIVE') {
      // 위치 검증을 먼저 실행하여 주소를 인허가 검증에 활용
      [locationResult, salesResult] = await Promise.all([
        verifyLocation(cleanBizNum, name),
        getSalesData(cleanBizNum, name),
      ]);
      // 인허가: location 주소로 프랜차이즈 지점 매칭
      const locAddr = locationResult?.address || locationResult?.jibunAddress || null;
      licenseResult = await getLicenseInfo(cleanBizNum, name, locAddr);
    }

    const trustScore = calculateTrustScore({
      nts: ntsResult, location: locationResult, license: licenseResult,
      sales: salesResult,
    });

    console.log(`[검증 완료] 점수: ${trustScore.totalScore}점 / 판정: ${trustScore.verdict.verdict}`);

    // 상호명: 비즈노(민간 DB) 우선 → 국세청 Mock 상호(시연) → 없으면 '' (프론트에서 '상호명 미확인')
    const biznoResult = await companyNamePromise;
    const resolvedName = biznoResult.companyName || ntsResult.companyName || '';

    return res.json({
      success: true,
      businessNumber: cleanBizNum.substring(0, 3) + '*'.repeat(7),
      companyName: resolvedName,
      companyNameSource: biznoResult.found ? 'BIZNO' : (ntsResult.companyName ? 'NTS' : 'NONE'),
      trustScore,
      verifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[검증 오류]', error.message);
    return res.status(500).json({ success: false, error: '검증 중 오류가 발생했습니다.' });
  }
});

// ── SSE 스트리밍 (4단계) ──────────────────────────────────────
router.get('/stream', async (req, res) => {
  const { businessNumber, consentGiven, storeName } = req.query;

  if (consentGiven !== 'true') {
    return res.status(400).json({ success: false, error: '동의가 필요합니다.' });
  }

  const validation = validateBusinessNumber(businessNumber);
  if (!validation.valid) {
    return res.status(400).json({ success: false, error: validation.error });
  }
  const cleanBizNum = validation.cleaned;
  const name = storeName || '';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (step, data) => res.write(`data: ${JSON.stringify({ step, ...data })}\n\n`);

  // 상호명은 단계 검증과 병렬로 조회(참고용). 완료 시점에만 취합, 실패해도 무영향.
  const companyNamePromise = getCompanyName(cleanBizNum);

  try {
    // ── Step 1: 국세청 ────────────────────────────────────────
    send(1, { status: 'loading', message: '국세청 사업자 상태 조회 중...' });
    const ntsResult = await checkBusinessStatus(cleanBizNum);
    const ntsScore  = calcStepScore(1, ntsResult);
    send(1, {
      status: ntsResult.businessStatus === 'ACTIVE' ? 'success' : 'failed',
      result: ntsResult,
      score:  ntsScore.score,
      detail: ntsScore.detail,
    });

    if (ntsResult.businessStatus !== 'ACTIVE') {
      const trustScore = calculateTrustScore({
        nts: ntsResult, location: null, license: null, sales: null,
      });
      // 휴/폐업이어도 상호명(참고용)은 표시. 판정은 국세청 기준 그대로.
      const biznoResult = await companyNamePromise;
      const resolvedName = biznoResult.companyName || ntsResult.companyName || '';
      send('done', { trustScore, companyName: resolvedName });
      return res.end();
    }

    // ── Step 2: 사업장 위치 ───────────────────────────────────
    send(2, { status: 'loading', message: '네이버 + 소상공인진흥공단 사업장 위치 교차검증 중...' });
    const locationResult = await verifyLocation(cleanBizNum, name);
    const locationScore  = calcStepScore(2, locationResult);
    send(2, {
      status: locationResult.matched ? 'success' : 'failed',
      result: locationResult,
      score:  locationScore.score,
      detail: locationScore.detail,
    });

    // ── Step 3: 영업 인허가 ───────────────────────────────────
    send(3, { status: 'loading', message: '행정안전부 지방행정인허가 조회 중...' });
    const licenseAddress = locationResult?.address || locationResult?.jibunAddress || null;
    const licenseResult = await getLicenseInfo(cleanBizNum, name, licenseAddress);
    const licenseScore  = calcStepScore(3, licenseResult);
    send(3, {
      status: licenseResult.hasLicense ? 'success' : 'warning',
      result: licenseResult,
      score:  licenseScore.score,
      detail: licenseScore.detail,
    });

    // 인허가 주소로 2단계 위치 교차검증 업그레이드 확인
    if (locationResult?.confidence !== 'HIGH' && licenseResult?.hasLicense) {
      const upgradedScore = calcStepScore(2, locationResult, licenseResult);
      if (upgradedScore.score > locationScore.score) {
        send(2, {
          status: 'success',
          result: locationResult,
          score:  upgradedScore.score,
          detail: upgradedScore.detail,
        });
      }
    }

    // ── Step 4: 카드 FDS ──────────────────────────────────────
    send(4, { status: 'loading', message: 'BC카드 매출 패턴 분석 중 (가맹점 본질 검증)...' });
    const salesResult = await getSalesData(cleanBizNum, name);
    const salesScore  = calcStepScore(4, salesResult);
    send(4, {
      status: salesResult.hasData ? 'success' : 'warning',
      result: salesResult,
      score:  salesScore.score,
      detail: salesScore.detail,
    });

    // ── 최종 결과 ─────────────────────────────────────────────
    const trustScore = calculateTrustScore({
      nts: ntsResult, location: locationResult, license: licenseResult,
      sales: salesResult,
    });
    // 상호명: 비즈노(민간 DB) 우선 → 국세청 Mock 상호(시연) → 없으면 '' (프론트 '상호명 미확인')
    const biznoResult = await companyNamePromise;
    const resolvedName = biznoResult.companyName || ntsResult.companyName || '';
    send('done', { trustScore, companyName: resolvedName });

  } catch (err) {
    send('error', { message: err.message });
  }

  res.end();
});

module.exports = router;
