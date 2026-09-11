/* =====================================================================
   Nazir Paneli — shared executive calculation logic
   ---------------------------------------------------------------------
   Pure, side-effect-free functions used by the dashboard renderers and
   exercised directly by the Node test suite (tests/exec.test.mjs).

   Everything here is timezone-aware. Timestamps are interpreted with an
   explicit Asia/Baku (+04:00) offset when one is not already present, so
   opening the prototype in a different browser timezone does not change
   a computed age, overdue window or meeting conflict.

   No value is fabricated: a missing date is reported as unknown, never as
   zero, and a future submission time is rejected rather than silently used.
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node
  if (root) root.Exec = api;                                                   // browser
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const BAKU_OFFSET = '+04:00';
  const DAY_MS = 86400000;

  /* Demonstration "as-of" instant. In demo mode every age/overdue/freshness
     figure is measured against this fixed point, so re-opening the panel on a
     different real-world date never makes the snapshot look newly collected.
     Kept separate from the data snapshot time (FEED.meta.observedAt) on
     purpose: the snapshot is when the data was captured; the as-of is the
     moment the demo asks you to reason from. */
  const DEMO_ASOF = '2026-09-11T12:00:00+04:00';

  /* Cutoff applied to a date-only deadline. Documented and explicit rather
     than silently assuming midnight: a date-only due date means "by the end
     of that day, Asia/Baku". */
  const DATE_ONLY_CUTOFF = 'T23:59:59' + BAKU_OFFSET;

  /* Parse a timestamp to epoch ms, attaching the Baku offset when the string
     carries none. Returns null for anything unparseable (never NaN, never 0). */
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    let s = String(v).trim();
    const hasTime = s.indexOf('T') >= 0 || s.indexOf(' ') >= 0;
    const hasZone = /([zZ]|[+\-]\d{2}:?\d{2})$/.test(s);
    if (!hasTime) s = s + DATE_ONLY_CUTOFF;               // date-only -> explicit cutoff
    else if (!hasZone) s = s + BAKU_OFFSET;               // naive local -> Baku
    const t = Date.parse(s.replace(' ', 'T'));
    return isNaN(t) ? null : t;
  }

  function asOfMs(asOf) {
    return asOf == null ? toMs(DEMO_ASOF) : (typeof asOf === 'number' ? asOf : toMs(asOf));
  }

  const PENDING_STATES = ['draft', 'submitted', 'under_review', 'ready', 'pending'];
  function isPending(status) {
    if (!status) return true;                             // no status -> treat as pending/open
    return PENDING_STATES.indexOf(String(status).toLowerCase()) >= 0;
  }

  /* ---- Decisions: age, overdue and due-window metrics (P0-02) ----
     age is measured from submission (only meaningful while pending);
     overdue and "due in next N days" are non-overlapping intervals. */
  function decisionMetric(d, asOf) {
    const now = asOfMs(asOf);
    const sub = toMs(d.submittedAt);
    const due = toMs(d.dueAt || d.due);
    const pending = isPending(d.status);

    let ageDays = null, ageUnknown = false, futureSubmission = false;
    if (sub == null) { ageUnknown = true; }
    else if (sub > now) { futureSubmission = true; ageUnknown = true; }   // reject future submission
    else { ageDays = Math.floor((now - sub) / DAY_MS); }

    let overdueDays = null, dueInDays = null, dueUnknown = false;
    if (due == null) { dueUnknown = true; }
    else if (due < now) { overdueDays = Math.floor((now - due) / DAY_MS); }
    else { dueInDays = Math.floor((due - now) / DAY_MS); }

    return {
      pending: pending,
      ageDays: ageDays, ageUnknown: ageUnknown, futureSubmission: futureSubmission,
      overdueDays: overdueDays, dueInDays: dueInDays, dueUnknown: dueUnknown,
      isOverdue: pending && overdueDays != null,
      dueWithin: function (n) { return pending && dueInDays != null && dueInDays <= n; }
    };
  }

  /* Aggregate KPIs over a decision list. Only pending decisions feed the
     pending-oriented counts; average age is null (shown as a dash) when there
     is nothing valid to average, never a misleading zero. */
  function decisionSummary(decisions, asOf, dueWindowDays) {
    const win = dueWindowDays == null ? 7 : dueWindowDays;
    const rows = (decisions || []).map(function (d) { return decisionMetric(d, asOf); });
    const pending = rows.filter(function (r) { return r.pending; });
    const ages = pending.filter(function (r) { return r.ageDays != null; }).map(function (r) { return r.ageDays; });
    const avgAge = ages.length ? Math.round(ages.reduce(function (a, b) { return a + b; }, 0) / ages.length) : null;
    return {
      total: (decisions || []).length,
      pending: pending.length,
      overdue: pending.filter(function (r) { return r.isOverdue; }).length,
      dueNext: pending.filter(function (r) { return r.dueWithin(win) && !r.isOverdue; }).length,
      dueWindowDays: win,
      avgAgeDays: avgAge,
      unknownSubmission: pending.filter(function (r) { return r.ageUnknown; }).length,
      unknownDue: pending.filter(function (r) { return r.dueUnknown; }).length,
      rows: rows
    };
  }

  /* ---- Meetings: overlap detection from start/end timestamps (P1-09) ----
     Two meetings conflict when their [start,end) intervals intersect on the
     same day. Overlap is reported in whole minutes. */
  function meetingStart(m) { return toMs(m.dt); }
  function meetingEnd(m) {
    if (!m.end) return null;
    if (String(m.end).indexOf('T') >= 0) return toMs(m.end);
    const day = String(m.dt || '').slice(0, 10);
    return toMs(day + 'T' + m.end);
  }

  function meetingConflicts(meetings) {
    const list = (meetings || []).filter(function (m) { return meetingStart(m) != null; });
    const out = {};
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const as = meetingStart(a), ae = meetingEnd(a);
        const bs = meetingStart(b), be = meetingEnd(b);
        if (ae == null || be == null) continue;
        const overlap = Math.min(ae, be) - Math.max(as, bs);
        if (overlap > 0) {
          const mins = Math.round(overlap / 60000);
          (out[a.id] = out[a.id] || []).push({ withId: b.id, minutes: mins });
          (out[b.id] = out[b.id] || []).push({ withId: a.id, minutes: mins });
        }
      }
    }
    return out;
  }

  /* ---- Priority / risk / readiness (P0-04) ----
     These are four separate dimensions. A missing risk or readiness value is
     "not assessed", never silently downgraded to medium/moderate. Meeting
     attendance priority is derived only from importance/urgency (+ an explicit
     minister override); task severity is a distinct dimension and must not, on
     its own, force a meeting to Critical. */
  const PRI_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

  function meetingPriority(m) {
    if (m && m.crit) return m.crit;                       // explicit minister override
    if (!m) return 'low';
    return (m.imp && m.urg) ? 'high' : (m.imp ? 'medium' : 'low');
  }

  function normRisk(m) {
    return (m && m.risk) ? m.risk : 'notAssessed';
  }
  function normReadiness(m) {
    return (m && m.readiness) ? m.readiness : 'notAssessed';
  }

  return {
    BAKU_OFFSET: BAKU_OFFSET,
    DEMO_ASOF: DEMO_ASOF,
    DATE_ONLY_CUTOFF: DATE_ONLY_CUTOFF,
    PRI_RANK: PRI_RANK,
    toMs: toMs,
    asOfMs: asOfMs,
    isPending: isPending,
    decisionMetric: decisionMetric,
    decisionSummary: decisionSummary,
    meetingStart: meetingStart,
    meetingEnd: meetingEnd,
    meetingConflicts: meetingConflicts,
    meetingPriority: meetingPriority,
    normRisk: normRisk,
    normReadiness: normReadiness
  };
});
