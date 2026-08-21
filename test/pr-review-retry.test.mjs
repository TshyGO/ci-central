#!/usr/bin/env node
// Executes the real bounded retry script against mocked GitHub APIs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(here, '..', '.github', 'workflows', 'pr-review-retry.yml');
const raw = fs.readFileSync(workflowPath, 'utf8').split('\n');
const workflowText = raw.join('\n');
const start = raw.findIndex((line) => line.trim() === 'script: |');
if (start < 0) throw new Error('retry script block not found');
const lines = [];
for (let i = start + 1; i < raw.length; i++) {
  if (raw[i].trim() !== '' && !raw[i].startsWith(' '.repeat(12))) break;
  lines.push(raw[i].slice(12));
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runScript = new AsyncFunction('github', 'context', 'core', lines.join('\n'));

const headSha = 'deadbeef'.repeat(5);
const workflowSha = 'feedface'.repeat(5);
const baseRun = {
  id: 12345,
  name: 'AI PR Review',
  event: 'pull_request',
  conclusion: 'failure',
  run_attempt: 1,
  head_sha: headSha,
  pull_requests: [{ number: 27 }],
};
const endpointDiagnostic = ({ head = headSha, status = 'diagnostic', bot = true, body = 'Reason: endpoint-unavailable.\nfetch failed' } = {}) => ({
  user: { login: bot ? 'github-actions[bot]' : 'octocat' },
  body: [
    '<!-- ai-pr-review-bot:lane-A -->',
    `<!-- ai-pr-review-evidence:v2 lane=A head=${head} workflow=${workflowSha} status=${status} -->`,
    body,
  ].join('\n'),
});

async function scenario({ run = {}, pull = {}, comments = [endpointDiagnostic()], repository = 'TshyGO/ci-central' } = {}) {
  const reruns = [];
  const logs = [];
  const [owner, repo] = repository.split('/');
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { state: 'open', head: { sha: headSha }, ...pull } }),
      },
      issues: { listComments: 'comments' },
      actions: {
        reRunWorkflowFailedJobs: async (args) => { reruns.push(args); },
      },
    },
    paginate: async (endpoint) => endpoint === 'comments' ? comments : [],
  };
  const context = {
    repo: { owner, repo },
    payload: { workflow_run: { ...baseRun, ...run } },
  };
  await runScript(github, context, { info: (message) => logs.push(message) });
  return { reruns, logs };
}

const checks = [];
const check = (name, condition) => {
  checks.push(Boolean(condition));
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`);
};

check('retry workflow supports centralized calls and self workflow_run events', workflowText.includes('workflow_call:')
  && workflowText.includes('workflow_run:')
  && workflowText.includes('workflows: [AI PR Review]'));
check('retry workflow has bounded trigger and write permission only for Actions', workflowText.includes("github.event.workflow_run.run_attempt == 1")
  && workflowText.includes('actions: write')
  && workflowText.includes('issues: read')
  && workflowText.includes('pull-requests: read'));
check('retry action is SHA-pinned and never checks out PR code', /actions\/github-script@[0-9a-f]{40}/.test(workflowText)
  && !workflowText.includes('actions/checkout'));
check('retry workflow carries no provider credentials', !/PR_AGENT_LANE_[ABC]_(KEY|API_BASE)/.test(workflowText));

let result = await scenario();
check('matching Lane A endpoint diagnostic reruns failed jobs exactly once', result.reruns.length === 1
  && result.reruns[0].run_id === baseRun.id
  && result.reruns[0].owner === 'TshyGO'
  && result.reruns[0].repo === 'ci-central');

result = await scenario({ run: { run_attempt: 2 } });
check('second workflow attempt never triggers another rerun', result.reruns.length === 0);

result = await scenario({ run: { conclusion: 'success' } });
check('successful review never triggers a rerun', result.reruns.length === 0);

result = await scenario({ run: { event: 'issue_comment' } });
check('manual review failures are not auto-rerun', result.reruns.length === 0);

result = await scenario({ run: { pull_requests: [] } });
check('unlinked workflow run is ignored', result.reruns.length === 0);

result = await scenario({ pull: { state: 'closed' } });
check('closed pull request is ignored', result.reruns.length === 0);

result = await scenario({ pull: { head: { sha: 'a'.repeat(40) } } });
check('changed pull request head is ignored', result.reruns.length === 0);

result = await scenario({ comments: [endpointDiagnostic({ head: 'a'.repeat(40) })] });
check('stale Lane A evidence is ignored', result.reruns.length === 0);

result = await scenario({ comments: [endpointDiagnostic({ status: 'valid' })] });
check('valid Lane A evidence is never retried', result.reruns.length === 0);

result = await scenario({ comments: [endpointDiagnostic({ body: 'Reason: quota-exhausted.\nHTTP 429' })] });
check('quota diagnostics are not auto-rerun', result.reruns.length === 0);

result = await scenario({ comments: [endpointDiagnostic({ bot: false })] });
check('non-bot comments cannot trigger a rerun', result.reruns.length === 0);

result = await scenario({ repository: 'octocat/fork' });
check('unmanaged repositories cannot invoke centralized retries', result.reruns.length === 0);

if (checks.some((passed) => !passed)) process.exit(1);
