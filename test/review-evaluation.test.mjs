import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, evaluateReport } from '../scripts/evaluate-review-reports.mjs';
const report = (file, findings = []) => JSON.stringify({ summary: '仅判断已提供的代码。', reviewed_files: [file], findings, limitations: [] });
test('the fixture harness exposes missed defects and unexpected locations without claiming semantic correctness', () => {
  const removed = cases.find((item) => item.id === 'removed-authorization');
  const missing = evaluateReport(removed, report('src/record.js'));
  assert.equal(missing.missing_expected_location, true);
  const found = evaluateReport(removed, report('src/record.js', [{ priority: 'P1', file: 'src/record.js', side: 'old', line: 10,
    title: '删除了授权检查', trigger: '不同租户访问', impact: '越权读取', confidence: 'high',
    evidence: "if (user.tenant !== record.tenant) throw new Error('forbidden');", suggestion: '恢复授权检查' }]));
  assert.equal(found.expected_location_matched, true);
  assert.equal(found.semantic_confirmation, 'requires human judgment');
  const clean = cases.find((item) => item.id === 'small-correct-guard');
  assert.equal(evaluateReport(clean, report('src/access.js')).unexpected_locations, 0);
  const large = cases.find(item => item.id === 'large-context-budget');
  assert.equal(evaluateReport(large, report('src/access.js')).contract, 'valid');
});
test('missing or truncated material is rejected by the evidence contract', () => {
  for (const item of cases.filter((item) => item.expect_coverage_blocked)) {
    assert.equal(evaluateReport(item, report(item.files[0].filename)).contract, 'rejected');
  }
});
