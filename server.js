/**
 * ============================================================
 * iM Bank 사업자 실영위 검증 자동화 시스템 - Express 서버
 * ============================================================
 * 이 파일은 애플리케이션의 진입점입니다.
 * 보안 미들웨어 설정, CORS, Rate Limiting을 구성합니다.
 */

require('dotenv').config(); // .env 파일에서 환경 변수 로드 (최상단에 위치해야 함)

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet'); // 보안 HTTP 헤더 자동 설정
const rateLimit = require('express-rate-limit');
const verifyRouter = require('./routes/verify');

const app = express();
const PORT = process.env.PORT || 4000;

// ── 보안 미들웨어 ──────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: 배포 시 같은 서버이므로 모든 origin 허용
app.use(cors());

// Rate Limiting: API 남용 및 브루트포스 공격 방어
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1분 윈도우
  max: parseInt(process.env.RATE_LIMIT_MAX) || 30,
  message: {
    success: false,
    error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ── 미들웨어 ───────────────────────────────────────────────
// JSON 파싱 (요청 본문 크기 제한으로 DoS 방어)
app.use(express.json({ limit: '10kb' }));

// ── 라우터 연결 ────────────────────────────────────────────
app.use('/api/verify', verifyRouter);

// 서버 상태 확인 엔드포인트
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    mode: process.env.USE_MOCK === 'true' ? 'MOCK' : 'LIVE',
    timestamp: new Date().toISOString(),
  });
});

// ── 정적 파일 서빙 (Vite 빌드 결과물) ─────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SPA 폴백: API 외 모든 요청은 index.html로
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 전역 에러 핸들러 ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[서버 오류]', err.message);
  res.status(500).json({ success: false, error: '내부 서버 오류가 발생했습니다.' });
});

app.listen(PORT, () => {
  console.log(`\n🏦 iM Bank 검증 서버 실행 중`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   모드: ${process.env.USE_MOCK === 'true' ? '🔵 MOCK (시연용)' : '🟢 LIVE (실제 API)'}`);
  console.log(`   시작 시각: ${new Date().toLocaleString('ko-KR')}\n`);
});
