import test from "node:test";
import assert from "node:assert/strict";

import {
  DOCTOR_CHECK_STATES,
  doctorCheck,
  normalizeDoctorCheck,
  normalizeDoctorChecks,
} from "../src/doctor-check.mjs";
import { teamTeamVisibilityCheck } from "../src/cli/doctor-command.mjs";
import { formatCommand } from "../src/cli/operator-output.mjs";

test("doctorCheck builds an S3 record with a derived ok (warn is not a failure)", () => {
  assert.deepEqual(DOCTOR_CHECK_STATES, ["ok", "warn", "fail"]);
  assert.deepEqual(doctorCheck({ name: "a", state: "ok", message: "m" }), {
    name: "a",
    state: "ok",
    ok: true,
    message: "m",
  });
  const warn = doctorCheck({ name: "b", state: "warn", message: "posture" });
  assert.equal(warn.state, "warn");
  assert.equal(warn.ok, true, "a warning derives ok:true so it never fails an exit code/gate");
  const fail = doctorCheck({ name: "c", state: "fail", message: "broken", fix: "do x" });
  assert.equal(fail.ok, false);
  assert.equal(fail.fix, "do x");
});

test("doctorCheck rejects an invalid state", () => {
  assert.throws(() => doctorCheck({ name: "x", state: "bogus" }), /Invalid doctor check state/);
});

test("normalizeDoctorCheck maps legacy {ok} to state and preserves extra fields", () => {
  assert.deepEqual(normalizeDoctorCheck({ name: "a", ok: true, message: "m", showMessage: true }), {
    name: "a",
    ok: true,
    message: "m",
    showMessage: true,
    state: "ok",
  });
  assert.deepEqual(normalizeDoctorCheck({ name: "b", ok: false, message: "bad", fix: "f" }), {
    name: "b",
    ok: false,
    message: "bad",
    fix: "f",
    state: "fail",
  });
});

test("normalizeDoctorCheck keeps an explicit warn and recomputes ok from it", () => {
  // A producer that emitted state:'warn' but a stale ok:false still normalizes to ok:true.
  const normalized = normalizeDoctorCheck({ name: "autostart", state: "warn", ok: false, message: "m" });
  assert.equal(normalized.state, "warn");
  assert.equal(normalized.ok, true);
});

test("normalizeDoctorChecks is idempotent", () => {
  const once = normalizeDoctorChecks([{ name: "a", ok: true }, { name: "b", ok: false }]);
  const twice = normalizeDoctorChecks(once);
  assert.deepEqual(twice, once);
});
test("teamTeamVisibilityCheck gives deleted saved-team recovery guidance", () => {
  const check = teamTeamVisibilityCheck({
    team: {
      id: "livetest",
      linear: {
        workspace_id: "workspace-1",
        workspace_name: "agentic factory sandbox",
        team_id: "18cc5008-0b05-44f9-bdef-2d9e1a56f6d1",
        team_key: "LIVE",
        team_name: "livetest",
      },
    },
    teamCheck: { name: "team", ok: false, message: "missing LIVE" },
    savedTeamCheck: { name: "cache teamId", ok: false, message: "teamId 18cc5008-0b05-44f9-bdef-2d9e1a56f6d1" },
    teamKey: "LIVE",
  });

  assert.equal(check.ok, false);
  assert.equal(check.showMessage, true);
  assert.match(check.message, /The Linear team saved for team "livetest" no longer exists/);
  assert.match(check.message, /configured_linear_team_missing: Team livetest points to Linear team 18cc5008-0b05-44f9-bdef-2d9e1a56f6d1/);
  assert.match(check.message, /will not guess by name or silently recreate it/);
  assert.ok(check.fix.includes(formatCommand("uninstall --team livetest")));
  assert.ok(check.fix.includes(formatCommand("init --team livetest")));
});
