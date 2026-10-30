#!/usr/bin/env node
'use strict';
// Actual-runner acceptance, not a GitHub publisher. Credentials arrive only via stdin.
// GitHub is simulated; model requests use the exact production bundle and SDK.
const { runReview } = require('../review-action/dist/review-runner.js');
const { requestChatCompletion } = require('../review-action/dist/sdk-client.js');
const config = require('../review-action/config/repositories/TshyGO__NebulaLab.json');
const workflow = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(workflow || '')) throw new Error('Supply the tested 40-character commit');
const report = JSON.stringify({ summary: 'Acceptance fixture reviewed', reviewed_files: ['src/candidate.js'], findings: [], limitations: [] });
const response = (status, content) => ({ ok: status < 400, status, text: async () => content });
const fakeReview = (model) => response(200, JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content: report } }] }));
const bundle = (providers) => JSON.stringify({ schema_version: 1, providers });
let stage = 'read-input';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const secrets = JSON.parse(input);
    input = '';
    const bases = { openai: secrets.openai_base.replace(/\/$/, ''), 'command-code': secrets.cc_base.replace(/\/$/, '') };
    const env = { RUNNER_ENVIRONMENT: 'self-hosted', NEBULA_REVIEW_PROXY_URL: 'http://192.168.122.1:17890',
      PR_REVIEW_CONFIG: JSON.stringify(config), PR_REVIEW_WORKFLOW_SHA: workflow,
      LANE_A_KEY: 'acceptance-stub-a', LANE_A_API_BASE: 'https://stub-a.invalid/v1',
      LANE_B_KEY: 'acceptance-stub-b', LANE_B_API_BASE: 'https://stub-b.invalid/v1',
      LANE_C_KEY: bundle({ openai: secrets.openai_key, 'command-code': secrets.cc_key }),
      LANE_C_API_BASE: bundle(bases) };
    const summaries = [];
    async function round(name, headDigit, prior = [], inject = false, verifyAB = false) {
      stage = name;
      console.error(`Acceptance case: ${name}`);
      const head = headDigit.repeat(40);
      const comments = prior.map((comment, i) => ({ id: i + 1, user: { login: 'github-actions[bot]' }, body: comment }));
      const traces = [];
      const github = { rest: { pulls: { get: async () => ({ data: { number: 42, state: 'open', title: 'Runner acceptance fixture',
        user: { login: 'acceptance' }, body: '', base: { ref: 'main', sha: 'a'.repeat(40) }, head: { ref: 'acceptance', sha: head } } }),
        listFiles: 'files', listCommits: 'commits', listReviews: 'reviews', listReviewComments: 'replies' },
        repos: { compareCommitsWithBasehead: async () => { throw new Error('Fixture has no compare API'); },
          getContent: async () => { throw new Error('Fixture has no content API'); } },
        issues: { listComments: 'comments', createComment: async ({ body }) => {
          comments.push({ id: comments.length + 1, user: { login: 'github-actions[bot]' }, body }); return { data: comments.at(-1) };
        }, updateComment: async ({ comment_id, body }) => { const item = comments.find((item) => item.id === comment_id); item.body = body; return { data: item }; },
        deleteComment: async () => {} } }, paginate: async (which) => which === 'comments' ? comments
          : which === 'files' ? [{ filename: 'src/candidate.js', status: 'modified', additions: 1, deletions: 1,
            patch: `@@ -1 +1 @@\n-export const value = 1;\n+export const value = ${headDigit.charCodeAt(0)};` }]
            : which === 'commits' ? [{ commit: { message: 'Acceptance fixture' } }] : [] };
      await runReview({ github, context: { eventName: 'pull_request', repo: { owner: 'TshyGO', repo: 'NebulaLab' },
        payload: { pull_request: { number: 42, head: { sha: head } } }, serverUrl: 'https://github.com', runId: 1 }, env,
        logger: { log: () => {} }, maskSecret: () => {}, sdk: { requestChatCompletion: async (args) => {
          const provider = args.baseURL === bases.openai ? 'openai' : args.baseURL === bases['command-code'] ? 'command-code' : 'stub';
          if (provider === 'stub') return verifyAB ? response(503, 'Injected own-provider outage') : fakeReview(args.payload.model);
          if (verifyAB && provider === 'openai') return fakeReview(args.payload.model);
          if (inject && provider === 'openai') { traces.push({ provider, model: args.payload.model, injected: true }); return response(503, 'Injected outage'); }
          const result = await requestChatCompletion(args);
          traces.push({ provider, model: args.payload.model, http_status: result.status, real_request: true });
          return result;
        } } });
      const laneComments = comments.filter((item) => item.body.startsWith('<!-- ai-pr-review-bot:lane-')).map((item) => item.body);
      const c = laneComments.find((body) => body.startsWith('<!-- ai-pr-review-bot:lane-C -->')) || '';
      if (!c.includes(`head=${head} workflow=${workflow} status=valid`)) throw new Error('C evidence was not valid');
      const firstPass = c.includes('ai-pr-review-first-pass:v1 lane=C');
      const expected = verifyAB ? ['command-code:meta/muse-spark-1.3-contributor', 'command-code:claude-haiku-5-5']
        : inject ? ['command-code:gpt-6-luna'] : [`openai:${prior.length ? 'gpt-6-luna' : 'gpt-6.1-terra'}`];
      const actual = traces.filter((trace) => trace.real_request).map((trace) => `${trace.provider}:${trace.model}`).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) throw new Error('Unexpected provider/model trace');
      if (verifyAB && laneComments.some((body) => !body.includes('status=valid'))) throw new Error('A/B evidence was not valid');
      if (!firstPass) throw new Error('First pass was not preserved');
      summaries.push({ case: name, valid: true, first_pass_preserved: firstPass, traces });
      return laneComments;
    }
    const first = await round('Terra first pass / real OpenAI', 'b');
    await round('Luna subsequent head / real OpenAI', 'c', first);
    await round('Luna injected OpenAI outage / real CC fallback', 'd', first, true);
    await round('A/B injected own-provider outages / real CC fallbacks', 'e', [], false, true);
    console.log(JSON.stringify({ commit: workflow, github_context: 'simulated; no GitHub writes', runner: process.env.RUNNER_NAME || require('node:os').hostname(),
      proxy: 'approved szlab review proxy', summaries }, null, 2));
  } catch {
    // Neither provider errors nor secret-bearing inputs are printed by this harness.
    console.error(`Actual-runner acceptance failed at ${stage}; no secret values or provider error bodies were printed.`);
    process.exitCode = 1;
  }
});
