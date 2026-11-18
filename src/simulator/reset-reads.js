// Mark AI agent messages unread — a presenter's reset, served on a page of its own
// (/reset) so the audience never sees it on the simulator's main page.
//
// The bell's count is the learner's unread notifications; opening one sets read_at.
// After a rehearsal the AI agents' messages have been opened, so the bell no longer
// shows them and the staff screens count them as "opened". This puts read_at back to
// null on every notification an AI agent wrote (applied_by_agent: true) and on nothing
// else, in the target's live state document, with a conditional write (If-Match) so a
// write the app makes at the same moment is never lost: on a conflict it reads again
// and retries once, then stops by name.
import { uploadTargets } from '../stack.js';
import { STATE_PREFIX } from './actions.js';

const KEY = `${STATE_PREFIX}notifications.json`;
const MAX_ATTEMPTS = 2;

function agentOf(n) {
  return n.agent ?? n.agent_kind ?? n.agent_flag ?? 'unnamed';
}

export async function markAgentMessagesUnread({ aws, stack, dryRun = false }) {
  const { stateBucket } = uploadTargets(await aws.stackOutputs(stack));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const doc = await aws.getObject(stateBucket, KEY);
    if (!doc) return { stack, written: false, agentMessages: 0, reset: 0, byAgent: {}, note: 'no notifications document yet' };
    const all = JSON.parse(doc.body.toString('utf8'));
    if (!Array.isArray(all)) throw new Error(`${KEY} is not a list`);
    const agent = all.filter((n) => n?.applied_by_agent === true);
    const read = agent.filter((n) => n.read_at);
    const byAgent = {};
    for (const n of read) byAgent[agentOf(n)] = (byAgent[agentOf(n)] ?? 0) + 1;
    const report = { stack, agentMessages: agent.length, reset: read.length, byAgent, dryRun };
    if (dryRun || read.length === 0) return { ...report, written: false };
    for (const n of read) n.read_at = null;
    try {
      await aws.put(stateBucket, KEY, Buffer.from(JSON.stringify(all)), 'application/json', { ifMatch: doc.etag ?? undefined });
      return { ...report, written: true };
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      if ((status === 412 || error?.name === 'PreconditionFailed') && attempt < MAX_ATTEMPTS) continue;
      throw new Error(status === 412 ? 'the app wrote notifications at the same moment twice; try again' : error.message);
    }
  }
  throw new Error('unreachable');
}
