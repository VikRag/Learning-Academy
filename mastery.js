const PRIOR_ATTEMPTS = 4;
const PRIOR_MEAN = 0.5;

// Recency weighting: a student's last few quiz attempts on a topic
// matter more than attempts from a month ago, because mastery changes
// as they learn. The most recent RECENT_WINDOW quiz-attempts on a
// topic count RECENT_WEIGHT times as much as older ones.
const RECENT_WINDOW = 3;
const RECENT_WEIGHT = 2;

// A topic can't be labeled "Mastered" just because the last couple of
// answers were lucky — it needs a real track record.
const MASTERED_MIN_ATTEMPTS = 8;
const MASTERED_THRESHOLD = 85;

// A topic only counts as "meaningful" for strengths/weaknesses and
// recommendations once it has at least this many answered questions.
const MEANINGFUL_MIN_ATTEMPTS = 3;

/* ── Helpers ── */

export function toDate(ts) {
  if (!ts) return new Date(0);
  if (typeof ts.toDate === 'function') return ts.toDate();
  return new Date(ts);
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function dateKey(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/* ── Core mastery calculation ──
   events: [{ correct, total, timestamp }], one entry per quiz attempt
   that touched this topic. Order does not need to be sorted — we sort
   internally. Returns null mastery if there is no data at all. */
export function calculateMastery(events) {
  if (!events || events.length === 0) {
    return { mastery: null, attempts: 0, isMastered: false };
  }
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  let weightedCorrect = 0;
  let weightedTotal = 0;
  let attempts = 0;

  sorted.forEach((e, i) => {
    const isRecent = i >= sorted.length - RECENT_WINDOW;
    const w = isRecent ? RECENT_WEIGHT : 1;
    weightedCorrect += e.correct * w;
    weightedTotal += e.total * w;
    attempts += e.total;
  });

  const smoothedCorrect = weightedCorrect + PRIOR_ATTEMPTS * PRIOR_MEAN;
  const smoothedTotal = weightedTotal + PRIOR_ATTEMPTS;
  const mastery = Math.round((smoothedCorrect / smoothedTotal) * 100);
  const isMastered = attempts >= MASTERED_MIN_ATTEMPTS && mastery >= MASTERED_THRESHOLD;

  return { mastery, attempts, isMastered };
}

/* Mastery as it evolved attempt-by-attempt — powers the "68% → 76%"
   improvement callouts and the mastery-over-time chart. */
export function masteryHistory(events) {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const history = [];
  for (let i = 0; i < sorted.length; i++) {
    const prefix = sorted.slice(0, i + 1);
    const { mastery, attempts } = calculateMastery(prefix);
    history.push({ timestamp: sorted[i].timestamp, mastery, attempts });
  }
  return history;
}

/* ── Build topic-level event map from raw quizResults ── */
export function buildTopicMap(quizResults) {
  // key -> { topic, subject, grade, events: [] }
  const map = {};
  const sorted = [...quizResults].sort((a, b) => toDate(a.timestamp) - toDate(b.timestamp));

  sorted.forEach(r => {
    const ts = toDate(r.timestamp);
    const breakdown = r.topicBreakdown || {};
    Object.entries(breakdown).forEach(([topic, d]) => {
      const key = `${r.subject || 'Unknown'}::${r.grade || '?'}::${topic}`;
      if (!map[key]) {
        map[key] = { topic, subject: r.subject || 'Unknown', grade: r.grade || '?', events: [] };
      }
      map[key].events.push({ correct: d.correct || 0, total: d.total || 0, timestamp: ts });
    });
  });

  return map;
}

/* Topic mastery, one row per topic (subject+grade+topic), with mastery
   computed. Sorted by subject then mastery ascending isn't forced here
   — callers sort as needed. */
export function computeTopicMastery(quizResults) {
  const map = buildTopicMap(quizResults);
  return Object.values(map).map(t => ({
    ...t,
    ...calculateMastery(t.events),
  }));
}

/* Overall mastery across everything the student has ever done. Uses
   the same smoothing/recency logic, just applied to every event from
   every topic at once, so a student with lots of practice earns a
   confident number and a brand-new student doesn't get 0%. */
export function computeOverallMastery(quizResults) {
  const allEvents = [];
  quizResults.forEach(r => {
    const ts = toDate(r.timestamp);
    Object.values(r.topicBreakdown || {}).forEach(d => {
      allEvents.push({ correct: d.correct || 0, total: d.total || 0, timestamp: ts });
    });
  });
  return calculateMastery(allEvents);
}

/* Exam readiness for one subject+grade = mastery aggregated over just
   that subject's events. Same honest math — a student who has only
   answered a handful of questions will not see a high number, because
   the Bayesian prior pulls a low-attempt score toward 50%. */
export function computeSubjectReadiness(quizResults, subject, grade) {
  const events = [];
  quizResults
    .filter(r => r.subject === subject && String(r.grade) === String(grade))
    .forEach(r => {
      const ts = toDate(r.timestamp);
      Object.values(r.topicBreakdown || {}).forEach(d => {
        events.push({ correct: d.correct || 0, total: d.total || 0, timestamp: ts });
      });
    });
  return calculateMastery(events);
}

/* ── Strengths / weaknesses ── */
export function getStrengthsAndWeaknesses(topicMasteryList) {
  const meaningful = topicMasteryList.filter(t => t.attempts >= MEANINGFUL_MIN_ATTEMPTS && t.mastery !== null);
  const sorted = [...meaningful].sort((a, b) => b.mastery - a.mastery);
  const strengths = sorted.filter(t => t.mastery >= 75).slice(0, 3);
  const weaknesses = [...sorted].reverse().filter(t => t.mastery < 70).slice(0, 3);
  return { strengths, weaknesses };
}

/* ── Recommendation: weakest meaningful topic, avoiding repeating the
   exact topic the student just practiced if a real alternative exists ── */
export function getRecommendation(topicMasteryList, lastPracticedTopics = []) {
  const candidates = topicMasteryList.filter(t => t.attempts >= 1 && !t.isMastered);
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => a.mastery - b.mastery);
  const notJustPracticed = sorted.filter(t => !lastPracticedTopics.includes(t.topic));

  return notJustPracticed.length > 0 ? notJustPracticed[0] : sorted[0];
}

/* ── Study streak: consecutive calendar days (ending today or
   yesterday) that include at least one quiz ── */
export function computeStreak(quizResults) {
  if (quizResults.length === 0) return 0;
  const days = new Set(quizResults.map(r => dateKey(toDate(r.timestamp))));
  let streak = 0;
  const cursor = new Date();
  // Streak still counts if today has no activity yet but yesterday does.
  if (!days.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dateKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/* ── Achievements ──
   Fully derived from quiz history — nothing is stored, so nothing can
   drift out of sync or "reset." Pass the full quizResults list (or a
   prefix of it, to check what was unlocked before the latest quiz). */
export function computeAchievements(quizResults) {
  const topicList = computeTopicMastery(quizResults);
  const unlocked = [];

  // First Mastery
  if (topicList.some(t => t.isMastered)) {
    unlocked.push({ id: 'first-mastery', icon: '🏅', title: 'First Mastery', desc: 'Mastered your first topic' });
  }

  // Getting Better (+10% in one topic's running mastery, attempt to attempt)
  const gotBetter = topicList.some(t => {
    const hist = masteryHistory(t.events);
    return hist.some((h, i) => i > 0 && h.mastery - hist[i - 1].mastery >= 10);
  });
  if (gotBetter) {
    unlocked.push({ id: 'getting-better', icon: '📈', title: 'Getting Better', desc: 'Improved a topic by 10% or more' });
  }

  // Consistency (5-day streak)
  if (computeStreak(quizResults) >= 5) {
    unlocked.push({ id: 'consistency', icon: '🔥', title: 'Consistency', desc: '5-day study streak' });
  }

  // Perfect Score
  if (quizResults.some(r => r.percentage === 100)) {
    unlocked.push({ id: 'perfect-score', icon: '💯', title: 'Perfect Score', desc: '100% on a practice session' });
  }

  // Subject Master (90%+ aggregate mastery in a subject, with real attempts)
  const subjects = [...new Set(quizResults.map(r => r.subject).filter(Boolean))];
  const subjectMastered = subjects.some(s => {
    const events = [];
    quizResults.filter(r => r.subject === s).forEach(r => {
      const ts = toDate(r.timestamp);
      Object.values(r.topicBreakdown || {}).forEach(d => events.push({ correct: d.correct || 0, total: d.total || 0, timestamp: ts }));
    });
    const m = calculateMastery(events);
    return m.attempts >= MASTERED_MIN_ATTEMPTS && m.mastery >= 90;
  });
  if (subjectMastered) {
    unlocked.push({ id: 'subject-master', icon: '🎓', title: 'Subject Master', desc: 'Reached 90% mastery in a subject' });
  }

  // Comeback (+20% from a topic's lowest point to its current mastery)
  const comeback = topicList.some(t => {
    const hist = masteryHistory(t.events);
    if (hist.length < 2) return false;
    let low = hist[0].mastery;
    for (const h of hist) {
      if (h.mastery - low >= 20 && low < 50) return true;
      low = Math.min(low, h.mastery);
    }
    return false;
  });
  if (comeback) {
    unlocked.push({ id: 'comeback', icon: '🔄', title: 'Comeback', desc: 'Improved a previously weak topic by 20%' });
  }

  return unlocked;
}

/* ── Aggregate stats for the "Your Progress" card ── */
export function computeProgressStats(quizResults) {
  const questionsAnswered = quizResults.reduce((s, r) => s + (r.total || 0), 0);
  const correctTotal = quizResults.reduce((s, r) => s + (r.score || 0), 0);
  const accuracy = questionsAnswered > 0 ? Math.round((correctTotal / questionsAnswered) * 100) : null;
  const topicsPracticed = new Set();
  quizResults.forEach(r => Object.keys(r.topicBreakdown || {}).forEach(t => topicsPracticed.add(t)));
  const studySeconds = quizResults.reduce((s, r) => s + (r.timeTakenSeconds || 0), 0);
  const streak = computeStreak(quizResults);
  const overall = computeOverallMastery(quizResults);

  return {
    overallMastery: overall.mastery,
    questionsAnswered,
    accuracy,
    topicsPracticed: topicsPracticed.size,
    studySeconds,
    studyTimeLabel: formatDuration(studySeconds),
    streak,
  };
}

/* ── Weekly mastery-over-time series for the Progress page chart ── */
export function computeWeeklyMasterySeries(quizResults) {
  if (quizResults.length === 0) return [];
  const sorted = [...quizResults].sort((a, b) => toDate(a.timestamp) - toDate(b.timestamp));
  const firstDate = toDate(sorted[0].timestamp);

  const weekOf = (d) => Math.floor((d - firstDate) / (7 * 24 * 3600 * 1000));
  const byWeek = {};
  sorted.forEach(r => {
    const w = weekOf(toDate(r.timestamp));
    if (!byWeek[w]) byWeek[w] = [];
    byWeek[w].push(r);
  });

  const weeks = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
  let cumulative = [];
  return weeks.map(w => {
    cumulative = cumulative.concat(byWeek[w]);
    const { mastery } = computeOverallMastery(cumulative);
    return { week: w + 1, mastery };
  });
}