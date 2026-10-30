'use strict';

// The six caller secrets stay fixed. A configured slot may contain a versioned,
// provider-named bundle; plain slots retain their existing multi-account format.
function readCredentials(lanes, env, maskSecret = () => {}) {
  const slots = new Map();
  const keysOf = (value) => String(value || '').split(/\r?\n/).map((key) => key.trim()).filter(Boolean);
  const credential = (key, base) => {
    const keys = keysOf(key);
    for (const value of keys) maskSecret(value);
    return { apiKey: keys[0], keys, baseUrl: String(base || '').replace(/\/$/, '') };
  };
  const envelope = (raw, providers) => {
    const value = JSON.parse(raw);
    if (!value || value.schema_version !== 1 || Object.keys(value).sort().join(',') !== 'providers,schema_version'
      || !value.providers || Array.isArray(value.providers)
      || Object.keys(value.providers).sort().join(',') !== [...providers].sort().join(',')
      || providers.some((provider) => typeof value.providers[provider] !== 'string' || !value.providers[provider].trim())) {
      throw new Error('Invalid credential bundle');
    }
    return value.providers;
  };
  for (const lane of lanes) {
    const key = env[`LANE_${lane.id}_KEY`] || '';
    const base = env[`LANE_${lane.id}_API_BASE`] || '';
    const profiles = new Map();
    if (lane.credential_providers) {
      if (!key && !base) {
        for (const provider of lane.credential_providers) profiles.set(provider, credential('', ''));
      } else {
        try {
          const keys = envelope(key, lane.credential_providers);
          const bases = envelope(base, lane.credential_providers);
          // Register every nested key before any request or diagnostic can expose it.
          for (const provider of lane.credential_providers) profiles.set(provider, credential(keys[provider], bases[provider]));
          for (const { baseUrl } of profiles.values()) {
            const url = new URL(baseUrl);
            if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid endpoint');
          }
        } catch {
          // Never include JSON parser errors: they may quote the secret input.
          throw new Error(`Lane ${lane.id} requires matching version-1 provider credential bundles; no requests were sent.`);
        }
      }
    } else {
      if (key.trim().startsWith('{') || base.trim().startsWith('{')) {
        throw new Error(`Lane ${lane.id} does not configure provider credential bundles; no requests were sent.`);
      }
      profiles.set(lane.provider, credential(key, base));
    }
    slots.set(lane.id, profiles);
  }
  return (laneId, provider) => slots.get(laneId)?.get(provider);
}

module.exports = { readCredentials };
