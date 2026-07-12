import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SETUP_DISCLOSURE_HASH,
  SETUP_DISCLOSURE_VERSION,
  SETUP_PHASES,
  aggregateLiveSetupHealth,
  buildLiveSetupSteps,
  createSetupStateStore,
  normalizeSetupRepoIntent,
  runSetupCompletionContract,
  runSharedSetupStateMachine,
  setupEffectsDisclosure,
  verifySetupConsent,
} from "../src/setup-orchestrator.mjs";

test("setup disclosure is versioned, hashed, complete, and requires an exact explicit confirmation", () => {
  const disclosure = setupEffectsDisclosure();
  assert.equal(disclosure.version, SETUP_DISCLOSURE_VERSION);
  assert.equal(disclosure.hash, SETUP_DISCLOSURE_HASH);
  assert.equal(disclosure.effects.length, 6);
  assert.deepEqual(disclosure.effects.map((effect) => effect.id), [
    "linear_workspace",
    "linear_admin_exception",
    "product_repo_allowlist",
    "behavior_repo",
    "claude_plugin",
    "local_state",
  ]);
  const linearEffect = disclosure.effects.find((effect) => effect.id === "linear_workspace");
  assert.match(linearEffect.detail, /create or reconcile.*team.*labels.*project statuses.*project template.*workflow shape/i);
  const adminEffect = disclosure.effects.find((effect) => effect.id === "linear_admin_exception");
  assert.match(adminEffect.retention, /never persisted/i);
  assert.match(adminEffect.retention, /if provider revocation cannot be verified.*setup stays blocked/i);
  assert.match(adminEffect.retention, /revoke Teami access in Linear Settings/i);
  assert.match(adminEffect.retention, /fresh token cannot prove the lost token is gone/i);
  assert.doesNotMatch(adminEffect.retention, /is revoked after/i);
  assert.equal(verifySetupConsent({}).status, "consent_required");
  assert.equal(verifySetupConsent({
    confirm: true,
    disclosureVersion: SETUP_DISCLOSURE_VERSION,
    disclosureHash: "stale",
  }).reason, "setup_disclosure_changed");
  assert.equal(verifySetupConsent({
    confirm: true,
    disclosureVersion: SETUP_DISCLOSURE_VERSION,
    disclosureHash: SETUP_DISCLOSURE_HASH,
  }).ok, true);
});

test("repo intent makes non-code and allowlist choices explicit", () => {
  assert.deepEqual(normalizeSetupRepoIntent({ mode: "non_code" }), { mode: "non_code", repos: [] });
  assert.deepEqual(normalizeSetupRepoIntent({ mode: "allowlist", repos: ["Acme/App", "Acme/App"] }), {
    mode: "allowlist",
    repos: ["Acme/App"],
  });
  assert.throws(() => normalizeSetupRepoIntent(null), /setup_repo_intent_required/);
  assert.throws(() => normalizeSetupRepoIntent({ mode: "allowlist", repos: [] }), /requires_repo/);
});

test("CLI and MCP health observations use one complete live-step contract", async () => {
  const observedAt = "2026-07-11T12:00:00.000Z";
  const steps = buildLiveSetupSteps({
    consent: { status: "healthy", reason: "confirmed" },
    phoenix: { status: "degraded", reason: "unavailable" },
  }, { observedAt });

  assert.deepEqual(steps.map((step) => step.phase), SETUP_PHASES.map((phase) => phase.id));
  assert.equal(steps[0].source, "live");
  assert.equal(steps[0].observed_at, observedAt);
  assert.equal(steps.find((step) => step.phase === "phoenix").status, "degraded");
  assert.equal(steps.find((step) => step.phase === "linear").status, "pending");
  assert.equal(aggregateLiveSetupHealth(steps).status, "blocked");

  const cliSource = fs.readFileSync(new URL("../src/cli/linear-setup-command.mjs", import.meta.url), "utf8");
  const mcpSource = fs.readFileSync(new URL("../src/project-mcp-tools.mjs", import.meta.url), "utf8");
  assert.match(cliSource, /runSetupCompletionContract\(/);
  assert.match(mcpSource, /runSetupCompletionContract\(/);
  assert.doesNotMatch(cliSource, /runSharedSetupStateMachine\(|buildLiveSetupSteps\(/);
  assert.doesNotMatch(mcpSource, /runSharedSetupStateMachine\(|buildLiveSetupSteps\(/);

  const phaseAdapters = Object.fromEntries(SETUP_PHASES.map(({ id }) => [
    id,
    async () => ({ status: id === "phoenix" ? "degraded" : "healthy", reason: `${id}_observed` }),
  ]));
  const cliHealth = await runSetupCompletionContract({ phaseAdapters });
  const fixture = stateFixture();
  try {
    const store = createSetupStateStore({ home: fixture.home, now: fixture.now });
    const state = store.start({ input: fixture.input, consent: fixture.consent });
    const mcpHealth = await runSetupCompletionContract({
      setupId: state.setup_id,
      store,
      phaseAdapters,
    });
    const comparable = (health) => health.steps.map(({ phase, status, reason }) => ({ phase, status, reason }));
    assert.deepEqual(comparable(cliHealth), comparable(mcpHealth));
    assert.equal(store.read(state.setup_id).phases.doctor.status, "healthy");
  } finally {
    fixture.cleanup();
  }
});

test("setup state cannot be created without current consent and persists no OAuth material", () => {
  const fixture = stateFixture();
  try {
    const store = createSetupStateStore({ home: fixture.home, now: fixture.now });
    assert.throws(() => store.start({ input: fixture.input, consent: {} }), /explicit_setup_consent_required/);
    assert.equal(fs.existsSync(path.join(fixture.home, "setup")), false);

    const state = store.start({ input: fixture.input, consent: fixture.consent });
    const raw = fs.readFileSync(path.join(fixture.home, "setup", "sessions", `${state.setup_id}.json`), "utf8");
    assert.doesNotMatch(raw, /access_token|refresh_token|oauth_code|code_verifier|pkce/i);
    assert.equal(state.phases.consent.status, "healthy");
  } finally {
    fixture.cleanup();
  }
});

test("setup state uses one exclusive writer and reclaims it after release", () => {
  const fixture = stateFixture();
  try {
    const store = createSetupStateStore({ home: fixture.home, now: fixture.now });
    const first = store.acquire();
    assert.equal(first.ok, true);
    const second = store.acquire();
    assert.equal(second.ok, false);
    assert.equal(second.reason, "lock_held");
    assert.equal(first.release(), true);
    const third = store.acquire();
    assert.equal(third.ok, true);
    third.release();
  } finally {
    fixture.cleanup();
  }
});

test("active setup discovery reserves ownership while authorization is pending", () => {
  const fixture = stateFixture();
  try {
    const store = createSetupStateStore({ home: fixture.home, now: fixture.now });
    const started = store.start({ input: fixture.input, consent: fixture.consent });
    store.recordPhase(started.setup_id, "linear", {
      status: "awaiting_authorization",
      reason: "callback_pending",
      setupStatus: "awaiting_authorization",
    });
    assert.equal(store.findActive().setup_id, started.setup_id);
    assert.equal(store.findActive({ excludeSetupId: started.setup_id }), null);
    store.recordPhase(started.setup_id, "linear", {
      status: "blocked",
      reason: "authorization_process_restarted",
      setupStatus: "blocked",
    });
    assert.equal(store.findActive(), null);
  } finally {
    fixture.cleanup();
  }
});

test("admin revocation uncertainty is durable and cannot be cleared without verified revoke", () => {
  const fixture = stateFixture();
  try {
    const store = createSetupStateStore({ home: fixture.home, now: fixture.now });
    const started = store.start({ input: fixture.input, consent: fixture.consent });
    const marked = store.markAdminRevocationRequired(started.setup_id);
    assert.deepEqual(marked.admin_revocation_required, {
      status: "required",
      marked_at: "2026-07-11T13:00:00.000Z",
      reason: "one_shot_admin_oauth_started",
    });
    assert.throws(() => store.clearAdminRevocationRequired(started.setup_id), /verification_required/);
    const cleared = store.clearAdminRevocationRequired(started.setup_id, { revokeVerified: true });
    assert.equal(cleared.admin_revocation_required, null);
  } finally {
    fixture.cleanup();
  }
});

test("expired-session cleanup cannot erase unverified admin revocation", () => {
  const fixture = stateFixture();
  let nowMs = Date.parse("2026-07-11T13:00:00.000Z");
  try {
    const store = createSetupStateStore({
      home: fixture.home,
      now: () => nowMs,
      ttlMs: 1_000,
    });
    const started = store.start({ input: fixture.input, consent: fixture.consent });
    store.markAdminRevocationRequired(started.setup_id);
    nowMs += 60_000;
    assert.deepEqual(store.cleanupExpired(), { removed: 0 });
    assert.equal(store.read(started.setup_id).admin_revocation_required.status, "required");
  } finally {
    fixture.cleanup();
  }
});

test("CLI-compatible global admin marker is atomic and clears only after verified revoke", () => {
  const fixture = stateFixture();
  try {
    const store = createSetupStateStore({ home: fixture.home });
    assert.equal(store.readGlobalAdminRevocationRequired(), null);
    const marker = store.markGlobalAdminRevocationRequired({ surface: "cli" });
    assert.equal(marker.surface, "cli");
    assert.equal(store.readGlobalAdminRevocationRequired().status, "required");
    assert.throws(
      () => store.clearGlobalAdminRevocationRequired({ revokeVerified: false }),
      /admin_revoke_verification_required/,
    );
    assert.equal(store.readGlobalAdminRevocationRequired().status, "required");
    assert.equal(store.clearGlobalAdminRevocationRequired({ revokeVerified: true }), true);
    assert.equal(store.readGlobalAdminRevocationRequired(), null);
  } finally {
    fixture.cleanup();
  }
});

test("a fresh token cannot clear interrupted prior-token revocation state", () => {
  const fixture = stateFixture();
  try {
    const store = createSetupStateStore({ home: fixture.home, now: fixture.now });
    const started = store.start({ input: fixture.input, consent: fixture.consent });
    store.markAdminRevocationRequired(started.setup_id);
    store.markGlobalAdminRevocationRequired({ surface: "mcp" });
    assert.deepEqual(store.readAdminRevocationRequirement().setup_ids, [started.setup_id]);
    assert.equal(store.clearAdminRevocationAfterVerifiedCleanup, undefined);
    assert.equal(store.readGlobalAdminRevocationRequired().status, "required");
    assert.deepEqual(store.readAdminRevocationRequirement().setup_ids, [started.setup_id]);
    const state = store.read(started.setup_id);
    assert.equal(state.admin_revocation_required.status, "required");
    assert.equal(state.admin_revocation_confirmation, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("live health, never receipts, is the sole source of complete", () => {
  const live = healthyLiveSteps();
  assert.deepEqual(aggregateLiveSetupHealth(live), {
    ok: true,
    status: "complete",
    reason: null,
    steps: live.map((step) => ({ ...step, reason: null, repair: null })),
  });
  assert.throws(() => aggregateLiveSetupHealth([
    { phase: "consent", status: "healthy", source: "receipt", observed_at: live[0].observed_at },
  ]), /requires_live_source/);

  const pluginFailed = live.map((step) => step.phase === "plugin" ? { ...step, status: "degraded" } : step);
  assert.equal(aggregateLiveSetupHealth(pluginFailed).status, "blocked");
  const phoenixFailed = live.map((step) => step.phase === "phoenix" ? { ...step, status: "degraded" } : step);
  assert.deepEqual(
    { ok: aggregateLiveSetupHealth(phoenixFailed).ok, status: aggregateLiveSetupHealth(phoenixFailed).status },
    { ok: false, status: "degraded" },
  );
});

test("shared state machine records receipts but derives its verdict from the injected live health", async () => {
  const fixture = stateFixture();
  try {
    const store = createSetupStateStore({ home: fixture.home, now: fixture.now });
    const started = store.start({ input: fixture.input, consent: fixture.consent });
    const calls = [];
    const result = await runSharedSetupStateMachine({
      setupId: started.setup_id,
      store,
      phaseRunners: {
        linear: async () => {
          calls.push("linear");
          return { status: "healthy" };
        },
        product_repos: async () => {
          calls.push("product_repos");
          return { status: "healthy" };
        },
      },
      liveHealth: async () => healthyLiveSteps(),
    });
    assert.equal(result.status, "complete");
    assert.deepEqual(calls, ["linear", "product_repos"]);
    const persisted = store.read(started.setup_id);
    assert.equal(persisted.phases.linear.status, "healthy");
    assert.equal(persisted.phases.product_repos.status, "healthy");
  } finally {
    fixture.cleanup();
  }
});

function stateFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-shared-setup-"));
  return {
    home,
    now: () => Date.parse("2026-07-11T13:00:00.000Z"),
    input: {
      domain: "Support Ops",
      workspace: "Example Workspace",
      repo_intent: { mode: "non_code" },
      github_owner: "Acme",
      github_repo: "teami-behavior",
    },
    consent: {
      confirmed: true,
      version: SETUP_DISCLOSURE_VERSION,
      hash: SETUP_DISCLOSURE_HASH,
    },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

function healthyLiveSteps() {
  return SETUP_PHASES.map((phase) => ({
    phase: phase.id,
    status: "healthy",
    source: "live",
    observed_at: "2026-07-11T13:00:00.000Z",
  }));
}
