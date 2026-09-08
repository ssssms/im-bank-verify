/**
 * 업력 산출 — scoreEngine 과 eligibility 가 같은 함수를 쓴다.
 * (scoreEngine ↔ eligibility 순환 참조를 피하려고 별도 파일로 뺐다. scoreEngine 이 재수출한다.)
 */
function calcBusinessYears(registrationDate) {
  if (!registrationDate) return 0;
  const regDate = new Date(registrationDate);
  if (isNaN(regDate.getTime())) return 0;
  const now = new Date();
  return (now - regDate) / (365.25 * 24 * 60 * 60 * 1000);
}

module.exports = { calcBusinessYears };
