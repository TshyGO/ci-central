'use strict';

const SEPARATOR = '\n\n---\n\n';
const ISSUE_BUDGET = 20000;
const ISSUE_EXCERPT_CHARS = 6000;
const isTestFile = (name) => /(^|\/)(tests?|__tests__|__mocks__)\//.test(name)
  || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /(^|\/)test_[^/]+\.py$/.test(name) || /_test\.(go|py|rs)$/.test(name);

function riskOrder(name) {
  if (/(^|\/)(dist|build|generated|coverage)\/|\.min\.js$|\.map$/.test(name)) return 5;
  if (isTestFile(name)) return 3;
  if (/^review-action\/src\//.test(name)) return 0;
  if (/(^|\/)(auth|permissions?|migrations?|security|licenses?)(\/|\.)|\.github\/workflows\//i.test(name)) return 0;
  if (/schema|protocol|manifest|package\.json|Cargo\.toml|Dockerfile/i.test(name)) return 1;
  if (/\.(md|txt)$/.test(name)) return 4;
  return 2;
}

function hunks(file) {
  if (typeof file.after_image === 'string') {
    const code = file.after_image.split('\n');
    return [{ text: '[Complete head-side workflow source; removed/base diff is not supplied.]\n'
      + code.map((line, index) => `${index + 1} | ${line}`).join('\n'),
    complete: true, ranges: [[1, code.length]], old_ranges: [], code, new_code: code, old_code: [] }];
  }
  const patch = file.patch;
  if (!patch) return [{ text: '[binary or patch unavailable]', ranges: [], old_ranges: [], code: [], new_code: [], old_code: [] }];
  const lines = patch.split('\n');
  const headers = lines.flatMap((line, index) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line) ? [index] : []);
  // An unlocated patch can still be shown, but cannot substantiate line-number findings.
  if (!headers.length) return [{ text: patch, ranges: [], old_ranges: [], code: lines.map((line) => line.slice(1)), new_code: [], old_code: [] }];
  return headers.map((start, index) => {
    const chunk = lines.slice(start, headers[index + 1] ?? lines.length);
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(chunk[0]);
    const first = Number(match[3]);
    const count = match[4] === undefined ? 1 : Number(match[4]);
    const oldFirst = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const observedNew = chunk.slice(1).filter((line) => /^[ +]/.test(line)).length;
    const observedOld = chunk.slice(1).filter((line) => /^[ \-]/.test(line)).length;
    return { text: chunk.join('\n'), complete: observedNew === count && observedOld === oldCount,
      ranges: observedNew ? [[first, first + observedNew - 1]] : [],
      old_ranges: observedOld ? [[oldFirst, oldFirst + observedOld - 1]] : [],
      new_code: chunk.slice(1).filter(line => /^[ +]/.test(line)).map(line => line.slice(1)),
      old_code: chunk.slice(1).filter(line => /^[ \-]/.test(line)).map(line => line.slice(1)),
      code: chunk.slice(1).filter((line) => /^[ +\-]/.test(line)).map((line) => line.slice(1)) };
  });
}

function packDiff(files, budget) {
  const blocks = [];
  const coverage = [];
  let used = 0;
  const ordered = [...files].sort((a, b) => riskOrder(a.filename) - riskOrder(b.filename));
  for (const file of ordered) {
    const prefix = `File: ${file.filename}\nStatus: ${file.status}; +${file.additions} -${file.deletions}\n`;
    const candidates = hunks(file);
    const selected = [];
    for (const hunk of candidates) {
      if (hunk.complete === false) continue;
      const cost = (selected.length ? 1 : prefix.length + (blocks.length ? SEPARATOR.length : 0)) + hunk.text.length;
      if (used + cost > budget) continue;
      selected.push(hunk);
      used += cost;
    }
    if (selected.length) blocks.push(prefix + selected.map((hunk) => hunk.text).join('\n'));
    coverage.push({ file: file.filename, status: file.status, supplied_hunks: selected.length,
      total_hunks: candidates.length, patch_available: Boolean(file.patch),
      mode: typeof file.after_image === 'string' ? 'head_source' : 'patch',
      ranges: selected.flatMap((hunk) => hunk.ranges), old_ranges: selected.flatMap((hunk) => hunk.old_ranges),
      hunks: selected.map(({ text, ...evidence }) => evidence),
      code: selected.flatMap((hunk) => hunk.code) });
  }
  const text = blocks.join(SEPARATOR);
  const omittedFiles = coverage.filter((file) => !file.supplied_hunks);
  const omittedHunks = coverage.reduce((sum, file) => sum + file.total_hunks - file.supplied_hunks, 0);
  return { text, kept: blocks.length, packedChars: text.length, omitted: omittedFiles.length,
    omittedHunks, coverage, manifest: coverage.map(({ code, ranges, old_ranges, hunks, ...metadata }) => metadata) };
}

// A file's whole current text as one numbered hunk, so findings may quote code around the change.
function fullTextHunk(file) {
  const code = file.full_text.split('\n');
  return { text: `[Complete current text of ${file.filename} at the head commit; line numbers are head-side.]\n`
    + code.map((line, index) => `${index + 1} | ${line}`).join('\n'),
  complete: true, ranges: [[1, code.length]], old_ranges: [], code, new_code: code, old_code: [], full_text: true };
}

// Incremental material: every file's since-review patch hunks first, in risk order, then the
// complete current text of each changed file while the budget lasts. The runner reviews in full
// whenever any of it is left out (quality first: an incremental review never sees less of a changed
// file than its whole text). The result has packDiff's shape, so evidence is validated the same
// way against exactly what was supplied.
function packIncremental(files, budget) {
  const ordered = [...files].sort((a, b) => riskOrder(a.filename) - riskOrder(b.filename));
  const prefix = (file) => `File: ${file.filename}\nStatus: ${file.status}; +${file.additions} -${file.deletions}`
    + `${file.scope === 'pr' ? ' (its complete PR change: the commits since the reviewed one could not be compared on their own)' : ' (change since the reviewed commit)'}\n`;
  const plans = ordered.map((file) => ({ file, patch: hunks({ filename: file.filename, patch: file.patch }),
    text: typeof file.full_text === 'string' ? fullTextHunk(file) : null, context: [], selected: [] }));
  let used = 0;
  const cost = (plan, hunk) => (plan.selected.length ? 1 : prefix(plan.file).length + (used ? SEPARATOR.length : 0)) + hunk.text.length;
  for (const plan of plans) {
    for (const hunk of plan.patch) {
      if (hunk.complete === false || used + cost(plan, hunk) > budget) continue;
      used += cost(plan, hunk);
      plan.selected.push(hunk);
    }
  }
  for (const plan of plans.filter(({ text }) => text).sort((a, b) => a.file.full_text.length - b.file.full_text.length)) {
    if (used + cost(plan, plan.text) > budget) continue;
    used += cost(plan, plan.text);
    plan.selected.push(plan.text);
    plan.context = [plan.text];
  }
  const blocks = plans.filter((plan) => plan.selected.length).map((plan) => prefix(plan.file) + plan.selected.map((hunk) => hunk.text).join('\n'));
  const coverage = plans.map(({ file, patch, text, context, selected }) => ({ file: file.filename, status: file.status, supplied_hunks: selected.length,
    total_hunks: patch.length + (text ? 1 : 0), patch_available: Boolean(file.patch) || context.length > 0,
    mode: context.length ? 'patch+head_text' : 'patch',
    ranges: selected.flatMap((hunk) => hunk.ranges), old_ranges: selected.flatMap((hunk) => hunk.old_ranges),
    hunks: selected.map(({ text: hunkText, ...evidence }) => evidence), code: selected.flatMap((hunk) => hunk.code) }));
  const text = blocks.join(SEPARATOR);
  return { text, kept: blocks.length, packedChars: text.length, omitted: coverage.filter((file) => !file.supplied_hunks).length,
    omittedHunks: coverage.reduce((sum, file) => sum + file.total_hunks - file.supplied_hunks, 0), coverage,
    manifest: coverage.map(({ code, ranges, old_ranges, hunks: _, ...metadata }) => metadata) };
}

async function enrichWorkflows({ github, owner, repo, head, files, logger }) {
  const enriched = [];
  for (const file of files) {
    // This replaces a large removal-only context with the exact current workflow,
    // not arbitrary repository/document retrieval and not another model call.
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.filename) && file.status !== 'removed'
        && (file.patch?.length || 0) > 20000 && file.deletions > 3 * Math.max(1, file.additions)) {
      try {
        const { data } = await github.rest.repos.getContent({ owner, repo, path: file.filename, ref: head });
        if (data.type === 'file' && data.encoding === 'base64' && data.size <= 30000) {
          const source = Buffer.from(data.content, 'base64').toString('utf8').replace(/\r\n/g, '\n');
          const formattedSize = source.split('\n').reduce((sum, line, index) => sum + line.length + String(index + 1).length + 4, 90);
          if (source.trim() && !source.includes('\0') && source.length <= 20000 && formattedSize < file.patch.length) {
            enriched.push({ ...file, after_image: source }); continue;
          }
        }
      } catch {
        logger.log('Workflow head-source enrichment unavailable; retaining the bounded original patch.');
      }
    }
    enriched.push(file);
  }
  return enriched;
}

function excerpt(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  const note = '\n[Middle omitted by the issue-context budget; this is not the complete issue.]\n';
  if (limit < note.length) return { text: note.slice(0, Math.max(0, limit)), truncated: true };
  const available = Math.max(0, limit - note.length);
  const head = Math.ceil(available / 2);
  return { text: text.slice(0, head) + note + text.slice(text.length - (available - head)), truncated: true };
}

async function collectIssues({ github, owner, repo, pull, commits, logger, budget = ISSUE_BUDGET, excerptChars = ISSUE_EXCERPT_CHARS }) {
  const sources = [pull.title || '', pull.body || '', ...commits.map((commit) => commit.commit?.message || '')];
  const escapedRepo = `${owner}/${repo}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownLink = new RegExp(`https://github\\.com/${escapedRepo}/issues/(\\d+)`, 'g');
  const all = [...new Set(sources.flatMap((text) => [
    ...[...text.matchAll(/(?:^|[^A-Za-z0-9_/])#(\d+)\b/g)].map((match) => Number(match[1])),
    ...[...text.matchAll(ownLink)].map((match) => Number(match[1])),
  ]))];
  const numbers = all.slice(0, 10);
  const manifest = [];
  const blocks = [];
  let remaining = budget;
  for (const number of numbers) {
    if (remaining < 300) { manifest.push({ number, state: 'budget_omitted' }); continue; }
    try {
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
      if (issue.pull_request) { manifest.push({ number, state: 'pull_request_reference' }); continue; }
      const header = `\n### Issue #${number}: ${issue.title}\n`;
      const result = excerpt(issue.body || '', Math.min(excerptChars, Math.max(0, remaining - header.length)));
      const block = header + result.text + '\n';
      remaining -= block.length;
      blocks.push(block);
      manifest.push({ number, state: result.truncated ? 'excerpt' : 'complete' });
    } catch {
      // URLs, API bodies and credentials do not belong in diagnostic messages.
      logger.log(`Referenced issue #${number} is unavailable; review coverage records the gap.`);
      manifest.push({ number, state: 'unavailable' });
    }
  }
  return { text: blocks.join(''), manifest, omitted_references: Math.max(0, all.length - numbers.length) };
}

module.exports = { packDiff, packIncremental, collectIssues, excerpt, hunks, enrichWorkflows };
