# NebulaLab Lane C migration

Only `TshyGO/NebulaLab` opts into provider bundles. Other repository configurations
and their plain secrets keep the previous behavior.

| Lane | First pass | Regular review | Same-model cross-provider route |
| --- | --- | --- | --- |
| A | Muse Spark 1.3 Contributor on Go | Same | CC through C / command-code |
| B | Sonnet 5.5 on Anthropic | Haiku 5.5 on Anthropic | Haiku through C / command-code |
| C | GPT-6.1 Terra on OpenAI, high reasoning | GPT-6 Luna on OpenAI, medium reasoning | Luna through C / command-code |

First-pass models never cross providers. Failure enters the regular model chain in
the same round. Only a valid first pass records completion; otherwise the next push
tries again. Success ends the lane's round, and its report stays folded in later comments.
Existing PRs without a C first-pass marker receive Terra at their next review.

The 2-of-3 quorum, deadlines, diff budgets, and Anthropic 2:1 account selection stay
unchanged. Self-hosted OpenAI calls use the approved review proxy. Anthropic retains
the dedicated Taiwan path. There is no third Go hop after Luna on CC.

## Fixed secret interface

The six GitHub secret names stay fixed. For NebulaLab only, both C secrets become
versioned JSON. These examples contain placeholders, never real keys.

`PR_AGENT_LANE_C_KEY`:
```json
{"schema_version":1,"providers":{"openai":"<OpenAI key>","command-code":"<existing CC key>"}}
```

`PR_AGENT_LANE_C_API_BASE`:
```json
{"schema_version":1,"providers":{"openai":"https://api.openai.com/v1","command-code":"<existing CC HTTPS base>"}}
```

Both provider maps must exactly match `credential_providers`. Malformed or mismatched
bundles disable C and its cross routes without echoing input; A/B can still review. Every parsed nested key is masked before
requests or diagnostics. A provider selects both its key and endpoint. Legacy multiline
keys still mean separate accounts of one provider; bundles cannot use `key_weights`.
NebulaLab B stays plain and weighted 2:1.

## Production cutover

Never replace live C secrets while a caller can still run the old parser. This PR does
not write production secrets or pin callers to an unmerged central commit.

1. Merge the central change after remote Test and AI review cover its exact final head.
2. Prepare the NebulaLab caller PR with `uses`, `central_workflow_sha`, and the applicable
   `PR_REVIEW_CENTRAL_SHA` constant on that same merged 40-character SHA. Preserve the
   independent Claude workflow, permissions, and six secret mappings.
3. Drain or migrate active/queued runs and open PR caller/merge refs before they can
   receive the new format. Coordinate the caller/secret cutover so no review starts
   between the two secret writes.
4. Trigger a fresh event; rerunning an old run keeps its old pin. Verify actual Terra
   first-pass evidence, Luna on the next head, correct provider labels and A/B CC routes.

Retain original CC credentials in 1Password. Rollback must restore a compatible caller
and the original plain C secret pair together. Never put values in files or logs.

## Key rotation

`scripts/set-lane-secret.ps1` writes plain keys only and refuses NebulaLab's C slot. When
the Command Code key changes, update both sides: the plain C key on the other callers
(pass them with `-Repositories`), and the `command-code` entry of NebulaLab's C key bundle,
rewritten whole with the current OpenAI key from 1Password. Every Command Code request from a
repository left on the old key gets 401: a plain caller's C crosses to Go with no sign in the
comment status, and NebulaLab loses C's Luna fallback and the A/B cross routes.

## Validation boundary

Contract tests cover legacy slots, provider pairing, fail-closed parsing, masking,
first-pass persistence, one Luna fallback, and unchanged A/B routes. Actual-runner
acceptance must use the production SDK and proxy and obtain real final output from
both OpenAI models and CC. Injected failures prove routing, not a real provider outage.
