import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCaller } from '../scripts/audit-review-callers.mjs';
const sha = 'a'.repeat(40);
const slots = ['A', 'B', 'C'].flatMap((lane) => ['KEY', 'API_BASE'].map((suffix) => `PR_AGENT_LANE_${lane}_${suffix}`));
const text = `uses: TshyGO/ci-central/.github/workflows/pr-review.yml@${sha}\ncentral_workflow_sha: ${sha}\n`
  + slots.map((slot) => `${slot}: \${{ secrets.${slot} }}`).join('\n');
test('rollout audit distinguishes old branch pins from inconsistent callers and missing mappings', () => {
  assert.equal(inspectCaller(text, sha).diagnosis, 'current');
  assert.equal(inspectCaller(text, 'b'.repeat(40)).diagnosis, 'old_branch_pin');
  assert.equal(inspectCaller(text.replace('central_workflow_sha: ' + sha, 'central_workflow_sha: ' + 'b'.repeat(40)), sha).diagnosis, 'caller_pin_mismatch');
  assert.equal(inspectCaller(text.replace(slots[0] + ':', 'wrong:'), sha).diagnosis, 'secret_mapping_mismatch');
  assert.equal(inspectCaller('# uses: TshyGO/ci-central/.github/workflows/pr-review.yml@' + 'b'.repeat(40) + '\n' + text, sha).diagnosis, 'current');
});
