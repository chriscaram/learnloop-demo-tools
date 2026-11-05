// Copied from the LearnLoop repository, services/learning/src/services/progress.js.
/** Share of the course's total lesson time that is completed, 0-100. */
export function completionPercent(progress, course) {
  const lessons = course?.lessons ?? [];
  const total = lessons.reduce((sum, l) => sum + l.duration_min, 0);
  if (total === 0) return 0;
  const completed = new Set(progress.filter((p) => p.status === 'completed').map((p) => p.lesson_id));
  const done = lessons.filter((l) => completed.has(l.id)).reduce((sum, l) => sum + l.duration_min, 0);
  return Math.round((100 * done) / total);
}
