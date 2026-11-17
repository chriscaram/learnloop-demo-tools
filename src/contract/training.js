// Copied from the LearnLoop repository, services/admin/src/services/training.js (the
// pure part: where one required course stands for one employee). test/contract.test.js
// compares it with the service.
import { completionPercent } from './progress.js';

export const TRAINING_STATUSES = Object.freeze(['assigned', 'in_progress', 'completed', 'overdue']);

/**
 * Completed: every lesson of the course is completed and every quiz in it has an
 * attempt scoring at least the assignment's required_pass_score. completedAt is the
 * moment the last of those happened. Otherwise overdue once due_at has passed,
 * in progress when there is any lesson or quiz activity on the course, else assigned.
 *
 * record: { lessons: [{ id, duration_min, hasQuiz }], progress, quizResults }; now: a Date.
 */
export function trainingState(assignment, record, now = new Date()) {
  const lessons = record?.lessons ?? [];
  const progress = record?.progress ?? [];
  const results = record?.quizResults ?? [];
  const pass = assignment.required_pass_score ?? 0;
  const completedAt = new Map(progress.filter((p) => p.status === 'completed').map((p) => [p.lesson_id, p.completed_at]));
  const times = [];
  let met = lessons.length > 0;
  for (const lesson of lessons) {
    if (!completedAt.has(lesson.id)) { met = false; continue; }
    times.push(completedAt.get(lesson.id));
    if (!lesson.hasQuiz) continue;
    const passed = results.filter((r) => r.lesson_id === lesson.id && r.score >= pass).map((r) => r.submitted_at).sort()[0];
    if (passed) times.push(passed);
    else met = false;
  }
  const done = met ? times.sort().at(-1) : null;
  const overdue = !done && now.getTime() > Date.parse(assignment.due_at);
  const started = progress.length > 0 || results.length > 0;
  const quizScores = results.map((r) => r.score);
  return {
    status: done ? 'completed' : overdue ? 'overdue' : started ? 'in_progress' : 'assigned',
    completedAt: done,
    completedOnTime: done ? Date.parse(done) <= Date.parse(assignment.due_at) : null,
    percent: completionPercent(progress, { lessons }),
    completedLessons: lessons.filter((l) => completedAt.has(l.id)).length,
    totalLessons: lessons.length,
    quizAttempts: results.length,
    failedQuizAttempts: results.filter((r) => r.score < pass).length,
    bestQuizScore: quizScores.length ? Math.max(...quizScores) : null,
  };
}
