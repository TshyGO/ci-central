'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_PROTOCOLS = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-generate-content']);
const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ALLOWED_LANES = new Set(['A', 'B', 'C']);

function configFileName(repository) {
  const parts = (repository || '').split('/');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')
    || parts.some((part) => part === '.' || part === '..' || part.includes('..'))) {
    throw new Error(`Invalid repository identifier: ${repository || '<empty>'}`);
  }
  return `${repository.replace('/', '__')}.json`;
}

function validateModel(model, location) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error(`${location} must be an object.`);
  }
  if (typeof model.id !== 'string' || !model.id.trim()) {
    throw new Error(`${location}.id must be a non-empty string.`);
  }
  if (typeof model.label !== 'string' || !model.label.trim()) {
    throw new Error(`${location}.label must be a non-empty string.`);
  }
  if (!['full', 'kimi-k3-throttled'].includes(model.context_profile || 'full')) {
    throw new Error(`${location}.context_profile is not supported.`);
  }
  if (!Number.isInteger(model.max_output_tokens) || model.max_output_tokens < 1) {
    throw new Error(`${location}.max_output_tokens must be a positive integer.`);
  }
  if (model.request_timeout_ms !== undefined && (!Number.isInteger(model.request_timeout_ms) || model.request_timeout_ms < 1)) {
    throw new Error(`${location}.request_timeout_ms must be a positive integer when configured.`);
  }
  if (model.omit_max_tokens !== undefined && typeof model.omit_max_tokens !== 'boolean') {
    throw new Error(`${location}.omit_max_tokens must be a boolean.`);
  }
  // Context windows differ by model: a 1M-token model can take far more of a large
  // change than a 256K one, so the patch budget may be raised per model.
  if (model.diff_char_budget !== undefined && (!Number.isInteger(model.diff_char_budget) || model.diff_char_budget < 1)) {
    throw new Error(`${location}.diff_char_budget must be a positive integer when configured.`);
  }
  if (model.reporting_calibration !== undefined && typeof model.reporting_calibration !== 'boolean') {
    throw new Error(`${location}.reporting_calibration must be a boolean.`);
  }
  // A fallback may speak a different protocol than its lane primary; it still uses the lane's key.
  if (model.protocol !== undefined && !ALLOWED_PROTOCOLS.has(model.protocol)) {
    throw new Error(`${location}.protocol is not supported.`);
  }
}

// The one cross-provider path: a plan quota covers the whole provider account, so when it is
// exhausted the same model may be asked once through the provider behind another lane's fixed
// secret slot. It stays this lane's review, by the same model; nothing else crosses providers.
function validateQuotaOverflow(config, lane, model, protocol, location) {
  const overflow = model.quota_overflow;
  if (!overflow || typeof overflow !== 'object' || Array.isArray(overflow)
    || Object.keys(overflow).some((key) => !['credential_lane', 'id'].includes(key))) {
    throw new Error(`${location}.quota_overflow must be an object with only credential_lane and id.`);
  }
  if (typeof overflow.id !== 'string' || !overflow.id.trim()) {
    throw new Error(`${location}.quota_overflow.id must be a non-empty string.`);
  }
  const target = config.lanes.find((candidate) => candidate?.id === overflow.credential_lane);
  if (!target || overflow.credential_lane === lane.id) {
    throw new Error(`${location}.quota_overflow.credential_lane must name another configured lane.`);
  }
  if (typeof target.provider !== 'string' || target.provider === lane.provider) {
    throw new Error(`${location}.quota_overflow must use a provider other than the lane's own; a quota covers the whole provider.`);
  }
  if (protocol === 'google-generate-content') {
    throw new Error(`${location}.quota_overflow is not supported by google-generate-content.`);
  }
  if ([target.primary, ...(Array.isArray(target.fallbacks) ? target.fallbacks : [])].some((candidate) => candidate?.quota_overflow !== undefined)) {
    throw new Error(`${location}.quota_overflow cannot target a lane that overflows itself.`);
  }
}

function validateConfig(config, repository) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Repository config must be a JSON object.');
  }
  if (config.schema_version !== 1) throw new Error('Unsupported repository config schema_version.');
  if (config.repository !== repository) {
    throw new Error(`Config repository mismatch: expected ${repository}, found ${config.repository || '<empty>'}.`);
  }
  if (!config.review_policy || typeof config.review_policy.system_prompt !== 'string' || !config.review_policy.system_prompt.trim()) {
    throw new Error('review_policy.system_prompt must be a non-empty string.');
  }
  if (config.review_policy.max_attempts !== 1) throw new Error('review_policy.max_attempts must be 1; model retries are disabled.');
  for (const field of ['diff_char_budget', 'request_timeout_ms', 'model_budget_ms', 'max_attempts']) {
    if (!Number.isInteger(config.review_policy[field]) || config.review_policy[field] < 1) {
      throw new Error(`review_policy.${field} must be a positive integer.`);
    }
  }
  for (const field of ['issue_char_budget', 'issue_excerpt_chars', 'description_char_limit']) {
    const value = config.review_policy[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`review_policy.${field} must be a positive integer when configured.`);
    }
  }
  if (!Array.isArray(config.lanes) || config.lanes.length === 0) {
    throw new Error('Config must contain at least one lane.');
  }

  const minimum = config.review_policy.min_valid_lanes;
  if (minimum !== undefined && (!Number.isInteger(minimum) || minimum < 1 || minimum > config.lanes.length)) {
    throw new Error(`review_policy.min_valid_lanes must be an integer between 1 and the ${config.lanes.length} configured lane(s).`);
  }
  const laneIds = new Set();
  for (const [index, lane] of config.lanes.entries()) {
    const location = `lanes[${index}]`;
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) throw new Error(`${location} must be an object.`);
    if (!ALLOWED_LANES.has(lane.id)) throw new Error(`${location}.id must be A, B, or C.`);
    if (laneIds.has(lane.id)) throw new Error(`Lane ${lane.id} is configured more than once.`);
    laneIds.add(lane.id);
    if (typeof lane.provider !== 'string' || !lane.provider.trim()) throw new Error(`${location}.provider must be non-empty.`);
    if (lane.advisory !== undefined && typeof lane.advisory !== 'boolean') throw new Error(`${location}.advisory must be a boolean.`);
    if (lane.resend_unserved !== undefined && typeof lane.resend_unserved !== 'boolean') {
      throw new Error(`${location}.resend_unserved must be a boolean.`);
    }
    if (!ALLOWED_PROTOCOLS.has(lane.protocol)) throw new Error(`${location}.protocol is not supported.`);
    for (const field of ['request_timeout_ms', 'model_budget_ms']) {
      if (lane[field] !== undefined && (!Number.isInteger(lane[field]) || lane[field] < 1)) {
        throw new Error(`${location}.${field} must be a positive integer when configured.`);
      }
    }
    if (lane.request_timeout_ms !== undefined && lane.model_budget_ms !== undefined
      && lane.model_budget_ms < lane.request_timeout_ms) {
      throw new Error(`${location}.model_budget_ms must be greater than or equal to request_timeout_ms.`);
    }
    validateModel(lane.primary, `${location}.primary`);
    if (!Array.isArray(lane.fallbacks)) throw new Error(`${location}.fallbacks must be an array.`);
    if (lane.fallbacks.length > 1) throw new Error(`${location} supports at most one fallback.`);
    lane.fallbacks.forEach((model, modelIndex) => validateModel(model, `${location}.fallbacks[${modelIndex}]`));
    for (const [modelIndex, model] of [lane.primary, ...lane.fallbacks].entries()) {
      const modelLocation = modelIndex === 0 ? `${location}.primary` : `${location}.fallbacks[${modelIndex - 1}]`;
      const protocol = model.protocol ?? lane.protocol;
      if (model.omit_max_tokens && protocol !== 'openai-chat-completions') {
        throw new Error(`${modelLocation}.omit_max_tokens is only supported by openai-chat-completions.`);
      }
      if (model.effort !== undefined) {
        if (protocol !== 'anthropic-messages') throw new Error(`${modelLocation}.effort is only supported by anthropic-messages.`);
        if (!ANTHROPIC_EFFORTS.has(model.effort)) throw new Error(`${modelLocation}.effort is not supported.`);
      }
      // Claude models with adaptive thinking reject non-default sampling values.
      if (model.temperature !== undefined && protocol === 'anthropic-messages') {
        throw new Error(`${modelLocation}.temperature is not supported by anthropic-messages.`);
      }
      if (model.quota_overflow !== undefined) validateQuotaOverflow(config, lane, model, protocol, modelLocation);
      if (model.thinking_level === undefined) continue;
      if (protocol !== 'google-generate-content') {
        throw new Error(`${modelLocation}.thinking_level is only supported by google-generate-content.`);
      }
      if (!['minimal', 'low', 'medium', 'high'].includes(model.thinking_level)) {
        throw new Error(`${modelLocation}.thinking_level is not supported.`);
      }
    }
    const ids = [lane.primary.id, ...lane.fallbacks.map((model) => model.id)];
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Lane ${lane.id} contains a duplicate primary/fallback model id.`);
    }
  }
  // Advisory lanes never gate a review, so a config where every lane is advisory has no
  // enforcement left at all. Reject it here rather than let it degrade silently.
  if (config.lanes.every((lane) => lane.advisory === true)) {
    throw new Error('At least one lane must be required; every configured lane is advisory.');
  }
  return config;
}

function loadConfig(repository, actionPath) {
  const file = path.join(actionPath, 'config', 'repositories', configFileName(repository));
  if (!fs.existsSync(file)) throw new Error(`No central PR review config exists for ${repository}.`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${path.basename(file)}: ${error.message}`);
  }
  return validateConfig(parsed, repository);
}

function setOutput(name, value, outputPath) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set.');
  fs.appendFileSync(outputPath, `${name}=${value}\n`, 'utf8');
}

function run(env = process.env) {
  const repository = env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY;
  const actionPath = env.GITHUB_ACTION_PATH || path.resolve(__dirname, '..');
  const config = loadConfig(repository, actionPath);
  setOutput('config', JSON.stringify(config), env.GITHUB_OUTPUT);
  process.stdout.write(`Resolved central PR review config for ${repository}: ${config.lanes.length} lane(s).\n`);
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { configFileName, loadConfig, validateConfig, run };
