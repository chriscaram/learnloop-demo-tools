// Copied from the LearnLoop repository, services/notifications/src/services/support.js
// (the pure part: topics, the reply target and which open questions are overdue).
export const SUPPORT_TOPICS = Object.freeze(['billing', 'certificate', 'account', 'course_content', 'other']);

const HOUR_MS = 3_600_000;

/**
 * When a reply is due: one business day after the question. 24 hours later, moved
 * on to Monday (same time of day) when that lands on a Saturday or Sunday.
 */
export function replyDueAt(createdAt) {
  const due = new Date(new Date(createdAt).getTime() + 24 * HOUR_MS);
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + 1);
  return due;
}

/** Open requests whose reply is overdue at `now`, oldest first. */
export function overdueRequests(requests, now = new Date()) {
  return requests
    .filter((r) => r.status === 'open' && replyDueAt(r.created_at) <= now)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
