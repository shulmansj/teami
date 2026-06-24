import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMockGitHubTransport } from "../src/github-promotion-client.mjs";
import { GITHUB_CONNECTION_SCHEMA_VERSION } from "../src/github-setup.mjs";
import {
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import { DECOMPOSITION_FUNCTION_VERSION } from "../src/phase-contract.mjs";
import {
  buildPromotionMarker,
  renderPromotionMarkerBlock,
} from "../src/promote-candidate.mjs";
import {
  buildMarkerUndoBounds,
  buildMergedAcceptedRef,
} from "../src/promotion/marker-undo-frame.mjs";
import {
  collectPhase2ProposalWorklist,
  PHASE_2_PROPOSAL_STATE_NAMES,
} from "../src/promotion/proposal-worklist-read-model.mjs";
import { PROMOTION_REGISTRY_SCHEMA_VERSION } from "../src/promotion/registry-store.mjs";
import { writeRunArtifact } from "../../../engine/run-store.mjs";

// ---------------------------------------------------------------------------
// B-READ (S-READ): the read-time undo answer. At worklist-read time, for a
// MERGED proposal, `consumed_downstream` (tri-state) is computed by joining the
// run-version records (B-REFS) against the marker's post-merge version
// reference (`merged_accepted_ref`, B-UNDO), filtered to the live (non-eval)
// run mode. Because the run-version refs are captured AT LOAD and a candidate
// becomes the accepted baseline ONLY on merge, a captured-ref MATCH already
// implies the run loaded the post-merge version (downstream use) — so there is
// NO merge-time boundary; the ref match is the signal. `reversible` requires
// BOTH `consumed_downstream === "not_used"` AND that this version is still the
// CURRENT accepted version for the target (not superseded by a later merge).
// These tests exercise the join, the conservative tri-state unknown, the
// supersede gate, and the worklist-level authority assertion (a stale registry
// cache must not override live marker/PR state).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-17T12:00:00.000Z");
const MERGED_AT = "2026-06-17T11:30:00.000Z";
const TARGET = "prompt/decomposition/decomposition_quality_judge";
const TARGET_SNAPSHOT_PATH =
  "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-undo-answer-"));
}

function hex(label) {
  return createHash("sha256").update(label).digest("hex");
}

function writeVerifiedGitHubState(root) {
  const filePath = path.join(root, ".agentic-factory", "github-connection.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    schema_version: GITHUB_CONNECTION_SCHEMA_VERSION,
    connection_mode: "dry_run",
    status: "verified",
    repo: {
      id: "repo-1",
      owner: "factory-owner",
      name: "behavior-rules",
      full_name: "factory-owner/behavior-rules",
    },
    app_installation: {
      installation_id: "install-1",
      app_slug: "agentic-factory",
      repository_selection: "selected",
      selected_repository_ids: ["repo-1"],
      selected_repository_full_names: ["factory-owner/behavior-rules"],
      verified_exact: true,
      dry_run: true,
    },
    default_branch: "main",
    verified_at: NOW.toISOString(),
  }, null, 2)}\n`);
}

// Pin TARGET in a minimal phoenix-assets manifest under `root`, content-
// addressing a controllable snapshot. The supersede check resolves the CURRENT
// accepted ref for TARGET against this manifest, so writing the merged snapshot
// bytes here makes the merged version "still current" (not superseded); writing
// DIFFERENT bytes makes it superseded. When `versionId` is provided it is the
// accepted_prompt_version_id (so accepted_baseline_id is the version id);
// otherwise the accepted_baseline_id resolves to `sha256:<snapshot_sha256>`.
function writeAcceptedManifest(root, { snapshotBytes, versionId = null } = {}) {
  const bytes = Buffer.from(snapshotBytes ?? "current-accepted-snapshot");
  const snapshotPath = path.join(root, TARGET_SNAPSHOT_PATH);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, bytes);
  const snapshotSha256 = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = path.join(root, "execution", "evals", "decomposition", "phoenix-assets.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    schema_version: 1,
    prompts: [
      {
        role: "decomposition_quality_judge",
        target_key: TARGET,
        artifact_kind: "accepted_prompt",
        accepted_prompt_version_id: versionId,
        snapshot_path: TARGET_SNAPSHOT_PATH,
        snapshot_sha256: snapshotSha256,
      },
    ],
    rules: [],
    datasets: [],
  }, null, 2)}\n`);
  return { snapshotSha256 };
}

// The NEW (post-merge) version the candidate becomes — what `merged_accepted_ref`
// pins and what a downstream run that consumed the merged behavior records.
// Built from the SAME bytes the "still current" manifest pins, so a match means
// the merged version is still the current accepted version (not superseded).
const MERGED_SNAPSHOT_BYTES = "current-accepted-snapshot";
const NEW_PROMPT_SHA256 = createHash("sha256").update(Buffer.from(MERGED_SNAPSHOT_BYTES)).digest("hex");
const NEW_PROMPT_VERSION_ID = "PV-merged";

// Make the merged version "still current" for the supersede check: pin TARGET to
// the merged bytes AND the merged version id.
function writeCurrentAcceptedIsMerged(root) {
  writeAcceptedManifest(root, { snapshotBytes: MERGED_SNAPSHOT_BYTES, versionId: NEW_PROMPT_VERSION_ID });
}

function mergedAcceptedRefForPrompt() {
  return buildMergedAcceptedRef({
    candidateTargetKey: TARGET,
    humanSummary: { kind: "prompt", new_pinned_version_id: NEW_PROMPT_VERSION_ID },
    changedArtifacts: [{ kind: "accepted_prompt", new_sha256: NEW_PROMPT_SHA256 }],
  });
}

// Build a merged-proposal marker carrying the B-UNDO static frame + the
// post-merge join key, exactly as the proposal path would.
function mergedMarker({ proposalInstanceId, withUndoFrame = true } = {}) {
  const envelopeHash = hex(proposalInstanceId);
  return buildPromotionMarker({
    proposalInstanceId,
    candidateTargetKey: TARGET,
    candidateKind: "prompt",
    candidateVersionId: "PV1",
    acceptedBaselineId: "sha256:old-accepted",
    normalizedEnvelopeHash: envelopeHash,
    policyHash: "policy-hash",
    phoenixScope: { origin: "http://127.0.0.1:6006", project_name: "agentic-factory" },
    evidenceIds: { experiments: ["EXP1"], datasets: [], annotations: [] },
    proposalState: "proposed",
    undoBounds: withUndoFrame
      ? buildMarkerUndoBounds({
          humanSummary: { kind: "prompt", old_pinned_version_id: "PV0" },
          candidateKind: "prompt",
        })
      : null,
    mergedAcceptedRef: withUndoFrame ? mergedAcceptedRefForPrompt() : null,
  });
}

function mergedPr({ number, proposalInstanceId, withUndoFrame = true }) {
  return {
    number,
    state: "closed",
    title: `Accepted proposal ${number}`,
    body: renderPromotionMarkerBlock(mergedMarker({ proposalInstanceId, withUndoFrame })),
    head: { ref: `agentic-factory/promotion/prompt-decomposition-decomposition-quality-judge/${number}` },
    html_url: `mock://github/factory-owner/behavior-rules/pull/${number}`,
    created_at: "2026-06-17T10:00:00.000Z",
    closed_at: MERGED_AT,
    merged_at: MERGED_AT,
    mergeable: true,
  };
}

// Persist a terminal (commit-kind) decomposition run artifact carrying the
// run-version record (B-REFS): accepted_refs + completed_at + execution_mode.
function writeRunArtifactFixture(runStoreDir, runId, {
  acceptedRefs = null,
  completedAt = null,
  executionMode = "live",
} = {}) {
  const artifact = {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "commit",
    run_id: runId,
    domain_id: "support-ops",
    workspace_id: "workspace-1",
    team_id: "team-1",
    runtime_assignments: { pm: { runtime: "claude" } },
    runtime_metadata: { pm: { runtime_name: "claude" } },
    terminal_output: {
      outcome: "commit",
      reason: "synthesis_complete",
      context_digest: "Durable commit context.",
      source_refs: [],
      assumptions: [],
      constraints: [],
      risks: [],
    },
    evidence: { perspectives_run: [] },
    bounds: { rounds_used: 1, max_rounds: 2 },
    final_issues: [],
    project_update_markdown: `run_id: ${runId}\n\nDurable write.`,
    ...(Array.isArray(acceptedRefs) ? { accepted_refs: acceptedRefs } : {}),
    ...(completedAt !== null ? { completed_at: completedAt } : {}),
    ...(executionMode !== null ? { execution_mode: executionMode } : {}),
  };
  writeRunArtifact({ runStoreDir, runId }, artifact);
}

// The run-version ref a downstream run records when it consumes the MERGED
// accepted version (same normalized shape as `merged_accepted_ref`).
function consumingRef() {
  return {
    target_key: TARGET,
    accepted_baseline_id: NEW_PROMPT_VERSION_ID,
    snapshot_sha256: NEW_PROMPT_SHA256,
  };
}

function undoAnswerFor(report, proposalInstanceId) {
  const item = report.items.find((candidate) => candidate.id === `proposal:${proposalInstanceId}`);
  assert.ok(item, `merged proposal item ${proposalInstanceId} should exist`);
  return { item, answer: item.optional_technical?.undo_answer };
}

test("B-READ: a merged change with no matching live run is not_used + reversible (still current)", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  // The merged version is still the current accepted version (not superseded).
  writeCurrentAcceptedIsMerged(root);
  // A LIVE run carries a usable ref for THIS target, but a DIFFERENT version —
  // so negative coverage exists, and none match ⇒ not_used.
  writeRunArtifactFixture(runStoreDir, "run-live-other-version", {
    completedAt: "2026-06-17T11:45:00.000Z",
    executionMode: "live",
    acceptedRefs: [{
      target_key: TARGET,
      accepted_baseline_id: "PV-some-other-version",
      snapshot_sha256: hex("other-version"),
    }],
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 21, proposalInstanceId: "prop-not-used" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { item, answer } = undoAnswerFor(report, "prop-not-used");

  assert.ok(answer, "merged proposal should carry an undo answer");
  assert.equal(answer.consumed_downstream, "not_used");
  assert.equal(answer.superseded, false);
  assert.equal(answer.reversible, true);
  assert.ok(answer.undo_bounds, "the static undo frame should be surfaced from the marker");
  assert.equal(answer.undo_bounds.external_side_effects, false);
  assert.match(answer.undo_bounds.what_undo_changes, /previously accepted version PV0/);
  assert.ok(item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.UNDO_CLOSE));
});

test("B-READ: a merged change a live run consumed is used + not reversible", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  writeCurrentAcceptedIsMerged(root);
  // A LIVE run that consumed THIS target's merged version (captured at load ⇒
  // the run loaded the post-merge version ⇒ downstream consumption).
  writeRunArtifactFixture(runStoreDir, "run-live-match", {
    completedAt: "2026-06-17T11:45:00.000Z",
    executionMode: "live",
    acceptedRefs: [consumingRef()],
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 22, proposalInstanceId: "prop-used" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { answer } = undoAnswerFor(report, "prop-used");

  assert.equal(answer.consumed_downstream, "used");
  assert.equal(answer.reversible, false);
});

test("B-READ: the merge-time boundary is gone — a captured-ref match counts even with an earlier completed_at", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  writeCurrentAcceptedIsMerged(root);
  // A LIVE run whose `completed_at` is BEFORE merged_at but whose CAPTURED ref
  // matches the merged version. With refs captured at load, a match can only
  // mean the run loaded the post-merge accepted baseline; a clock-skew /
  // run-straddling-the-merge time gate would WRONGLY discard this. The ref
  // match is the signal ⇒ used.
  writeRunArtifactFixture(runStoreDir, "run-clock-skew-match", {
    completedAt: "2026-06-17T11:00:00.000Z", // earlier than MERGED_AT 11:30
    executionMode: "live",
    acceptedRefs: [consumingRef()],
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 26, proposalInstanceId: "prop-clock-skew" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { answer } = undoAnswerFor(report, "prop-clock-skew");

  assert.equal(
    answer.consumed_downstream,
    "used",
    "a captured-ref match implies post-merge consumption regardless of completed_at",
  );
  assert.equal(answer.reversible, false);
});

test("B-READ: a merged change with no run-version signal is unknown (possibly-used, conservative)", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  writeCurrentAcceptedIsMerged(root);
  // The run store is empty — the change predates any run-version record.
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 23, proposalInstanceId: "prop-unknown" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { answer } = undoAnswerFor(report, "prop-unknown");

  assert.equal(answer.consumed_downstream, "unknown");
  assert.equal(answer.reversible, false, "unknown must be treated as possibly-used (not reversible)");
});

test("B-READ (Fix 2): a live run with NO usable refs for the target ⇒ unknown, never not_used", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  writeCurrentAcceptedIsMerged(root);
  // A LIVE run with EMPTY accepted_refs has no usable signal for the target. It
  // must not be counted as negative coverage ⇒ unknown (conservative), NOT
  // not_used.
  writeRunArtifactFixture(runStoreDir, "run-live-no-refs", {
    completedAt: "2026-06-17T11:45:00.000Z",
    executionMode: "live",
    // No accepted_refs at all (field omitted).
  });
  // A second live run carries refs only for a DIFFERENT target — also not a
  // usable signal for THIS target.
  writeRunArtifactFixture(runStoreDir, "run-live-different-target", {
    completedAt: "2026-06-17T11:50:00.000Z",
    executionMode: "live",
    acceptedRefs: [{
      target_key: "prompt/decomposition/some_other_target",
      accepted_baseline_id: "PV-other",
      snapshot_sha256: hex("other"),
    }],
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 27, proposalInstanceId: "prop-no-usable-refs" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { answer } = undoAnswerFor(report, "prop-no-usable-refs");

  assert.equal(
    answer.consumed_downstream,
    "unknown",
    "a live run with no usable refs for the target is not negative coverage",
  );
  assert.equal(answer.reversible, false);
});

test("B-READ (mixed evidence): a run that touched the target at an UNKNOWN version forbids not_used, even with another run's negative coverage", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  writeCurrentAcceptedIsMerged(root);
  // R0: a live run that consumed THIS target at an older, non-merged version —
  // real negative coverage on its own (this alone would read not_used).
  writeRunArtifactFixture(runStoreDir, "run-negative-coverage", {
    completedAt: "2026-06-17T11:45:00.000Z",
    executionMode: "live",
    acceptedRefs: [{
      target_key: TARGET,
      accepted_baseline_id: "PV-some-other-version",
      snapshot_sha256: hex("other-version"),
    }],
  });
  // R1: a live run that TOUCHED this target but at an UNKNOWN version — an
  // unjoinable coverage marker (a non-surfacing executor, or runtime defaults
  // whose load-time ref was lost). It MIGHT have consumed the merged version, so
  // the owner must NOT be told not_used/reversible on R0's coverage alone.
  writeRunArtifactFixture(runStoreDir, "run-unjoinable-coverage", {
    completedAt: "2026-06-17T11:50:00.000Z",
    executionMode: "live",
    acceptedRefs: [{ target_key: TARGET, accepted_baseline_id: null, snapshot_sha256: null }],
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 30, proposalInstanceId: "prop-mixed-evidence" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { answer } = undoAnswerFor(report, "prop-mixed-evidence");

  assert.equal(
    answer.consumed_downstream,
    "unknown",
    "an inconclusive run (touched the target at an unknown version) must poison a confident not_used",
  );
  assert.equal(answer.reversible, false, "unknown is possibly-used ⇒ not reversible");
});

test("B-READ (Fix 3): a superseded change is not reversible even when not_used", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  // The CURRENT accepted version for TARGET is a DIFFERENT (newer) version: a
  // later PR merged a newer version of the same target, superseding this one.
  writeAcceptedManifest(root, { snapshotBytes: "a-newer-accepted-snapshot", versionId: "PV-newer" });
  // No live run consumed the merged version ⇒ not_used on its own.
  writeRunArtifactFixture(runStoreDir, "run-live-other-version", {
    completedAt: "2026-06-17T11:45:00.000Z",
    executionMode: "live",
    acceptedRefs: [{
      target_key: TARGET,
      accepted_baseline_id: "PV-some-other-version",
      snapshot_sha256: hex("other-version"),
    }],
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 28, proposalInstanceId: "prop-superseded" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { answer } = undoAnswerFor(report, "prop-superseded");

  assert.equal(answer.consumed_downstream, "not_used");
  assert.equal(answer.superseded, true, "a newer accepted version of the target supersedes this one");
  assert.equal(answer.reversible, false, "undoing a superseded change is not clean");
});

test("B-READ: when the current accepted ref cannot be resolved, superseded is unknown ⇒ not reversible", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  // No phoenix-assets manifest under root ⇒ the current accepted ref cannot be
  // resolved ⇒ superseded is "unknown" ⇒ conservative (not reversible) even
  // though no run consumed the change.
  writeRunArtifactFixture(runStoreDir, "run-live-other-version", {
    completedAt: "2026-06-17T11:45:00.000Z",
    executionMode: "live",
    acceptedRefs: [{
      target_key: TARGET,
      accepted_baseline_id: "PV-some-other-version",
      snapshot_sha256: hex("other-version"),
    }],
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 29, proposalInstanceId: "prop-supersede-unknown" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { answer } = undoAnswerFor(report, "prop-supersede-unknown");

  assert.equal(answer.consumed_downstream, "not_used");
  assert.equal(answer.superseded, "unknown");
  assert.equal(answer.reversible, false);
});

test("B-READ: an eval-only run does NOT count as consumption", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  writeCurrentAcceptedIsMerged(root);
  // A run that DID consume this target's merged version, but in EVAL mode —
  // read-only, so it is excluded from consumption AND from establishing
  // not_used coverage ⇒ unknown.
  writeRunArtifactFixture(runStoreDir, "run-eval", {
    completedAt: "2026-06-17T11:45:00.000Z",
    executionMode: "eval",
    acceptedRefs: [consumingRef()],
  });
  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 24, proposalInstanceId: "prop-eval-only" })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });
  const { answer } = undoAnswerFor(report, "prop-eval-only");

  assert.equal(
    answer.consumed_downstream,
    "unknown",
    "an eval-only run is read-only; it neither consumes nor establishes coverage",
  );
  assert.equal(answer.reversible, false);
});

test("B-READ worklist authority: a stale registry cache must not override live marker/PR state", async () => {
  const root = tempRoot();
  const runStoreDir = path.join(root, ".agentic-factory", "runs");
  writeVerifiedGitHubState(root);
  writeCurrentAcceptedIsMerged(root);

  const proposalInstanceId = "prop-authority";
  const envelopeHash = hex(proposalInstanceId);
  // A STALE registry cache row claims this proposal is still an OPEN PR (an
  // earlier snapshot). Live PR state below says it is MERGED and accepted.
  const registryDir = path.join(root, ".agentic-factory", "promotion-candidates");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(path.join(registryDir, `${envelopeHash}.json`), `${JSON.stringify({
    schema_version: PROMOTION_REGISTRY_SCHEMA_VERSION,
    normalized_envelope_hash: envelopeHash,
    proposal_instance_id: proposalInstanceId,
    candidate_target_key: TARGET,
    candidate_kind: "prompt",
    candidate_version_id: "PV1",
    accepted_baseline_id: "sha256:old-accepted",
    receipt_id: "expr-authority",
    phoenix_scope: { origin: "http://127.0.0.1:6006", project_name: "agentic-factory" },
    evidence_ids: { experiments: ["EXP1"], datasets: [], annotations: [] },
    // Stale cache asserts an OPEN PR #99 (a number that does NOT exist live).
    pr: { number: 99, url: "mock://pr/99", state: "open", dry_run: true },
    outcome: { outcome: "opened", reason: "pr_opened" },
    repair_state: "none",
    last_stage: "pr_opened",
    events: [{ stage: "pr_opened", at: "2026-06-17T10:30:00.000Z" }],
  }, null, 2)}\n`);

  // No live run consumed the merged version ⇒ not_used + reversible (still current).
  writeRunArtifactFixture(runStoreDir, "run-authority-other", {
    completedAt: "2026-06-17T11:45:00.000Z",
    executionMode: "live",
    acceptedRefs: [{
      target_key: TARGET,
      accepted_baseline_id: "PV-some-other-version",
      snapshot_sha256: hex("other-version"),
    }],
  });

  const transport = createMockGitHubTransport({
    openPullRequests: [],
    closedPullRequests: [mergedPr({ number: 50, proposalInstanceId })],
  });

  const report = await collectPhase2ProposalWorklist({
    repoRoot: root,
    registryDir,
    runStoreDir,
    githubTransport: transport,
    now: () => NOW,
  });

  // The stale registry row (proposal_instance_id matches) and the live merged
  // PR marker dedupe to ONE item — and the live merged state, not the stale
  // "open PR #99" cache, governs the surfaced undo answer.
  const matching = report.items.filter((item) => item.id === `proposal:${proposalInstanceId}`);
  assert.equal(matching.length, 1, "stale registry row and live merged marker must dedupe to one item");
  const item = matching[0];

  // Live PR state is authoritative: the item carries the merged undo answer.
  assert.ok(item.optional_technical?.undo_answer, "merged undo answer should come from live PR state");
  assert.equal(item.optional_technical.undo_answer.consumed_downstream, "not_used");
  assert.equal(item.optional_technical.undo_answer.reversible, true);
  assert.ok(
    item.states.includes(PHASE_2_PROPOSAL_STATE_NAMES.UNDO_CLOSE),
    "live merged PR state must surface the undo/close fact, not the stale open-PR cache",
  );
  // The stale cache must not have created a SECOND, separately-keyed open-PR
  // item (#99 does not exist live).
  assert.equal(
    report.items.some((candidate) => candidate.id === "proposal-pr:99"),
    false,
    "the stale cache's open-PR number must not surface as a live proposal",
  );
});
