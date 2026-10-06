import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStatusPublisher, MARKER } = require('../review-action/src/review-status.js');
const head = 'a'.repeat(40);
function fixture({ stale = false, fail = false, comments = [] } = {}) {
  const writes = [], logs = [], deleted = [];
  let comment;
  const github = { rest: {
    pulls: { get: async () => ({ data: { state: 'open', head: { sha: stale ? 'b'.repeat(40) : head } } }) },
    issues: { createComment: async ({ body }) => {
      if (fail) throw new Error('PRIVATE');
      comment = { id: 1, body }; writes.push(body); return { data: comment };
    }, updateComment: async ({ body, comment_id }) => { writes.push(body); return { data: { id: comment_id, body } }; },
      deleteComment: async ({ comment_id }) => { deleted.push(comment_id); } },
  } };
  const publisher = createStatusPublisher({ github, owner: 'TshyGO', repo: 'sample', pullNumber: 1,
    head, workflow: 'c'.repeat(40), runUrl: 'https://github.com/TshyGO/sample/actions/runs/1', runId: 1,
    lanes: ['A', 'B', 'C'].map((id) => ({ id, primary: { id: 'primary-' + id } })),
    reusableLaneIds: new Set(), comments, quorum: 2, logger: { log: (text) => logs.push(text) } });
  return { publisher, writes, logs, deleted };
}
test('one current-head summary distinguishes running, fallback and completed lanes', async () => {
  const { publisher, writes } = fixture();
  await publisher.publish();
  assert.ok(writes[0].startsWith(MARKER));
  assert.ok(writes[0].includes(head));
  assert.ok(writes[0].includes('主模型运行中'));
  await publisher.update('A', 'complete', 'primary-A');
  await publisher.update('B', 'fallback', 'fallback-B');
  assert.ok(writes.at(-1).includes('| A | primary-A | 已生成，证据格式已校验 | primary-A |'));
  assert.ok(writes.at(-1).includes('| B | primary-B | 备用模型运行中 | fallback-B |'));
  await publisher.update('B', 'complete', 'fallback-B');
  await publisher.update('C', 'failed');
  assert.ok(writes.at(-1).includes('有效发布：2/3；至少需要 2 路'));
  assert.ok(writes.at(-1).includes('不表示模型结论正确或人工批准'));
});
test('status updates never write against an obsolete head', async () => {
  const { publisher, writes } = fixture({ stale: true });
  await publisher.publish();
  await publisher.update('A', 'complete', 'primary-A');
  assert.equal(writes.length, 0);
});
test('duplicate summaries are reconciled without deleting human comments or quoted markers', async () => {
  const comments = [
    { id: 1, user: { login: 'github-actions[bot]' }, body: MARKER + '\nold' },
    { id: 2, user: { login: 'github-actions[bot]' }, body: MARKER + '\nnewer' },
    { id: 3, user: { login: 'human' }, body: MARKER + '\nhuman' },
    { id: 4, user: { login: 'github-actions[bot]' }, body: 'Quoted: ' + MARKER },
  ];
  const { publisher, deleted } = fixture({ comments });
  await publisher.publish();
  await publisher.update('A', 'complete', 'primary-A');
  assert.deepEqual(deleted, [1]);
});
test('a summary publication failure does not become a lane/model retry', async () => {
  const { publisher, writes, logs } = fixture({ fail: true });
  await assert.doesNotReject(publisher.publish());
  assert.equal(writes.length, 0);
  assert.ok(logs.length);
  assert.ok(!logs.join('').includes('PRIVATE'));
});
