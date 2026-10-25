import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCaller, inventoryProfiles, resolveRepository } from '../scripts/audit-review-callers.mjs';
const sha = 'a'.repeat(40);
test('Resume Pro transition resolves the stable repository without querying a future slug', () => {
  const names = ['TshyGO/resume-form-assistant-plugin', 'ptjworks/resume-form-assistant-plugin'];
  assert.deepEqual(inventoryProfiles(names), [names[0]]);
  assert.deepEqual(inventoryProfiles([names[1]]), [names[1]]);
  for (const profile of names) {
    for (const canonical of names) {
      const metadata = resolveRepository(profile, endpoint => {
        assert.equal(endpoint, 'repositories/1217054301');
        return { id: 1217054301, full_name: canonical };
      });
      assert.equal(metadata.full_name, canonical);
    }
  }
});
test('ownership transition audits one identity before and after transfer', () => {
  const oldName = 'TshyGO/NebulaLab-Plugins';
  const newName = 'ptjworks/NebulaLab-Plugins';
  const other = 'TshyGO/NebulaLab-Docs';
  assert.deepEqual(inventoryProfiles([oldName, newName, other]), [oldName, other]);
  assert.deepEqual(inventoryProfiles([newName, other]), [newName, other]);
  assert.deepEqual(inventoryProfiles([oldName, other]), [oldName, other]);
});
test('Plugins audit resolves its immutable ID and rejects an unexpected identity', () => {
  for (const name of ['TshyGO/NebulaLab-Plugins', 'ptjworks/NebulaLab-Plugins']) {
    for (const canonical of ['TshyGO/NebulaLab-Plugins', 'ptjworks/NebulaLab-Plugins']) {
      const result = resolveRepository(name, endpoint => {
        assert.equal(endpoint, 'repositories/1210416222');
        return { id: 1210416222, full_name: canonical, default_branch: 'main' };
      });
      assert.equal(result.full_name, canonical);
    }
    assert.throws(() => resolveRepository(name, () => ({ id: 99, full_name: name })), /Unexpected/);
    assert.throws(() => resolveRepository(name, () => ({ id: 1210416222, full_name: 'other/repository' })), /Unexpected/);
  }
  assert.equal(resolveRepository('TshyGO/AI-Thesis-Polisher', endpoint => endpoint), 'repos/TshyGO/AI-Thesis-Polisher');
});
test('Docs inventory deduplicates ownership aliases and resolves the stable ID', () => {
  const names = ['TshyGO/NebulaLab-Docs', 'ptjworks/NebulaLab-Docs'];
  assert.deepEqual(inventoryProfiles(names), [names[0]]);
  assert.deepEqual(inventoryProfiles([names[1]]), [names[1]]);
  assert.deepEqual(inventoryProfiles([names[0]]), [names[0]]);
  for (const profile of names) {
    for (const canonical of names) {
      const result = resolveRepository(profile, endpoint => {
        assert.equal(endpoint, 'repositories/1235769167');
        return { id: 1235769167, full_name: canonical, default_branch: 'main' };
      });
      assert.equal(result.full_name, canonical);
    }
    for (const payload of [null, {}, { id: 9, full_name: profile }, { id: 1235769167, full_name: 'other/repository' }]) {
      assert.throws(() => resolveRepository(profile, () => payload), /Unexpected repository identity/);
    }
  }
});
const slots = ['A', 'B', 'C'].flatMap((lane) => ['KEY', 'API_BASE'].map((suffix) => `PR_AGENT_LANE_${lane}_${suffix}`));
const text = `jobs:\n  ai-pr-review:\n    uses: TshyGO/ci-central/.github/workflows/pr-review.yml@${sha}\n    with:\n      central_workflow_sha: ${sha}\n    secrets:\n`
  + slots.map((slot) => `      ${slot}: \${{ secrets.${slot} }}`).join('\n');
test('rollout audit distinguishes old branch pins from inconsistent callers and missing mappings', () => {
  assert.equal(inspectCaller(text, sha).diagnosis, 'current');
  assert.equal(inspectCaller(text, 'b'.repeat(40)).diagnosis, 'old_branch_pin');
  assert.equal(inspectCaller(text.replace('central_workflow_sha: ' + sha, 'central_workflow_sha: ' + 'b'.repeat(40)), sha).diagnosis, 'caller_pin_mismatch');
  assert.equal(inspectCaller(text.replace(slots[0] + ':', 'wrong:'), sha).diagnosis, 'secret_mapping_mismatch');
  assert.equal(inspectCaller('# uses: TshyGO/ci-central/.github/workflows/pr-review.yml@' + 'b'.repeat(40) + '\n' + text, sha).diagnosis, 'current');
  assert.equal(inspectCaller(text.replace(`      ${slots[0]}:`, `      # ${slots[0]}:`), sha).diagnosis, 'secret_mapping_mismatch');
  const otherJob = '\n  unrelated:\n    secrets:\n' + slots.map(slot => `      ${slot}: \${{ secrets.${slot} }}`).join('\n');
  assert.equal(inspectCaller(text.replace(`      ${slots[0]}:`, `      # ${slots[0]}:`) + otherJob, sha).diagnosis, 'secret_mapping_mismatch');
  const wrongSection = text.replace(`      ${slots[0]}:`, `      # ${slots[0]}:`)
    .replace('    with:\n', `    with:\n      ${slots[0]}: \${{ secrets.${slots[0]} }}\n`);
  assert.equal(inspectCaller(wrongSection, sha).diagnosis, 'secret_mapping_mismatch');
  assert.equal(inspectCaller(text + '\n      EXTRA_KEY: ${{ secrets.EXTRA_KEY }}', sha).diagnosis, 'secret_mapping_mismatch');
});
