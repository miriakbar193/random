/* Numerical/logic regression tests for web/lib/exec.js.
   Run with:  node --test tests/exec.test.mjs
   These are the synthetic fixtures from the implementation handoff's
   "Required test matrix" — they are not ministry records or policy values. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Exec = require('../web/lib/exec.js');

const ASOF = '2026-09-11T12:00:00+04:00';   // injected clock: 11 Sep 2026, 12:00 Baku

test('P0-02 decision age is measured from submission (10 days)', () => {
  const m = Exec.decisionMetric({ submittedAt: '2026-09-01T12:00:00+04:00', due: '2026-09-09' }, ASOF);
  // due is date-only -> end of 9 Sep; still overdue as of 11 Sep noon
  const m2 = Exec.decisionMetric({ submittedAt: '2026-09-01T12:00:00+04:00', dueAt: '2026-09-09T12:00:00+04:00' }, ASOF);
  assert.equal(m.ageDays, 10);
  assert.equal(m2.ageDays, 10);
});

test('P0-02 overdue is 2 days and excluded from the upcoming window', () => {
  const m = Exec.decisionMetric({ submittedAt: '2026-09-01T12:00:00+04:00', dueAt: '2026-09-09T12:00:00+04:00' }, ASOF);
  assert.equal(m.overdueDays, 2);
  assert.equal(m.dueInDays, null);
  assert.equal(m.isOverdue, true);
  assert.equal(m.dueWithin(7), false);   // overdue is not "due in next 7 days"
});

test('P0-02 due within the next 7 days is counted, overdue is not', () => {
  const decisions = [
    { submittedAt: '2026-09-05T09:00:00+04:00', dueAt: '2026-09-09T12:00:00+04:00', status: 'pending' }, // overdue
    { submittedAt: '2026-09-08T09:00:00+04:00', dueAt: '2026-09-14T12:00:00+04:00', status: 'pending' }, // due in 3d
    { submittedAt: '2026-09-08T09:00:00+04:00', dueAt: '2026-10-01T12:00:00+04:00', status: 'pending' }, // far
  ];
  const s = Exec.decisionSummary(decisions, ASOF, 7);
  assert.equal(s.overdue, 1);
  assert.equal(s.dueNext, 1);
});

test('P0-02 approved/closed decisions are excluded from pending counts', () => {
  const decisions = [
    { submittedAt: '2026-09-01T12:00:00+04:00', dueAt: '2026-09-09T12:00:00+04:00', status: 'approved' },
    { submittedAt: '2026-09-08T09:00:00+04:00', dueAt: '2026-09-14T12:00:00+04:00', status: 'pending' },
  ];
  const s = Exec.decisionSummary(decisions, ASOF);
  assert.equal(s.pending, 1);
  assert.equal(s.overdue, 0);      // the overdue one is approved -> not counted
});

test('P0-02 empty collection yields a null average age (a dash, not NaN/0)', () => {
  const s = Exec.decisionSummary([], ASOF);
  assert.equal(s.avgAgeDays, null);
  assert.equal(s.pending, 0);
});

test('P0-02 unknown submission date is disclosed, not treated as zero age', () => {
  const m = Exec.decisionMetric({ dueAt: '2026-10-01T12:00:00+04:00', status: 'pending' }, ASOF);
  assert.equal(m.ageDays, null);
  assert.equal(m.ageUnknown, true);
  const s = Exec.decisionSummary([{ dueAt: '2026-10-01T12:00:00+04:00', status: 'pending' }], ASOF);
  assert.equal(s.unknownSubmission, 1);
  assert.equal(s.avgAgeDays, null);
});

test('P0-02 a future submission time is rejected', () => {
  const m = Exec.decisionMetric({ submittedAt: '2026-09-20T12:00:00+04:00', dueAt: '2026-10-01T12:00:00+04:00' }, ASOF);
  assert.equal(m.futureSubmission, true);
  assert.equal(m.ageDays, null);
  assert.equal(m.ageUnknown, true);
});

test('P0-02 timezone independence: age does not depend on host offset', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  const m = Exec.decisionMetric({ submittedAt: '2026-09-01T12:00:00+04:00', dueAt: '2026-09-09T12:00:00+04:00' }, ASOF);
  assert.equal(m.ageDays, 10);
  assert.equal(m.overdueDays, 2);
  process.env.TZ = prev;
});

test('P1-09 meeting overlap: 15:45-16:45 vs 16:00-17:00 is a 45-minute conflict', () => {
  const meetings = [
    { id: 'a', dt: '2026-09-08T15:45', end: '16:45' },
    { id: 'b', dt: '2026-09-08T16:00', end: '17:00' },
  ];
  const c = Exec.meetingConflicts(meetings);
  assert.ok(c.a && c.b, 'both meetings flagged');
  assert.equal(c.a[0].withId, 'b');
  assert.equal(c.a[0].minutes, 45);
  assert.equal(c.b[0].minutes, 45);
});

test('P1-09 non-overlapping back-to-back meetings do not conflict', () => {
  const meetings = [
    { id: 'a', dt: '2026-09-08T09:00', end: '10:00' },
    { id: 'b', dt: '2026-09-08T10:00', end: '11:00' },
  ];
  const c = Exec.meetingConflicts(meetings);
  assert.deepEqual(c, {});
});

test('P1-09 meetings on different days never conflict', () => {
  const meetings = [
    { id: 'a', dt: '2026-09-08T15:45', end: '16:45' },
    { id: 'b', dt: '2026-09-09T16:00', end: '17:00' },
  ];
  assert.deepEqual(Exec.meetingConflicts(meetings), {});
});

test('P0-04 missing risk/readiness is Not assessed, not medium', () => {
  assert.equal(Exec.normRisk({}), 'notAssessed');
  assert.equal(Exec.normReadiness({}), 'notAssessed');
  assert.equal(Exec.normRisk({ risk: 'high' }), 'high');
  assert.equal(Exec.normReadiness({ readiness: 'low' }), 'low');
});

test('P0-04 a critical child task does not force a meeting to Critical', () => {
  // meeting attendance priority is derived from imp/urg only
  const notImportant = { imp: false, urg: false };
  assert.equal(Exec.meetingPriority(notImportant), 'low');
  const importantUrgent = { imp: true, urg: true };
  assert.equal(Exec.meetingPriority(importantUrgent), 'high');
  const override = { imp: false, urg: false, crit: 'critical' };
  assert.equal(Exec.meetingPriority(override), 'critical');   // only an explicit override
});
