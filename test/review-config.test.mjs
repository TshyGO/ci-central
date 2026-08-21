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
  assert.deepEqual(fromSource.lanes.map((lane) => lane.primary.id), ['qwen3.8-max', 'glm-5.2', 'gemini-3.7-flash']);
  assert.deepEqual(fromSource.lanes.flatMap((lane) => lane.fallbacks.map((model) => model.id)), ['qwen3.7-max', 'deepseek-v4-pro-202606']);
  assert.equal(fromSource.lanes[2].primary.thinking_level, 'high', `${repository} Lane C must explicitly request high thinking`);
  assert.ok(fromSource.lanes.slice(0, 2).every((lane) => lane.primary.thinking_level === undefined
    && lane.fallbacks.every((model) => model.thinking_level === undefined)), `${repository} non-Google lanes changed unexpectedly`);
}

const ciCentral = source.loadConfig('TshyGO/ci-central', actionPath);
assert.equal(ciCentral.review_policy.request_timeout_ms, 600000);
assert.equal(ciCentral.review_policy.model_budget_ms, 720000);
assert.deepEqual(
  [ciCentral.lanes[1].primary, ...ciCentral.lanes[1].fallbacks].map((model) => model.max_output_tokens),
  [32768, 32768],
  'ci-central Lane B must preserve full reasoning quality with a 32K completion ceiling',
);

for (const repository of repositories.slice(1)) {
  const config = source.loadConfig(repository, actionPath);
  assert.equal(config.review_policy.request_timeout_ms, 300000, `${repository} request timeout changed unexpectedly`);
  assert.equal(config.review_policy.model_budget_ms, 360000, `${repository} model budget changed unexpectedly`);
  assert.deepEqual(
    [config.lanes[1].primary, ...config.lanes[1].fallbacks].map((model) => model.max_output_tokens),
    [16384, 16384],
    `${repository} Lane B output budget changed unexpectedly`,
  );
}

const nebula = source.loadConfig('TshyGO/NebulaLab', actionPath);
assert.equal(nebula.lanes[0].provider, 'alibaba');
assert.equal(nebula.lanes[1].provider, 'tencent');
assert.equal(nebula.lanes[2].provider, 'google');
assert.equal(nebula.lanes[0].fallbacks[0].context_profile, 'full');

const duplicateAcrossLanes = structuredClone(nebula);
duplicateAcrossLanes.lanes[1].primary.id = duplicateAcrossLanes.lanes[0].primary.id;
assert.doesNotThrow(() => source.validateConfig(duplicateAcrossLanes, 'TshyGO/NebulaLab'), 'routing must be lane-scoped, not keyed globally by model id');

const duplicateInsideLane = structuredClone(nebula);
duplicateInsideLane.lanes[0].fallbacks[0].id = duplicateInsideLane.lanes[0].primary.id;
assert.throws(() => source.validateConfig(duplicateInsideLane, 'TshyGO/NebulaLab'), /duplicate primary\/fallback/);

const invalidThinkingLevel = structuredClone(nebula);
invalidThinkingLevel.lanes[2].primary.thinking_level = 'maximum';
assert.throws(() => source.validateConfig(invalidThinkingLevel, 'TshyGO/NebulaLab'), /thinking_level is not supported/);

const crossProtocolThinking = structuredClone(nebula);
crossProtocolThinking.lanes[0].primary.thinking_level = 'high';
assert.throws(() => source.validateConfig(crossProtocolThinking, 'TshyGO/NebulaLab'), /only supported by google-generate-content/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-'));
const output = path.join(tmp, 'output.txt');
source.run({ INPUT_REPOSITORY: 'TshyGO/NebulaLab', GITHUB_ACTION_PATH: actionPath, GITHUB_OUTPUT: output });
const emitted = fs.readFileSync(output, 'utf8').trim();
assert.ok(emitted.startsWith('config={'));
assert.deepEqual(JSON.parse(emitted.slice('config='.length)), nebula);

assert.throws(() => source.loadConfig('TshyGO/Unknown', actionPath), /No central PR review config/);
assert.throws(() => source.configFileName('../invalid'), /Invalid repository identifier/);

console.log('ok   central repository config resolver');
