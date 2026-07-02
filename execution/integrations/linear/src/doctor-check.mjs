// The doctor check record (seam S3).
//
//   { name, state: 'ok' | 'warn' | 'fail', message?, fix?, showMessage? }
//
// `state` is authoritative. `ok` is a derived COMPATIBILITY field (ok === state !== 'fail') kept
// until every consumer reads `state` directly (D1) — a `warn` is NOT a failure, so it stays
// ok:true and never fails an exit code or onboarding gate. `fix` is an optional actionable repair;
// `showMessage` lets a producer keep its message as the headline line.

export const DOCTOR_CHECK_STATES = Object.freeze(["ok", "warn", "fail"]);

function assertState(state, name) {
  if (!DOCTOR_CHECK_STATES.includes(state)) {
    throw new Error(`Invalid doctor check state for "${name}": ${state}`);
  }
}

// Construct an S3 record explicitly — for producers that classify into the three states directly
// (e.g. a non-blocking posture check -> 'warn').
export function doctorCheck({ name, state, message = null, fix = null, showMessage } = {}) {
  assertState(state, name);
  const record = { name, state, ok: state !== "fail", message };
  if (fix !== null && fix !== undefined) record.fix = fix;
  if (showMessage !== undefined) record.showMessage = showMessage;
  return record;
}

// Normalize a possibly-legacy ({ name, ok, message }) check into the full S3 record: a valid
// `state` plus the derived `ok` compatibility field. A check that already carries `state` keeps it
// (so an explicit 'warn' survives); otherwise the legacy boolean maps ok:false -> 'fail', else
// 'ok'. All other fields (message, fix, showMessage, …) are preserved. This is the migration
// boundary that lets the renderer (D1) read `state` even from producers still emitting `{ ok }`.
export function normalizeDoctorCheck(check) {
  let state;
  if (check.state !== undefined) {
    assertState(check.state, check.name);
    state = check.state;
  } else {
    state = check.ok === false ? "fail" : "ok";
  }
  return { ...check, state, ok: state !== "fail" };
}

export function normalizeDoctorChecks(checks = []) {
  return checks.map(normalizeDoctorCheck);
}
