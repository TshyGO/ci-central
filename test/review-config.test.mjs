#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const actionPath = path.join(here, '..', 'review-action');
const probeScript = fs.readFileSync(path.join(here, '..', 'scripts', 'probe-provider.ps1'), 'utf8');
const source = require(path.join(actionPath, 'src', 'index.js'));
const bundled = require(path.join(actionPath, 'dist', 'index.js'));

const repositories = [
  'TshyGO/ci-central',
  'TshyGO/NebulaLab',
  'TshyGO/NebulaLab-Docs',
  'TshyGO/NebulaLab-Plugins',
  'TshyGO/resume-form-assistant-plugin',
  'TshyGO/AI-Thesis-Polisher',
  'TshyGO/NebulaGraph-License-Service',
];
assert.match(probeScript, /provider -ne 'volcengine-ark-coding'/, 'only Ark Coding may tolerate a missing or incomplete /models response');
assert.match(probeScript, /foreach \(\$modelConfig in \$models\)/, 'provider probe must validate the primary and every configured fallback');
assert.match(probeScript, /request\.max_tokens = 512\b/, 'provider probe must leave enough output room for reasoning models to return final text');
assert.match(probeScript, /elseif \(\$laneConfig\.protocol -eq 'google-generate-content'\)[\s\S]*?foreach \(\$modelConfig in \$models\)[\s\S]*?\$model = \$modelConfig\.id/, 'Google provider probe must initialize and validate every configured model');
for (const repository of repositories) {
  const fromSource = source.loadConfig(repository, actionPath);
  const fromBundle = bundled.loadConfig(repository, actionPath);
  assert.equal(fromSource.review_policy.max_attempts, 1);
  assert.ok(fromSource.lanes.every((lane) => lane.fallbacks.length === 1));
  assert.deepEqual(fromBundle, fromSource, `${repository} source and dist loaders disagree`);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.id), ['A', 'B', 'C']);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.primary.id), ['muse-spark-1.3-contributor', 'ark-code-latest', 'deepseek-v4.1-flash']);
  assert.equal(fromSource.lanes[1].provider, 'volcengine-ark-coding', `${repository} Lane B must use Volcengine Ark Coding`);
  assert.equal(fromSource.lanes[1].fallbacks[0]?.id, 'deepseek-v4-pro-ga-260813', `${repository} Lane B must use the Ark-hosted fallback`);
  assert.deepEqual(fromSource.lanes.flatMap((lane) => lane.fallbacks.map((model) => model.id)), ['muse-spark-1.2-contributor', 'deepseek-v4-pro-ga-260813', 'muse-spark-1.2-contributor']);
  assert.ok(fromSource.lanes.every((lane) => lane.primary.thinking_level === undefined
    && lane.fallbacks.every((model) => model.thinking_level === undefined)), `${repository} active OpenAI-compatible lanes must not configure Google thinking`);
  // Lane C moved from SenseNova onto OpenCode Go's DeepSeek V4.1 Flash, so no active lane
  // omits max_tokens any more. Every lane now has to send its own output ceiling: a request
  // shape that drops it is the failure this Lane C kept hitting, not a provider requirement.
  assert.ok(fromSource.lanes.every((lane) => lane.primary.omit_max_tokens === undefined
    && lane.fallbacks.every((model) => model.omit_max_tokens === undefined)), `${repository} no active lane may silently omit the output ceiling`);
}

const ciCentral = source.loadConfig('TshyGO/ci-central', actionPath);
assert.equal(ciCentral.review_policy.request_timeout_ms, 600000);
assert.equal(ciCentral.lanes[2].advisory, true, 'ci-central Lane C shares a provider quota and must not gate its own PRs');
assert.equal(ciCentral.review_policy.model_budget_ms, 720000);
assert.deepEqual(
  [ciCentral.lanes[1].primary, ...ciCentral.lanes[1].fallbacks].map((model) => model.max_output_tokens),
  [65536, 393216],
  'ci-central Lane B must preserve its configured Auto output budget and Ark-hosted DeepSeek fallback space',
);

for (const repository of repositories) {
  const config = source.loadConfig(repository, actionPath);
  // Lane C rides a shared quota that can return 429 once exhausted. Every repository keeps it
  // advisory so an empty quota never turns a PR red on its own, and keeps Lanes A and B
  // gating so the review still enforces something.
  assert.equal(config.lanes[2].advisory, true, `${repository} Lane C must stay advisory`);
  assert.ok(config.lanes.slice(0, 2).every((lane) => lane.advisory === undefined), `${repository} Lane A/B must keep gating the job`);
  assert.deepEqual(
    [config.lanes[1].primary, ...config.lanes[1].fallbacks].map((model) => model.max_output_tokens),
    [65536, 393216],
    `${repository} Lane B must preserve the configured Auto output budget and Ark-hosted DeepSeek fallback ceiling`,
  );
  assert.equal(config.lanes[1].request_timeout_ms, 1800000, `${repository} Lane B preserves reasoning with a thirty-minute request ceiling`);
  assert.equal(config.lanes[1].model_budget_ms, 1800000, `${repository} Lane B model budget matches its request ceiling`);
  // Lane C is advisory, so it can never fail a run on its own, and it still has to
  // finish a review. Its 600000ms window was calibrated against the retired
  // SenseNova slot, where deepseek-v4-flash spent a 16384-token ceiling on private
  // reasoning and returned finish_reason=length with no text. Lane C now calls
  // DeepSeek V4.1 Flash over the Responses protocol, and the Live evidence for that
  // exact failure is NebulaLab PR #914 run 35088795799: HTTP 200,
  // finish_reason=length, reasoning_tokens=16384, reasoningLen=64668, contentLen=0.
  // The ceiling is 131072 now, so both the request ceiling and the lane budget have
  // to cover a full reasoning pass and the fallback that still sits behind it.
  // 1800000 matches Lane B's ceiling, and lanes run concurrently under the reusable
  // job's 70-minute limit, so a 30-minute per-model window stays inside it.
  //
  // Every repository moves together, because the ceiling that consumed the lane was
  // central rather than repository-specific. The retired 180000 calibration does not
  // carry over: it measured SenseNova's quota behaviour, which no lane uses now.
  const laneCBudgetMs = 1800000;
  assert.equal(config.lanes[2].request_timeout_ms, laneCBudgetMs, `${repository} Lane C request budget changed without a measurement behind it`);
  assert.equal(config.lanes[2].model_budget_ms, laneCBudgetMs, `${repository} Lane C model budget changed without a measurement behind it`);
  assert.equal(config.lanes[1].fallbacks[0].request_timeout_ms, 1800000, `${repository} Lane B fallback preserves reasoning with its own thirty-minute ceiling`);
  // A/C budgets are deliberately unchanged even where advisory C can outlast B.
}

// The quorum keeps the bar where it was. NebulaLab required Lane A and Lane B, so two
// reviews had to land before a pull request could go green, and two still have to. What
// changed is that the gate no longer insists on which two, which is the only way three
// lanes are redundant rather than three chances to be blocked: a provider quota is
// exhausted for days, and under the old rule either one of the two named lanes running
// dry turned every pull request red while the other two published full reviews.
//
// Two is also the floor that keeps a heavyweight lane in every passing run: with three
// lanes, no quorum of two can be reached by Lane C alone.
// Every repository, because the reasoning is structural rather than measured.
// All six run the same three lanes - two heavyweights and one advisory flash
// model on a shared quota - so all six had the same failure: either named lane
// out of quota turned the run red while the other two published full reviews.
// The Lane C budget history did not spread this way either: 180000 came from
// NebulaLab timings on the retired SenseNova slot. The 2026-09-16 window raise is
// central instead, because the output ceiling that broke the lane is central.
for (const repository of repositories) {
  const policy = source.loadConfig(repository, actionPath).review_policy;
  const lanes = source.loadConfig(repository, actionPath).lanes;
  assert.equal(policy.min_valid_lanes, 2, `${repository} quorum must stay at the two reviews the required lanes already demanded`);
  assert.ok(policy.min_valid_lanes < lanes.length,
    `${repository} quorum equal to the lane count is the all-lanes rule again, with none of the redundancy`);
  assert.equal(lanes.filter((lane) => !lane.advisory).length, 2,
    `${repository} quorum of 2 assumes two non-advisory lanes; changing that changes what the number means`);
}

const nebula = source.loadConfig('TshyGO/NebulaLab', actionPath);
assert.equal(nebula.lanes[0].provider, 'opencode-go');
assert.equal(nebula.lanes[1].provider, 'volcengine-ark-coding');
assert.equal(nebula.lanes[2].provider, 'opencode-go');
assert.deepEqual(nebula.lanes.map((lane) => lane.protocol), ['openai-responses', 'openai-chat-completions', 'openai-responses']);
assert.deepEqual(nebula.lanes.map((lane) => lane.primary.id), ['muse-spark-1.3-contributor', 'ark-code-latest', 'deepseek-v4.1-flash']);
assert.equal(nebula.lanes[0].fallbacks[0].context_profile, 'full');

for (const loader of [source, bundled]) {
  const badAttempts = structuredClone(nebula);
  badAttempts.review_policy.max_attempts = 3;
  assert.throws(() => loader.validateConfig(badAttempts, 'TshyGO/NebulaLab'), /max_attempts must be 1/);
  const extraFallback = structuredClone(nebula);
  extraFallback.lanes[0].fallbacks.push({ ...extraFallback.lanes[0].fallbacks[0], id: 'third-model' });
  assert.throws(() => loader.validateConfig(extraFallback, 'TshyGO/NebulaLab'), /at most one fallback/);
}
for (const loader of [source, bundled]) {
  for (const invalid of [0, -1, 1.5, '300000', null]) {
    const config = structuredClone(nebula);
    config.lanes[1].fallbacks[0].request_timeout_ms = invalid;
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), /request_timeout_ms must be a positive integer/);
  }
}
const duplicateAcrossLanes = structuredClone(nebula);
duplicateAcrossLanes.lanes[1].primary.id = duplicateAcrossLanes.lanes[0].primary.id;
assert.doesNotThrow(() => source.validateConfig(duplicateAcrossLanes, 'TshyGO/NebulaLab'), 'routing must be lane-scoped, not keyed globally by model id');

const duplicateInsideLane = structuredClone(nebula);
duplicateInsideLane.lanes[0].fallbacks[0].id = duplicateInsideLane.lanes[0].primary.id;
assert.throws(() => source.validateConfig(duplicateInsideLane, 'TshyGO/NebulaLab'), /duplicate primary\/fallback/);

const invalidThinkingLevel = structuredClone(nebula);
invalidThinkingLevel.lanes[2].protocol = 'google-generate-content';
invalidThinkingLevel.lanes[2].primary.thinking_level = 'maximum';
assert.throws(() => source.validateConfig(invalidThinkingLevel, 'TshyGO/NebulaLab'), /thinking_level is not supported/);

const crossProtocolThinking = structuredClone(nebula);
crossProtocolThinking.lanes[0].primary.thinking_level = 'high';
assert.throws(() => source.validateConfig(crossProtocolThinking, 'TshyGO/NebulaLab'), /only supported by google-generate-content/);

const invalidOmitMaxTokens = structuredClone(nebula);
invalidOmitMaxTokens.lanes[2].primary.omit_max_tokens = 'yes';
assert.throws(() => source.validateConfig(invalidOmitMaxTokens, 'TshyGO/NebulaLab'), /omit_max_tokens must be a boolean/);

const googleOmitMaxTokens = structuredClone(nebula);
googleOmitMaxTokens.lanes[2].protocol = 'google-generate-content';
googleOmitMaxTokens.lanes[2].primary.omit_max_tokens = true;
assert.throws(() => source.validateConfig(googleOmitMaxTokens, 'TshyGO/NebulaLab'), /omit_max_tokens is only supported by openai-chat-completions/);

const invalidLaneBudget = structuredClone(nebula);
invalidLaneBudget.lanes[2].model_budget_ms = invalidLaneBudget.lanes[2].request_timeout_ms - 1;
assert.throws(() => source.validateConfig(invalidLaneBudget, 'TshyGO/NebulaLab'), /greater than or equal to request_timeout_ms/);

// Lane C is a free-tier best-effort slot. It must publish a review when it can, but an
// exhausted quota must never turn the job red - a permanently failing check is one that
// reviewers learn to ignore.
assert.equal(nebula.lanes[2].advisory, true, 'NebulaLab Lane C must stay advisory');
assert.ok(nebula.lanes.slice(0, 2).every((lane) => lane.advisory === undefined), 'NebulaLab Lane A/B must keep gating the job');

const invalidAdvisory = structuredClone(nebula);
invalidAdvisory.lanes[2].advisory = 'yes';
assert.throws(() => source.validateConfig(invalidAdvisory, 'TshyGO/NebulaLab'), /advisory must be a boolean/);

const everyLaneAdvisory = structuredClone(nebula);
for (const lane of everyLaneAdvisory.lanes) lane.advisory = true;
assert.throws(() => source.validateConfig(everyLaneAdvisory, 'TshyGO/NebulaLab'), /At least one lane must be required/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-'));
const output = path.join(tmp, 'output.txt');
source.run({ INPUT_REPOSITORY: 'TshyGO/NebulaLab', GITHUB_ACTION_PATH: actionPath, GITHUB_OUTPUT: output });
const emitted = fs.readFileSync(output, 'utf8').trim();
assert.ok(emitted.startsWith('config={'));
assert.deepEqual(JSON.parse(emitted.slice('config='.length)), nebula);

assert.throws(() => source.loadConfig('TshyGO/Unknown', actionPath), /No central PR review config/);
assert.throws(() => source.configFileName('../invalid'), /Invalid repository identifier/);

console.log('ok   central repository config resolver');
