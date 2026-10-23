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
assert.match(probeScript, /foreach \(\$modelConfig in \$models\) \{\s*\$model = \$modelConfig\.id\s*[\s\S]*?\$protocol = if \(\[string\]::IsNullOrWhiteSpace\(\$modelConfig\.protocol\)\) \{ \$laneConfig\.protocol \} else \{ \$modelConfig\.protocol \}/, 'provider probe must validate every configured model with its own protocol');
assert.match(probeScript, /elseif \(\$protocol -eq 'google-generate-content'\)[\s\S]*?inference\/go\/v1/, 'Go Gemini probe must use the inference endpoint');
assert.match(probeScript, /elseif \(\$protocol -eq 'anthropic-messages'\)[\s\S]*?'x-api-key' = \$key/, 'Anthropic Messages probe must authenticate with x-api-key');
// NebulaLab's Lane B runs on Anthropic: Sonnet 5.5 reviews each PR's first commit and Haiku 5.5
// the later ones, on one provider and key. The other repositories keep Haiku on OpenCode Go.
const anthropicLaneB = new Set(['TshyGO/NebulaLab']);
for (const repository of repositories) {
  const fromSource = source.loadConfig(repository, actionPath);
  const fromBundle = bundled.loadConfig(repository, actionPath);
  const onAnthropic = anthropicLaneB.has(repository);
  assert.equal(fromSource.review_policy.max_attempts, 1);
  // No lane falls back to a different model; its only fallback is the same model elsewhere.
  assert.ok(fromSource.lanes.every((lane) => lane.fallbacks.length === 0), `${repository} lanes must not fall back to another model`);
  assert.deepEqual(fromBundle, fromSource, `${repository} source and dist loaders disagree`);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.id), ['A', 'B', 'C']);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.primary.id), ['muse-spark-1.3-contributor', 'claude-haiku-5-5', 'gpt-6-luna']);
  // Lanes A/B draw on the OpenCode Go plan (NebulaLab's B on Anthropic) and Lane C on Command Code.
  assert.deepEqual(fromSource.lanes.map((lane) => lane.provider), ['opencode-go', onAnthropic ? 'anthropic' : 'opencode-go', 'command-code'], `${repository} lane providers changed`);
  // A fallback on the same provider cannot help once that provider's quota is gone or it is down.
  // So a primary that yields no usable review, for any reason, is asked once more as the same
  // model on the other provider: Lanes A/B on Command Code through the Lane C slot, Lane C on Go
  // through the Lane A slot. Command Code served Muse 1.3 and Haiku on 2026-10-15, and Go served
  // GPT-6 Luna on 2026-10-19 under the same id.
  assert.deepEqual(fromSource.lanes.map((lane) => lane.primary.cross_provider), [
    { credential_lane: 'C', id: 'meta/muse-spark-1.3-contributor' },
    { credential_lane: 'C', id: 'claude-haiku-5-5' },
    { credential_lane: 'A', id: 'gpt-6-luna' },
  ], `${repository} each primary must name the same model on the other provider`);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.protocol), ['openai-responses', 'anthropic-messages', 'openai-responses']);
  // Go serves GPT-6 Luna only over Responses (Chat Completions returns 400 ModelProtocolUnsupported),
  // and the cross route reuses the model's protocol, so no model-level override may move it back.
  assert.equal(fromSource.lanes[2].primary.protocol ?? fromSource.lanes[2].protocol, 'openai-responses',
    `${repository} GPT-6 Luna must be asked over Responses on both providers`);
  assert.equal(fromSource.lanes[2].primary.max_output_tokens, 65536);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.first_pass?.id ?? null), [null, onAnthropic ? 'claude-sonnet-5-5' : null, null],
    `${repository} only NebulaLab's Lane B has a first pass`);
  // Lane C's unserved resend was dropped: each lane is one request on its own provider, then one on the other.
  assert.ok(fromSource.lanes.every((lane) => lane.resend_unserved === undefined), `${repository} no lane resends on the same provider`);
  // Haiku at max effort spent all 65,536 output tokens thinking on three large NebulaLab PRs; high finished them.
  assert.equal(fromSource.lanes[1].primary.effort, 'high', `${repository} Haiku must stay at high effort`);
  // Calibration took Muse and Hy3 from near-silent to 1-5 findings on large NebulaLab PRs with no
  // high-confidence clean-change noise; on Haiku it only added noise. GPT-6 Luna took over Lane C
  // with Hy3's setting and was measured with it on 2026-10-19.
  assert.deepEqual(fromSource.lanes.flatMap((lane) => [lane.primary, ...lane.fallbacks]).filter((model) => model.reporting_calibration).map((model) => model.id),
    ['muse-spark-1.3-contributor', 'gpt-6-luna'], `${repository} calibration must stay limited to Muse and GPT-6 Luna`);
  assert.ok(fromSource.lanes.every((lane) => [lane.primary, ...lane.fallbacks].every((model) => model.thinking_level === undefined)),
    `${repository} no active lane uses Google thinking`);
  // Every active model must send an explicit output ceiling.
  assert.ok(fromSource.lanes.every((lane) => lane.primary.omit_max_tokens === undefined
    && lane.fallbacks.every((model) => model.omit_max_tokens === undefined)), `${repository} no active lane may silently omit the output ceiling`);
}

const ciCentral = source.loadConfig('TshyGO/ci-central', actionPath);
assert.equal(ciCentral.review_policy.request_timeout_ms, 600000);
assert.equal(ciCentral.lanes[2].advisory, true, 'ci-central Lane C shares a provider quota and must not gate its own PRs');
assert.equal(ciCentral.review_policy.model_budget_ms, 720000);
assert.equal(ciCentral.lanes[1].primary.max_output_tokens, 120000, 'ci-central Lane B must preserve the Haiku output ceiling');

for (const repository of repositories) {
  const config = source.loadConfig(repository, actionPath);
  // Lane C rides a shared quota that can return 429 once exhausted. Every repository keeps it
  // advisory so an empty quota never turns a PR red on its own, and keeps Lanes A and B
  // gating so the review still enforces something.
  assert.equal(config.lanes[2].advisory, true, `${repository} Lane C must stay advisory`);
  assert.ok(config.lanes.slice(0, 2).every((lane) => lane.advisory === undefined), `${repository} Lane A/B must keep gating the job`);
  // Haiku at high effort used up to 47,348 output tokens on a 226K-token PR; 120,000 keeps
  // room for larger changes under its 128K ceiling.
  assert.equal(config.lanes[1].primary.max_output_tokens, 120000, `${repository} Lane B must preserve the Haiku output ceiling`);
  assert.equal(config.lanes[1].request_timeout_ms, 1800000, `${repository} Lane B preserves reasoning with a thirty-minute request ceiling`);
  assert.equal(config.lanes[1].model_budget_ms, 1800000, `${repository} Lane B model budget matches its request ceiling`);
  // Measured 2026-10-15: calibrated Hy3 finished three large NebulaLab PRs in 115-156 s; on
  // 2026-10-19 GPT-6 Luna finished the same three on Go in 68-107 s. Lane C keeps its fifteen
  // minutes, on Command Code and again on Go.
  assert.equal(config.lanes[2].request_timeout_ms, 900000, `${repository} Lane C request budget changed without a measurement behind it`);
  assert.equal(config.lanes[2].model_budget_ms, 900000, `${repository} Lane C model cap matches GPT-6 Luna's fifteen minutes`);
  assert.equal(config.lanes[2].primary.request_timeout_ms, undefined, `${repository} GPT-6 Luna inherits the lane's fifteen-minute window`);
  // Measured 2026-10-14: Haiku finished 71-226K-token NebulaLab PRs in 146-211 s.
  assert.equal(config.lanes[1].primary.request_timeout_ms, 900000, `${repository} Lane B Haiku primary uses a fifteen-minute window`);
  if (anthropicLaneB.has(repository)) {
    // Measured 2026-10-15 through the TW egress: Sonnet 5.5 finished 71-226K-token NebulaLab PRs
    // in 54-174 s. Its fifteen minutes and Haiku's fit the lane's thirty together.
    assert.equal(config.lanes[1].first_pass.request_timeout_ms, 900000, `${repository} the Sonnet first pass uses a fifteen-minute window`);
  }
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
// All registered repositories keep the same two-review quorum.
for (const repository of repositories) {
  const policy = source.loadConfig(repository, actionPath).review_policy;
  const lanes = source.loadConfig(repository, actionPath).lanes;
  assert.equal(policy.min_valid_lanes, 2, `${repository} quorum must stay at the two reviews the required lanes already demanded`);
  assert.ok(policy.min_valid_lanes < lanes.length,
    `${repository} quorum equal to the lane count is the all-lanes rule again, with none of the redundancy`);
  assert.equal(lanes.filter((lane) => !lane.advisory).length, 2,
    `${repository} quorum of 2 assumes two non-advisory lanes; changing that changes what the number means`);
}

// Context budgets are sized per model window. The worst prompt measured on NebulaLab
// (Chinese-heavy diffs) was 2.05 characters per input token; 40,000 characters cover
// the system prompt, coverage manifest and headers. Kimi K2.7 Code shares its window
// with output. An unlisted model fails here until its window is recorded.
const WORST_CHARS_PER_TOKEN = 2;
const inputTokenRoom = {
  'muse-spark-1.3-contributor': 1048576,
  'muse-spark-1.2-contributor': 1048576,
  'claude-haiku-5-5': 1000000,
  'claude-sonnet-5-5': 1000000,
  'glm-5.3': 1000000,
  'kimi-k2.7-code': 262144,
  hy3: 192000,
  // Command Code lists a 262,144-token window for Hy3 and 1M for GLM 5.3 Flash; both count output against it.
  'tencent/hy3-paid': 262144,
  'z-ai/glm-5.3-flash': 1000000,
  // Cross-provider targets, from Command Code's /models context_length.
  'meta/muse-spark-1.3-contributor': 1048576,
  'meta/muse-spark-1.2-contributor': 1048576,
  'moonshotai/Kimi-K2.7-Code': 256000,
  // GPT-6 Luna: a 1M-token window (recorded 2026-10-19). Command Code and Go use the same id, so this
  // one entry bounds both routes; it is counted together with its output, the conservative reading.
  'gpt-6-luna': 1000000,
};
const sharesWindowWithOutput = new Set(['kimi-k2.7-code', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'tencent/hy3-paid', 'z-ai/glm-5.3-flash', 'moonshotai/Kimi-K2.7-Code', 'gpt-6-luna']);
for (const repository of repositories) {
  const config = source.loadConfig(repository, actionPath);
  const policy = config.review_policy;
  assert.equal(policy.diff_char_budget, 260000, `${repository} default diff budget must fit the 256K-window models`);
  assert.deepEqual([policy.issue_char_budget, policy.issue_excerpt_chars, policy.description_char_limit], [60000, 20000, 20000],
    `${repository} issue and description context must not fall back to the old 20K/6K/4K cuts`);
  for (const model of [config.lanes[0].primary, ...config.lanes[0].fallbacks]) {
    assert.equal(model.max_output_tokens, 65536, `${repository} ${model.id} must not truncate its report at the old 16K ceiling`);
  }
  for (const model of [config.lanes[0].primary, config.lanes[1].primary]) {
    assert.equal(model.diff_char_budget, 1200000, `${repository} ${model.id} must use its 1M-token window for large changes`);
  }
  assert.deepEqual([config.lanes[0].request_timeout_ms, config.lanes[0].model_budget_ms], [600000, 600000],
    `${repository} Lane A needs a longer window for 1M-token inputs`);
  const promptChars = policy.issue_char_budget + policy.description_char_limit + 40000;
  for (const lane of config.lanes) {
    for (const model of [...(lane.first_pass ? [lane.first_pass] : []), lane.primary, ...lane.fallbacks]) {
      const diffChars = model.diff_char_budget ?? policy.diff_char_budget;
      const sharedOutput = sharesWindowWithOutput.has(model.id) ? model.max_output_tokens : 0;
      assert.ok((diffChars + promptChars) / WORST_CHARS_PER_TOKEN + sharedOutput <= inputTokenRoom[model.id],
        `${repository} Lane ${lane.id} ${model.id} context budget can exceed its model window`);
      // The cross-provider fallback resends the same prompt, so it must fit the target model's window too.
      const crossId = model.cross_provider?.id;
      if (crossId) {
        const crossOutput = sharesWindowWithOutput.has(crossId) ? model.max_output_tokens : 0;
        assert.ok((diffChars + promptChars) / WORST_CHARS_PER_TOKEN + crossOutput <= inputTokenRoom[crossId],
          `${repository} Lane ${lane.id} ${model.id} cross-provider ${crossId} context budget can exceed its model window`);
      }
    }
  }
}

const nebula = source.loadConfig('TshyGO/NebulaLab', actionPath);
assert.equal(nebula.lanes[0].provider, 'opencode-go');
assert.equal(nebula.lanes[1].provider, 'anthropic');
assert.equal(nebula.lanes[2].provider, 'command-code');
assert.deepEqual(nebula.lanes.map((lane) => lane.protocol), ['openai-responses', 'anthropic-messages', 'openai-responses']);
assert.deepEqual(nebula.lanes.map((lane) => lane.primary.id), ['muse-spark-1.3-contributor', 'claude-haiku-5-5', 'gpt-6-luna']);
assert.equal(nebula.lanes[0].primary.context_profile, 'full');
// Sonnet 5.5 found real defects Haiku missed and none of Haiku's false P1s on NebulaLab
// #1133/#1237/#1241 (2026-10-15), at 0.4x Haiku's output. A first review sees a median 97% of
// the final diff, so it runs once per PR and Haiku reviews the later commits.
assert.deepEqual(nebula.lanes[1].first_pass, {
  id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', request_timeout_ms: 900000, context_profile: 'full',
  max_output_tokens: 120000, effort: 'high', diff_char_budget: 1200000,
}, 'NebulaLab Lane B first pass changed without a measurement behind it');
assert.equal(nebula.lanes[1].primary.reporting_calibration, undefined, 'Haiku stays uncalibrated');
// Two Anthropic accounts share NebulaLab's Lane B slot, one key per line (2026-10-23). PRs are
// split by number in proportion to their monthly budgets: $200 for the first, $100 for the second.
assert.deepEqual(nebula.lanes[1].key_weights, [2, 1], 'NebulaLab Lane B splits PRs 2:1 between its two Anthropic keys');
for (const repository of repositories) {
  const config = source.loadConfig(repository, actionPath);
  assert.ok(config.lanes.every((lane) => lane.key_weights === undefined || (repository === 'TshyGO/NebulaLab' && lane.id === 'B')),
    `${repository} only NebulaLab's Lane B weighs several keys`);
}
for (const loader of [source, bundled]) {
  for (const weights of [[2], [], [2, 0], [2, 1.5], [2, '1'], [1, 2, 3, 4, 5], [101, 1], '2:1']) {
    const config = structuredClone(nebula);
    config.lanes[1].key_weights = weights;
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), /lanes\[1\]\.key_weights must be an array of 2 to 4 integers from 1 to 100/,
      `key_weights ${JSON.stringify(weights)} must be rejected`);
  }
}

// A first pass is validated like any lane model, stays on the lane's own provider, and cannot
// share an id with the models that follow it.
for (const loader of [source, bundled]) {
  for (const [mutate, message] of [
    [(config) => { config.lanes[1].first_pass.cross_provider = { credential_lane: 'C', id: 'claude-sonnet-5-5' }; }, /first_pass cannot configure cross_provider/],
    [(config) => { config.lanes[1].first_pass.id = config.lanes[1].primary.id; }, /duplicate first-pass\/primary\/fallback/],
    [(config) => { config.lanes[1].first_pass.effort = 'extreme'; }, /first_pass\.effort is not supported/],
    [(config) => { config.lanes[1].first_pass.temperature = 0.2; }, /first_pass\.temperature is not supported by anthropic-messages/],
    [(config) => { config.lanes[1].first_pass.max_output_tokens = 0; }, /first_pass\.max_output_tokens must be a positive integer/],
    [(config) => { config.lanes[1].first_pass = 'claude-sonnet-5-5'; }, /first_pass must be an object/],
  ]) {
    const config = structuredClone(nebula);
    mutate(config);
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), message);
  }
}

for (const loader of [source, bundled]) {
  const badAttempts = structuredClone(nebula);
  badAttempts.review_policy.max_attempts = 3;
  assert.throws(() => loader.validateConfig(badAttempts, 'TshyGO/NebulaLab'), /max_attempts must be 1/);
  // The engine still accepts one different-model fallback per lane, but never a second.
  const extraFallback = structuredClone(nebula);
  const { cross_provider: _, ...sameLaneModel } = extraFallback.lanes[0].primary;
  extraFallback.lanes[0].fallbacks.push({ ...sameLaneModel, id: 'second-model' }, { ...sameLaneModel, id: 'third-model' });
  assert.throws(() => loader.validateConfig(extraFallback, 'TshyGO/NebulaLab'), /at most one fallback/);
}
for (const loader of [source, bundled]) {
  for (const invalid of [0, -1, 1.5, '300000', null]) {
    const config = structuredClone(nebula);
    config.lanes[2].primary.request_timeout_ms = invalid;
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), /request_timeout_ms must be a positive integer/);
  }
}
const duplicateAcrossLanes = structuredClone(nebula);
duplicateAcrossLanes.lanes[1].primary.id = duplicateAcrossLanes.lanes[0].primary.id;
assert.doesNotThrow(() => source.validateConfig(duplicateAcrossLanes, 'TshyGO/NebulaLab'), 'routing must be lane-scoped, not keyed globally by model id');

const duplicateInsideLane = structuredClone(nebula);
duplicateInsideLane.lanes[0].fallbacks.push({ ...duplicateInsideLane.lanes[0].primary, cross_provider: undefined });
assert.throws(() => source.validateConfig(duplicateInsideLane, 'TshyGO/NebulaLab'), /duplicate first-pass\/primary\/fallback/);

const invalidThinkingLevel = structuredClone(nebula);
invalidThinkingLevel.lanes[2].protocol = 'google-generate-content';
delete invalidThinkingLevel.lanes[2].primary.cross_provider;
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
delete googleOmitMaxTokens.lanes[2].primary.cross_provider;
googleOmitMaxTokens.lanes[2].primary.omit_max_tokens = true;
assert.throws(() => source.validateConfig(googleOmitMaxTokens, 'TshyGO/NebulaLab'), /omit_max_tokens is only supported by openai-chat-completions/);
// Lane C's Responses request always carries its output ceiling; the flag cannot drop it there either.
const responsesOmitMaxTokens = structuredClone(nebula);
responsesOmitMaxTokens.lanes[2].primary.omit_max_tokens = true;
assert.throws(() => source.validateConfig(responsesOmitMaxTokens, 'TshyGO/NebulaLab'), /omit_max_tokens is only supported by openai-chat-completions/);

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

// The cross-provider fallback sends a review to another lane's provider, so its shape is strict.
for (const loader of [source, bundled]) {
  for (const [mutate, message] of [
    [(config) => { config.lanes[0].primary.cross_provider.credential_lane = 'A'; }, /must name another configured lane/],
    [(config) => { config.lanes[0].primary.cross_provider.credential_lane = 'D'; }, /must name another configured lane/],
    [(config) => { config.lanes[1].provider = 'opencode-go'; config.lanes[1].primary.cross_provider.credential_lane = 'A'; }, /provider other than the lane's own/],
    [(config) => { config.lanes[0].primary.cross_provider.id = ' '; }, /cross_provider\.id must be a non-empty string/],
    [(config) => { config.lanes[0].primary.cross_provider.provider = 'other'; }, /only credential_lane and id/],
    [(config) => { config.lanes[0].primary.cross_provider = 'C'; }, /only credential_lane and id/],
    [(config) => { config.lanes[0].protocol = 'google-generate-content'; }, /not supported by google-generate-content/],
    // The quota-only overflow it replaced must not be ignored silently in a stale config.
    [(config) => { config.lanes[0].primary.quota_overflow = { credential_lane: 'C', id: 'meta/muse-spark-1.3-contributor' }; }, /quota_overflow was replaced by cross_provider/],
  ]) {
    const config = structuredClone(nebula);
    mutate(config);
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), message);
  }
  // Only the one request crosses, never the target lane's own chain, so lanes may name each
  // other (A and C already do) and may target a lane that crosses too.
  const towardAnthropic = structuredClone(nebula);
  towardAnthropic.lanes[0].primary.cross_provider.credential_lane = 'B';
  assert.doesNotThrow(() => loader.validateConfig(towardAnthropic, 'TshyGO/NebulaLab'));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-'));
const output = path.join(tmp, 'output.txt');
source.run({ INPUT_REPOSITORY: 'TshyGO/NebulaLab', GITHUB_ACTION_PATH: actionPath, GITHUB_OUTPUT: output });
const emitted = fs.readFileSync(output, 'utf8').trim();
assert.ok(emitted.startsWith('config={'));
assert.deepEqual(JSON.parse(emitted.slice('config='.length)), nebula);

assert.throws(() => source.loadConfig('TshyGO/Unknown', actionPath), /No central PR review config/);
assert.throws(() => source.configFileName('../invalid'), /Invalid repository identifier/);

console.log('ok   central repository config resolver');
