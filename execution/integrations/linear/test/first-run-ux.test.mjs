import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { createCliOutput } from "../src/cli/cli-output.mjs";
import {
  firstRunOfflineProxyBranch,
  firstRunPlan,
  renderFirstRunUx,
  shouldRenderFirstRunRepairBranch,
} from "../src/cli/first-run-ux.mjs";
import { HOME_STATE } from "../src/cli/home-state.mjs";
import { oauthFirewallHint } from "../src/linear-oauth.mjs";
import { runtimeFetchDegradationNotice } from "../src/local-phoenix-manager.mjs";

const COMMANDS = Object.freeze({
  init: "teami init",
  doctor: "teami doctor",
  gatewayStart: "teami gateway start",
  gatewayStatus: "teami gateway status",
  phoenixStart: "teami phoenix:start",
});
const PLANNED_STEP = 'Move a Linear project to "Planned" to start your first run';

class MemoryStream extends Writable {
  constructor() {
    super();
    this.output = "";
  }

  _write(chunk, encoding, callback) {
    this.output += chunk.toString("utf8");
    callback();
  }
}

test("D0c first-run plan is ordered and resumable across home-state probe states", () => {
  const idle = firstRunPlan({
    state: HOME_STATE.IDLE,
    commands: COMMANDS,
    plannedProjectText: PLANNED_STEP,
  });
  assert.deepEqual(idle.map((step) => step.text), [
    "teami gateway start",
    PLANNED_STEP,
    "teami gateway status",
    "teami doctor",
    "Local Phoenix (traces)",
  ]);
  assert.match(idle[0].hint, /start polling Linear/);

  const uninitialized = firstRunPlan({ state: HOME_STATE.UNINITIALIZED, commands: COMMANDS });
  assert.equal(uninitialized[0].text, "teami init");
  assert.match(uninitialized[0].hint, /resume setup/);

  const degraded = firstRunPlan({ state: HOME_STATE.DEGRADED, commands: COMMANDS });
  assert.equal(degraded[0].text, "teami doctor");
  assert.equal(degraded[1].text, "teami init");

  const listening = firstRunPlan({
    state: HOME_STATE.LISTENING,
    commands: COMMANDS,
    plannedProjectText: PLANNED_STEP,
  });
  assert.equal(listening[0].text, PLANNED_STEP);
  assert.equal(listening.some((step) => step.text === "teami gateway start"), false);
});

test("D0c offline branch renders the imported runtime and Windows firewall notices", () => {
  const runtimeNotice = runtimeFetchDegradationNotice();
  const firewallNotice = oauthFirewallHint({ platform: "win32" });
  assert.ok(firewallNotice, "Windows firewall hint must be present for the branch assertion");

  const branch = firstRunOfflineProxyBranch({
    platform: "win32",
    includeRuntimeFetchNotice: true,
    commands: COMMANDS,
  });
  assert.ok(branch.includes(runtimeNotice));
  assert.ok(branch.includes(firewallNotice));
  assert.equal(
    shouldRenderFirstRunRepairBranch({ gate: { smokeOk: true }, phoenixAppUrl: "http://127.0.0.1:6006", platform: "linux" }),
    false,
  );
  assert.equal(
    shouldRenderFirstRunRepairBranch({ gate: { smokeOk: true }, phoenixAppUrl: "http://127.0.0.1:6006", platform: "win32" }),
    true,
  );

  const stream = new MemoryStream();
  const output = createCliOutput({ stream, color: false, unicode: false });
  renderFirstRunUx({
    output,
    state: HOME_STATE.IDLE,
    commands: COMMANDS,
    plannedProjectText: PLANNED_STEP,
    gate: { smokeOk: false },
    phoenixAppUrl: null,
    platform: "win32",
    includeOfflineBranch: true,
    includeRuntimeFetchNotice: true,
  });
  assert.match(stream.output, /Offline, antivirus, or proxy/);
  assert.ok(stream.output.includes(runtimeNotice));
  assert.ok(stream.output.includes(firewallNotice));
});

test("D0c first-run rendering uses the CLI ASCII fallback", () => {
  const stream = new MemoryStream();
  const output = createCliOutput({ stream, color: false, unicode: false });

  renderFirstRunUx({
    output,
    state: HOME_STATE.IDLE,
    commands: COMMANDS,
    plannedProjectText: PLANNED_STEP,
    gate: { smokeOk: true },
    phoenixAppUrl: "http://127.0.0.1:6006",
    platform: "linux",
    includeOfflineBranch: false,
  });

  assert.match(stream.output, /Setup is resumable: if a step stops/);
  assert.match(stream.output, /\n  -> teami gateway start\s+start polling Linear/);
});
