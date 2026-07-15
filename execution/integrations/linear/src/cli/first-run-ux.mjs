import { oauthFirewallHint } from "../linear-oauth.mjs";
import { runtimeFetchDegradationNotice } from "../local-phoenix-manager.mjs";
import { HOME_STATE } from "./home-state.mjs";
import { formatCommand } from "./operator-output.mjs";

const DEFAULT_PLANNED_PROJECT_TEXT = 'Run /teami:plan in a new Claude Code session to shape your first project';

function firstRunCommands(overrides = {}) {
  return {
    init: formatCommand("init"),
    doctor: formatCommand("doctor"),
    gatewayStart: formatCommand("gateway start"),
    gatewayStatus: formatCommand("gateway status"),
    ...overrides,
  };
}

function normalizeHomeState(state) {
  return Object.values(HOME_STATE).includes(state) ? state : HOME_STATE.IDLE;
}

export function firstRunPlan({
  state = HOME_STATE.IDLE,
  phoenixAppUrl = null,
  commands: commandOverrides = {},
  plannedProjectText = DEFAULT_PLANNED_PROJECT_TEXT,
} = {}) {
  const commands = firstRunCommands(commandOverrides);
  const normalizedState = normalizeHomeState(state);

  if (normalizedState === HOME_STATE.UNINITIALIZED) {
    return [
      { text: commands.init, hint: "resume setup from the next unfinished step" },
      { text: commands.doctor, hint: "show the red check and exact fix" },
    ];
  }

  if (normalizedState === HOME_STATE.DEGRADED) {
    return [
      { text: commands.doctor, hint: "show the red check and exact fix" },
      { text: commands.init, hint: "repair setup; safe to rerun" },
    ];
  }

  if (normalizedState === HOME_STATE.LISTENING) {
    return [
      { text: plannedProjectText, hint: "Teami will guide the planning conversation" },
    ];
  }

  return [
    { text: plannedProjectText, hint: "Teami will guide the planning conversation" },
  ];
}

export function firstRunStatusLine({ state = HOME_STATE.IDLE } = {}) {
  const normalizedState = normalizeHomeState(state);
  if (normalizedState === HOME_STATE.UNINITIALIZED) {
    return "Setup has not finished yet.";
  }
  if (normalizedState === HOME_STATE.DEGRADED) {
    return "Setup is recorded, but local state needs a doctor check before the first run.";
  }
  if (normalizedState === HOME_STATE.LISTENING) {
    return "Setup is complete and Teami is listening.";
  }
  return "Setup is complete.";
}

export function shouldIncludeRuntimeFetchNotice({ gate = null, phoenixAppUrl = null } = {}) {
  return gate?.smokeOk === false || !phoenixAppUrl;
}

export function shouldRenderFirstRunRepairBranch({
  gate = null,
  phoenixAppUrl = null,
  platform = process.platform,
} = {}) {
  return shouldIncludeRuntimeFetchNotice({ gate, phoenixAppUrl }) || oauthFirewallHint({ platform }) !== null;
}

export function firstRunOfflineProxyBranch({
  platform = process.platform,
  includeRuntimeFetchNotice = true,
  commands: commandOverrides = {},
} = {}) {
  const commands = firstRunCommands(commandOverrides);
  const notices = [];
  if (includeRuntimeFetchNotice) notices.push(runtimeFetchDegradationNotice());
  const firewallHint = oauthFirewallHint({ platform });
  if (firewallHint) notices.push(firewallHint);
  notices.push(
    `If you are offline, behind a proxy, or security software blocks the browser callback or GitHub Releases download, allow it and rerun ${commands.init}. Setup is resumable.`,
  );
  return notices;
}

export function renderFirstRunUx({
  output,
  probe = null,
  state = probe?.state || HOME_STATE.IDLE,
  phoenixAppUrl = null,
  gate = null,
  platform = process.platform,
  commands: commandOverrides = {},
  plannedProjectText = DEFAULT_PLANNED_PROJECT_TEXT,
  includeOfflineBranch = shouldRenderFirstRunRepairBranch({ gate, phoenixAppUrl, platform }),
  includeRuntimeFetchNotice = shouldIncludeRuntimeFetchNotice({ gate, phoenixAppUrl }),
} = {}) {
  if (!output) throw new Error("first_run_output_required");
  const commands = firstRunCommands(commandOverrides);
  const normalizedState = normalizeHomeState(state);

  output.section("First run");
  output.info(firstRunStatusLine({ state: normalizedState }));
  if ([HOME_STATE.UNINITIALIZED, HOME_STATE.DEGRADED].includes(normalizedState)) {
    output.info(`Setup is resumable: if a step stops, fix it and run ${commands.init} again.`);
  }
  output.nextSteps(firstRunPlan({
    state: normalizedState,
    phoenixAppUrl,
    commands,
    plannedProjectText,
  }));

  if (includeOfflineBranch) {
    output.section("Offline, antivirus, or proxy");
    for (const line of firstRunOfflineProxyBranch({
      platform,
      includeRuntimeFetchNotice,
      commands,
    })) {
      output.info(line);
    }
  }
}

export { DEFAULT_PLANNED_PROJECT_TEXT };
