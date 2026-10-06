#!/usr/bin/env node
// Read-only rollout inventory. Never reads or writes secret values or changes PR branches.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export function inspectCaller(text, expectedSha) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const uses = lines.flatMap((line, index) => {
    const match = /^ {4}uses:\s*TshyGO\/ci-central\/\.github\/workflows\/pr-review\.yml@([a-f0-9]{40})\s*(?:#.*)?$/.exec(line);
    return match ? [{ index, sha: match[1] }] : [];
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
  const inputs = [...block.matchAll(/^ {6}central_workflow_sha:\s*([a-f0-9]{40})\s*(?:#.*)?$/gm)].map((m) => m[1]);
  const slots = ['A', 'B', 'C'].flatMap((lane) => ['KEY', 'API_BASE'].map((suffix) => `PR_AGENT_LANE_${lane}_${suffix}`));
  const mappingsValid = /^ {4}secrets:\s*(?:#.*)?$/m.test(block) && slots.every((slot) => {
    const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(`^ {6}${escaped}:\\s*\\$\\{\\{\\s*secrets\\.${escaped}\\s*\\}\\}\\s*(?:#.*)?$`, 'gm');
    return [...block.matchAll(expression)].length === 1;
  });
  const matched = pins.length === 1 && inputs.length === 1 && pins[0] === inputs[0];
  return { pin: pins.length === 1 ? pins[0] : null, matched, mappingsValid,
    current: matched && pins[0] === expectedSha,
    diagnosis: !matched ? 'caller_pin_mismatch' : !mappingsValid ? 'secret_mapping_mismatch'
      : pins[0] !== expectedSha ? 'old_branch_pin' : 'current' };
}

function api(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
export function audit(expectedSha, includeOpenPrs = true) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('--expected-sha requires a full immutable SHA.');
  const profiles = fs.readdirSync(path.join(here, '../review-action/config/repositories'))
    .filter((file) => file.endsWith('.json')).map((file) => JSON.parse(fs.readFileSync(path.join(here, '../review-action/config/repositories', file), 'utf8')).repository)
    .filter((repo) => repo !== 'TshyGO/ci-central');
  const rows = [];
  for (const repo of profiles) {
    const metadata = api(`repos/${repo}`);
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
        const result = inspectCaller(Buffer.from(file.content, 'base64').toString('utf8'), expectedSha);
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
