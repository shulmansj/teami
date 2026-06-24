import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ENGINE_VERSION,
  LEGACY_RUN_ARTIFACT_SCHEMA_VERSION,
  RUN_ARTIFACT_SCHEMA_VERSION,
} from "../../../engine/engine-contract-constants.mjs";
import {
  DECOMPOSITION_FUNCTION_VERSION,
  DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID,
} from "../src/phase-contract.mjs";
import { commitPayload as decompositionCommitPayload } from "../src/workflows/decomposition/commit-payload.mjs";
import {
  assertRunStoreWritable,
  classifyRunArtifactKind,
  classifyRunArtifactSchemaVersion,
  readRunArtifact,
  RUN_ARTIFACT_COMPATIBILITY,
  runArtifactPath,
  validateRunArtifact,
  writeRunArtifact,
} from "../../../engine/run-store.mjs";

test("writeRunArtifact fsyncs the temp file and returns opt-in durability result data", () => {
  const runStoreDir = tempRunStore();
  const originalFsync = fs.fsyncSync;
  let fsyncCalls = 0;
  fs.fsyncSync = (fd) => {
    fsyncCalls += 1;
    return originalFsync(fd);
  };
  try {
    const result = writeRunArtifact(
      {
        runId: "run-durable-result",
        runStoreDir,
        returnDurabilityResult: true,
        payloadValidator: decompositionCommitPayload,
        functionVersion: DECOMPOSITION_FUNCTION_VERSION,
        requireTerminalAudit: true,
      },
      terminalCommitArtifactFor("run-durable-result"),
    );

    assert.deepEqual(result, {
      written: true,
      artifact_schema_valid: true,
      terminal_artifact_schema_valid: true,
      artifact_path: runArtifactPath({ runId: "run-durable-result", runStoreDir }),
    });
    assert.deepEqual(
      readRunArtifact({
        runId: "run-durable-result",
        runStoreDir,
        payloadValidator: decompositionCommitPayload,
        functionVersion: DECOMPOSITION_FUNCTION_VERSION,
        requireTerminalAudit: true,
      }).kind,
      "commit",
    );
    assert.equal(fsyncCalls, process.platform === "win32" ? 1 : 2);
    assert.deepEqual(tmpFiles(runStoreDir), []);
  } finally {
    fs.fsyncSync = originalFsync;
  }
});

test("writeRunArtifact throws on temp fsync failure without a final file or tmp residue", () => {
  const runStoreDir = tempRunStore();
  const finalPath = runArtifactPath({ runId: "run-fsync-fails", runStoreDir });
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw new Error("simulated fsync failure");
  };
  try {
    assert.throws(
      () => writeRunArtifact({ runId: "run-fsync-fails", runStoreDir }, artifactFor("run-fsync-fails")),
      /simulated fsync failure/,
    );
    assert.equal(fs.existsSync(finalPath), false);
    assert.deepEqual(tmpFiles(runStoreDir), []);
  } finally {
    fs.fsyncSync = originalFsync;
  }
});

test("writeRunArtifact throws on temp open failure without reporting success", () => {
  const runStoreDir = tempRunStore();
  const finalPath = runArtifactPath({ runId: "run-open-fails", runStoreDir });
  const originalOpen = fs.openSync;
  fs.openSync = (target, ...args) => {
    const targetPath = String(target);
    if (path.basename(targetPath).startsWith(".run-open-fails.json.")) {
      throw new Error("simulated open failure");
    }
    return originalOpen(target, ...args);
  };
  try {
    assert.throws(
      () => writeRunArtifact({ runId: "run-open-fails", runStoreDir }, artifactFor("run-open-fails")),
      /simulated open failure/,
    );
    assert.equal(fs.existsSync(finalPath), false);
    assert.deepEqual(tmpFiles(runStoreDir), []);
  } finally {
    fs.openSync = originalOpen;
  }
});

test("assertRunStoreWritable creates, fsyncs, and removes a probe file", () => {
  const runStoreDir = tempRunStore();
  assert.deepEqual(assertRunStoreWritable({ runStoreDir }), { ok: true, run_store_dir: runStoreDir });
  assert.deepEqual(tmpFiles(runStoreDir), []);
  assert.deepEqual(fs.readdirSync(runStoreDir), []);
});

test("assertRunStoreWritable throws on probe fsync failure and cleans up", () => {
  const runStoreDir = tempRunStore();
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw new Error("simulated probe fsync failure");
  };
  try {
    assert.throws(
      () => assertRunStoreWritable({ runStoreDir }),
      /simulated probe fsync failure/,
    );
    assert.deepEqual(tmpFiles(runStoreDir), []);
    assert.deepEqual(fs.readdirSync(runStoreDir), []);
  } finally {
    fs.fsyncSync = originalFsync;
  }
});

test("an old terminal artifact without the run-version record still validates (forward-compat)", () => {
  // No accepted_refs / completed_at / execution_mode — exactly a pre-B-REFS
  // artifact. It must remain valid (Q7: recreate-clean, no migration).
  assert.equal(validateRunArtifact(terminalCommitArtifactFor("run-pre-refs")), true);
});

test("validateRunArtifact accepts the legacy v3 decomposition schema for read compatibility", () => {
  assert.equal(validateRunArtifact(legacyTerminalCommitArtifactFor("run-legacy-v3")), true);
});

test("run artifact schema ids and kinds are explicitly classified for compatibility", () => {
  assert.equal(classifyRunArtifactSchemaVersion(RUN_ARTIFACT_SCHEMA_VERSION), "new-write");
  assert.equal(classifyRunArtifactSchemaVersion(LEGACY_RUN_ARTIFACT_SCHEMA_VERSION), "legacy-read");
  assert.equal(classifyRunArtifactSchemaVersion("linear-decomposition-run-artifact/v1"), "delete-after-fixture");
  assert.equal(classifyRunArtifactSchemaVersion("linear-decomposition-run-artifact/v2"), "delete-after-fixture");
  assert.equal(classifyRunArtifactKind("commit"), "legacy-read-and-replay");
  assert.equal(classifyRunArtifactKind("pause"), "legacy-read-and-replay");
  assert.equal(classifyRunArtifactKind("checkpoint"), "legacy-read");
  assert.equal(classifyRunArtifactKind("resume"), "new-write");
  assert.deepEqual(RUN_ARTIFACT_COMPATIBILITY.kinds.checkpoint, "legacy-read");
});

test("readRunArtifact migrates a legacy v3 commit artifact in memory only", () => {
  const runStoreDir = tempRunStore();
  const legacy = writeFixtureArtifact(runStoreDir, "legacy-v3-commit.json");
  const artifactPath = runArtifactPath({ runId: legacy.run_id, runStoreDir });
  const before = fs.readFileSync(artifactPath, "utf8");

  const migrated = readRunArtifact({
    runId: legacy.run_id,
    runStoreDir,
    payloadValidator: decompositionCommitPayload,
    functionVersion: DECOMPOSITION_FUNCTION_VERSION,
    requireTerminalAudit: true,
  });

  assert.equal(migrated.schema_version, RUN_ARTIFACT_SCHEMA_VERSION);
  assert.equal(migrated.engine_version, legacy.workflow_version);
  assert.equal(migrated.function_version, legacy.workflow_version);
  assert.equal(migrated.workflow_version, legacy.workflow_version);
  assert.equal(migrated.payload_schema_id, DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID);
  assert.deepEqual(migrated.payload.final_issues, legacy.final_issues);
  assert.equal(migrated.payload.project_update_markdown, legacy.project_update_markdown);
  assert.deepEqual(migrated.final_issues, legacy.final_issues);
  assert.equal(migrated.project_update_markdown, legacy.project_update_markdown);
  assert.equal(fs.readFileSync(artifactPath, "utf8"), before);
  assert.equal(JSON.parse(before).schema_version, LEGACY_RUN_ARTIFACT_SCHEMA_VERSION);
});

test("readRunArtifact recognizes legacy checkpoint artifacts without making them terminal", () => {
  const runStoreDir = tempRunStore();
  const legacy = writeFixtureArtifact(runStoreDir, "legacy-v3-checkpoint.json");
  const artifactPath = runArtifactPath({ runId: legacy.run_id, runStoreDir });
  const before = fs.readFileSync(artifactPath, "utf8");

  const migrated = readRunArtifact({ runId: legacy.run_id, runStoreDir });

  assert.equal(migrated.schema_version, RUN_ARTIFACT_SCHEMA_VERSION);
  assert.equal(migrated.kind, "checkpoint");
  assert.equal(migrated.engine_version, legacy.workflow_version);
  assert.equal(migrated.function_version, legacy.workflow_version);
  assert.equal(Object.hasOwn(migrated, "payload"), false);
  assert.equal(fs.readFileSync(artifactPath, "utf8"), before);
});

test("generic run envelope accepts a non-decomposition commit payload without final_issues", () => {
  assert.equal(
    validateRunArtifact({
      schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
      engine_version: ENGINE_VERSION,
      function_version: "0.0.1",
      run_id: "probe-1",
      domain_id: "d",
      workspace_id: "w",
      team_id: "t",
      kind: "commit",
      runtime_assignments: {},
      runtime_metadata: {},
      bounds: { rounds_used: 1, max_rounds: 1000 },
      evidence: { perspectives_run: [] },
      payload_schema_id: "probe-run-payload/v1",
      payload: { terminal_output: {}, probe_result: "ok" },
    }),
    true,
  );
});

test("neutral run artifact fixture validates without decomposition payload fields", () => {
  const fixture = loadRunArtifactFixture("neutral-v1-commit.json");
  assert.equal(validateRunArtifact(fixture), true);
  assert.equal(Object.hasOwn(fixture, "final_issues"), false);
  assert.equal(fixture.payload_schema_id, "probe-run-payload/v1");
});

test("definition-supplied payload validator owns decomposition commit payload requirements", () => {
  const artifact = terminalCommitArtifactFor("run-missing-function-payload");
  delete artifact.final_issues;
  delete artifact.payload.final_issues;

  assert.equal(validateRunArtifact(artifact), true);
  assert.throws(
    () =>
      validateRunArtifact(artifact, {
        payloadValidator: decompositionCommitPayload,
        functionVersion: DECOMPOSITION_FUNCTION_VERSION,
        requireTerminalAudit: true,
      }),
    /missing_final_issues/,
  );
});

test("validateRunArtifact accepts a terminal artifact carrying the run-version record", () => {
  const artifact = terminalCommitArtifactFor("run-with-refs");
  artifact.accepted_refs = [
    {
      target_key: "prompt/decomposition/pm_synthesis",
      accepted_baseline_id: "sha256:abc",
      snapshot_sha256: "abc",
    },
  ];
  artifact.completed_at = "2026-06-19T12:00:00.000Z";
  artifact.execution_mode = "live";
  assert.equal(validateRunArtifact(artifact), true);
});

test("validateRunArtifact tolerates null accepted_baseline_id and snapshot_sha256 on a ref", () => {
  const artifact = terminalCommitArtifactFor("run-null-ref-fields");
  artifact.accepted_refs = [
    { target_key: "rule/decomposition/runtime_role_assignments", accepted_baseline_id: null, snapshot_sha256: null },
  ];
  assert.equal(validateRunArtifact(artifact), true);
});

test("validateRunArtifact rejects a malformed run-version record", () => {
  const cases = [
    { mutate: (a) => { a.accepted_refs = {}; }, reason: "invalid_accepted_refs" },
    { mutate: (a) => { a.accepted_refs = ["x"]; }, reason: "invalid_accepted_ref_entry" },
    { mutate: (a) => { a.accepted_refs = [{ accepted_baseline_id: "x" }]; }, reason: "invalid_accepted_ref_target_key" },
    { mutate: (a) => { a.accepted_refs = [{ target_key: "t", accepted_baseline_id: 7 }]; }, reason: "invalid_accepted_ref_accepted_baseline_id" },
    { mutate: (a) => { a.accepted_refs = [{ target_key: "t", snapshot_sha256: 7 }]; }, reason: "invalid_accepted_ref_snapshot_sha256" },
    { mutate: (a) => { a.completed_at = 123; }, reason: "invalid_completed_at" },
    { mutate: (a) => { a.execution_mode = "staging"; }, reason: "invalid_execution_mode" },
  ];
  for (const { mutate, reason } of cases) {
    const artifact = terminalCommitArtifactFor("run-bad-record");
    mutate(artifact);
    assert.throws(() => validateRunArtifact(artifact), new RegExp(reason), `expected ${reason}`);
  }
});

function artifactFor(runId, overrides = {}) {
  return {
    schema_version: RUN_ARTIFACT_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    function_version: DECOMPOSITION_FUNCTION_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "checkpoint",
    run_id: runId,
    domain_id: "support-ops",
    workspace_id: "workspace-1",
    team_id: "team-1",
    runtime_assignments: {
      pm: { runtime: "claude" },
      sr_eng: { runtime: "codex" },
    },
    runtime_metadata: {
      pm: { runtime_name: "claude" },
      sr_eng: { runtime_name: "codex" },
    },
    ...overrides,
  };
}

function terminalCommitArtifactFor(runId) {
  const terminalOutput = {
    run_id: runId,
    outcome: "commit",
    reason: "synthesis_complete",
    context_digest: "Durable commit context.",
    source_refs: [],
    assumptions: [],
    constraints: [],
    risks: [],
  };
  const finalIssues = [validFinalIssue()];
  const projectUpdateMarkdown = [
    `run_id: ${runId}`,
    "",
    "Durable write.",
    "",
    "## What I did with each part of your project",
    "- Captured the synthesized issue set.",
  ].join("\n");
  return artifactFor(runId, {
    kind: "commit",
    terminal_output: terminalOutput,
    evidence: { perspectives_run: [] },
    bounds: { rounds_used: 1, max_rounds: 2 },
    payload_schema_id: DECOMPOSITION_RUN_PAYLOAD_SCHEMA_ID,
    payload: {
      terminal_output: terminalOutput,
      final_issues: finalIssues,
      project_update_markdown: projectUpdateMarkdown,
    },
    final_issues: finalIssues,
    project_update_markdown: projectUpdateMarkdown,
  });
}

function legacyTerminalCommitArtifactFor(runId) {
  return {
    schema_version: LEGACY_RUN_ARTIFACT_SCHEMA_VERSION,
    workflow_version: DECOMPOSITION_FUNCTION_VERSION,
    kind: "commit",
    run_id: runId,
    domain_id: "support-ops",
    workspace_id: "workspace-1",
    team_id: "team-1",
    runtime_assignments: {
      pm: { runtime: "claude" },
      sr_eng: { runtime: "codex" },
    },
    runtime_metadata: {
      pm: { runtime_name: "claude" },
      sr_eng: { runtime_name: "codex" },
    },
    terminal_output: {
      run_id: runId,
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
  };
}

function validFinalIssue() {
  return {
    decomposition_key: "durable-write",
    title: "Persist the durable run artifact",
    issue_body_markdown: "## Assignment\n\nPersist the durable run artifact.",
    depends_on: [],
    assignment: "Persist the durable run artifact.",
    output: "A validated durable run artifact.",
    acceptance_criteria: ["The artifact validates and reads back."],
  };
}

function tempRunStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-factory-run-store-"));
}

function runArtifactFixturePath(name) {
  return path.join(import.meta.dirname, "fixtures", "run-artifacts", name);
}

function loadRunArtifactFixture(name) {
  return JSON.parse(fs.readFileSync(runArtifactFixturePath(name), "utf8"));
}

function writeFixtureArtifact(runStoreDir, name) {
  const artifact = loadRunArtifactFixture(name);
  const filePath = runArtifactPath({ runId: artifact.run_id, runStoreDir });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

function tmpFiles(runStoreDir) {
  return fs.readdirSync(runStoreDir).filter((file) => file.endsWith(".tmp"));
}
