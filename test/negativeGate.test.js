/**
 * 네거티브 게이트 단위 테스트 — 신용·경영 신호(INFO)는 판정에 영향이 없어야 한다 (2026-09-12).
 * 실행: node test/negativeGate.test.js
 */
const assert = require('assert');
const { evaluateGate, ALARM_RULES } = require('../utils/negativeGate');

let n = 0;
const ok = (msg, fn) => { fn(); n++; console.log(`  ✓ ${msg}`); };
const gate = alarms => evaluateGate({ sales: { alarms }, salesScore: { subScores: [] } });

console.log('negativeGate');

ok('신용·경영 4종(사고코드·연체·압류·역환)은 INFO — 게이트 NONE, 오버라이드 없음', () => {
  const g = gate({ accidentCode: true, overdueHolder: true, seizureHold: true, chargebackHold: true });
  assert.strictEqual(g.level, 'NONE'); assert.strictEqual(g.override, null);
  assert.strictEqual(g.infoCount, 4);
  assert.ok(g.summary.includes('참고 4건'), g.summary);
  assert.ok(g.reasons.every(r => r.level === 'INFO' && r.category === 'CREDIT'));
});

ok('부정·가장 신호는 그대로 — 불량가맹점 BLOCK, 대외기관 적발 BLOCK, 명의대여 BLOCK', () => {
  for (const k of ['badMerchantRegistered', 'externalReport', 'ownerMismatch', 'merchantIdError', 'severeTermsViolation']) {
    const g = gate({ [k]: true });
    assert.strictEqual(g.level, 'BLOCK', k); assert.strictEqual(g.override, 'REJECTED', k);
  }
  for (const k of ['fdsHighScore10', 'abnormalOperationHold', 'fraudComplaint']) {
    const g = gate({ [k]: true });
    assert.strictEqual(g.level, 'HOLD', k); assert.strictEqual(g.override, 'PENDING', k);
  }
});

ok('INFO 가 BLOCK 과 같이 오면 레벨은 BLOCK, summary 엔 BLOCK 사유만', () => {
  const g = gate({ overdueHolder: true, badMerchantRegistered: true });
  assert.strictEqual(g.level, 'BLOCK');
  assert.strictEqual(g.summary, '카드업권 불량가맹점 등록');
  assert.strictEqual(g.infoCount, 1);
});

ok('INFO 규칙은 category CREDIT 이고 detail 에 「판정에 반영하지 않습니다」가 붙는다', () => {
  const infos = ALARM_RULES.filter(r => r.level === 'INFO');
  assert.deepStrictEqual(infos.map(r => r.key).sort(), ['accidentCode', 'chargebackHold', 'overdueHolder', 'seizureHold']);
  assert.ok(infos.every(r => r.category === 'CREDIT' && r.detail.includes('판정에 반영하지 않습니다')));
});

ok('FDS 스코어 5%(fdsHighScore5) 는 WATCH — 판정은 그대로, 사유만 남는다 [2026-09-16]', () => {
  const g = gate({ fdsHighScore5: true });
  assert.strictEqual(g.level, 'WATCH');
  assert.strictEqual(g.override, null, '5% 만으로는 판정을 바꾸지 않는다');
  assert.ok(g.reasons.some(r => r.code === 'fdsHighScore5' && r.level === 'WATCH'), JSON.stringify(g.reasons));
});

ok('5% 와 10% 가 함께 오면 10%(HOLD)가 이긴다 — 보류', () => {
  const g = gate({ fdsHighScore5: true, fdsHighScore10: true });
  assert.strictEqual(g.level, 'HOLD');
  assert.strictEqual(g.override, 'PENDING');
});

console.log(`\u2705 ${n}건 통과`);
