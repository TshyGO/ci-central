'use strict';

const MARKER = '<!-- ai-pr-review-status:v1 -->';
const labels = { running: '主模型运行中', fallback: '备用模型运行中', complete: '已生成，证据格式已校验',
  reused: '复用当前提交的有效证据', failed: '审核未生成', partial: '输出不完整，不计入 quorum',
  publication_failed: '结果发布失败，不计入 quorum' };
const cell = (text) => String(text ?? '').replace(/[|`<>\r\n]/g, ' ');

function createStatusPublisher({ github, owner, repo, pullNumber, head, workflow, runUrl, runId,
  lanes, reusableLaneIds, comments, quorum, logger }) {
  const rows = new Map(lanes.map((lane) => [lane.id, { primary: lane.primary.id,
    state: reusableLaneIds.has(lane.id) ? 'reused' : 'running', served: null }]));
  let comment = comments.filter((item) => item.user?.login === 'github-actions[bot]' && item.body?.startsWith(MARKER)).at(-1);
  let queue = Promise.resolve();
  function body() {
    const valid = [...rows.values()].filter((row) => ['complete', 'reused'].includes(row.state)).length;
    return [MARKER, `<!-- ai-pr-review-status-head:${head} workflow:${workflow} run:${runId} -->`,
      '## AI 审核 · 当前提交状态', '', `提交：\`${head}\` · [本轮运行](${runUrl})`,
      `中央版本：\`${workflow}\``, '', '| Lane | 主模型 | 当前状态 | 实际服务模型 |', '|---|---|---|---|',
      ...lanes.map((lane) => { const row = rows.get(lane.id); return `| ${lane.id} | ${cell(row.primary)} | ${labels[row.state]} | ${cell(row.served || (row.state === 'reused' ? '见该 Lane 评论' : '—'))} |`; }),
      '', `有效发布：${valid}/${lanes.length}${quorum ? `；至少需要 ${quorum} 路` : ''}。`,
      'quorum 表示本次审核证据已生成，不表示模型结论正确或人工批准。',
      '尚未完成的 Lane 可能仍显示历史提交的评论；以本表的完整提交 SHA 和本轮运行链接为准。',
      '本表记录最后一次观测状态；若运行被取消，最终运行状态以链接为准。',
    ].join('\n');
  }
  function publish() {
    queue = queue.then(async () => {
      // Every asynchronous update checks freshness; the same-PR latest-wins job
      // concurrency additionally cancels old executions before new ones begin.
      const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      if (pull.head.sha !== head || pull.state !== 'open') return;
      const text = body();
      if (comment) {
        ({ data: comment } = await github.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body: text }));
      } else {
        ({ data: comment } = await github.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body: text }));
      }
    }).catch(() => logger.log('Current-head status summary could not be published; lane evidence remains independent.'));
    return queue;
  }
  return { publish, update(lane, state, served = null) {
    if (!rows.has(lane) || !Object.hasOwn(labels, state)) throw new Error('Unknown lane/status transition.');
    rows.set(lane, { ...rows.get(lane), state, served });
    return publish();
  } };
}

module.exports = { createStatusPublisher, MARKER };
