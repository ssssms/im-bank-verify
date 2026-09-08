/**
 * ============================================================
 * 관리자 룰 조정 API — "룰로 돌린다"를 눈으로 보여주는 장치 (2026-09-08)
 * ============================================================
 * GET  /api/admin/rules        현재 값 · 기본값 · 변경 이력
 * PUT  /api/admin/rules        부분 갱신 { 키: 값 } — 범위 검증, 하나라도 틀리면 전부 거부
 * POST /api/admin/rules/reset  전부 기본값으로
 *
 * [등록 조건] server.js 가 ADMIN_ENABLED=true 일 때만 이 라우터를 붙인다.
 *             미설정이면 라우트 자체가 없어 기존 동작과 100% 같다.
 * [인증]     요청 헤더 x-admin-token 이 .env 의 ADMIN_TOKEN 과 같아야 한다.
 *             ADMIN_TOKEN 이 비어 있으면 모든 요청을 거부한다(토큰 없는 개방 금지).
 * [저장]     변경 이력은 메모리에 { at, key, from, to } 로 쌓인다. 서버를 재시작하면
 *             오버라이드·이력 모두 초기화된다(영속 저장 없음 — 시연·검증용).
 */

const express = require('express');
const router = express.Router();
const { snapshot, updateRules, resetRules } = require('../utils/rules.config');

// 토큰 검사 — 길이가 다르면 바로 거부, 같으면 상수 시간 비교
function tokenOk(given, expected) {
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

router.use((req, res, next) => {
  const expected = process.env.ADMIN_TOKEN || '';
  if (!tokenOk(req.get('x-admin-token'), expected)) {
    return res.status(401).json({ success: false, error: '관리자 토큰이 올바르지 않습니다.' });
  }
  next();
});

router.get('/rules', (req, res) => {
  res.json({ success: true, ...snapshot() });
});

router.put('/rules', (req, res) => {
  const result = updateRules(req.body);
  if (result.error) return res.status(400).json({ success: false, error: result.error });
  if (result.changed.length) console.log(`[관리자] 룰 변경: ${result.changed.join(', ')}`);
  res.json({ success: true, ...result });
});

router.post('/rules/reset', (req, res) => {
  const result = resetRules();
  if (result.changed.length) console.log(`[관리자] 룰 기본값 복원: ${result.changed.join(', ')}`);
  res.json({ success: true, ...result });
});

module.exports = router;
