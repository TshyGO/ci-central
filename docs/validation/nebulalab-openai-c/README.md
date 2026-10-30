# NebulaLab OpenAI C validation - 2026-10-30

## Code and remote tests

The ci-build VM (Node 24.21.0) runs the config tests, workflow/runner contract tests,
and complete Node test set. The review-credentials suite adds provider pairing,
partial-bundle masking, per-slot failure isolation and legacy-account coverage.
Three deployed bundles are rebuilt remotely and byte-compared with the checked-in files.
Only `TshyGO__NebulaLab.json` changes repository policy; all other repository JSON files
retain their original bytes. The final PR head receives its own GitHub Test and AI round.

## Actual runner boundary

The ci-review VM uses its runner-provided Node 24 and the production bundled SDK.
GitHub PR/context APIs are simulated; acceptance publishes no real GitHub comments.
The fixture changes its patch between heads, so unchanged-diff reuse cannot hide the
Luna request. Every result identifies real requests, injected failures and synthetic lanes.
The acceptance report records SHA-256 hashes of both deployed bundles.

Observed real calls:

| Path | Result |
| --- | --- |
| Terra first pass on OpenAI, high reasoning | HTTP 200, valid report and first-pass marker |
| Luna subsequent head on OpenAI, medium reasoning | HTTP 200, valid report, Terra marker preserved |
| Injected OpenAI outage, Luna on Command Code | Request reaches CC, HTTP 401 UNAUTHORIZED; not accepted |
| Independent CC Luna / Muse / Haiku SDK probes | All return HTTP 401 |
| Independent Node fetch, same CC key and Provider API | HTTP 401 UNAUTHORIZED |

The CC key was not changed. Shape checks show one key, no Bearer prefix, no internal
whitespace or non-ASCII characters. These observations do not establish that the key
itself is invalid: the existing CI request also returns 401, and the account/provider
authentication cause remains unresolved. Do not rotate the key based on this report alone.
The CC probe endpoint is the repository-documented and current provider-documented
`https://api.commandcode.ai/provider/v1`.

The existing PR run provides a separate control: run
[41060773017](https://github.com/ptjworks/ci-central/actions/runs/41060773017), head
`0a7689d8f9d344598744c60281ffcbef78d6a602`, records CC Luna HTTP 401 at
2026-10-30 13:08:43 UTC, then a valid Go Luna response. That run uses ci-central's
unchanged own C policy, not NebulaLab's new OpenAI policy.

## Approved proxy prerequisite

The existing Mihomo policy rejected OpenAI via `MATCH,REJECT`. An isolated stage
proved the missing rule; the user then explicitly authorized the production change.
Only `api.openai.com -> existing TW-DEDICATED` was added. All other config fields,
nodes and original domain rules were preserved. No runner service was restarted.

The persistent updater now includes `api.openai.com` in `TW_DOMAIN_SUFFIXES`.
Its SHA-256 is `2438ebd03205395a945c075e7cb2a85af43f7be5f74d6a95d48c6d483e0617c2`.
Original updater and encrypted configuration are backed up under
`/srv/nebulalab-ops/services/mihomo/backups/openai-c-20261030T131846Z`.
Production checks: OpenAI unauthenticated request 401 (TLS reachable), Go 200,
Anthropic trace `loc=TW`; all 15 existing proxy policy tests pass remotely.

## Review decisions

- Fix masking immediately after key-bundle parsing, even if base parsing then fails.
- Disable only an invalid credential slot; independent lanes still run and can reach 2/3.
- Restrict Go direct-egress exemptions to Go routes; test an OpenAI route sharing a Go model ID.
- Label the synthetic C response in the A/B-isolation acceptance case explicitly.
- Keep account-state ownership unchanged: only own-provider requests read/write a lane's
  spent-key sets. Cross routes use the target profile's PR-number key and ignore spent-key
  sets by design; a new two-profile test covers OpenAI failures with CC key index zero.
- Missing-provider lookup cannot reach `pickedKey`: config validation requires a declared
  profile and `crossRoute` checks its credentials before key selection. Malformed bundles
  disable both profiles and generate diagnostics instead of invoking key selection.

## Deployment boundary

No NebulaLab caller pin or GitHub Secret was changed, and no PR was merged. Production
cutover must follow the migration document after central merge and successful CC acceptance.
Passing tests and OpenAI primary acceptance do not substitute for a successful CC fallback.
