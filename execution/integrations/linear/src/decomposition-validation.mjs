import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadLinearConfig } from "./config.mjs";
import { createSnapshotEvalLinearClient } from "./decomposition-eval-cli.mjs";
import { validateOrchestratorOutput } from "../../../engine/orchestrator-output.mjs";
import { runDecompositionEvalMode } from "./trigger-runner.mjs";
import { commitPayload as decompositionCommitPayload } from "./workflows/decomposition/commit-payload.mjs";

const MODULE_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..", "..");
const FROZEN_PROJECT_FIXTURE_PATH = path.resolve(
  MODULE_DIR,
  "..",
  "test",
  "fixtures",
  "decomposition-validation",
  "commit-capable-project.json",
);

const REQUIRED_RUNTIME_PROBES = Object.freeze(["claude", "codex"]);
const EXPECTED_SUBAGENT_FAMILIES = Object.freeze([
  Object.freeze({ role: "pm", runtime: "claude" }),
  Object.freeze({ role: "sr_eng", runtime: "codex" }),
]);
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const VALIDATION_SCOPE_CAVEAT =
  "Scope caveat: eval mode has no lease renewal, so a green validation run does not prove the hosted lease/long-turn path is safe; this is not a security-spine proof.";

export function defaultValidationOperatorDir() {
  const base = process.platform === "win32" ? "C:\\tmp" : os.tmpdir();
  return path.resolve(base, "agentic-factory-decomposition-validation");
}

export function defaultValidationRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[^A-Za-z0-9_-]/g, "_");
  return `decomposition_validation_${stamp}`;
}

export async function probeRuntimeBinary(binary, {
  spawnImpl = spawn,
  timeoutMs = 15_000,
} = {}) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timer = null;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnImpl(binary, ["--version"], {
        stdio: "ignore",
        shell: process.platform === "win32",
      });
    } catch (error) {
      settle({
        ok: false,
        binary,
        reason: "spawn_error",
        detail: oneLine(error?.message || String(error)),
      });
      return;
    }

    timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        // Best effort timeout cleanup; the precondition result is the signal.
      }
      settle({ ok: false, binary, reason: "timeout", detail: `${binary} --version timed out` });
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (error) => {
      settle({
        ok: false,
        binary,
        reason: error?.code || "spawn_error",
        detail: oneLine(error?.message || String(error)),
      });
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        settle({ ok: true, binary });
        return;
      }
      settle({
        ok: false,
        binary,
        reason: signal ? `signal_${signal}` : `exit_${code}`,
        detail: `${binary} --version exited ${signal || code}`,
      });
    });
  });
}

export async function checkRuntimePreconditions({
  binaries = REQUIRED_RUNTIME_PROBES,
  probeBinary = probeRuntimeBinary,
} = {}) {
  const results = [];
  for (const binary of binaries) {
    results.push(await probeBinary(binary));
  }
  const failures = results.filter((result) => !result?.ok);
  if (failures.length === 0) {
    return { ok: true, results };
  }

  return {
    ok: false,
    results,
    failures,
    message: formatRuntimePreconditionFailure(failures),
  };
}

export function formatRuntimePreconditionFailure(failures = []) {
  const failed = failures
    .map((failure) => `${failure.binary || "unknown"} (${failure.reason || "not_ready"})`)
    .join(", ");
  return oneLine(
    `Validation precondition failed: ${failed} could not run with --version. Ensure the required CLIs are installed on PATH and authenticated, then retry.`,
  );
}

export function loadFrozenWebhookInboxProject({
  fixturePath = FROZEN_PROJECT_FIXTURE_PATH,
  config = null,
} = {}) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const project = fixture?.input?.project;
  if (!project?.id) {
    throw new Error(`Frozen validation fixture is missing input.project.id: ${fixturePath}`);
  }
  return normalizeFixtureProject(project, { config });
}

export function normalizeFixtureProject(project, { config = null } = {}) {
  return {
    id: project.id,
    name: project.name,
    description: typeof project.description === "string" ? project.description : null,
    content: project.content,
    status: normalizeFixtureStatus(project.status, { config }),
    labels: normalizeFixtureLabels(project.labels, "validation-project-label"),
    existing_issues: Array.isArray(project.existing_issues)
      ? project.existing_issues.map((issue, index) => ({
        ...issue,
        labels: normalizeFixtureLabels(issue?.labels, `validation-issue-${index}-label`),
      }))
      : [],
  };
}

export function createLocalValidationDomainContext({ teamId = "eval-team-1" } = {}) {
  const workspaceId = "local-validation-workspace";
  return Object.freeze({
    domainId: "local-validation",
    linear: Object.freeze({
      workspaceId,
      teamId,
    }),
    trace: Object.freeze({
      domain_id: "local-validation",
      workspace_id: workspaceId,
      team_id: teamId,
      behavior_repo_id: "local-validation-behavior-repo",
    }),
  });
}

export async function runDecompositionValidation({
  repoRoot = REPO_ROOT,
  config = null,
  loadConfig = loadLinearConfig,
  fixturePath = FROZEN_PROJECT_FIXTURE_PATH,
  operatorDir = defaultValidationOperatorDir(),
  runStoreDir = null,
  runId = defaultValidationRunId(),
  runEvalMode = runDecompositionEvalMode,
  validateOutput = validateDecompositionOrchestratorOutput,
} = {}) {
  const resolvedConfig = config || loadConfig({ repoRoot });
  const project = loadFrozenWebhookInboxProject({ fixturePath, config: resolvedConfig });
  const snapshot = createSnapshotEvalLinearClient({ config: resolvedConfig, project });
  const domainContext = createLocalValidationDomainContext({ teamId: snapshot.cache.teamId });
  const resolvedOperatorDir = path.resolve(operatorDir);
  const resolvedRunStoreDir = path.resolve(runStoreDir || path.join(resolvedOperatorDir, "runs"));
  fs.mkdirSync(resolvedOperatorDir, { recursive: true });
  fs.mkdirSync(resolvedRunStoreDir, { recursive: true });

  const result = await runEvalMode({
    linearClient: snapshot.client,
    config: resolvedConfig,
    cache: {
      ...snapshot.cache,
      domainId: domainContext.domainId,
      workspaceId: domainContext.linear.workspaceId,
    },
    projectId: project.id,
    runId,
    repoRoot,
    runStoreDir: resolvedRunStoreDir,
    domainContext,
  });

  const rawOutputPath = writeRawRunOutput({
    operatorDir: resolvedOperatorDir,
    runId,
    result,
  });
  const assertion = assertValidationResult(result, { validateOutput });

  return {
    ok: assertion.ok,
    assertion,
    result,
    rawOutputPath,
    runId,
    operatorDir: resolvedOperatorDir,
    runStoreDir: resolvedRunStoreDir,
    projectId: project.id,
  };
}

export function assertValidationResult(result, {
  validateOutput = validateDecompositionOrchestratorOutput,
  expectedSubagentFamilies = EXPECTED_SUBAGENT_FAMILIES,
} = {}) {
  const failureReasons = [];
  const evidence = Array.isArray(result?.subagent_evidence) ? result.subagent_evidence : [];

  for (const family of expectedSubagentFamilies) {
    const records = evidence.filter(
      (record) => record?.role === family.role && record?.runtime === family.runtime,
    );
    const label = `${family.role}/${family.runtime}`;
    if (records.length === 0) {
      failureReasons.push(`missing subagent evidence for ${label}`);
      continue;
    }
    records.forEach((record, index) => {
      if (record.parse_status !== "valid" || record.clean_parse !== true) {
        failureReasons.push(
          `subagent evidence for ${label} attempt ${index + 1} was parse_status=${String(record.parse_status)} clean_parse=${String(record.clean_parse)}`,
        );
      }
    });
  }

  const orchestratorOutput = result?.orchestratorOutput;
  const outcome = orchestratorOutput?.terminal_output?.outcome;
  if (outcome !== "commit") {
    failureReasons.push(`expected terminal outcome commit, got ${String(outcome || "missing")}`);
  }

  const validation = validateOutput(orchestratorOutput);
  if (!validation?.ok) {
    const reasons = Array.isArray(validation?.failureReasons)
      ? validation.failureReasons
      : ["orchestrator_output_invalid"];
    failureReasons.push(`orchestrator output validation failed: ${reasons.join(", ")}`);
  }

  return {
    ok: failureReasons.length === 0,
    failureReasons: [...new Set(failureReasons)],
  };
}

function validateDecompositionOrchestratorOutput(output) {
  return validateOrchestratorOutput(output, decompositionCommitPayload);
}

export function writeRawRunOutput({ operatorDir = defaultValidationOperatorDir(), runId, result }) {
  if (!runId || typeof runId !== "string" || !SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error("A safe runId is required to write validation raw output.");
  }
  const resolvedOperatorDir = path.resolve(operatorDir);
  fs.mkdirSync(resolvedOperatorDir, { recursive: true });
  const outputPath = path.join(resolvedOperatorDir, `${runId}-raw-output.json`);
  fs.writeFileSync(outputPath, `${safeJsonStringify(result)}\n`, "utf8");
  return outputPath;
}

export async function main({
  stdout = console.log,
  stderr = console.error,
  exit = (code) => {
    process.exitCode = code;
  },
  checkPreconditions = checkRuntimePreconditions,
  runValidation = runDecompositionValidation,
} = {}) {
  const preconditions = await checkPreconditions();
  if (!preconditions.ok) {
    stderr(preconditions.message);
    exit(1);
    return { ok: false, stage: "precondition", preconditions };
  }

  stdout(VALIDATION_SCOPE_CAVEAT);

  try {
    const run = await runValidation();
    if (!run.assertion.ok) {
      stderr(
        oneLine(`VALIDATION FAIL: ${run.assertion.failureReasons.join("; ")}. Raw output: ${run.rawOutputPath}`),
      );
      exit(1);
      return { ok: false, stage: "assertion", ...run };
    }

    stdout(
      oneLine(`VALIDATION PASS: commit outcome with clean pm/claude and sr_eng/codex subagent evidence. Raw output: ${run.rawOutputPath}`),
    );
    exit(0);
    return { ok: true, ...run };
  } catch (error) {
    stderr(oneLine(`VALIDATION FAIL: ${error?.message || String(error)}`));
    exit(1);
    return { ok: false, stage: "run", error };
  }
}

function normalizeFixtureStatus(status, { config = null } = {}) {
  if (typeof status !== "string") return status;
  const normalized = status.trim().toLowerCase().replace(/\s+/g, "_");
  const statusTypes = config?.linear?.project?.status_types || {};
  if (Object.hasOwn(statusTypes, normalized)) return normalized;
  for (const [semantic, nativeType] of Object.entries(statusTypes)) {
    if (String(nativeType).toLowerCase() === normalized) return semantic;
  }
  return status;
}

function normalizeFixtureLabels(labels, fallbackPrefix) {
  if (!Array.isArray(labels)) return [];
  return labels.map((label, index) => {
    if (typeof label === "string") {
      return { id: `${fallbackPrefix}-${index}`, name: label };
    }
    return {
      ...label,
      id: label?.id ?? `${fallbackPrefix}-${index}`,
      name: label?.name ?? String(label?.value ?? label?.id ?? `label-${index}`),
    };
  });
}

function safeJsonStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (_key, current) => {
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          code: current.code,
        };
      }
      if (typeof current === "bigint") return current.toString();
      if (current && typeof current === "object") {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    },
    2,
  );
}

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(oneLine(`VALIDATION FAIL: ${error?.message || String(error)}`));
    process.exitCode = 1;
  });
}
