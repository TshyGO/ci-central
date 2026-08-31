#!/usr/bin/env node
// Executes the real inline workflow script against mocked GitHub and HTTP APIs.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowSource = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'pr-review.yml'), 'utf8');
const workflowText = workflowSource.replace(/\r\n/g, '\n');
if (/[\r\u0085\u2028\u2029]/.test(workflowText)) throw new Error('Workflow contains a non-canonical YAML line break');
const callerText = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'pr-agent.yml'), 'utf8');
const workflowCallInputsBlock = /workflow_call:\n    inputs:\n([\s\S]*?)    secrets:/.exec(workflowText)?.[1] || '';
const workflowCallInputs = [...workflowCallInputsBlock.matchAll(/^      ([a-z][a-z0-9_]*):$/gm)].map((match) => match[1]);
const pinnedCheckoutAction = 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09';
const pinnedGithubScriptAction = 'actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd';
const trustedStepUses = [pinnedGithubScriptAction, pinnedCheckoutAction, './.ci-central/review-action', pinnedGithubScriptAction];
const trustedResolverEnv = {
  JOB_WORKFLOW_SHA: '${{ github.job_workflow_sha }}',
  JOB_WORKFLOW_REF: '${{ github.job_workflow_ref }}',
  CALLER_WORKFLOW_SHA: '${{ inputs.central_workflow_sha }}',
  EVENT_SHA: '${{ github.sha }}',
  REPOSITORY: '${{ github.repository }}',
};
const trustedReviewEnv = {
  LANE_A_KEY: '${{ secrets.PR_AGENT_LANE_A_KEY }}',
  LANE_A_API_BASE: '${{ secrets.PR_AGENT_LANE_A_API_BASE }}',
  LANE_B_KEY: '${{ secrets.PR_AGENT_LANE_B_KEY }}',
  LANE_B_API_BASE: '${{ secrets.PR_AGENT_LANE_B_API_BASE }}',
  LANE_C_KEY: '${{ secrets.PR_AGENT_LANE_C_KEY }}',
  LANE_C_API_BASE: '${{ secrets.PR_AGENT_LANE_C_API_BASE }}',
  PR_REVIEW_CONFIG: '${{ steps.review-config.outputs.config }}',
  PR_REVIEW_WORKFLOW_SHA: '${{ steps.central-ref.outputs.sha }}',
};
const runnerValidationScript = `case "\${RUNNER_TIER}" in
  hosted|review|build) ;;
  *)
    echo "::error::runner_tier must be hosted, review, or build; got '\${RUNNER_TIER}'." >&2
    exit 1
    ;;
esac
echo "runner_tier=\${RUNNER_TIER} runner=\${RUNNER_NAME:-unknown}"`;

function yamlScalar(value) {
  const uncommented = value.replace(/\s+#.*$/, '').trim();
  const quote = uncommented[0];
  return quote && quote === uncommented.at(-1) && ['"', "'"].includes(quote)
    ? uncommented.slice(1, -1)
    : uncommented;
}

function mappingAtIndent(lines, start, end, indent) {
  const mapping = {};
  let valid = true;
  const prefix = ' '.repeat(indent);
  for (let index = start; index < end; index++) {
    const line = lines[index].replace(/\r$/, '');
    if (line === '' || /^\s*#/.test(line) || !line.startsWith(prefix) || line[indent] === ' ') continue;
    const field = new RegExp(`^ {${indent}}([a-zA-Z0-9_-]+):\\s*(.*?)\\s*$`).exec(line);
    if (!field || Object.hasOwn(mapping, field[1])) {
      valid = false;
      continue;
    }
    mapping[field[1]] = yamlScalar(field[2]);
  }
  return { mapping, valid };
}

function workflowExecutionContract(text) {
  const lines = text.split('\n');
  const top = mappingAtIndent(lines, 0, lines.length, 0);
  if (!top.valid || !exactObject(top.mapping, { name: 'Reusable AI PR Review', on: '', jobs: '' })) return false;

  const jobsStart = lines.findIndex((line) => line.trimEnd() === 'jobs:');
  const jobs = mappingAtIndent(lines, jobsStart + 1, lines.length, 2);
  if (jobsStart < 0 || !jobs.valid || !exactObject(jobs.mapping, { 'ai-pr-review': '' })) return false;

  const jobStart = lines.findIndex((line) => line.trimEnd() === '  ai-pr-review:');
  const job = mappingAtIndent(lines, jobStart + 1, lines.length, 4);
  if (jobStart < 0 || !job.valid || !exactObject(job.mapping, {
    concurrency: '',
    'runs-on': "${{ inputs.runner_tier == 'review' && 'ai-pr-review' || inputs.runner_tier == 'build' && 'nebulalab-build' || 'ubuntu-latest' }}",
    'timeout-minutes': '40',
    permissions: '',
    steps: '',
  })) return false;

  const concurrencyStart = lines.findIndex((line, index) => index > jobStart && line.trimEnd() === '    concurrency:');
  const runsOn = lines.findIndex((line, index) => index > concurrencyStart && line.startsWith('    runs-on:'));
  const concurrency = mappingAtIndent(lines, concurrencyStart + 1, runsOn, 6);
  if (concurrencyStart < 0 || runsOn < 0 || !concurrency.valid || !exactObject(concurrency.mapping, {
    group: 'centralized-ai-pr-review-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number }}',
    'cancel-in-progress': 'true',
  })) return false;

  const permissionsStart = lines.findIndex((line, index) => index > jobStart && line.trimEnd() === '    permissions:');
  const stepsStart = lines.findIndex((line, index) => index > permissionsStart && line.trimEnd() === '    steps:');
  const permissions = mappingAtIndent(lines, permissionsStart + 1, stepsStart, 6);
  return permissionsStart >= 0 && stepsStart >= 0 && permissions.valid && exactObject(permissions.mapping, {
    contents: 'read',
    issues: 'write',
    'pull-requests': 'write',
  });
}

// This deliberately parses the controlled block-style subset used by this workflow.
// Unknown formatting fails the exact contract instead of being treated as trusted YAML.
function jobSteps(text, jobName) {
  const lines = text.split('\n');
  const jobStart = lines.findIndex((line) => line.trimEnd() === `  ${jobName}:`);
  if (jobStart < 0) return [];
  const jobEnd = lines.findIndex((line, index) => index > jobStart && /^  [a-zA-Z0-9_-]+:\s*$/.test(line));
  const stepsStart = lines.findIndex((line, index) => index > jobStart
    && (jobEnd < 0 || index < jobEnd)
    && line.trimEnd() === '    steps:');
  if (stepsStart < 0) return [];

  const steps = [];
  let step;
  let section;
  for (let index = stepsStart + 1; index < (jobEnd < 0 ? lines.length : jobEnd); index++) {
    const line = lines[index].trimEnd();
    const firstField = /^      - ([a-zA-Z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (/^      -(?:\s+.*)?$/.test(line)) {
      step = { start: index, valid: Boolean(firstField) };
      if (firstField) step[firstField[1]] = yamlScalar(firstField[2]);
      steps.push(step);
      section = undefined;
      continue;
    }
    if (!step) continue;
    const field = /^        ([a-zA-Z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (field) {
      if (['env', 'with'].includes(field[1]) && field[2] === '') {
        if (step[`${field[1]}Start`] !== undefined) step.valid = false;
        step[`${field[1]}Start`] = index;
        step[field[1]] = {};
        section = field[1];
        continue;
      }
      section = undefined;
      step[field[1]] = yamlScalar(field[2]);
      continue;
    }
    if (/^        \S/.test(line) && !/^\s*#/.test(line)) {
      step.valid = false;
      section = undefined;
      continue;
    }
    const nestedField = /^          ([a-zA-Z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (nestedField && ['env', 'with'].includes(section)) {
      if (Object.hasOwn(step[section], nestedField[1])) step.valid = false;
      step[section][nestedField[1]] = yamlScalar(nestedField[2]);
      continue;
    }
    if (['env', 'with'].includes(section) && /^          \S/.test(line) && !/^\s*#/.test(line)) step.valid = false;
  }
  return steps;
}

function literalBlock(text, step, fieldName) {
  const lines = text.split('\n');
  const stepEnd = lines.findIndex((line, index) => index > step.start && /^      -(?:\s+.*)?$/.test(line.trimEnd()));
  const end = stepEnd < 0 ? lines.length : stepEnd;
  const fieldStart = lines.findIndex((line, index) => index > step.start
    && index < end
    && line.trimEnd() === `        ${fieldName}: |`);
  if (fieldStart < 0) return undefined;
  const block = [];
  for (let index = fieldStart + 1; index < end; index++) {
    const line = lines[index].trimEnd();
    if (line !== '' && !line.startsWith(' '.repeat(10))) {
      const trailing = lines.slice(index, end).map((candidate) => candidate.replace(/\r$/, ''));
      if (/^\s*#/.test(line) && trailing.every((candidate) => candidate === ''
        || (/^\s*#/.test(candidate) && !candidate.startsWith(' '.repeat(10))))) break;
      return undefined;
    }
    block.push(line.slice(10));
  }
  while (block.at(-1) === '') block.pop();
  return block.join('\n');
}

function withLiteralBlock(text, step, fieldName) {
  if (step.withStart === undefined) return undefined;
  const lines = text.split('\n');
  const stepEnd = lines.findIndex((line, index) => index > step.start && /^      -(?:\s+.*)?$/.test(line.trimEnd()));
  const end = stepEnd < 0 ? lines.length : stepEnd;
  const sectionEnd = lines.findIndex((line, index) => index > step.withStart
    && index < end
    && /^        [a-zA-Z0-9_-]+:/.test(line.trimEnd()));
  const withEnd = sectionEnd < 0 ? end : sectionEnd;
  const fieldStarts = lines.flatMap((line, index) => index > step.withStart
    && index < withEnd
    && line.trimEnd() === `          ${fieldName}: |` ? [index] : []);
  if (fieldStarts.length !== 1) return undefined;
  const fieldStart = fieldStarts[0];
  const nextField = lines.findIndex((line, index) => index > fieldStart
    && index < withEnd
    && /^          [a-zA-Z0-9_-]+:/.test(line.trimEnd()));
  const blockEnd = nextField < 0 ? withEnd : nextField;
  const block = [];
  for (let index = fieldStart + 1; index < blockEnd; index++) {
    const line = lines[index].replace(/\r$/, '');
    if (line !== '' && !line.startsWith(' '.repeat(12))) {
      const trailing = lines.slice(index, blockEnd).map((candidate) => candidate.replace(/\r$/, ''));
      if (/^\s*#/.test(line) && trailing.every((candidate) => candidate === ''
        || (/^\s*#/.test(candidate) && !candidate.startsWith(' '.repeat(12))))) break;
      return undefined;
    }
    block.push(line.slice(12));
  }
  while (block.at(-1) === '') block.pop();
  return block.join('\n');
}

function exactObject(actual, expected) {
  return actual !== undefined
    && Object.keys(actual).sort().join(',') === Object.keys(expected).sort().join(',')
    && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function exactStepFields(step, expected) {
  const metadata = new Set(['start', 'valid', 'envStart', 'withStart']);
  return step.valid && Object.keys(step).filter((key) => !metadata.has(key)).sort().join(',') === expected.slice().sort().join(',');
}

function checkoutContract(text) {
  if (/[\r\u0085\u2028\u2029]/.test(text)) return false;
  if (!workflowExecutionContract(text)) return false;
  const steps = jobSteps(text, 'ai-pr-review');
  const uses = steps.filter((step) => Object.hasOwn(step, 'uses')).map((step) => step.uses);
  const runSteps = steps.filter((step) => Object.hasOwn(step, 'run'));
  if (steps.length !== 5
    || steps.some((step) => !step.valid)
    || uses.join('\n') !== trustedStepUses.join('\n')
    || runSteps.length !== 1
    || literalBlock(text, runSteps[0], 'run') !== runnerValidationScript
    || !exactStepFields(steps[0], ['name', 'env', 'run'])
    || !exactObject(steps[0].env, { RUNNER_TIER: '${{ inputs.runner_tier }}' })
    || !exactStepFields(steps[1], ['name', 'id', 'uses', 'env', 'with'])
    || !exactObject(steps[1].env, trustedResolverEnv)
    || !exactObject(steps[1].with, { script: '|' })
    || !exactStepFields(steps[2], ['name', 'uses', 'with'])
    || !exactStepFields(steps[3], ['name', 'id', 'uses', 'with'])
    || !exactObject(steps[3].with, { repository: '${{ github.repository }}' })
    || !exactStepFields(steps[4], ['name', 'uses', 'env', 'with'])
    || !exactObject(steps[4].env, trustedReviewEnv)
    || !exactObject(steps[4].with, { script: '|' })) return false;
  const checkoutSteps = steps
    .filter((step) => step.uses?.toLowerCase().startsWith('actions/checkout@'));
  if (checkoutSteps.length !== 1) return false;
  const [checkout] = checkoutSteps;
  return Object.keys(checkout.with).sort().join(',') === 'path,ref,repository,sparse-checkout'
    && checkout.uses === pinnedCheckoutAction
    && checkout.with.repository === 'TshyGO/ci-central'
    && checkout.with.ref === '${{ steps.central-ref.outputs.sha }}'
    && checkout.with.path === '.ci-central'
    && checkout.with['sparse-checkout'] === 'review-action';
}

function replaceExactlyOnce(text, search, replacement) {
  const first = text.indexOf(search);
  if (first < 0) throw new Error(`Mutation anchor not found: ${search}`);
  if (text.indexOf(search, first + search.length) >= 0) throw new Error(`Mutation anchor is not unique: ${search}`);
  return `${text.slice(0, first)}${replacement}${text.slice(first + search.length)}`;
}

function insertBeforeTrustedCheckout(text, insertedStep) {
  const lines = text.split('\n');
  const usesLine = `        uses: ${pinnedCheckoutAction} # v5`;
  const usesIndexes = lines.flatMap((line, index) => line === usesLine ? [index] : []);
  if (usesIndexes.length !== 1) throw new Error(`Expected one trusted checkout line, found ${usesIndexes.length}`);
  let stepStart = usesIndexes[0];
  while (stepStart >= 0 && !/^      - /.test(lines[stepStart])) stepStart--;
  if (stepStart < 0) throw new Error('Trusted checkout step start not found');
  lines.splice(stepStart, 0, ...insertedStep.split('\n'), '');
  return lines.join('\n');
}

function githubScriptBodies(text) {
  const scriptSteps = jobSteps(text, 'ai-pr-review')
    .filter((step) => step.uses === pinnedGithubScriptAction);
  if (scriptSteps.length !== 2
    || scriptSteps.some((step) => !step.valid
      || !exactObject(step.with, { script: '|' }))
    || !exactObject(scriptSteps[0].env, trustedResolverEnv)
    || !exactObject(scriptSteps[1].env, trustedReviewEnv)) return [];
  return scriptSteps.map((step) => withLiteralBlock(text, step, 'script'));
}

function insertGithubScriptEnvDecoy(text, scriptIndex, maliciousBody) {
  const steps = jobSteps(text, 'ai-pr-review');
  const scriptSteps = steps.filter((step) => step.uses === pinnedGithubScriptAction);
  const target = scriptSteps[scriptIndex];
  const trustedBody = target && withLiteralBlock(text, target, 'script');
  if (!target || trustedBody === undefined) throw new Error(`github-script ${scriptIndex} not found`);

  const lines = text.split('\n');
  const decoyLines = ['          script: |', ...trustedBody.split('\n').map((line) => `            ${line}`)];
  lines.splice(target.withStart, 0, ...decoyLines);
  const actualWithStart = target.withStart + decoyLines.length;
  const actualScriptStart = lines.findIndex((line, index) => index > actualWithStart
    && line.trimEnd() === '          script: |');
  const stepEnd = lines.findIndex((line, index) => index > actualScriptStart
    && /^      -(?:\s+.*)?$/.test(line.trimEnd()));
  if (actualScriptStart < 0 || stepEnd < 0) throw new Error('Executable github-script block not found');
  lines.splice(actualScriptStart + 1, stepEnd - actualScriptStart - 1,
    ...maliciousBody.split('\n').map((line) => `            ${line}`), '');
  return lines.join('\n');
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const trustedGithubScriptBodies = (text) => {
  const [resolver, review] = githubScriptBodies(text);
  return resolver !== undefined && review !== undefined
    && sha256(resolver) === 'a6c84e5ea58b2db4246625c7fb128eaa2c11e8936ccfeb12eed0a34f6209dc31'
    && sha256(review) === '1a14db7ad1f8bf97f9c2a6ff971c89f4628ae47ebcf291b1e171885d70c4290f';
};
if (!trustedGithubScriptBodies(workflowText)) throw new Error('Security-critical github-script body digest mismatch');
const [resolverScript, reviewScript] = githubScriptBodies(workflowText);
if (resolverScript === undefined || reviewScript === undefined) throw new Error('Trusted github-script blocks not found');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runResolver = new AsyncFunction('core', 'process', resolverScript);
const runScript = new AsyncFunction('github', 'context', 'process', 'fetch', 'setTimeout', 'clearTimeout', 'console', reviewScript);

const centralConfig = JSON.parse(fs.readFileSync(path.join(here, '..', 'review-action', 'config', 'repositories', 'TshyGO__NebulaLab.json'), 'utf8'));
const patch = (filename, size) => ({ filename, status: 'modified', additions: 2, deletions: 1, patch: `@@\n${'+x\n'.repeat(size)}` });
const files = [patch('src/a.ts', 100), patch('tests/a.test.ts', 100)];
const headSha = 'deadbeef'.repeat(5);
const workflowSha = 'feedface'.repeat(5);
const pull = { number: 42, title: 'Test', state: 'open', user: { login: 'octocat' }, base: { ref: 'main' }, head: { ref: 'feature', sha: headSha }, body: '' };
const context = { eventName: 'pull_request', payload: { pull_request: { number: 42, head: { sha: headSha } } }, repo: { owner: 'TshyGO', repo: 'NebulaLab' }, serverUrl: 'https://github.com', runId: 1 };
const env = {
  LANE_A_KEY: 'lane-a-key', LANE_A_API_BASE: 'https://lane-a.example.test/v1/',
  LANE_B_KEY: 'lane-b-key', LANE_B_API_BASE: 'https://lane-b.example.test/v1/',
  LANE_C_KEY: 'lane-c-key', LANE_C_API_BASE: 'https://lane-c.example.test/v1/',
  PR_REVIEW_CONFIG: JSON.stringify(centralConfig),
  PR_REVIEW_WORKFLOW_SHA: workflowSha,
};
const evidenceComment = (lane, { head = headSha, workflow = workflowSha, status = 'valid' } = {}) => ({
  body: [
    `<!-- ai-pr-review-bot:lane-${lane} -->`,
    `<!-- ai-pr-review-evidence:v2 lane=${lane} head=${head} workflow=${workflow} status=${status} -->`,
    `review ${lane}`,
  ].join('\n'),
});
const reply = (status, text) => ({ ok: status < 400, status, text: async () => text });
const chatResult = (model, content, { reasoning = 'private thinking', finish = 'stop' } = {}) => JSON.stringify({
  model: `provider/${model}`,
  choices: [{ finish_reason: finish, message: { content, reasoning_content: reasoning } }],
  usage: { prompt_tokens: 1 },
});
const geminiResult = (content, { finish = 'STOP', thought = '', usageMetadata } = {}) => JSON.stringify({
  candidates: [{ finishReason: finish, content: { parts: [
    ...(thought ? [{ thought: true, text: thought }] : []),
    { text: content },
  ] } }],
  usageMetadata: usageMetadata || {
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 512,
    totalTokenCount: 632,
  },
});

function laneForUrl(url) {
  if (url.startsWith('https://lane-a.')) return 'A';
  if (url.startsWith('https://lane-b.')) return 'B';
  if (url.startsWith('https://lane-c.')) return 'C';
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return 'C';
  return '?';
}

async function scenario(route, overrides = {}, options = {}) {
  const posted = [], captured = [], logs = [];
  const comments = (options.comments || []).map((comment, index) => ({
    id: index + 1,
    user: { login: 'github-actions[bot]' },
    ...comment,
  }));
  const pulls = options.pulls || [pull];
  let pullGets = 0;
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pulls[Math.min(pullGets++, pulls.length - 1)] }), listFiles: 'files', listCommits: 'commits' },
      issues: {
        get: async () => { throw new Error('not found'); },
        listComments: 'comments',
        createComment: async ({ body }) => {
          if (options.rejectComment?.(body)) throw new Error('comment rejected');
          posted.push(body);
          const comment = { id: comments.length + 1, user: { login: 'github-actions[bot]' }, body };
          comments.push(comment);
          return { data: comment };
        },
        updateComment: async ({ comment_id, body }) => {
          if (options.rejectComment?.(body)) throw new Error('comment rejected');
          const comment = comments.find(({ id }) => id === comment_id);
          if (!comment) throw new Error('comment not found');
          comment.body = body;
          posted.push(body);
          return { data: comment };
        },
        deleteComment: async ({ comment_id }) => {
          const index = comments.findIndex(({ id }) => id === comment_id);
          if (index >= 0) comments.splice(index, 1);
        },
      },
    },
    paginate: async (which) => which === 'files' ? files : which === 'comments' ? comments : [{ commit: { message: 'test' } }],
  };
  const fetch = async (url, request) => {
    const body = JSON.parse(request.body);
    const lane = laneForUrl(url);
    const match = /\/models\/([^/:]+):generateContent$/.exec(url);
    const model = match ? decodeURIComponent(match[1]) : body.model;
    const call = { lane, model, body, headers: request.headers, url };
    captured.push(call);
    return route(call);
  };
  let error;
  try {
    await runScript(github, options.context || context, { env: { ...env, ...overrides } }, fetch, (fn) => setTimeout(fn, 0), clearTimeout, { log: (...xs) => logs.push(xs.join(' ')) });
  } catch (caught) {
    error = caught;
  }
  return { posted, captured, comments, logs, error, pullGets };
}

const checks = [];
const check = (name, condition) => { checks.push(Boolean(condition)); console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`); };
const healthy = ({ model, body }) => reply(200, body.contents
  ? geminiResult(`# review ${model}`, { thought: 'PRIVATE GEMINI THOUGHT' })
  : chatResult(model, `# review ${model}`));

async function resolverScenario(env) {
  const outputs = {}, warnings = [];
  let error;
  try {
    await runResolver({ setOutput: (name, value) => { outputs[name] = value; }, warning: (message) => warnings.push(message) }, { env });
  } catch (caught) {
    error = caught;
  }
  return { outputs, warnings, error };
}

check('workflow exposes only immutable central SHA metadata and a runner tier, never model, provider, fallback, prompt, or budget inputs',
  workflowCallInputs.join(',') === 'central_workflow_sha,runner_tier'
  && !['model:', 'provider:', 'fallback:', 'system_prompt:', 'max_output_tokens:', 'model_budget_ms:', 'request_timeout_ms:']
    .some((name) => workflowText.slice(0, workflowText.indexOf('secrets:')).includes(name)));
// runner_tier is infrastructure, not policy - but it still decides which machine receives
// the Lane credentials, so a caller must only ever pick from a closed set of tiers. If the
// label could be interpolated straight from the input, a caller could name any runner.
check('runner_tier maps to fixed labels and can never carry a caller-supplied label',
  workflowText.includes("runs-on: ${{ inputs.runner_tier == 'review' && 'ai-pr-review' || inputs.runner_tier == 'build' && 'nebulalab-build' || 'ubuntu-latest' }}")
  && !/runs-on:\s*\$\{\{\s*inputs\.runner_tier\s*\}\}/.test(workflowText)
  && workflowText.includes('- name: Validate runner tier'));
check('security-critical first-party Actions are pinned to immutable commits',
  workflowText.includes('actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd')
  && workflowText.includes('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09')
  && !workflowText.includes('actions/github-script@v8')
  && !workflowText.includes('actions/checkout@v5'));
check('security-critical github-script bodies match their reviewed digests', trustedGithubScriptBodies(workflowText));
check('github-script body contract rejects runner-only child_process code', !trustedGithubScriptBodies(replaceExactlyOnce(workflowText,
  '            const shaPattern = /^[0-9a-f]{40}$/;',
  `            if (process.env.GITHUB_ACTIONS) require('node:child_process').execFileSync('git', ['clone', 'https://github.com/TshyGO/NebulaLab']);\n            const shaPattern = /^[0-9a-f]{40}$/;`,
)));
check('github-script digest guard rejects process exit before script compilation', !trustedGithubScriptBodies(replaceExactlyOnce(workflowText,
  '            const shaPattern = /^[0-9a-f]{40}$/;',
  `            globalThis.process.exit(0);\n            const shaPattern = /^[0-9a-f]{40}$/;`,
)));
check('github-script body contract hashes the executable with.script, not an inert env.script decoy',
  !trustedGithubScriptBodies(insertGithubScriptEnvDecoy(workflowText, 0,
    "if (process.env.GITHUB_ACTIONS) require('node:child_process').execFileSync('git', ['clone', 'https://github.com/TshyGO/NebulaLab']);")));
check('execution-surface contract rejects NODE_OPTIONS code injection before a pinned Action starts',
  !checkoutContract(replaceExactlyOnce(workflowText,
    '          REPOSITORY: ${{ github.repository }}',
    `          REPOSITORY: \${{ github.repository }}\n          NODE_OPTIONS: "--import=data:text/javascript,import%20{execFileSync}%20from%20'node:child_process';execFileSync('git',['clone','https://github.com/'+process.env.GITHUB_REPOSITORY,'caller'])"`,
  )));
check('execution-surface contract rejects job-level NODE_OPTIONS code injection',
  !checkoutContract(replaceExactlyOnce(workflowText,
    '  ai-pr-review:',
    `  ai-pr-review:\n    env:\n      NODE_OPTIONS: "--import=data:text/javascript,import%20{execFileSync}%20from%20'node:child_process';execFileSync('git',['clone','https://github.com/'+process.env.GITHUB_REPOSITORY,'caller'])"`,
  )));
check('execution-surface contract rejects workflow-level NODE_OPTIONS code injection',
  !checkoutContract(replaceExactlyOnce(workflowText,
    'jobs:',
    `env:\n  NODE_OPTIONS: "--import=data:text/javascript,import%20{execFileSync}%20from%20'node:child_process';execFileSync('git',['clone','https://github.com/'+process.env.GITHUB_REPOSITORY,'caller'])"\n\njobs:`,
  )));
check('execution-surface contract rejects YAML line breaks hidden after a comment',
  ['\r', '\u0085', '\u2028', '\u2029'].every((lineBreak) => !checkoutContract(replaceExactlyOnce(workflowText,
    '          sparse-checkout: review-action',
    `          sparse-checkout: review-action #${lineBreak}      - name: Clone caller PR code${lineBreak}        run: git clone https://github.com/\${{ github.repository }} caller`,
  ))));
check('the only checkout reads pinned ci-central review configuration, never caller PR code', checkoutContract(workflowText));
check('checkout contract ignores checkout-shaped text in YAML comments', checkoutContract(insertBeforeTrustedCheckout(workflowText,
  `      # - name: Checkout caller PR code\n      #   uses: ${pinnedCheckoutAction}\n      #   with:\n      #     ref: \${{ github.event.pull_request.head.sha }}`)));
check('checkout contract rejects a commented-out trusted checkout action', !checkoutContract(replaceExactlyOnce(workflowText,
  `        uses: ${pinnedCheckoutAction} # v5`,
  `        # uses: ${pinnedCheckoutAction} # v5`,
)));
check('checkout contract rejects an additional default checkout', !checkoutContract(insertBeforeTrustedCheckout(workflowText,
  `      - name: Checkout caller code\n        uses: ${pinnedCheckoutAction} # v5`)));
check('checkout contract rejects a quoted, case-varied additional checkout', !checkoutContract(insertBeforeTrustedCheckout(workflowText,
  `      - name: Checkout caller code\n        uses: "Actions/Checkout@${pinnedCheckoutAction.split('@')[1]}"`)));
check('checkout contract rejects a YAML-escaped additional checkout', !checkoutContract(insertBeforeTrustedCheckout(workflowText,
  `      - name: Checkout caller code\n        uses: "actions/check\\u006fut@${pinnedCheckoutAction.split('@')[1]}"`)));
check('checkout contract rejects a folded-scalar additional checkout', !checkoutContract(insertBeforeTrustedCheckout(workflowText,
  `      - name: Checkout caller code\n        uses: >\n          ${pinnedCheckoutAction}`)));
check('checkout contract rejects a quoted duplicate uses key in a trusted step', !checkoutContract(replaceExactlyOnce(workflowText,
  `        uses: ${pinnedCheckoutAction} # v5`,
  `        uses: ${pinnedCheckoutAction} # v5\n        "uses": ${pinnedCheckoutAction}`,
)));
check('checkout contract rejects a quoted duplicate repository key', !checkoutContract(replaceExactlyOnce(workflowText,
  '          repository: TshyGO/ci-central',
  '          repository: TshyGO/ci-central\n          "repository": TshyGO/NebulaLab',
)));
check('checkout contract rejects a shell clone and checkout of the PR head', !checkoutContract(insertBeforeTrustedCheckout(workflowText,
  `      - name: Clone caller PR code\n        run: |\n          git clone https://github.com/\${{ github.repository }} caller\n          git -C caller checkout \${{ github.event.pull_request.head.sha }}`)));
check('checkout contract rejects a bare-dash shell step with quoted keys', !checkoutContract(insertBeforeTrustedCheckout(workflowText,
  `      -\n        "name": Clone caller PR code\n        "run": |\n          git clone https://github.com/\${{ github.repository }} caller\n          git -C caller checkout \${{ github.event.pull_request.head.sha }}`)));
check('checkout contract rejects a pull request head checkout', !checkoutContract(replaceExactlyOnce(workflowText,
  '          ref: ${{ steps.central-ref.outputs.sha }}',
  '          ref: ${{ github.event.pull_request.head.sha }}',
)));
check('checkout contract rejects a pull request head branch', !checkoutContract(replaceExactlyOnce(workflowText,
  '          ref: ${{ steps.central-ref.outputs.sha }}',
  '          ref: ${{ github.event.pull_request.head.ref }}',
)));
check('checkout contract rejects github.head_ref', !checkoutContract(replaceExactlyOnce(workflowText,
  '          ref: ${{ steps.central-ref.outputs.sha }}',
  '          ref: ${{ github.head_ref }}',
)));
check('checkout contract rejects the pull request event merge SHA', !checkoutContract(replaceExactlyOnce(workflowText,
  '          ref: ${{ steps.central-ref.outputs.sha }}',
  '          ref: ${{ github.sha }}',
)));
check('checkout contract rejects the pull request merge commit SHA', !checkoutContract(replaceExactlyOnce(workflowText,
  '          ref: ${{ steps.central-ref.outputs.sha }}',
  '          ref: ${{ github.event.pull_request.merge_commit_sha }}',
)));
check('checkout contract rejects an explicit pull request merge ref', !checkoutContract(replaceExactlyOnce(workflowText,
  '          ref: ${{ steps.central-ref.outputs.sha }}',
  '          ref: refs/pull/123/merge',
)));
check('checkout contract rejects an explicit pull request head ref', !checkoutContract(replaceExactlyOnce(workflowText,
  '          ref: ${{ steps.central-ref.outputs.sha }}',
  '          ref: refs/pull/123/head',
)));
check('checkout contract rejects a missing checkout ref', !checkoutContract(replaceExactlyOnce(workflowText,
  '          ref: ${{ steps.central-ref.outputs.sha }}\n',
  '',
)));
check('checkout contract rejects the caller repository', !checkoutContract(replaceExactlyOnce(workflowText,
  '          repository: TshyGO/ci-central',
  '          repository: ${{ github.repository }}',
)));
check('checkout contract rejects a literal non-central repository', !checkoutContract(replaceExactlyOnce(workflowText,
  '          repository: TshyGO/ci-central',
  '          repository: TshyGO/NebulaLab',
)));
check('checkout contract rejects an implicit caller-repository checkout', !checkoutContract(replaceExactlyOnce(workflowText,
  '          repository: TshyGO/ci-central\n',
  '',
)));
check('checkout contract rejects additional checkout credentials', !checkoutContract(replaceExactlyOnce(workflowText,
  '          sparse-checkout: review-action',
  '          sparse-checkout: review-action\n          token: ${{ secrets.REVIEW_TOKEN }}',
)));
check('checkout contract does not rely on the checkout step name', checkoutContract(replaceExactlyOnce(workflowText,
  '      - name: Check out matching central configuration',
  '      - name: Renamed trusted checkout',
)));
check('workflow resolves repository config and exposes only fixed lane slots', workflowText.includes('uses: ./.ci-central/review-action')
  && ['A', 'B', 'C'].every((lane) => workflowText.includes(`PR_AGENT_LANE_${lane}_KEY`) && workflowText.includes(`PR_AGENT_LANE_${lane}_API_BASE`)));
check('Lane C has no hidden Google endpoint fallback after provider migration',
  !workflowText.includes("process.env.LANE_C_KEY ? 'https://generativelanguage.googleapis.com/v1beta'"));
check('config resolver uses a validated trusted workflow SHA', workflowText.includes('- name: Resolve matching central ref')
  && workflowText.includes('JOB_WORKFLOW_SHA: ${{ github.job_workflow_sha }}')
  && workflowText.includes('JOB_WORKFLOW_REF: ${{ github.job_workflow_ref }}')
  && workflowText.includes('CALLER_WORKFLOW_SHA: ${{ inputs.central_workflow_sha }}')
  && workflowText.includes("const expectedPrefix = 'TshyGO/ci-central/.github/workflows/pr-review.yml@';")
  && workflowText.includes('External callers must repeat their full ci-central uses pin as central_workflow_sha.')
  && workflowText.includes('The reusable workflow context SHA does not match central_workflow_sha.')
  && workflowText.includes('REPOSITORY: ${{ github.repository }}')
  && workflowText.includes("repository === 'TshyGO/ci-central'")
  && workflowText.includes('ref: ${{ steps.central-ref.outputs.sha }}')
  && workflowText.includes('PR_REVIEW_WORKFLOW_SHA: ${{ steps.central-ref.outputs.sha }}')
  && workflowText.includes('trusted 40-character ci-central workflow SHA')
  && !workflowText.includes('github.workflow_ref')
  && !workflowText.includes('TshyGO/ci-central/.github/workflows/pr-review.yml@main')
  && !workflowText.includes('TshyGO/ci-central/review-action@main'));

let resolved = await resolverScenario({
  REPOSITORY: 'TshyGO/NebulaLab',
  CALLER_WORKFLOW_SHA: workflowSha,
  JOB_WORKFLOW_SHA: '',
  JOB_WORKFLOW_REF: '',
  EVENT_SHA: headSha,
});
check('external caller falls back visibly to its reviewed explicit SHA when GitHub omits both job workflow fields',
  resolved.error === undefined && resolved.outputs.sha === workflowSha && resolved.warnings.length === 1);
resolved = await resolverScenario({ REPOSITORY: 'TshyGO/NebulaLab', CALLER_WORKFLOW_SHA: '', EVENT_SHA: headSha });
check('external caller rejects a missing explicit central SHA', /must repeat/.test(resolved.error?.message || ''));
resolved = await resolverScenario({ REPOSITORY: 'TshyGO/NebulaLab', CALLER_WORKFLOW_SHA: workflowSha, JOB_WORKFLOW_REF: 'TshyGO/ci-central/.github/workflows/pr-review.yml@main' });
check('a provided job workflow ref rejects branch or tag pins', /full 40-character/.test(resolved.error?.message || ''));
resolved = await resolverScenario({ REPOSITORY: 'TshyGO/NebulaLab', CALLER_WORKFLOW_SHA: workflowSha, JOB_WORKFLOW_REF: `TshyGO/ci-central/.github/workflows/other.yml@${workflowSha}` });
check('a provided job workflow ref rejects another workflow path', /exact ci-central pr-review/.test(resolved.error?.message || ''));
resolved = await resolverScenario({ REPOSITORY: 'TshyGO/NebulaLab', CALLER_WORKFLOW_SHA: workflowSha, JOB_WORKFLOW_SHA: '0'.repeat(40) });
check('external caller rejects a GitHub context SHA that disagrees with its explicit pin', /does not match/.test(resolved.error?.message || ''));
resolved = await resolverScenario({
  REPOSITORY: 'TshyGO/NebulaLab',
  CALLER_WORKFLOW_SHA: workflowSha,
  JOB_WORKFLOW_SHA: workflowSha,
  JOB_WORKFLOW_REF: `TshyGO/ci-central/.github/workflows/pr-review.yml@${workflowSha}`,
});
check('matching GitHub SHA, exact workflow ref, and caller pin resolve without fallback warning',
  resolved.error === undefined && resolved.outputs.sha === workflowSha && resolved.warnings.length === 0);
resolved = await resolverScenario({
  REPOSITORY: 'TshyGO/NebulaLab',
  CALLER_WORKFLOW_SHA: workflowSha,
  JOB_WORKFLOW_SHA: '0'.repeat(40),
  JOB_WORKFLOW_REF: `TshyGO/ci-central/.github/workflows/pr-review.yml@${workflowSha}`,
});
check('disagreeing GitHub job workflow SHA and ref fail closed', /job_workflow_sha and github.job_workflow_ref disagree/.test(resolved.error?.message || ''));
resolved = await resolverScenario({ REPOSITORY: 'TshyGO/NebulaLab', CALLER_WORKFLOW_SHA: workflowSha, JOB_WORKFLOW_SHA: 'not-a-sha' });
check('a malformed GitHub job workflow SHA fails with a precise diagnostic', /not a full 40-character SHA/.test(resolved.error?.message || ''));
resolved = await resolverScenario({ REPOSITORY: 'TshyGO/ci-central', JOB_WORKFLOW_SHA: '', JOB_WORKFLOW_REF: '', EVENT_SHA: headSha });
check('same-repository relative caller falls back to its exact event SHA', resolved.error === undefined && resolved.outputs.sha === headSha);
resolved = await resolverScenario({ REPOSITORY: 'TshyGO/ci-central', CALLER_WORKFLOW_SHA: workflowSha, EVENT_SHA: headSha });
check('same-repository caller rejects an accidentally mismatched explicit SHA', /same-repository central_workflow_sha does not match/.test(resolved.error?.message || ''));
check('reusable workflow accepts only fixed Lane secret slots',
  !['PR_AGENT_OPENAI_KEY', 'PR_AGENT_OPENAI_API_BASE', 'PR_AGENT_TENCENT_KEY', 'PR_AGENT_TENCENT_API_BASE', 'PR_AGENT_GOOGLE_AI_KEY', 'LEGACY_']
    .some((name) => workflowText.includes(name)));
check('central repository self-caller exercises the workflow from its own PR revision', callerText.includes('uses: ./.github/workflows/pr-review.yml')
  && !callerText.includes('TshyGO/ci-central/.github/workflows/pr-review.yml@main')
  && ['A', 'B', 'C'].every((lane) => callerText.includes(`PR_AGENT_LANE_${lane}_KEY`) && callerText.includes(`PR_AGENT_LANE_${lane}_API_BASE`))
  && callerText.includes('group: ai-pr-review-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.issue.number }}')
  // Without the event_name segment a bot comment cancels the in-flight review; keep
  // the un-keyed form from creeping back in.
  && !callerText.includes('group: ai-pr-review-${{ github.event.pull_request.number || github.event.issue.number }}')
  && callerText.includes('cancel-in-progress: true')
  && callerText.includes("github.event.pull_request.author_association == 'OWNER'")
  && !/qwen|glm|gemini|kimi|deepseek|alibaba|tencent|google/i.test(callerText));
check('reusable job uses one latest-wins group for automatic and manual triggers', workflowText.includes('group: centralized-ai-pr-review-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number }}')
  && workflowText.includes('cancel-in-progress: true')
  && workflowText.includes('timeout-minutes: 40'));

let r = await scenario(healthy);
check('healthy path calls exactly the three configured lane primaries', r.captured.map(({ lane, model }) => `${lane}:${model}`).sort().join(',') === 'A:qwen3.8-max,B:glm-5.2,C:deepseek-v4-flash');
check('healthy path never calls a fallback', !r.captured.some(({ model }) => ['qwen3.7-max', 'deepseek-v4-pro-202606', 'sensenova-6.8-flash-lite'].includes(model)));
const healthyLaneA = r.captured.find(({ lane }) => lane === 'A')?.body;
const healthyLaneB = r.captured.find(({ lane }) => lane === 'B')?.body;
const healthyLaneC = r.captured.find(({ lane }) => lane === 'C')?.body;
check('all active OpenAI-compatible lanes receive the repository review prompt',
  healthyLaneA?.messages[0].content === centralConfig.review_policy.system_prompt
  && healthyLaneB?.messages[0].content === centralConfig.review_policy.system_prompt
  && healthyLaneC?.messages[0].content === centralConfig.review_policy.system_prompt
  && !healthyLaneA?.messages[0].content.includes('two independent internal review passes')
  && !healthyLaneB?.messages[0].content.includes('two independent internal review passes')
  && !healthyLaneC?.messages[0].content.includes('two independent internal review passes'));
check('Lane C uses OpenAI Chat Completions without Google thinking fields',
  healthyLaneC?.model === 'deepseek-v4-flash'
  && healthyLaneC?.max_tokens === undefined
  && healthyLaneC?.temperature === 0.2
  && healthyLaneC?.generationConfig === undefined);
check('Lane B uses GLM maximum output space without lowering model reasoning',
  healthyLaneB?.model === 'glm-5.2'
  && healthyLaneB?.max_tokens === 65536
  && healthyLaneB?.reasoning_effort === undefined
  && healthyLaneB?.thinking === undefined);
check('each healthy lane publishes exactly one stable lane comment', r.posted.length === 3
  && ['A', 'B', 'C'].every((lane) => r.posted.filter((body) => body.includes(`<!-- ai-pr-review-bot:lane-${lane} -->`)).length === 1));
check('healthy comments carry reusable v2 evidence for the full head and workflow SHAs', ['A', 'B', 'C'].every((lane) =>
  r.posted.some((body) => body.includes(`<!-- ai-pr-review-evidence:v2 lane=${lane} head=${headSha} workflow=${workflowSha} status=valid -->`))));
check('healthy comments visibly identify the reviewed head and stable-update behavior', r.posted.every((body) =>
  body.includes(`> 审核提交：\`${headSha.slice(0, 7)}\``)
  && /更新时间：`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`/.test(body)
  && body.includes('此评论会随 PR 新提交原地更新')
  && body.includes(`[Run](${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId})`)));

const validEvidence = ['A', 'B', 'C'].map((lane) => evidenceComment(lane));
r = await scenario(() => { throw new Error('model should not run'); }, {}, { comments: validEvidence });
check('automatic rerun reuses all valid same-head evidence without model calls', r.error === undefined
  && r.captured.length === 0 && r.posted.length === 0 && r.pullGets === 2
  && r.logs.some((line) => line.includes('skipping model requests')));

r = await scenario(healthy, {}, { comments: [
  evidenceComment('A'),
  evidenceComment('B', { status: 'diagnostic' }),
  evidenceComment('C', { status: 'partial' }),
] });
check('automatic rerun calls only missing or invalid Lanes', r.error === undefined
  && r.captured.map(({ lane }) => lane).sort().join(',') === 'B,C'
  && r.posted.length === 2);

r = await scenario(healthy, {}, { comments: [
  evidenceComment('A'),
  evidenceComment('A', { status: 'diagnostic' }),
  evidenceComment('B'),
  evidenceComment('C'),
] });
check('duplicate stable comments force only that Lane to rerun and reconcile history', r.error === undefined
  && r.captured.map(({ lane }) => lane).join(',') === 'A'
  && r.posted.length === 1
  && r.comments.filter(({ body }) => body.includes('ai-pr-review-bot:lane-A')).length === 1
  && r.logs.some((line) => line.includes('forcing a rerun to reconcile duplicates')));

r = await scenario(healthy, {}, { comments: ['A', 'B', 'C'].map((lane) => evidenceComment(lane, { workflow: '0'.repeat(40) })) });
check('evidence from an older reusable workflow revision is not reused', r.error === undefined && r.captured.length === 3 && r.posted.length === 3);

const otherHeadSha = '01234567'.repeat(5);
const otherHeadPull = { ...pull, head: { ...pull.head, sha: otherHeadSha } };
const otherHeadContext = { ...context, payload: { pull_request: { number: 42, head: { sha: otherHeadSha } } } };
r = await scenario(healthy, {}, { comments: validEvidence, pulls: [otherHeadPull], context: otherHeadContext });
check('valid evidence from an older PR head is not reused', r.error === undefined && r.captured.length === 3 && r.posted.length === 3);
check('new-head reviews overwrite stable comments in place with visible freshness evidence',
  r.comments.map(({ id }) => id).join(',') === '1,2,3'
  && r.comments.every(({ body }) => body.includes(`> 审核提交：\`${otherHeadSha.slice(0, 7)}\``)
    && body.includes(`head=${otherHeadSha}`)
    && !body.includes(`head=${headSha}`)));

const manualContext = { ...context, eventName: 'issue_comment', payload: { issue: { number: 42 }, comment: { body: '/review' } } };
r = await scenario(healthy, {}, { comments: validEvidence, context: manualContext });
check('manual /review bypasses same-head reuse and forces every Lane', r.error === undefined && r.captured.length === 3 && r.posted.length === 3
  && r.logs.some((line) => line.includes('forces every configured Lane')));

r = await scenario(healthy, {}, { comments: validEvidence.map((comment) => ({ ...comment, user: { login: 'octocat' } })) });
check('non-bot comments cannot spoof reusable review evidence', r.error === undefined && r.captured.length === 3 && r.posted.length === 3);

r = await scenario(healthy, { PR_REVIEW_WORKFLOW_SHA: '' });
check('workflow defense requires a full reusable-workflow SHA before model calls', /40-character/.test(r.error?.message || '') && r.captured.length === 0);
const duplicateComments = [
  { id: 10, body: '<!-- ai-pr-review-bot:lane-A -->\nold diagnostic' },
  { id: 11, body: '<!-- ai-pr-review-bot:lane-A -->\nnewer diagnostic' },
  { id: 12, body: '<!-- ai-pr-review-bot:lane-B -->\nold review' },
];
const googleConfig = structuredClone(centralConfig);
googleConfig.lanes[2] = {
  id: 'C',
  provider: 'google',
  protocol: 'google-generate-content',
  primary: { id: 'gemini-3.7-flash', label: 'Gemini-3.7-Flash', context_profile: 'full', max_output_tokens: 16384, thinking_level: 'high' },
  fallbacks: [],
};
const googleOverrides = {
  PR_REVIEW_CONFIG: JSON.stringify(googleConfig),
  LANE_C_API_BASE: 'https://generativelanguage.googleapis.com/v1beta',
};
r = await scenario(healthy, googleOverrides, { comments: duplicateComments });
check('reruns update one stable comment per lane and remove prior duplicates', r.posted.length === 3
  && ['A', 'B', 'C'].every((lane) => r.comments.filter(({ body }) => body.includes(`<!-- ai-pr-review-bot:lane-${lane} -->`)).length === 1));
check('reasoning and Gemini thought parts never reach comments', !r.posted.some((body) => body.includes('private thinking') || body.includes('PRIVATE GEMINI THOUGHT')));
check('Gemini thought-token usage is visible without exposing thought text',
  r.posted.some((body) => body.includes('lane-C') && body.includes('Thinking: 512 tokens')));

r = await scenario((call) => reply(200, call.lane === 'C'
  ? geminiResult(`# review ${call.model}`, { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } })
  : chatResult(call.model, `# review ${call.model}`, { reasoning: '' })), googleOverrides);
check('zero or absent thinking usage keeps provider reporting accurate',
  r.posted.some((body) => body.includes('lane-C') && body.includes('Thinking: 0 tokens'))
  && ['A', 'B'].every((lane) => r.posted.some((body) => body.includes(`lane-${lane}`) && body.includes('Thinking: not reported'))));

r = await scenario((call) => reply(200, call.lane === 'C'
  ? geminiResult(`# review ${call.model}`, { usageMetadata: { promptTokenCount: 100 } })
  : chatResult(call.model, `# review ${call.model}`)), googleOverrides);
check('missing Gemini token totals remain explicitly unreported',
  r.posted.some((body) => body.includes('lane-C') && body.includes('Thinking: not reported')));

r = await scenario((call) => reply(200, call.lane === 'C'
  ? geminiResult(`# review ${call.model}`, { finish: 'stop' })
  : chatResult(call.model, `# review ${call.model}`, { finish: 'STOP' })), googleOverrides);
check('finish reasons are normalized across provider casing', r.error === undefined
  && ['A', 'B', 'C'].every((lane) => r.posted.some((body) => body.includes(`lane-${lane}`) && body.includes('status=valid')))
  && !r.posted.some((body) => body.includes('可能不完整')));

r = await scenario(healthy);
check('full-context primaries preserve input while SenseNova omits only max_tokens',
  r.captured.every(({ body }) => body.messages[1].content.includes('Changed files and patches:'))
  && r.captured.find(({ lane }) => lane === 'A')?.body.max_tokens === 16384
  && r.captured.find(({ lane }) => lane === 'B')?.body.max_tokens === 65536
  && r.captured.find(({ lane }) => lane === 'C')?.body.max_tokens === undefined);

check('protocol and credentials come from lanes', r.captured.find(({ lane }) => lane === 'A')?.url.endsWith('/chat/completions')
  && r.captured.find(({ lane }) => lane === 'A')?.headers.authorization === 'Bearer lane-a-key'
  && r.captured.find(({ lane }) => lane === 'B')?.headers.authorization === 'Bearer lane-b-key'
  && r.captured.find(({ lane }) => lane === 'C')?.url.endsWith('/chat/completions')
  && r.captured.find(({ lane }) => lane === 'C')?.headers.authorization === 'Bearer lane-c-key');

const overriddenConfig = structuredClone(centralConfig);
overriddenConfig.lanes[0].primary.max_output_tokens = 8192;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(overriddenConfig) });
check('repository configuration supplied through the environment remains authoritative', r.error === undefined
  && r.captured.find(({ lane }) => lane === 'A')?.body.max_tokens === 8192
  && r.captured.find(({ lane }) => lane === 'B')?.body.max_tokens === 65536
  && r.captured.find(({ lane }) => lane === 'C')?.body.max_tokens === undefined);

r = await scenario((call) => call.model === 'qwen3.8-max' ? reply(503, '{"error":"unavailable"}') : healthy(call));
check('Lane A uses Qwen3.7-Max only after Qwen3.8-Max exhausts retries', r.captured.filter(({ model }) => model === 'qwen3.8-max').length === 3 && r.captured.filter(({ model }) => model === 'qwen3.7-max').length === 1);
const qwenFallback = r.captured.find(({ model }) => model === 'qwen3.7-max')?.body;
check('Qwen3.7-Max fallback uses the full review contract', qwenFallback?.max_tokens === 16384 && qwenFallback?.temperature === 0.2 && qwenFallback.messages[1].content.includes('Changed files and patches:'));
check('Qwen3.7-Max still yields one Lane A comment', r.posted.filter((body) => body.includes('ai-pr-review-bot:lane-A')).length === 1 && r.posted.some((body) => body.includes('qwen3.8-max unavailable -> served by qwen3.7-max')));

r = await scenario((call) => call.lane === 'B' && call.model === 'glm-5.2' ? reply(503, '{"error":"unavailable"}') : healthy(call));
check('Lane B falls back only to its dated DeepSeek model', r.captured.filter(({ lane, model }) => lane === 'B' && model === 'glm-5.2').length === 3
  && r.captured.filter(({ model }) => model === 'deepseek-v4-pro-202606').length === 1
  && r.captured.find(({ model }) => model === 'deepseek-v4-pro-202606')?.body.max_tokens === 393216
  && !r.captured.some(({ lane, model }) => lane !== 'B' && model === 'deepseek-v4-pro-202606')
  && r.posted.some((body) => body.includes('glm-5.2 unavailable -> served by deepseek-v4-pro-202606')));

r = await scenario((call) => call.lane === 'C' && call.model === 'deepseek-v4-flash' ? reply(503, '{"error":"slow upstream"}') : healthy(call));
check('Lane C falls back only to SenseNova 6.8 Flash Lite after DeepSeek V4 Flash exhausts retries',
  r.captured.filter(({ lane, model }) => lane === 'C' && model === 'deepseek-v4-flash').length === 3
  && r.captured.filter(({ model }) => model === 'sensenova-6.8-flash-lite').length === 1
  && !r.captured.some(({ lane, model }) => lane !== 'C' && model === 'sensenova-6.8-flash-lite')
  && r.posted.some((body) => body.includes('deepseek-v4-flash unavailable -> served by sensenova-6.8-flash-lite')));

r = await scenario((call) => call.lane === 'A' ? reply(429, '{"error":{"code":"insufficient_quota","message":"weekly quota exhausted"}}') : healthy(call));
check('quota failure short-circuits only its provider lane', r.captured.filter(({ lane }) => lane === 'A').length === 1
  && !r.captured.some(({ model }) => model === 'qwen3.7-max') && r.captured.some(({ lane }) => lane === 'B') && r.captured.some(({ lane }) => lane === 'C'));
check('failed lane publishes a diagnostic and fails the strict aggregate gate', /Lane A/.test(r.error?.message || '')
  && r.posted.length === 3
  && r.posted.some((body) => body.includes('shared Token Plan quota is exhausted') && body.includes('status=diagnostic')));

r = await scenario((call) => { if (call.lane === 'A') throw new Error('fetch failed'); return healthy(call); });
check('DNS or TLS style failures retry primary but do not resend context to fallback', r.captured.filter(({ lane }) => lane === 'A').length === 3
  && !r.captured.some(({ model }) => model === 'qwen3.7-max') && r.logs.some((line) => line.includes('endpoint-unavailable') && line.includes('Lane A')));

r = await scenario((call) => call.model === 'qwen3.8-max' && 'temperature' in call.body
  ? reply(400, '{"error":{"message":"Extra inputs are not permitted, field: \'temperature\'"}}') : healthy(call));
const repairedQwen = r.captured.filter(({ model }) => model === 'qwen3.8-max').map(({ body }) => body);
check('optional-field rejection repairs the request inside the same lane', repairedQwen.length === 2 && !('temperature' in repairedQwen[1]));

r = await scenario((call) => call.model === 'qwen3.8-max' ? reply(200, chatResult(call.model, '')) : healthy(call));
check('empty final content advances to fallback without publishing reasoning', r.captured.some(({ model }) => model === 'qwen3.7-max') && !r.posted.some((body) => body.includes('private thinking')));

r = await scenario((call) => call.lane === 'A'
  ? reply(200, chatResult(call.model, '# incomplete', { finish: 'LENGTH' }))
  : healthy(call));
check('truncated output is marked partial and cannot satisfy the strict aggregate gate', /Lane A/.test(r.error?.message || '')
  && r.captured.some(({ model }) => model === 'qwen3.7-max')
  && r.posted.some((body) => body.includes('lane-A') && body.includes('status=partial') && body.includes('max_tokens')));

const sameModelConfig = structuredClone(centralConfig);
sameModelConfig.lanes[1].primary = { ...sameModelConfig.lanes[1].primary, id: 'qwen3.8-max', label: 'Qwen via Lane B' };
sameModelConfig.lanes[1].fallbacks = [];
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(sameModelConfig) });
check('identical model ids on different providers remain lane-scoped', r.captured.filter(({ model }) => model === 'qwen3.8-max').length === 2
  && r.captured.some(({ lane, model, headers }) => lane === 'A' && model === 'qwen3.8-max' && headers.authorization === 'Bearer lane-a-key')
  && r.captured.some(({ lane, model, headers }) => lane === 'B' && model === 'qwen3.8-max' && headers.authorization === 'Bearer lane-b-key'));

const protocolConfig = structuredClone(centralConfig);
protocolConfig.lanes[1].primary = { ...protocolConfig.lanes[1].primary, id: 'gemini-3.7-flash', label: 'Gemini via OpenAI protocol' };
protocolConfig.lanes[1].fallbacks = [];
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(protocolConfig) });
check('protocol is bound to lane rather than inferred from model id', r.captured.some(({ lane, model, url }) => lane === 'B' && model === 'gemini-3.7-flash' && url.endsWith('/chat/completions')));

const throttledGoogleConfig = structuredClone(centralConfig);
throttledGoogleConfig.lanes[2] = {
  id: 'C',
  provider: 'google',
  protocol: 'google-generate-content',
  primary: { id: 'gemini-3.7-flash', label: 'Gemini-3.7-Flash', context_profile: 'kimi-k3-throttled', max_output_tokens: 8192, thinking_level: 'high' },
  fallbacks: [],
};
r = await scenario(healthy, {
  PR_REVIEW_CONFIG: JSON.stringify(throttledGoogleConfig),
  LANE_C_API_BASE: 'https://generativelanguage.googleapis.com/v1beta',
});
const throttledGoogle = r.captured.find(({ lane }) => lane === 'C')?.body;
check('Google protocol honors the configured throttled context profile', throttledGoogle?.generationConfig.maxOutputTokens === 8192
  && throttledGoogle.systemInstruction.parts[0].text.includes('high-confidence')
  && throttledGoogle.systemInstruction.parts[0].text.includes('two independent internal review passes')
  && throttledGoogle.contents[0].parts[0].text.includes('All changed file names:'));

const missingPromptConfig = structuredClone(centralConfig);
delete missingPromptConfig.review_policy.system_prompt;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(missingPromptConfig) });
check('workflow defense rejects a missing system prompt before model calls', /system_prompt/.test(r.error?.message || '') && r.captured.length === 0);

const missingFallbacksConfig = structuredClone(centralConfig);
delete missingFallbacksConfig.lanes[0].fallbacks;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(missingFallbacksConfig) });
check('workflow defense rejects a missing fallback array before model calls', /fallbacks must be an array/.test(r.error?.message || '') && r.captured.length === 0);

const invalidThinkingConfig = structuredClone(centralConfig);
invalidThinkingConfig.lanes[2].protocol = 'google-generate-content';
delete invalidThinkingConfig.lanes[2].primary.omit_max_tokens;
invalidThinkingConfig.lanes[2].primary.thinking_level = 'maximum';
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(invalidThinkingConfig) });
check('workflow defense rejects an unsupported Google thinking level before model calls', /thinking_level is not supported/.test(r.error?.message || '') && r.captured.length === 0);

const crossProtocolThinkingConfig = structuredClone(centralConfig);
crossProtocolThinkingConfig.lanes[0].primary.thinking_level = 'high';
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(crossProtocolThinkingConfig) });
check('workflow defense rejects thinking configuration outside Google protocol', /only supported by google-generate-content/.test(r.error?.message || '') && r.captured.length === 0);

const invalidOmitMaxTokensConfig = structuredClone(centralConfig);
invalidOmitMaxTokensConfig.lanes[2].primary.omit_max_tokens = 'yes';
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(invalidOmitMaxTokensConfig) });
check('workflow defense rejects a non-boolean omit_max_tokens flag', /omit_max_tokens must be a boolean/.test(r.error?.message || '') && r.captured.length === 0);

r = await scenario(healthy, { LANE_B_KEY: '' });
check('an unprovisioned lane preserves healthy reviews but fails the strict aggregate gate', /Lane B/.test(r.error?.message || '')
  && r.captured.length === 2
  && !r.captured.some(({ lane }) => lane === 'B')
  && r.posted.length === 3
  && r.posted.some((body) => body.includes('PR_AGENT_LANE_B_KEY')));

r = await scenario(healthy, {
  LANE_A_KEY: '', LANE_A_API_BASE: '', LANE_B_KEY: '', LANE_B_API_BASE: '', LANE_C_KEY: '', LANE_C_API_BASE: '',
});
// Lane C is advisory, so it is absent from the gate message even when it also failed:
// every lane still publishes its diagnostic, but only the required lanes turn the job red.
check('diagnostic-only execution fails the job after preserving lane diagnostics', /Lane A, Lane B/.test(r.error?.message || '')
  && !/Lane C/.test(r.error?.message || '')
  && r.captured.length === 0 && r.posted.length === 3);

r = await scenario(healthy, { LANE_C_KEY: '', LANE_C_API_BASE: '' });
check('an advisory lane without evidence publishes its diagnostic without failing the job', !r.error
  && r.captured.length === 2
  && !r.captured.some(({ lane }) => lane === 'C')
  && r.posted.length === 3
  && r.posted.some((body) => body.includes('PR_AGENT_LANE_C_KEY'))
  && r.logs.some((line) => line.includes('Advisory lane(s) without valid evidence')));

r = await scenario(healthy, { LANE_A_KEY: '', LANE_C_KEY: '' });
check('a required lane still gates the job when an advisory lane fails alongside it', /Lane A/.test(r.error?.message || '')
  && !/Lane C/.test(r.error?.message || ''));

const allAdvisoryConfig = structuredClone(centralConfig);
for (const lane of allAdvisoryConfig.lanes) lane.advisory = true;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(allAdvisoryConfig) });
check('workflow defense rejects a config where every lane is advisory', /every configured lane is advisory/.test(r.error?.message || '')
  && r.captured.length === 0);

const invalidAdvisoryConfig = structuredClone(centralConfig);
invalidAdvisoryConfig.lanes[2].advisory = 'yes';
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(invalidAdvisoryConfig) });
check('workflow defense rejects a non-boolean advisory flag', /advisory must be a boolean/.test(r.error?.message || '')
  && r.captured.length === 0);

const newerPull = { ...pull, head: { ...pull.head, sha: 'cafebabe'.repeat(5) } };
r = await scenario(() => { throw new Error('model should not run'); }, {}, { comments: validEvidence, pulls: [pull, newerPull] });
check('head change during evidence reuse prevents a stale green result', r.captured.length === 0 && r.posted.length === 0
  && r.logs.some((line) => line.includes('Skip stale evidence reuse')));
r = await scenario(() => { throw new Error('model should not run'); }, {}, { pulls: [newerPull] });
check('superseded event makes zero model calls before context collection', r.captured.length === 0 && r.logs.some((line) => line.includes('before context collection')));
r = await scenario(() => { throw new Error('model should not run'); }, {}, { pulls: [pull, newerPull] });
check('head change during collection makes zero model calls', r.captured.length === 0 && r.logs.some((line) => line.includes('before model dispatch')));
r = await scenario(healthy, {}, { pulls: [pull, pull, newerPull] });
check('head change during model execution publishes no stale comments', r.captured.length === 3 && r.posted.length === 0 && r.logs.some((line) => line.includes('before comment publishing')));

r = await scenario(healthy, {}, { rejectComment: (body) => body.includes('lane-A') });
check('one comment failure preserves healthy independent lanes but fails the aggregate gate', /Lane A/.test(r.error?.message || '')
  && r.posted.length === 2 && r.posted.some((body) => body.includes('lane-B')) && r.posted.some((body) => body.includes('lane-C')));

if (checks.some((value) => !value)) process.exitCode = 1;
