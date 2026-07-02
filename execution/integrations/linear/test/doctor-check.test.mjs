import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DOCTOR_CHECK_STATES,
  doctorCheck,
  normalizeDoctorCheck,
  normalizeDoctorChecks,
} from "../src/doctor-check.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import { localSupervisorDoctorChecks } from "../src/supervisor/status.mjs";

const realRepoRoot = path.resolve(import.meta.dirname, "../../../..");

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

test("the local supervisor OS autostart check is a warn, not a fail", async () => {
  const config = loadLinearConfig({ repoRoot: realRepoRoot });
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "af-doctor-autostart-"));
  try {
    const checks = await localSupervisorDoctorChecks({
      repoRoot,
      config,
      cachePath: path.join(repoRoot, "linear-cache.json"),
    });
    const autostart = checks.find((check) => check.name === "local supervisor OS autostart");
    assert.ok(autostart, "autostart check is present");
    assert.equal(autostart.state, "warn");
    assert.equal(autostart.ok, true, "a warning must not count as a failure");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
