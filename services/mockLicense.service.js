/**
 * ============================================================
 * [5단계] 행정인허가 검증 서비스
 * ============================================================
 * 실제 API: 행정안전부 지방행정인허가데이터 (localdata.go.kr)
 * 엔드포인트: https://www.localdata.go.kr/platform/rest/{serviceCode}/openDataApi
 *
 * 업종별 영업허가 유효 여부를 확인합니다.
 * 인허가 없이는 합법적으로 사업을 영위할 수 없으므로
 * 실재 영업장 여부의 핵심 증거입니다.
 *
 * [지원 업종 코드]
 * GR0: 일반음식점 / GR1: 휴게음식점 / GR2: 제과점영업
 * LA0: 미용업 / LB0: 이용업 / LC0: 세탁업 / LD0: 목욕장업
 * LD1: 숙박업 / LF0: 안경업 / MK0: 의약품 판매업
 */

const axios = require('axios');

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['1234567890', '9876543210', '1111111111', '2222222222']);

// ── 인허가 업종 서비스 코드 ────────────────────────────────────
const LICENSE_SERVICE_CODES = [
  { code: 'GR0', name: '일반음식점' },
  { code: 'GR1', name: '휴게음식점' },
  { code: 'GR2', name: '제과점영업' },
  { code: 'LA0', name: '미용업' },
  { code: 'LB0', name: '이용업' },
  { code: 'LC0', name: '세탁업' },
  { code: 'LD0', name: '목욕장업' },
  { code: 'LD1', name: '숙박업' },
  { code: 'LF0', name: '안경업' },
];

// ── Mock 데이터 ───────────────────────────────────────────────
const MOCK_LICENSE_DATA = {
  // 시나리오 A: 음식업 허가 정상 (만점)
  '1234567890': {
    hasLicense: true,
    licenseType: '일반음식점',
    licenseStatus: '영업',
    licenseDate: '2019-03-20',
    expiryDate: null,       // 일반음식점은 만료일 없음
    address: '서울특별시 강남구 테헤란로 123',
    detail: '식품위생법 일반음식점 영업허가 유효 (2019.03 취득)',
  },
  // 시나리오 B: 신규 사업자 — 인허가 미취득 (신청 진행 중)
  '9876543210': {
    hasLicense: false,
    licenseType: null,
    licenseStatus: '미취득',
    licenseDate: null,
    expiryDate: null,
    address: null,
    detail: '행정인허가 조회 결과 없음 (신규사업자 또는 인허가 불필요 업종)',
  },
  // 시나리오 C: 신설 사업자 — 인허가 신규 취득
  '2222222222': {
    hasLicense: true,
    licenseType: '일반음식점',
    licenseStatus: '영업',
    licenseDate: '2025-09-15',
    expiryDate: null,
    address: '대구광역시 수성구 동대구로 100',
    detail: '일반음식점 영업허가 유효 (2025.09 취득) — 새로운분식',
  },
  // 시나리오 D: 폐업으로 허가 취소
  '1111111111': {
    hasLicense: false,
    licenseType: '일반음식점',
    licenseStatus: '폐업',
    licenseDate: '2020-05-25',
    expiryDate: '2024-01-31',
    address: null,
    detail: '인허가 폐업 처리 확인 (2024.01.31 말소)',
  },
};

// ── Mock 조회 ─────────────────────────────────────────────────
async function getLicenseMock(businessNumber) {
  await new Promise(r => setTimeout(r, 700 + Math.random() * 400));

  const data = MOCK_LICENSE_DATA[businessNumber];
  if (!data) {
    // 미등록 번호: 70% 확률로 인허가 있음
    const hasLicense = Math.random() > 0.3;
    return {
      hasLicense,
      licenseType: hasLicense ? '일반음식점' : null,
      licenseStatus: hasLicense ? '영업' : '미취득',
      licenseDate: hasLicense ? '2021-07-01' : null,
      expiryDate: null,
      address: hasLicense ? '서울특별시 종로구 종로 1' : null,
      detail: hasLicense
        ? '행정인허가 조회 완료 — 영업 상태 확인'
        : '행정인허가 조회 결과 없음',
    };
  }
  return data;
}

// ── data.go.kr 행정안전부 인허가 API (195종) ─────────────────
// 검색 파라미터: cond[BPLC_NM::LIKE]=상호명, cond[DTL_SALS_STTS_NM::EQ]=영업
// 페이징: perPage, page / 응답: returnType=json
const DATA_GO_KR_LICENSE_APIS = [
  { url: '/1741000/general_restaurants/info', name: '일반음식점' },
  { url: '/1741000/rest_cafes/info', name: '휴게음식점' },
  { url: '/1741000/bakeries/info', name: '제과점' },
  // 승인 대기 중 (403 해제되면 자동 동작)
  { url: '/1741000/beauty_salons/info', name: '미용업' },
  { url: '/1741000/laundries/info', name: '세탁업' },
  { url: '/1741000/lodgings/info', name: '숙박업' },
];

// 주소에서 매칭용 키워드 추출 (구/동/로 단위)
function extractAddressKeys(addr) {
  if (!addr) return [];
  // "대구광역시 달서구 성서로 123" → ["달서구", "성서로"] 등
  const tokens = addr.replace(/[,\s]+/g, ' ').split(' ').filter(Boolean);
  return tokens.filter(t => /[구동로길읍면리]$/.test(t) && t.length >= 2);
}

function matchAddress(candidateAddr, referenceAddr) {
  if (!referenceAddr) return 0;
  const refKeys = extractAddressKeys(referenceAddr);
  if (refKeys.length === 0) return 0;
  const candAddr = candidateAddr || '';
  return refKeys.filter(k => candAddr.includes(k)).length / refKeys.length;
}

async function getLicenseLive(storeName, address) {
  const serviceKey = process.env.LICENSE_API_KEY || process.env.NTS_API_KEY;
  if (!serviceKey) throw new Error('LICENSE_API_KEY 미설정');

  // 주소가 있으면 더 많은 결과를 받아서 지점 매칭
  const perPage = address ? 10 : 5;

  for (const { url: path, name } of DATA_GO_KR_LICENSE_APIS) {
    try {
      const url = `https://apis.data.go.kr${path}`
        + `?serviceKey=${encodeURIComponent(serviceKey)}`
        + `&perPage=${perPage}&page=1&returnType=json`
        + `&cond%5BBPLC_NM%3A%3ALIKE%5D=${encodeURIComponent(storeName)}`;

      const res = await axios.get(url, { timeout: 8000 });

      const items = res.data?.response?.body?.items?.item;
      if (!items) continue;
      const list = Array.isArray(items) ? items : [items];
      if (list.length === 0) continue;

      // 영업 중인 건만 필터
      const activeList = list.filter(i => i.DTL_SALS_STTS_NM === '영업');

      let active;
      if (address && activeList.length > 1) {
        // 주소 매칭으로 정확한 지점 선택
        const scored = activeList.map(i => ({
          item: i,
          score: matchAddress(i.ROAD_NM_ADDR || i.LOTNO_ADDR || '', address),
        }));
        scored.sort((a, b) => b.score - a.score);
        active = scored[0].score > 0 ? scored[0].item : activeList[0];
        if (scored[0].score > 0) {
          console.log(`[인허가] 주소 매칭: ${scored[0].item.BPLC_NM} (score: ${scored[0].score.toFixed(2)})`);
        }
      } else {
        active = activeList[0] || list[0];
      }

      const isActive = active.DTL_SALS_STTS_NM === '영업';

      return {
        hasLicense: isActive,
        licenseType: name,
        licenseStatus: active.DTL_SALS_STTS_NM || '미확인',
        licenseDate: active.LCPMT_YMD || '',
        expiryDate: active.CLSBIZ_YMD || null,
        address: active.ROAD_NM_ADDR || active.LOTNO_ADDR || '',
        detail: isActive
          ? `${name} 영업허가 유효 (${active.LCPMT_YMD || '취득일 미상'}) — ${active.BPLC_NM}`
          : `${name} ${active.DTL_SALS_STTS_NM || '미확인'} — ${active.BPLC_NM}`,
      };
    } catch {
      continue;
    }
  }

  return {
    hasLicense: false,
    licenseType: null,
    licenseStatus: '미확인',
    licenseDate: null,
    expiryDate: null,
    address: null,
    detail: '행정인허가 조회 결과 없음 (인허가 불필요 업종이거나 미취득)',
  };
}

// ── 외부 노출 ─────────────────────────────────────────────────
async function getLicenseInfo(businessNumber, storeName, address) {
  const useMock = process.env.USE_MOCK !== 'false';
  const key = process.env.LICENSE_API_KEY || process.env.NTS_API_KEY || '';

  if (useMock || DEMO_NUMBERS.has(businessNumber) || !storeName || !key || key.startsWith('your_')) {
    const result = await getLicenseMock(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }

  try {
    const result = await getLicenseLive(storeName, address);
    return { ...result, dataSource: 'LIVE' };
  } catch (e) {
    console.warn('[행정인허가 Live 실패 → Mock 전환]', e.message);
    const result = await getLicenseMock(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }
}

module.exports = { getLicenseInfo };
