'use strict';
/**
 * Pure attendance rules: one employee, one calendar day -> attendance row (or null when the day is still open).
 * No I/O, so it can be unit tested in isolation.
 *
 * Definitions (all minutes are local wall-clock minutes since midnight in the company timezone):
 *  - late_minutes       = check-in minus shift start, when check-in is later than start + grace; otherwise 0
 *  - early_out_minutes  = shift end minus check-out, when check-out is earlier than end - early-out grace; otherwise 0
 *  - overtime_minutes   = check-out minus shift end, when check-out is later than end + overtime threshold (capped)
 *  - on a weekly-off day or holiday, all worked time is overtime (off_day_work = true)
 *  - worked_minutes     = (check-out - check-in), minus the unpaid break when the span exceeds 4 hours
 */
const { dow, toMin } = require('../utils/time');

const DEFAULT_RULES = { min_punch_gap_minutes: 5, half_day_minutes: 240, ot_max_minutes: 240 };

function computeDay({ date, today, nowMin, user, shift, punches, holiday, leave, rules }) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  if (!shift) return null;                       // employees without a shift are not tracked
  if (user.join_date && date < user.join_date) return null;
  if (date > today) return null;

  const startMin = toMin(shift.start_time);
  const endMin = toMin(shift.end_time);
  const isWeeklyOff = (shift.weekly_off || []).includes(dow(date));
  const isOffDay = isWeeklyOff || !!holiday;
  const shiftStarted = date < today || nowMin >= (startMin + shift.grace_minutes);
  const dayOver = date < today || nowMin >= endMin;

  const base = {
    shift_id: shift.id, check_in: null, check_out: null, punch_count: punches.length, worked_minutes: 0,
    late_minutes: 0, early_out_minutes: 0, overtime_minutes: 0, missing_checkout: false, off_day_work: false,
  };

  if (punches.length === 0) {
    if (isOffDay) return { ...base, status: holiday ? 'holiday' : 'weekend' };
    if (leave) return { ...base, status: leave.paid ? 'leave' : 'unpaid_leave' };
    if (shiftStarted) return { ...base, status: 'absent' };
    return null;                                  // shift not started yet
  }

  const first = punches[0];
  const last = punches[punches.length - 1];
  const inMin = toMin(first.t);
  const outMin = toMin(last.t);
  const isPastDay = date < today;
  // A punch is recognized as a genuine check-out when:
  //  1. In the normal departure window near/after shift end (from 60 mins before shift end onwards, e.g. >= 18:00 for 19:00 shift, >= 17:45 for 18:45 Commercial, >= 16:00 for 17:00 Store), OR
  //  2. Explicitly registered as a check-out (state = 1) near departure with at least 4 hours worked.
  // Intermediate midday/afternoon tea, prayer, or lunch swipes (e.g. 11:00–16:30 for evening shifts) are NEVER recognized as checkouts.
  const isLegitCheckout = outMin >= (endMin - 60)
    || (last.state === 1 && outMin - inMin >= 240 && outMin >= (endMin - 120));
  const hasOut = punches.length >= 2 && (outMin - inMin >= r.min_punch_gap_minutes) && isLegitCheckout;
  const row = { ...base, check_in: first.at, check_out: hasOut ? last.at : null };

  const span = hasOut ? outMin - inMin : 0;
  const allowOt = (shift.allow_overtime !== false) && (user.overtime_eligible !== false);
  if (isOffDay) {
    const otMins = allowOt ? Math.min(span, r.ot_max_minutes * 2) : 0;
    return { ...row, status: 'present', off_day_work: true, worked_minutes: span, overtime_minutes: otMins };
  }

  row.late_minutes = inMin > startMin + shift.grace_minutes ? inMin - startMin : 0;
  if (hasOut) {
    row.worked_minutes = Math.max(0, span - (span > 240 ? shift.break_minutes : 0));
    row.early_out_minutes = outMin < endMin - shift.early_out_grace_minutes ? endMin - outMin : 0;
    row.overtime_minutes = (allowOt && outMin > endMin + shift.overtime_after_minutes) ? Math.min(outMin - endMin, r.ot_max_minutes) : 0;
  } else {
    row.missing_checkout = dayOver;
  }

  let status = row.late_minutes > 0 ? 'late' : 'present';
  if (hasOut && row.worked_minutes < r.half_day_minutes) status = 'half_day';
  return { ...row, status };
}

module.exports = { computeDay, DEFAULT_RULES };
