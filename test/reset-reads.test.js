import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markAgentMessagesUnread } from '../src/simulator/reset-reads.js';

const OUTPUTS = {
  StateBucketName: 'state-bucket', AppLogsBucketName: 'a', AccessLogsBucketName: 'b', CloudFrontLogPrefix: 'cloudfront/',
  DistributionId: 'd', DistributionDomainName: 'x.cloudfront.net', LogPseudonymSaltSecretName: 's',
};

function fakeAws(doc, { conflicts = 0 } = {}) {
  const writes = [];
  let body = Buffer.from(JSON.stringify(doc));
  let etag = '"e1"';
  return {
    writes,
    stackOutputs: async () => OUTPUTS,
    getObject: async (bucket, key) => { assert.equal(bucket, 'state-bucket'); assert.equal(key, 'state/notifications.json'); return { body, etag }; },
    put: async (bucket, key, b, type, { ifMatch }) => {
      if (conflicts > 0) { conflicts -= 1; etag = '"e2"'; throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } }); }
      assert.equal(ifMatch, etag);
      writes.push(JSON.parse(b.toString('utf8')));
      body = b;
    },
  };
}

const DOC = [
  { id: 'n1', applied_by_agent: true, agent: 'inactivity_nudge', read_at: '2026-11-18T10:00:00.000Z' },
  { id: 'n2', applied_by_agent: true, agent_kind: 'nudge', read_at: null },
  { id: 'n3', type: 'staff_message', read_at: '2026-11-18T10:00:00.000Z' },
  { id: 'n4', applied_by_agent: true, agent_flag: 'ga-x', read_at: '2026-11-18T11:00:00.000Z' },
];

test('only AI agent messages go back to unread, with an If-Match write', async () => {
  const aws = fakeAws(structuredClone(DOC));
  const r = await markAgentMessagesUnread({ aws, stack: 'LearnLoopStaging' });
  assert.deepEqual([r.agentMessages, r.reset, r.written], [3, 2, true]);
  assert.deepEqual(r.byAgent, { inactivity_nudge: 1, 'ga-x': 1 });
  const out = aws.writes[0];
  assert.deepEqual(out.map((n) => n.read_at), [null, null, '2026-11-18T10:00:00.000Z', null]);
});

test('a dry run reports and writes nothing; nothing read means no write', async () => {
  const aws = fakeAws(structuredClone(DOC));
  const r = await markAgentMessagesUnread({ aws, stack: 'LearnLoopStaging', dryRun: true });
  assert.deepEqual([r.reset, r.written, aws.writes.length], [2, false, 0]);
  const clean = fakeAws(DOC.map((n) => ({ ...n, read_at: null })));
  assert.equal((await markAgentMessagesUnread({ aws: clean, stack: 'LearnLoopStaging' })).written, false);
  assert.equal(clean.writes.length, 0);
});

test('a concurrent app write is retried once, a second conflict stops by name', async () => {
  const once = fakeAws(structuredClone(DOC), { conflicts: 1 });
  assert.equal((await markAgentMessagesUnread({ aws: once, stack: 'LearnLoopStaging' })).written, true);
  const twice = fakeAws(structuredClone(DOC), { conflicts: 2 });
  await assert.rejects(markAgentMessagesUnread({ aws: twice, stack: 'LearnLoopStaging' }), /same moment twice/);
});
