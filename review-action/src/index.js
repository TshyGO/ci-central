'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_PROTOCOLS = new Set(['openai-chat-completions', 'google-generate-content']);
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
  if (model.omit_max_tokens !== undefined && typeof model.omit_max_tokens !== 'boolean') {
    throw new Error(`${location}.omit_max_tokens must be a boolean.`);
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
  for (const field of ['diff_char_budget', 'request_timeout_ms', 'model_budget_ms', 'max_attempts']) {
    if (!Number.isInteger(config.review_policy[field]) || config.review_policy[field] < 1) {
      throw new Error(`review_policy.${field} must be a positive integer.`);
    }
  }
  if (!Array.isArray(config.lanes) || config.lanes.length === 0) {
    throw new Error('Config must contain at least one lane.');
  }

  const laneIds = new Set();
  for (const [index, lane] of config.lanes.entries()) {
    const location = `lanes[${index}]`;
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) throw new Error(`${location} must be an object.`);
    if (!ALLOWED_LANES.has(lane.id)) throw new Error(`${location}.id must be A, B, or C.`);
    if (laneIds.has(lane.id)) throw new Error(`Lane ${lane.id} is configured more than once.`);
    laneIds.add(lane.id);
    if (typeof lane.provider !== 'string' || !lane.provider.trim()) throw new Error(`${location}.provider must be non-empty.`);
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
    lane.fallbacks.forEach((model, modelIndex) => validateModel(model, `${location}.fallbacks[${modelIndex}]`));
    for (const [modelIndex, model] of [lane.primary, ...lane.fallbacks].entries()) {
      const modelLocation = modelIndex === 0 ? `${location}.primary` : `${location}.fallbacks[${modelIndex - 1}]`;
      if (model.omit_max_tokens && lane.protocol !== 'openai-chat-completions') {
        throw new Error(`${modelLocation}.omit_max_tokens is only supported by openai-chat-completions.`);
      }
      if (model.thinking_level === undefined) continue;
      if (lane.protocol !== 'google-generate-content') {
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
