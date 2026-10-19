'use strict';

// Incremental re-review and repeat-review skipping. A lane comment records, in one runner-written
// header line, what its last valid review saw: the head, the identity of the PR's own diff, and
// the findings it raised. The next run compares the PR's own diff with that record: unchanged
// means no model call, a small change means a review of only that change plus the previous
// findings, and anything else means the full review the lane always did.

const { createHash } = require('node:crypto');

const STATE_VERSION = 1;
const STATE_LINE = /^<!-- ai-pr-review-state:v1 (\{.*\}) -->$/;
const STATE_LIMIT = 24000;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MODEL_ID = /^[\w.:@/+-]{1,200}$/;
const MAX_STATE_FINDINGS = 100;
// 14 bytes per file (6 of the path hash, 8 of the change hash); about 11 KB of state at this cap.
const MAX_FILE_HASHES = 600;
const FILE_HASH_BYTES = 14;
// What a stored finding may hold when read back, and what it is cut to when space runs out.
const FINDING_LIMITS = { title: 180, trigger: 400, impact: 400, evidence: 800, suggestion: 400, note: 600 };
const COMPACT_LIMITS = { title: 120, trigger: 160, impact: 160, evidence: 240, suggestion: 160, note: 200 };
const MEMBER_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// <, > and the two JSON-legal line separators (U+2028, U+2029).
const UNSAFE_IN_COMMENT = new RegExp(`[<>${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const digest = (text) => createHash('sha256').update(text).digest();
const clip = (text, limit) => String(text ?? '').slice(0, limit);

// One PR-own file change as git patch-id sees it: the hunk headers (line numbers and section
// names) are dropped and every added, removed and context line is kept verbatim, whitespace
// included. Merging the base branch moves line numbers but leaves this unchanged; any edit to
// the PR's own lines, or to the lines around them, changes it. A file without a text patch is
// identified by its blob.
function fileIdentity(file) {
  const patch = typeof file.patch === 'string'
    ? file.patch.split('\n').filter((line) => !line.startsWith('@@')).join('\n') : null;
  return JSON.stringify([file.filename, file.status, file.previous_filename ?? '', patch ?? `blob:${file.sha ?? ''}`]);
}

function diffIdentity(files) {
  const entries = files.map((file) => [file.filename, fileIdentity(file)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const fingerprint = digest(entries.map(([, identity]) => identity).join('\n')).toString('hex');
  const perFile = new Map(entries.map(([name, identity]) => [name, digest(identity).subarray(0, 8).toString('hex')]));
  const packed = entries.length > MAX_FILE_HASHES ? null : Buffer.concat(entries.map(([name, identity]) =>
    Buffer.concat([digest(name).subarray(0, 6), digest(identity).subarray(0, 8)]))).toString('base64url');
  return { fingerprint, perFile, files: packed };
}

// Files whose PR-own change differs from the recorded review, by path. Files the PR no longer
// changes are only counted: the record keeps path hashes, not paths.
function changedSince(packed, current) {
  if (typeof packed !== 'string') return null;
  const bytes = Buffer.from(packed, 'base64url');
  const recorded = new Map();
  for (let offset = 0; offset + FILE_HASH_BYTES <= bytes.length; offset += FILE_HASH_BYTES) {
    recorded.set(bytes.subarray(offset, offset + 6).toString('hex'), bytes.subarray(offset + 6, offset + FILE_HASH_BYTES).toString('hex'));
  }
  const changed = [];
  const present = new Set();
  for (const [name, hash] of current.perFile) {
    const key = digest(name).subarray(0, 6).toString('hex');
    present.add(key);
    if (recorded.get(key) !== hash) changed.push(name);
  }
  return { changed: changed.sort(), dropped: [...recorded.keys()].filter((key) => !present.has(key)).length };
}

// Whether the commits after the reviewed head are the PR's own: a merge commit after it may bring
// in the base branch, and a reviewed head that is no longer in the PR means its history was
// rewritten. A list cut at GitHub's 250-commit page cannot show what came after.
function sinceReviewScope({ commits, reviewedHead }) {
  if (!Array.isArray(commits) || commits.length >= 250) return 'unknown';
  const at = commits.findIndex((commit) => commit?.sha === reviewedHead);
  if (at < 0) return 'rewritten';
  return commits.slice(at + 1).some((commit) => !Array.isArray(commit?.parents) || commit.parents.length !== 1) ? 'merged' : 'linear';
}

function validFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return null;
  if (typeof finding.id !== 'string' || !/^[A-C]\d{1,6}$/.test(finding.id) || !['P0', 'P1', 'P2'].includes(finding.priority)
    || typeof finding.file !== 'string' || !finding.file || finding.file.length > 400 || !['new', 'old'].includes(finding.side)
    || !Number.isSafeInteger(finding.line) || finding.line < 1 || !['high', 'medium', 'low', 'unspecified'].includes(finding.confidence)
    || !['open', 'answered'].includes(finding.status) || typeof finding.head !== 'string' || !SHA.test(finding.head)
    || typeof finding.title !== 'string' || !finding.title.trim()) return null;
  for (const [key, limit] of Object.entries(FINDING_LIMITS)) {
    const value = finding[key];
    if (key === 'note' && value === undefined) continue;
    if (typeof value !== 'string' || value.length > limit) return null;
  }
  const { id, priority, file, side, line, title, confidence, trigger, impact, evidence, suggestion, status, head, note } = finding;
  return { id, priority, file, side, line, title, confidence, trigger, impact, evidence, suggestion, status, head,
    ...(note === undefined ? {} : { note }) };
}

function validState(state, laneId) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.v !== STATE_VERSION || state.lane !== laneId) return null;
  const { head, workflow, base, prompt, model, mode, at, fp, files, findings, next, lossy } = state;
  if (typeof head !== 'string' || !SHA.test(head) || typeof workflow !== 'string' || !SHA.test(workflow) || ![undefined, true].includes(lossy)
    || typeof base !== 'string' || !base || base.length > 255
    || typeof prompt !== 'string' || !prompt || prompt.length > 64 || typeof model !== 'string' || !MODEL_ID.test(model)
    || !['full', 'incremental'].includes(mode) || typeof at !== 'string' || !ISO.test(at) || !Number.isFinite(Date.parse(at))
    || typeof fp !== 'string' || !/^[0-9a-f]{64}$/.test(fp)
    || !(files === null || (typeof files === 'string' && /^[A-Za-z0-9_-]*$/.test(files)
      && Buffer.from(files, 'base64url').length % FILE_HASH_BYTES === 0 && Buffer.from(files, 'base64url').length <= MAX_FILE_HASHES * FILE_HASH_BYTES))
    || !Array.isArray(findings) || findings.length > MAX_STATE_FINDINGS || !Number.isSafeInteger(next) || next < 1 || next > 1000000) return null;
  const checked = findings.map(validFinding);
  if (checked.some((finding) => !finding)) return null;
  return { v: STATE_VERSION, lane: laneId, head, workflow, base, prompt, model, mode, at, fp, files, findings: checked, next,
    ...(lossy ? { lossy } : {}) };
}

// JSON with <, > and line separators escaped, so model text inside a finding can neither close
// the HTML comment that hides the state nor start a new line.
const stateLine = (state) => `<!-- ai-pr-review-state:v1 ${JSON.stringify(state)
  .replace(UNSAFE_IN_COMMENT, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)} -->`;

// Most states are a few kilobytes. When one is not, it gives up detail in this order: long
// finding text, older remembered answers, the per-file hashes, every remembered answer, and
// finally the lowest-priority open findings. Open findings are what the next round re-checks, so a
// record that lost any is marked lossy and the next changed diff gets a full review.
function encodeState(state) {
  let current = state;
  let line = stateLine(current);
  const fits = () => (line = stateLine(current)).length <= STATE_LIMIT;
  if (line.length <= STATE_LIMIT) return line;
  const compact = (finding) => Object.fromEntries(Object.entries(finding).map(([key, value]) =>
    [key, Object.hasOwn(COMPACT_LIMITS, key) ? clip(value, COMPACT_LIMITS[key]) : value]));
  current = { ...current, findings: current.findings.map(compact) };
  if (fits()) return line;
  const open = current.findings.filter((finding) => finding.status === 'open');
  const answered = current.findings.filter((finding) => finding.status !== 'open');
  current = { ...current, findings: [...open, ...answered.slice(-10)] };
  if (fits()) return line;
  current = { ...current, files: null };
  if (fits()) return line;
  current = { ...current, findings: open };
  if (fits()) return line;
  const rank = (finding) => ['P0', 'P1', 'P2'].indexOf(finding.priority);
  const kept = [...open];
  while (kept.length && !fits()) {
    const drop = kept.reduce((worst, finding, index) => (rank(finding) >= rank(kept[worst]) ? index : worst), 0);
    kept.splice(drop, 1);
    current = { ...current, lossy: true, findings: kept };
  }
  // The loop can stop on an empty list without measuring it; the line returned is always current's.
  return stateLine(current);
}

// Only the runner-written header line counts: line 0 is the lane marker, line 1 the v2 evidence
// and line 2 the state. The same text quoted anywhere in a review is never read.
function readState(body, laneId) {
  const lines = String(body ?? '').split(/\r?\n/, 3);
  if (lines[0] !== `<!-- ai-pr-review-bot:lane-${laneId} -->`
    || !lines[1]?.startsWith(`<!-- ai-pr-review-evidence:v2 lane=${laneId} `)) return null;
  const match = STATE_LINE.exec(lines[2] ?? '');
  if (!match || match[0].length > STATE_LIMIT) return null;
  try {
    return validState(JSON.parse(match[1]), laneId);
  } catch {
    return null;
  }
}

const isBot = (user) => user?.type === 'Bot' || /\[bot\]$/i.test(user?.login ?? '');
function excerptReply(text, limit) {
  if (text.length <= limit) return text;
  const note = '\n[... middle of this reply omitted ...]\n';
  const half = Math.max(0, Math.floor((limit - note.length) / 2));
  return text.slice(0, half) + note + text.slice(text.length - half);
}

// What the PR author and repository members wrote after the previous review: their own comments,
// review summaries and inline comments. Bots, including this workflow, and everyone else are left
// out, and a leading "/review" command line is not part of a reply. The newest replies are kept
// when the budget runs out. These are claims for the model to check, never instructions here.
function collectReplies({ pull, since, comments = [], reviews = [], reviewComments = [], budget = 24000, excerptChars = 6000 }) {
  const after = Date.parse(since);
  const author = pull?.user?.login;
  const candidates = [
    ...comments.map((item) => ({ item, at: item?.created_at })),
    ...reviews.map((item) => ({ item, at: item?.submitted_at })),
    ...reviewComments.map((item) => ({ item, at: item?.created_at })),
  ].filter(({ item, at }) => item && typeof item.body === 'string' && !isBot(item.user) && typeof item.user?.login === 'string'
    && (item.user.login === author || MEMBER_ROLES.has(item.author_association))
    && Number.isFinite(Date.parse(at)) && Date.parse(at) >= after)
    .map(({ item, at }) => ({
      author: item.user.login,
      role: [MEMBER_ROLES.has(item.author_association) ? item.author_association : '', item.user.login === author ? 'PR author' : '']
        .filter(Boolean).join(', '),
      at,
      ...(typeof item.path === 'string' ? { file: item.path.slice(0, 400) } : {}),
      text: item.body.replace(/\r\n/g, '\n').replace(/^\/review\b[^\n]*\n?/i, '').trim(),
    }))
    .filter((reply) => reply.text)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const items = [];
  let used = 2;
  for (const reply of [...candidates].reverse()) {
    const kept = { ...reply, text: excerptReply(reply.text, excerptChars) };
    const cost = JSON.stringify(kept).length + 1;
    if (used + cost > budget) break;
    items.unshift(kept);
    used += cost;
  }
  return { items, omitted: candidates.length - items.length };
}

// The decision before any material is fetched. A review someone asks for by hand is always a full
// review on the current version. Reusing the visible review needs it to be the recorded one;
// reviewing incrementally needs a record this version can read, made under the same report
// contract, by a model the lane still runs.
function planLane({ lane, state, evidence, base, fingerprint, promptVersion, manual, firstPassDue }) {
  if (manual) return { mode: 'full', reason: 'manual' };
  // A first pass that is still due runs on the next commit, whether or not its diff changed.
  if (firstPassDue) return { mode: 'full', reason: 'first-pass-due' };
  if (!state) return { mode: 'full', reason: 'no-previous-review' };
  const models = [lane.first_pass, lane.primary, ...(lane.fallbacks || [])].filter(Boolean).map((model) => model.id);
  if (state.prompt !== promptVersion || !models.includes(state.model)) return { mode: 'full', reason: 'untrusted-state' };
  // Retargeting a PR changes its whole diff, while its commits since the review may look linear.
  if (state.base !== base) return { mode: 'full', reason: 'base-changed' };
  if (state.fp === fingerprint) {
    // A later failed round replaced the comment text, so there is no review left to point at.
    if (evidence?.status !== 'valid' || evidence.head !== state.head) return { mode: 'full', reason: 'unchanged-not-shown' };
    return { mode: 'skip', reason: 'unchanged' };
  }
  // The record lost open findings the incremental round would have to re-check; a full review sees them again.
  if (state.lossy) return { mode: 'full', reason: 'record-incomplete' };
  return { mode: 'incremental', reason: 'changed' };
}

// Quality first (Peter, 2026-10-19): an incremental review sends the change since the review and the
// complete current text of every changed file, never less. A change that is more than half of the
// PR is reviewed in full, and so is one whose material would be larger than the full review's.
const INCREMENTAL_SHARE_LIMIT = 0.5;
function chooseIncremental({ changedFiles, sincePatchChars, fullPatchChars, materialChars, fullMaterialChars, missingText = 0, omitted = 0 }) {
  if (!changedFiles) return { incremental: false, reason: 'nothing-changed' };
  if (sincePatchChars > INCREMENTAL_SHARE_LIMIT * fullPatchChars) return { incremental: false, reason: 'large-change' };
  if (missingText) return { incremental: false, reason: 'text-unavailable' };
  if (omitted) return { incremental: false, reason: 'over-budget' };
  if (materialChars > fullMaterialChars) return { incremental: false, reason: 'not-smaller' };
  return { incremental: true };
}

const STORED_FIELDS = ['priority', 'file', 'side', 'line', 'title', 'confidence', 'trigger', 'impact', 'evidence', 'suggestion'];
const MAX_OPEN = 60;
const MAX_ANSWERED = 30;
// The record the next round re-checks. Previous findings keep their ids: fixed ones are dropped,
// answered ones are remembered so they are not raised again, and the rest stay open. New findings
// get the next ids, written onto them so the published review shows the id the next round uses.
function nextFindings({ previous = [], statuses = [], fresh = [], laneId, next = 1, head }) {
  const verdicts = new Map(statuses.map((verdict) => [verdict.id, verdict]));
  const carried = [];
  for (const finding of previous) {
    const verdict = verdicts.get(finding.id);
    if (verdict?.status === 'fixed') continue;
    const note = verdict?.reason ? { note: clip(verdict.reason, FINDING_LIMITS.note) } : {};
    if (verdict?.status === 'answered') carried.push({ ...finding, status: 'answered', ...note });
    else if (verdict?.status === 'still_present') carried.push({ ...finding, status: 'open', ...note });
    else carried.push(finding);
  }
  let id = next;
  for (const finding of fresh) {
    finding.id = `${laneId}${id++}`;
    carried.push({ id: finding.id, ...Object.fromEntries(STORED_FIELDS.map((key) =>
      [key, Object.hasOwn(FINDING_LIMITS, key) ? clip(finding[key], FINDING_LIMITS[key]) : finding[key]])), status: 'open', head });
  }
  const allOpen = carried.filter((finding) => finding.status === 'open');
  const open = allOpen.slice(-MAX_OPEN);
  const answered = carried.filter((finding) => finding.status === 'answered').slice(-MAX_ANSWERED);
  // Open findings left out of the record are never re-checked by an incremental round; the record says so.
  return { findings: carried.filter((finding) => open.includes(finding) || answered.includes(finding)), next: id,
    ...(open.length < allOpen.length ? { lossy: true } : {}) };
}

// The lines the PR's own commits changed since the reviewed commit, in the current text's numbering:
// lines added or rewritten, and the places where lines were only removed. A linear round names them
// next to each changed file's whole PR change, which is what a full review shows of that file.
const SINCE_RANGES_SHOWN = 30;
function sinceLines(patch) {
  if (typeof patch !== 'string') return '';
  const added = [];
  const removedAfter = [];
  let line = 0;
  let removal = null;
  const settle = () => {
    if (removal !== null && removedAfter.at(-1) !== removal) removedAfter.push(removal);
    removal = null;
  };
  for (const text of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (header) {
      settle();
      // A hunk with no new lines is numbered by the line before it.
      line = Number(header[1]) + (header[2] === '0' ? 1 : 0);
    } else if (text.startsWith('+')) {
      // Lines removed right before added ones were rewritten, not removed.
      removal = null;
      if (added.at(-1)?.[1] === line - 1) added.at(-1)[1] = line;
      else added.push([line, line]);
      line++;
    } else if (text.startsWith('-')) {
      removal ??= line - 1;
    } else if (!text.startsWith('\\')) {
      settle();
      line++;
    }
  }
  settle();
  const list = (items, format, noun) => items.slice(0, SINCE_RANGES_SHOWN).map(format).join(', ')
    + (items.length > SINCE_RANGES_SHOWN ? ` and ${items.length - SINCE_RANGES_SHOWN} more ${noun}` : '');
  return [
    added.length ? `added or rewritten lines ${list(added, ([start, end]) => (start === end ? `${start}` : `${start}-${end}`), 'ranges')}` : '',
    removedAfter.length ? `lines removed after line ${list(removedAfter, String, 'places')}` : '',
  ].filter(Boolean).join('; ');
}

module.exports = { STATE_VERSION, diffIdentity, changedSince, sinceReviewScope, encodeState, readState, collectReplies,
  planLane, chooseIncremental, nextFindings, sinceLines, INCREMENTAL_SHARE_LIMIT };
