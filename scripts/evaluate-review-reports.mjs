#!/usr/bin/env node
// Offline comparison of model reports against synthetic fixtures. Does not call a model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { packDiff } = require('../review-action/src/review-context.js');
const { parseReview } = require('../review-action/src/review-report.js');
const here = path.dirname(fileURLToPath(import.meta.url));
export const cases = JSON.parse(fs.readFileSync(path.join(here, '../test/fixtures/review-evaluation.json'), 'utf8')).map(item => {
  if (item.generated_lines) item.files.push({ filename: 'src/large-generated.js', status: 'added', additions: item.generated_lines,
    deletions: 0, patch: `@@ -0,0 +1,${item.generated_lines} @@\n` + Array.from({ length: item.generated_lines },
      (_, line) => `+const value_${line} = ${line};`).join('\n') });
  return item;
});
export function evaluateReport(testCase, text) {
  const context = packDiff(testCase.files, testCase.budget ?? 100000);
  try {
    const report = parseReview(text, context);
    const matches = (finding, location) => finding.file === location.file && finding.side === location.side && finding.line === location.line;
    const expectedLocationMatched = testCase.expected_locations.some((location) => report.findings.some((finding) => matches(finding, location)));
    const unexpected = report.findings.filter((finding) => !testCase.expected_locations.some((location) => matches(finding, location))).length;
    return { id: testCase.id, contract: 'valid', expected_location_matched: expectedLocationMatched,
      unexpected_locations: unexpected, missing_expected_location: Boolean(testCase.expected_locations.length) && !expectedLocationMatched,
      semantic_confirmation: 'requires human judgment' };
  } catch {
    return { id: testCase.id, contract: 'rejected', expected_coverage_block: Boolean(testCase.expect_coverage_blocked) };
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--reports');
    if (index < 0 || !process.argv[index + 1]) throw new Error('Missing reports.');
    const reports = JSON.parse(fs.readFileSync(process.argv[index + 1], 'utf8'));
    console.log(JSON.stringify(cases.map((item) => reports[item.id] === undefined
      ? { id: item.id, contract: 'not_evaluated' } : evaluateReport(item, reports[item.id])), null, 2));
  } catch {
    console.error('Provide --reports <JSON file> mapping fixture IDs to the model final JSON strings. No model calls were made.');
    process.exitCode = 1;
  }
}
