import test from "node:test";
import assert from "node:assert/strict";

import { createCliOutput } from "../src/cli/cli-output.mjs";
import {
  doctorExitCode,
  renderDoctorCheckLine,
  renderDoctorReport,
} from "../src/cli/doctor-report.mjs";

function captureOutput() {
  const writes = [];
  const stream = {
    isTTY: false,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
  };
  // color:false + unicode:false simulates a piped / legacy-console target (the `| cat` case).
  const output = createCliOutput({ color: false, unicode: false, stream });
  return { output, text: () => writes.join("") };
}

test("doctorExitCode: fail -> 1, warn-only -> 0, all-ok -> 0", () => {
  assert.equal(doctorExitCode([{ state: "ok" }, { state: "warn" }]), 0);
  assert.equal(doctorExitCode([{ state: "ok" }, { state: "fail" }]), 1);
  assert.equal(doctorExitCode([{ state: "ok" }]), 0);
  // legacy {ok} checks are tolerated via effectiveState
  assert.equal(doctorExitCode([{ ok: true }, { ok: false }]), 1);
  assert.equal(doctorExitCode([{ ok: true }]), 0);
});

test("renderDoctorReport is color- and animation-free with three ASCII states + verdict", () => {
  const { output, text } = captureOutput();
  renderDoctorReport(
    [
      { name: "Setup", state: "ok", message: "config found", showMessage: true },
      { name: "Linear", state: "ok", message: "connected to Acme" },
      { name: "GitHub", state: "warn", message: "missing the repo scope", fix: "gh auth refresh -s repo" },
      { name: "Gateway", state: "fail", message: "not running", fix: "npm run init" },
    ],
    output,
  );
  const out = text();

  assert.ok(!out.includes("\x1b"), "no ANSI escapes on a non-color stream");
  assert.ok(!out.includes("\r"), "no carriage-return animation");
  // ASCII state marks (unicode off): ok '+', warn '!', fail 'x'.
  assert.match(out, /\+ Setup: config found/);
  assert.match(out, /! GitHub: missing the repo scope/);
  assert.match(out, /x Gateway: not running/);
  // an ok check without showMessage stays terse (no inline message)
  assert.doesNotMatch(out, /connected to Acme/);
  // verdict counts problems and warnings and names the re-run command
  assert.match(out, /1 problem, 1 warning\./);
  assert.match(out, /re-run .*teami.* doctor/);
});

test("renderDoctorCheckLine converts npm-run fixes to the launcher form and glosses external fixes", () => {
  const warnCapture = captureOutput();
  renderDoctorCheckLine(
    { name: "GitHub", state: "warn", message: "scope", fix: "gh auth refresh -s repo" },
    warnCapture.output,
  );
  const warnOut = warnCapture.text();
  assert.match(warnOut, /Fix:/);
  assert.match(warnOut, /re-grants GitHub the 'repo' scope/);

  const failCapture = captureOutput();
  renderDoctorCheckLine(
    { name: "Gateway", state: "fail", message: "down", fix: "npm run init" },
    failCapture.output,
  );
  const failOut = failCapture.text();
  assert.doesNotMatch(failOut, /npm run/, "npm-run repair copy is converted to the launcher form");
  assert.match(failOut, /teami.* init|teami init/);
});

test("renderDoctorCheckLine prints no Fix line for an ok check", () => {
  const { output, text } = captureOutput();
  renderDoctorCheckLine({ name: "Setup", state: "ok", message: "ready", fix: "should-not-show" }, output);
  assert.doesNotMatch(text(), /Fix:/);
});
