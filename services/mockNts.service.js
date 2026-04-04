/**
 * ============================================================
 * [Mock] 국세청 사업자 상태 조회 서비스
 * ============================================================
 * 실제 API: 공공데이터포털 "국세청_사업자등록정보 진위확인 및 상태조회 서비스"
 * 실제 엔드포인트: https://api.odcloud.kr/api/nts-businessman/v1/status
 * 인증: Service Key (공공데이터포털에서 발급)
 *
 * 이 Mock 서비스는 실제 API와 동일한 응답 구조를 반환합니다.
 * USE_MOCK=false 설정 시 실제 API 호출로 교체됩니다.
 */

const axios = require('axios');

// ── 시연용 사업자번호 (항상 Mock 사용) ────────────────────────────
const DEMO_NUMBERS = new Set(['1234567890', '9876543210', '1111111111', '2222222222']);

// ── Mock 데이터 테이블 ─────────────────────────────────────────
// 시연 시나리오별 사업자번호 → 결과 매핑
const MOCK_BUSINESSES = {
  // 시나리오 A: 우량 사업자 (고득점 → 승인)
  '1234567890': {
    businessStatus: 'ACTIVE',
    businessType: '음식업',
    registrationDate: '2019-03-15',
    companyName: '(주)맛있는식당',
    ceoName: '김*진',
  },
  // 시나리오 B: 활동 중이지만 데이터 부족 (중간 점수 → 보류)
  '9876543210': {
    businessStatus: 'ACTIVE',
    businessType: '소매업',
    registrationDate: '2023-11-01',
    companyName: '행복마트',
    ceoName: '이*수',
  },
  // 시나리오 C: 신설 사업자 (업력 6개월 → 조건부 승인, 서류 2종)
  '2222222222': {
    businessStatus: 'ACTIVE',
    businessType: '음식업',
    registrationDate: '2025-10-01',
    companyName: '새로운분식',
    ceoName: '최*영',
  },
  // 시나리오 D: 폐업 사업자 (저점수 → 거절)
  '1111111111': {
    businessStatus: 'CLOSED',
    businessType: '서비스업',
    registrationDate: '2020-05-20',
    closedDate: '2024-01-31',
    companyName: '옛날서비스',
    ceoName: '박*호',
  },
};

/**
 * 사업자 상태 조회 (Mock 버전)
 * @param {string} businessNumber - 하이픈 제거된 10자리 사업자 번호
 * @returns {Promise<object>} 국세청 조회 결과
 */
async function checkBusinessStatus(businessNumber) {
  // 네트워크 지연 시뮬레이션 (실제 API 호출 느낌 구현)
  await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 400));

  const data = MOCK_BUSINESSES[businessNumber];

  if (!data) {
    // 등록되지 않은 번호: 랜덤하게 결과 생성 (시연용 fallback)
    const isActive = Math.random() > 0.3;
    return {
      businessStatus: isActive ? 'ACTIVE' : 'NOT_FOUND',
      businessType: '',
      registrationDate: '2021-06-01',
      companyName: '',
      ceoName: '',
    };
  }

  return data;
}

/**
 * 실제 국세청 API 호출 함수 (USE_MOCK=false 시 사용)
 * @param {string} businessNumber
 */
async function checkBusinessStatusLive(businessNumber) {
  const serviceKey = process.env.NTS_API_KEY;
  if (!serviceKey) throw new Error('NTS_API_KEY가 설정되지 않았습니다.');

  const response = await axios.post(
    `https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${encodeURIComponent(serviceKey)}`,
    { b_no: [businessNumber] },
    {
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      timeout: 8000,
    }
  );

  const item = response.data?.data?.[0];
  if (!item) throw new Error('국세청 API 응답 없음');

  // b_stt (사업자 상태): '계속사업자' | '휴업자' | '폐업자'
  // b_stt_cd: '01'=계속, '02'=휴업, '03'=폐업
  // tax_type: 세금 유형 (업종이 아님 - "부가가치세 일반과세자" 등)
  // → 업종 정보는 이 API에서 제공하지 않으므로 세금유형을 그대로 표시
  const statusMap = { '01': 'ACTIVE', '02': 'SUSPENDED', '03': 'CLOSED' };

  // 업력 추정: tax_type_change_dt(과세유형 전환일)을 개업 시점 참고로 활용
  // 실서비스에서는 당행 내부 DB의 사업자등록일로 대체
  const changeDt = item.tax_type_change_dt || '';
  let registrationDate = '';
  if (changeDt.length === 8) {
    registrationDate = `${changeDt.substring(0, 4)}-${changeDt.substring(4, 6)}-${changeDt.substring(6, 8)}`;
  }

  return {
    businessStatus: statusMap[item.b_stt_cd] || 'UNKNOWN',
    businessStatusText: item.b_stt || '',       // "계속사업자" 텍스트
    businessType: item.tax_type || '미분류',     // 세금 유형 (업종 아님)
    registrationDate,                            // 업력 산출용 (과세유형 전환일 기반)
    closedDate: item.end_dt || '',
    companyName: '',
    ceoName: '',
  };
}

// USE_MOCK 환경 변수에 따라 실제/Mock 서비스 선택 + dataSource 태깅
async function checkBusinessStatusSafe(businessNumber) {
  // 시연용 번호는 항상 Mock (실제 국세청에 없는 번호이므로)
  if (process.env.USE_MOCK !== 'false' || DEMO_NUMBERS.has(businessNumber)) {
    const result = await checkBusinessStatus(businessNumber);
    return { ...result, dataSource: DEMO_NUMBERS.has(businessNumber) ? 'MOCK' : 'MOCK' };
  }
  try {
    const result = await checkBusinessStatusLive(businessNumber);
    return { ...result, dataSource: 'LIVE' };
  } catch (e) {
    console.warn('[국세청 Live 실패 → Mock 전환]', e.message);
    const result = await checkBusinessStatus(businessNumber);
    return { ...result, dataSource: 'MOCK' };
  }
}

module.exports = { checkBusinessStatus: checkBusinessStatusSafe };
