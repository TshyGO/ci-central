#!/usr/bin/env node
// Read-only rollout inventory. Never reads or writes secret values or changes PR branches.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// ci-central itself is moving to ptjworks. GitHub does not redirect reusable-workflow calls,
// so a caller must name whichever identity is live; the immutable ID says which one that is.
const centralRepositoryId = 1283955746;
export const centralRepositories = ['TshyGO/ci-central', 'ptjworks/ci-central'];
export function inspectCaller(text, expectedSha, expectedCentral = null) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const uses = lines.flatMap((line, index) => {
    const match = /^ {4}uses:\s*(TshyGO\/ci-central|ptjworks\/ci-central)\/\.github\/workflows\/pr-review\.yml@([a-f0-9]{40})\s*(?:#.*)?$/.exec(line);
    return match ? [{ index, central: match[1], sha: match[2] }] : [];
  });
  let block = '';
  if (uses.length === 1) {
    let start = uses[0].index;
    while (start >= 0 && !/^ {2}[\w-]+:\s*(?:#.*)?$/.test(lines[start])) start--;
    let end = uses[0].index + 1;
    while (end < lines.length && !/^ {2}[\w-]+:\s*(?:#.*)?$/.test(lines[end])) end++;
    if (start >= 0) block = lines.slice(start, end).join('\n');
  }
  const pins = uses.map(item => item.sha);
  const section = (name) => {
    const rows = block.split('\n');
    const start = rows.findIndex(line => new RegExp(`^ {4}${name}:\\s*(?:#.*)?$`).test(line));
    if (start < 0) return '';
    let end = start + 1;
    while (end < rows.length && (!rows[end].trim() || /^\s*#/.test(rows[end]) || /^ {6}\S/.test(rows[end]))) end++;
    return rows.slice(start + 1, end).join('\n');
  };
  const inputs = [...section('with').matchAll(/^ {6}central_workflow_sha:\s*([a-f0-9]{40})\s*(?:#.*)?$/gm)].map((m) => m[1]);
  const slots = ['A', 'B', 'C'].flatMap((lane) => ['KEY', 'API_BASE'].map((suffix) => `PR_AGENT_LANE_${lane}_${suffix}`));
  const secretBlock = section('secrets');
  const secretKeys = [...secretBlock.matchAll(/^ {6}([\w-]+):/gm)].map(match => match[1]);
  const mappingsValid = secretKeys.length === slots.length && slots.every((slot) => {
    const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(`^ {6}${escaped}:\\s*\\$\\{\\{\\s*secrets\\.${escaped}\\s*\\}\\}\\s*(?:#.*)?$`, 'gm');
    return [...secretBlock.matchAll(expression)].length === 1;
  });
  const matched = pins.length === 1 && inputs.length === 1 && pins[0] === inputs[0];
  const central = uses.length === 1 ? uses[0].central : null;
  // Every ci-central reference must follow the move, not only the pr-review pin inspected
  // above: NebulaLab's caller also pins claude-pr-review.yml, which breaks just the same.
  // GitHub resolves owner and repository names case-insensitively, so compare them that way.
  const centralNames = lines.flatMap((line) => {
    const match = /^\s*(?:-\s+)?uses:\s*["']?(TshyGO\/ci-central|ptjworks\/ci-central)\//i.exec(line);
    return match ? [match[1].toLowerCase()] : [];
  });
  const centralLive = !expectedCentral || centralNames.every((name) => name === expectedCentral.toLowerCase());
  return { pin: pins.length === 1 ? pins[0] : null, central, matched, mappingsValid,
    current: matched && centralLive && pins[0] === expectedSha,
    diagnosis: !matched ? 'caller_pin_mismatch' : !mappingsValid ? 'secret_mapping_mismatch'
      : !centralLive ? 'stale_central_name' : pins[0] !== expectedSha ? 'old_branch_pin' : 'current' };
}

function api(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
const ownershipTransitions = [
  { id: 1210416222, names: ['TshyGO/NebulaLab-Plugins', 'ptjworks/NebulaLab-Plugins'] },
  { id: 1235769167, names: ['TshyGO/NebulaLab-Docs', 'ptjworks/NebulaLab-Docs'] },
  { id: 1217054301, names: ['TshyGO/resume-form-assistant-plugin', 'ptjworks/resume-form-assistant-plugin'] },
];
export function inventoryProfiles(profiles) {
  // ci-central reviews itself through a relative caller, so neither of its identities is
  // audited. Register both identities of a moving caller, but inspect the repository once.
  return profiles.filter((repo) => !centralRepositories.includes(repo)
    && !ownershipTransitions.some(({ names }) => repo === names[1] && profiles.includes(names[0])));
}
export function resolveCentralRepository(read = api) {
  const metadata = read(`repositories/${centralRepositoryId}`);
  if (metadata?.id !== centralRepositoryId || !centralRepositories.includes(metadata.full_name)) {
    throw new Error('Unexpected ci-central repository identity during ownership transition.');
  }
  return metadata.full_name;
}
export function resolveRepository(profile, read = api) {
  const transition = ownershipTransitions.find(({ names }) => names.includes(profile));
  if (!transition) return read(`repos/${profile}`);
  // The immutable repository ID survives transfer and cannot be shadowed by a
  // recreated legacy slug. Do not depend on legacy URL redirects for auditing.
  const metadata = read(`repositories/${transition.id}`);
  if (metadata?.id !== transition.id || !transition.names.includes(metadata.full_name)) {
    throw new Error('Unexpected repository identity during ownership transition.');
  }
  return metadata;
}
export function audit(expectedSha, includeOpenPrs = true) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('--expected-sha requires a full immutable SHA.');
  const profiles = fs.readdirSync(path.join(here, '../review-action/config/repositories'))
    .filter((file) => file.endsWith('.json')).map((file) => JSON.parse(fs.readFileSync(path.join(here, '../review-action/config/repositories', file), 'utf8')).repository);
  const liveCentral = resolveCentralRepository();
  const rows = [];
  for (const profile of inventoryProfiles(profiles)) {
    const metadata = resolveRepository(profile);
    const repo = metadata.full_name;
    const refs = [{ label: metadata.default_branch, ref: metadata.default_branch, authoritative: true }];
    if (includeOpenPrs) {
      const pulls = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=open&per_page=100`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).flat();
      refs.push(...pulls.flatMap((pull) => [
        { label: `PR #${pull.number} head`, ref: pull.head.sha, authoritative: false },
        { label: `PR #${pull.number} merge`, ref: `refs/pull/${pull.number}/merge`, authoritative: true },
      ]));
    }
    for (const target of refs) {
      const workflow = /NebulaLab-(Docs|Plugins)$/.test(repo) ? 'ai-pr-review.yml' : 'pr-agent.yml';
      try {
        const file = api(`repos/${repo}/contents/.github/workflows/${workflow}?ref=${encodeURIComponent(target.ref)}`);
        const result = inspectCaller(Buffer.from(file.content, 'base64').toString('utf8'), expectedSha, liveCentral);
        rows.push({ repository: repo, target: target.label, authoritative: target.authoritative, ...result });
      } catch {
        rows.push({ repository: repo, target: target.label, authoritative: target.authoritative, diagnosis: 'unavailable' });
      }
    }
  }
  return rows;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--expected-sha');
    const rows = audit(index >= 0 ? process.argv[index + 1] || '' : '', !process.argv.includes('--default-branches-only'));
    console.log(JSON.stringify(rows, null, 2));
    // A PR head can retain the old file while the pull_request merge tree inherits
    // the updated caller from main. Head rows are informational, not proof of CI drift.
    if (rows.some((row) => row.authoritative && row.diagnosis !== 'current')) process.exitCode = 1;
  } catch {
    console.error('Caller audit failed; check the expected SHA, gh authentication and repository access. No state was changed.');
    process.exitCode = 1;
  }
}
