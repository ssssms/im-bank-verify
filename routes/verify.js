/**
 * ============================================================
 * 사업자 검증 API 라우터 — 6단계 버전
 * ============================================================
 * GET  /api/verify/lookup       - 사업자번호 빠른 조회 (입력 시 자동)
 * GET  /api/verify/autocomplete - 상호명 자동완성 (인허가 API 검색)
 * POST /api/verify/business     - 전체 검증 (REST 폴백)
 * GET  /api/verify/stream       - 단계별 실시간 검증 (SSE)
 */

const express = require('express');
const router = express.Router();

const { checkBusinessStatus } = require('../services/mockNts.service');
const { getPensionInfo }       = require('../services/mockPension.service');
const { verifyLocation }       = require('../services/mockLocation.service');
const { getLicenseInfo }       = require('../services/mockLicense.service');
const { getBuildingInfo }      = require('../services/mockBuilding.service');
const { getSalesData }         = require('../services/mockSales.service');
const { calculateTrustScore, calcStepScore } = require('../utils/scoreEngine');

function validateBusinessNumber(raw) {
  const cleaned = (raw || '').replace(/-/g, '').replace(/\s/g, '');
  if (!/^\d{10}$/.test(cleaned)) {
    return { valid: false, error: '사업자 번호는 10자리 숫자여야 합니다.' };
  }
  return { valid: true, cleaned };
}

// ── 사업자번호 빠른 조회 ──────────────────────────────────────
// GET /api/verify/lookup?businessNumber=1234567890
router.get('/lookup', async (req, res) => {
  const validation = validateBusinessNumber(req.query.businessNumber);
  if (!validation.valid) return res.json({ found: false });

  try {
    const ntsResult = await checkBusinessStatus(validation.cleaned);
    return res.json({
      found: ntsResult.businessStatus === 'ACTIVE',
      businessStatus: ntsResult.businessStatus,
      businessStatusText: ntsResult.businessStatusText || '',
      companyName: ntsResult.companyName || '',
      businessType: ntsResult.businessType || '',
    });
  } catch {
    return res.json({ found: false });
  }
});

// ── 상호명 자동완성 (인허가 API 검색) ─────────────────────────
// GET /api/verify/autocomplete?q=또이스
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

  // 모든 업종 API를 병렬로 검색
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

  // 중복 제거 (이름+주소 기준) 후 최대 10개
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

  try {
    const ntsResult = await checkBusinessStatus(cleanBizNum);

    let pensionResult  = null;
    let locationResult = null;
    let licenseResult  = null;
    let buildingResult = null;
    let salesResult    = null;

    if (ntsResult.businessStatus === 'ACTIVE') {
      // 위치 검증을 먼저 실행하여 주소를 인허가·건물현황 검증에 활용
      [pensionResult, locationResult, salesResult] =
        await Promise.all([
          getPensionInfo(cleanBizNum),
          verifyLocation(cleanBizNum, name),
          getSalesData(cleanBizNum, name),
        ]);
      // 인허가: location 주소로 프랜차이즈 지점 매칭
      const locAddr = locationResult?.address || locationResult?.jibunAddress || null;
      licenseResult = await getLicenseInfo(cleanBizNum, name, locAddr);
      // 건물현황: location에서 얻은 지번 주소 활용 (건축물대장 API는 지번 기반)
      const buildingAddress = locationResult?.jibunAddress || locationResult?.address || null;
      buildingResult = await getBuildingInfo(cleanBizNum, buildingAddress);
    }

    const trustScore = calculateTrustScore({
      nts: ntsResult, pension: pensionResult,
      location: locationResult, license: licenseResult,
      building: buildingResult, sales: salesResult,
    });

    console.log(`[검증 완료] 점수: ${trustScore.totalScore}점 / 판정: ${trustScore.verdict.verdict}`);

    return res.json({
      success: true,
      businessNumber: cleanBizNum.substring(0, 3) + '*'.repeat(7),
      companyName: ntsResult.companyName || name || '(상호 확인됨)',
      trustScore,
      verifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[검증 오류]', error.message);
    return res.status(500).json({ success: false, error: '검증 중 오류가 발생했습니다.' });
  }
});

// ── SSE 스트리밍 ──────────────────────────────────────────────
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

    // 폐업/휴업이면 trustScore 계산 후 종료 (버그 수정: 결과 화면으로 전환되게 포함)
    if (ntsResult.businessStatus !== 'ACTIVE') {
      const trustScore = calculateTrustScore({
        nts: ntsResult, pension: null, location: null,
        license: null, building: null, sales: null,
      });
      send('done', { trustScore, companyName: ntsResult.companyName || name });
      return res.end();
    }

    // ── Step 2: 국민연금 ──────────────────────────────────────
    send(2, { status: 'loading', message: '국민연금 직장가입자 내역 조회 중...' });
    const pensionResult = await getPensionInfo(cleanBizNum);
    const pensionScore  = calcStepScore(2, pensionResult);
    send(2, {
      status: pensionResult.employeeCount > 0 ? 'success' : 'warning',
      result: pensionResult,
      score:  pensionScore.score,
      detail: pensionScore.detail,
    });

    // ── Step 3: 상권정보 위치 검증 ────────────────────────────
    send(3, { status: 'loading', message: '상권정보 DB 사업장 위치 교차검증 중...' });
    const locationResult = await verifyLocation(cleanBizNum, name);
    const locationScore  = calcStepScore(3, locationResult);
    send(3, {
      status: locationResult.matched ? 'success' : 'failed',
      result: locationResult,
      score:  locationScore.score,
      detail: locationScore.detail,
    });

    // ── Step 4: 행정인허가 ────────────────────────────────────
    send(4, { status: 'loading', message: '행정안전부 지방행정인허가 조회 중...' });
    const licenseAddress = locationResult?.address || locationResult?.jibunAddress || null;
    const licenseResult = await getLicenseInfo(cleanBizNum, name, licenseAddress);
    const licenseScore  = calcStepScore(4, licenseResult);
    send(4, {
      status: licenseResult.hasLicense ? 'success' : 'warning',
      result: licenseResult,
      score:  licenseScore.score,
      detail: licenseScore.detail,
    });

    // 인허가 주소로 3단계 교차검증 업그레이드 확인
    if (locationResult?.confidence !== 'HIGH' && licenseResult?.hasLicense) {
      const upgradedScore = calcStepScore(3, locationResult, licenseResult);
      if (upgradedScore.score > locationScore.score) {
        send(3, {
          status: 'success',
          result: locationResult,
          score:  upgradedScore.score,
          detail: upgradedScore.detail,
        });
      }
    }

    // ── Step 5: 건물현황 ──────────────────────────────────────
    send(5, { status: 'loading', message: '국토교통부 건축물대장 주소 확인 중...' });
    const buildingAddress = locationResult?.jibunAddress || locationResult?.address || null;
    const buildingResult = await getBuildingInfo(cleanBizNum, buildingAddress);
    const buildingScore  = calcStepScore(5, buildingResult);
    send(5, {
      status: buildingResult.exists ? (buildingResult.isCommercial ? 'success' : 'warning') : 'failed',
      result: buildingResult,
      score:  buildingScore.score,
      detail: buildingScore.detail,
    });

    // ── Step 6: 금융활동 보완 ─────────────────────────────────
    send(6, { status: 'loading', message: '카드매출 · 전자세금계산서 확인 중...' });
    const salesResult = await getSalesData(cleanBizNum, name);
    const salesScore  = calcStepScore(6, salesResult);
    send(6, {
      status: salesResult.hasData ? 'success' : 'warning',
      result: salesResult,
      score:  salesScore.score,
      detail: salesScore.detail,
    });

    // ── 최종 결과 ─────────────────────────────────────────────
    const trustScore = calculateTrustScore({
      nts: ntsResult, pension: pensionResult, location: locationResult,
      license: licenseResult, building: buildingResult, sales: salesResult,
    });
    send('done', { trustScore, companyName: ntsResult.companyName || name });

  } catch (err) {
    send('error', { message: err.message });
  }

  res.end();
});

module.exports = router;
