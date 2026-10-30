import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { readCredentials } = createRequire(import.meta.url)('../review-action/src/review-credentials.js');
const lanes = [{ id: 'B', provider: 'anthropic' },
  { id: 'C', provider: 'openai', credential_providers: ['openai', 'command-code'] }];
const bundle = (providers) => JSON.stringify({ schema_version: 1, providers });
const env = { LANE_B_KEY: 'anthropic-1\nanthropic-2', LANE_B_API_BASE: 'https://anthropic.example/v1/',
  LANE_C_KEY: bundle({ openai: 'openai-key', 'command-code': 'cc-key' }),
  LANE_C_API_BASE: bundle({ openai: 'https://openai.example/v1', 'command-code': 'https://cc.example/v1' }) };
test('provider credentials stay paired, nested keys are masked, legacy accounts are preserved', () => {
  const masked = [];
  const get = readCredentials(lanes, env, (key) => masked.push(key));
  assert.deepEqual(get('B', 'anthropic').keys, ['anthropic-1', 'anthropic-2']);
  assert.equal(get('C', 'openai').apiKey, 'openai-key');
  assert.equal(get('C', 'command-code').baseUrl, 'https://cc.example/v1');
  assert.equal(get('C', 'anthropic'), undefined);
  assert.deepEqual(masked.sort(), ['anthropic-1', 'anthropic-2', 'cc-key', 'openai-key']);
});
test('malformed, partial, mismatched and unconfigured bundles fail without echoing input', () => {
  for (const change of [
    { LANE_C_KEY: '{secret-never-print' },
    { LANE_C_KEY: 'secret-never-print' },
    { LANE_C_API_BASE: '' },
    { LANE_C_KEY: bundle({ openai: 'secret-never-print' }) },
    { LANE_C_API_BASE: bundle({ openai: 'https://wrong.example?key=secret-never-print', 'command-code': 'https://cc.example' }) },
    { LANE_C_KEY: JSON.stringify({ schema_version: 2, providers: { openai: 'secret-never-print', 'command-code': 'cc-key' } }) },
  ]) {
    assert.throws(() => readCredentials(lanes, { ...env, ...change }), (error) =>
      error.message.includes('Lane C requires matching') && !error.message.includes('secret-never-print'));
  }
  assert.throws(() => readCredentials([{ id: 'C', provider: 'command-code' }], env), /does not configure provider credential bundles/);
});
test('an absent bundle supplies no provider instead of borrowing another provider key', () => {
  const get = readCredentials(lanes, { ...env, LANE_C_KEY: '', LANE_C_API_BASE: '' });
  assert.equal(get('C', 'openai').apiKey, undefined);
  assert.equal(get('C', 'command-code').apiKey, undefined);
});
