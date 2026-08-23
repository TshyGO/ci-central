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
const source = require(path.join(actionPath, 'src', 'index.js'));
const bundled = require(path.join(actionPath, 'dist', 'index.js'));

const repositories = ['TshyGO/ci-central', 'TshyGO/NebulaLab', 'TshyGO/NebulaLab-Docs', 'TshyGO/NebulaLab-Plugins'];
for (const repository of repositories) {
  const fromSource = source.loadConfig(repository, actionPath);
  const fromBundle = bundled.loadConfig(repository, actionPath);
  assert.deepEqual(fromBundle, fromSource, `${repository} source and dist loaders disagree`);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.id), ['A', 'B', 'C']);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.primary.id), ['qwen3.8-max', 'glm-5.2', 'deepseek-v4-flash']);
  assert.deepEqual(fromSource.lanes.flatMap((lane) => lane.fallbacks.map((model) => model.id)), ['qwen3.7-max', 'deepseek-v4-pro-202606', 'sensenova-6.8-flash-lite']);
  assert.ok(fromSource.lanes.every((lane) => lane.primary.thinking_level === undefined
    && lane.fallbacks.every((model) => model.thinking_level === undefined)), `${repository} active OpenAI-compatible lanes must not configure Google thinking`);
  assert.ok([fromSource.lanes[2].primary, ...fromSource.lanes[2].fallbacks].every((model) => model.omit_max_tokens === true), `${repository} SenseNova models must follow the provider request shape without max_tokens`);
  assert.ok(fromSource.lanes.slice(0, 2).every((lane) => lane.primary.omit_max_tokens === undefined
    && lane.fallbacks.every((model) => model.omit_max_tokens === undefined)), `${repository} Lane A/B output request fields changed unexpectedly`);
}

const ciCentral = source.loadConfig('TshyGO/ci-central', actionPath);
assert.equal(ciCentral.review_policy.request_timeout_ms, 600000);
assert.equal(ciCentral.review_policy.model_budget_ms, 720000);
assert.deepEqual(
  [ciCentral.lanes[1].primary, ...ciCentral.lanes[1].fallbacks].map((model) => model.max_output_tokens),
  [65536, 393216],
  'ci-central Lane B must use the GLM maximum for its primary and preserve DeepSeek fallback space',
);

for (const repository of repositories) {
  const config = source.loadConfig(repository, actionPath);
  assert.deepEqual(
    [config.lanes[1].primary, ...config.lanes[1].fallbacks].map((model) => model.max_output_tokens),
    [65536, 393216],
    `${repository} Lane B must use GLM primary and retain the DeepSeek fallback ceiling`,
  );
  assert.equal(config.lanes[1].request_timeout_ms, 900000, `${repository} Lane B request budget must allow high reasoning`);
  assert.equal(config.lanes[1].model_budget_ms, 900000, `${repository} Lane B model budget must allow high reasoning`);
  assert.equal(config.lanes[2].request_timeout_ms, 600000, `${repository} Lane C request budget must preserve the provider response window`);
  assert.equal(config.lanes[2].model_budget_ms, 600000, `${repository} Lane C must fall back after one full provider response window`);
}

const nebula = source.loadConfig('TshyGO/NebulaLab', actionPath);
assert.equal(nebula.lanes[0].provider, 'alibaba');
assert.equal(nebula.lanes[1].provider, 'tencent');
assert.equal(nebula.lanes[2].provider, 'sensenova');
assert.ok(nebula.lanes.every((lane) => lane.protocol === 'openai-chat-completions'));
assert.equal(nebula.lanes[0].fallbacks[0].context_profile, 'full');

const duplicateAcrossLanes = structuredClone(nebula);
duplicateAcrossLanes.lanes[1].primary.id = duplicateAcrossLanes.lanes[0].primary.id;
assert.doesNotThrow(() => source.validateConfig(duplicateAcrossLanes, 'TshyGO/NebulaLab'), 'routing must be lane-scoped, not keyed globally by model id');

const duplicateInsideLane = structuredClone(nebula);
duplicateInsideLane.lanes[0].fallbacks[0].id = duplicateInsideLane.lanes[0].primary.id;
assert.throws(() => source.validateConfig(duplicateInsideLane, 'TshyGO/NebulaLab'), /duplicate primary\/fallback/);

const invalidThinkingLevel = structuredClone(nebula);
invalidThinkingLevel.lanes[2].protocol = 'google-generate-content';
delete invalidThinkingLevel.lanes[2].primary.omit_max_tokens;
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
assert.throws(() => source.validateConfig(googleOmitMaxTokens, 'TshyGO/NebulaLab'), /omit_max_tokens is only supported by openai-chat-completions/);

const invalidLaneBudget = structuredClone(nebula);
invalidLaneBudget.lanes[2].model_budget_ms = invalidLaneBudget.lanes[2].request_timeout_ms - 1;
assert.throws(() => source.validateConfig(invalidLaneBudget, 'TshyGO/NebulaLab'), /greater than or equal to request_timeout_ms/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-'));
const output = path.join(tmp, 'output.txt');
source.run({ INPUT_REPOSITORY: 'TshyGO/NebulaLab', GITHUB_ACTION_PATH: actionPath, GITHUB_OUTPUT: output });
const emitted = fs.readFileSync(output, 'utf8').trim();
assert.ok(emitted.startsWith('config={'));
assert.deepEqual(JSON.parse(emitted.slice('config='.length)), nebula);

assert.throws(() => source.loadConfig('TshyGO/Unknown', actionPath), /No central PR review config/);
assert.throws(() => source.configFileName('../invalid'), /Invalid repository identifier/);

console.log('ok   central repository config resolver');
