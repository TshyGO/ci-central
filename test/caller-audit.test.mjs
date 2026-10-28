import test from 'node:test';
import assert from 'node:assert/strict';
import { centralRepositories, inspectCaller, inventoryProfiles, resolveCentralRepository, resolveRepository } from '../scripts/audit-review-callers.mjs';
const sha = 'a'.repeat(40);
// Only the live identity is excluded. A repository recreated at the retired TshyGO/ci-central
// slug is a separate repository, so a profile for it would be audited like any other caller.
test('ci-central does not audit its live identity as a caller', () => {
  assert.deepEqual(inventoryProfiles([...centralRepositories, 'TshyGO/NebulaLab']), ['TshyGO/NebulaLab']);
  assert.deepEqual(inventoryProfiles(['ptjworks/ci-central', 'ptjworks/NebulaLab-Docs']), ['ptjworks/NebulaLab-Docs']);
  assert.deepEqual(inventoryProfiles(['TshyGO/ci-central', 'ptjworks/ci-central']), ['TshyGO/ci-central']);
});
test('ci-central live identity resolves by immutable ID to ptjworks only', () => {
  assert.deepEqual(centralRepositories, ['ptjworks/ci-central']);
  assert.equal(resolveCentralRepository(endpoint => {
    assert.equal(endpoint, 'repositories/1283955746');
    return { id: 1283955746, full_name: 'ptjworks/ci-central' };
  }), 'ptjworks/ci-central');
  // ci-central left TshyGO on 2026-10-27; that name is no longer a valid live identity.
  for (const payload of [null, {}, { id: 9, full_name: 'ptjworks/ci-central' }, { id: 1283955746, full_name: 'other/ci-central' },
    { id: 1283955746, full_name: 'TshyGO/ci-central' }]) {
    assert.throws(() => resolveCentralRepository(() => payload), /Unexpected ci-central repository identity/);
  }
});
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
  assert.equal(resolveRepository('TshyGO/NebulaGraph-License-Service', endpoint => endpoint), 'repos/TshyGO/NebulaGraph-License-Service');
});
test('Thesis Polisher transition audits one identity and resolves its immutable ID', () => {
  const names = ['TshyGO/AI-Thesis-Polisher', 'ptjworks/AI-Thesis-Polisher'];
  assert.deepEqual(inventoryProfiles([...names, 'TshyGO/NebulaLab']), [names[0], 'TshyGO/NebulaLab']);
  assert.deepEqual(inventoryProfiles([names[1]]), [names[1]]);
  for (const profile of names) {
    for (const canonical of names) {
      const result = resolveRepository(profile, endpoint => {
        assert.equal(endpoint, 'repositories/1190330270');
        return { id: 1190330270, full_name: canonical, default_branch: 'main' };
      });
      assert.equal(result.full_name, canonical);
    }
    for (const payload of [null, {}, { id: 9, full_name: profile }, { id: 1190330270, full_name: 'other/AI-Thesis-Polisher' }]) {
      assert.throws(() => resolveRepository(profile, () => payload), /Unexpected repository identity/);
    }
  }
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
test('rollout audit requires callers to name the live ci-central identity', () => {
  const moved = text.replace('uses: TshyGO/ci-central/', 'uses: ptjworks/ci-central/');
  assert.equal(inspectCaller(moved, sha).central, 'ptjworks/ci-central');
  assert.equal(inspectCaller(moved, sha).diagnosis, 'current');
  // Before the transfer the new name does not resolve yet; after it the legacy name never will.
  assert.equal(inspectCaller(text, sha, 'TshyGO/ci-central').diagnosis, 'current');
  assert.equal(inspectCaller(moved, sha, 'TshyGO/ci-central').diagnosis, 'stale_central_name');
  assert.equal(inspectCaller(moved, sha, 'ptjworks/ci-central').diagnosis, 'current');
  const stale = inspectCaller(text, sha, 'ptjworks/ci-central');
  assert.equal(stale.diagnosis, 'stale_central_name');
  assert.equal(stale.current, false);
  assert.equal(inspectCaller(text.replace('uses: TshyGO/ci-central/', 'uses: someone/ci-central/'), sha).diagnosis, 'caller_pin_mismatch');
});
test('rollout audit flags any other ci-central pin left on the stale identity', () => {
  const moved = text.replace('uses: TshyGO/ci-central/', 'uses: ptjworks/ci-central/');
  const claudeJob = (owner) => `\n  claude-review:\n    uses: ${owner}/ci-central/.github/workflows/claude-pr-review.yml@${'b'.repeat(40)}\n`;
  assert.equal(inspectCaller(moved + claudeJob('TshyGO'), sha, 'ptjworks/ci-central').diagnosis, 'stale_central_name');
  assert.equal(inspectCaller(moved + claudeJob('ptjworks'), sha, 'ptjworks/ci-central').diagnosis, 'current');
  assert.equal(inspectCaller(moved + `\n  claude-review:\n    uses: "TshyGO/ci-central/.github/workflows/claude-pr-review.yml@${'b'.repeat(40)}"\n`, sha, 'ptjworks/ci-central').diagnosis, 'stale_central_name');
  // GitHub resolves names case-insensitively, so a re-cased legacy pin still targets the old name.
  for (const owner of ['tshygo', 'TSHYGO']) {
    assert.equal(inspectCaller(moved + claudeJob(owner), sha, 'ptjworks/ci-central').diagnosis, 'stale_central_name');
  }
  assert.equal(inspectCaller(moved + claudeJob('PtjWorks'), sha, 'ptjworks/ci-central').diagnosis, 'current');
  // A comment that still mentions the old name is not a call and must not fail the audit.
  assert.equal(inspectCaller('# Thin caller: logic lives in TshyGO/ci-central.\n#    uses: TshyGO/ci-central/.github/workflows/claude-pr-review.yml@x\n' + moved, sha, 'ptjworks/ci-central').diagnosis, 'current');
});
