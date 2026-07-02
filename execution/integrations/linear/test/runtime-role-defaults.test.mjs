import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH,
  UNPINNED_RUNTIME_DEV_FLAG,
  formatRuntimeRoleAssignmentsSection,
  unpinnedRuntimeTraceAttributes,
  validateAcceptedRuntimeRoleDefaults,
  validateLinearConfig,
} from "../src/config.mjs";
import {
  RESOLVABLE_RUNTIME_ROLES,
  deriveResolvableRuntimeRoles,
  resolveJudgeRuntimeAssignment,
} from "../src/runtime-adapters.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";
import { RUNTIME_ROLE_DEFAULTS_TARGET_KEY } from "../../../engine/run-accepted-refs.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const configExamplePath = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
const acceptedRuntimeRolesPath = path.join(repoRoot, ...ACCEPTED_RUNTIME_ROLES_RELATIVE_PATH.split(/[\\/]/));

test("runtime adapter resolvable roles derive from definition.runtime_assignment_roles", () => {
  assert.deepEqual(RESOLVABLE_RUNTIME_ROLES, decompositionDefinition.runtime_assignment_roles);
  assert.deepEqual(RESOLVABLE_RUNTIME_ROLES, ["pm", "sr_eng", "judge", "drafter", "orchestrator"]);

  const mutatedDefinition = {
    ...decompositionDefinition,
    runtime_assignment_roles: [...decompositionDefinition.runtime_assignment_roles, "probe_runtime"],
  };
  assert.deepEqual(
    deriveResolvableRuntimeRoles(mutatedDefinition),
    ["pm", "sr_eng", "judge", "drafter", "orchestrator", "probe_runtime"],
  );
});

test("config.example leaves runtime/model unpinned and accepted defaults fill stampable values", () => {
  const config = readJson(configExamplePath);
  const accepted = readJson(acceptedRuntimeRolesPath);

  for (const [role, fields] of Object.entries(config.workflows.decomposition.roles)) {
    assert.equal(Object.hasOwn(fields, "runtime"), false, `${role}.runtime should not be in config.example`);
    assert.equal(Object.hasOwn(fields, "model"), false, `${role}.model should not be in config.example`);
  }

  validateLinearConfig(config, "test-config", {
    repoRoot,
    moduleRootFallback: false,
  });

  assert.deepEqual(projectRuntimeRoleFields(config.workflows.decomposition.roles), accepted.roles);
  assert.deepEqual(config.workflows.decomposition.role_field_sources, allRoleSources("accepted_defaults"));
  assert.equal(config.workflows.decomposition.unpinned_runtime, null);
  assert.ok(config.workflows.decomposition.accepted_runtime_defaults_ref);
});

test("without the dev flag, explicit adopter runtime roles are ignored in favor of accepted defaults", () => {
  const config = readJson(configExamplePath);
  setRuntimeRoleFields(config, {
    pm: { runtime: "codex", model: "adopter-pm-model" },
    sr_eng: { runtime: "claude", model: "adopter-eng-model" },
    judge: { runtime: "codex", model: "adopter-judge-model" },
    drafter: { runtime: "codex", model: "adopter-drafter-model" },
    orchestrator: { runtime: "codex", model: "adopter-orchestrator-model" },
  });
  const acceptedRoles = {
    pm: { runtime: "claude", model: "default-pm-model" },
    sr_eng: { runtime: "codex", model: "default-eng-model" },
    judge: { runtime: "claude", model: "default-judge-model" },
    drafter: { runtime: "claude", model: "default-drafter-model" },
    orchestrator: { runtime: "claude", model: "default-orchestrator-model" },
  };

  validateLinearConfig(config, "test-config", {
    acceptedRuntimeRolesPath: writeAcceptedDefaults(acceptedRoles),
    moduleRootFallback: false,
  });

  assert.deepEqual(projectRuntimeRoleFields(config.workflows.decomposition.roles), acceptedRoles);
  assert.deepEqual(config.workflows.decomposition.role_field_sources, allRoleSources("accepted_defaults"));
  assert.equal(config.workflows.decomposition.unpinned_runtime, null);
});

test("dev flag honors tunable-role overrides and marks unpinned_runtime", () => {
  const config = readJson(configExamplePath);
  setRuntimeRoleFields(config, {
    pm: { runtime: "codex", model: "adopter-pm-model" },
    sr_eng: { runtime: "claude", model: "adopter-eng-model" },
    judge: { runtime: "codex", model: "adopter-judge-model" },
    drafter: { runtime: "codex", model: "adopter-drafter-model" },
    orchestrator: { runtime: "codex", model: "adopter-orchestrator-model" },
  });
  const acceptedRoles = {
    pm: { runtime: "claude", model: "default-pm-model" },
    sr_eng: { runtime: "codex", model: "default-eng-model" },
    judge: { runtime: "claude", model: "default-judge-model" },
    drafter: { runtime: "claude", model: "default-drafter-model" },
    orchestrator: { runtime: "claude", model: "default-orchestrator-model" },
  };

  validateLinearConfig(config, "test-config", {
    acceptedRuntimeRolesPath: writeAcceptedDefaults(acceptedRoles),
    moduleRootFallback: false,
    env: { [UNPINNED_RUNTIME_DEV_FLAG]: "1" },
  });

  assert.deepEqual(projectRuntimeRoleFields(config.workflows.decomposition.roles), {
    pm: { runtime: "codex", model: "adopter-pm-model" },
    sr_eng: { runtime: "claude", model: "adopter-eng-model" },
    judge: { runtime: "claude", model: "default-judge-model" },
    drafter: { runtime: "codex", model: "adopter-drafter-model" },
    orchestrator: { runtime: "codex", model: "adopter-orchestrator-model" },
  });
  assert.deepEqual(config.workflows.decomposition.role_field_sources, {
    pm: { runtime: "adopter_config", model: "adopter_config" },
    sr_eng: { runtime: "adopter_config", model: "adopter_config" },
    judge: { runtime: "accepted_defaults", model: "accepted_defaults" },
    drafter: { runtime: "adopter_config", model: "adopter_config" },
    orchestrator: { runtime: "adopter_config", model: "adopter_config" },
  });
  assert.deepEqual(config.workflows.decomposition.unpinned_runtime, {
    pm: { runtime: true, model: true },
    sr_eng: { runtime: true, model: true },
    drafter: { runtime: true, model: true },
    orchestrator: { runtime: true, model: true },
  });
  assert.deepEqual(unpinnedRuntimeTraceAttributes(config), {
    "teami.unpinned_runtime": {
      drafter: { model: true, runtime: true },
      orchestrator: { model: true, runtime: true },
      pm: { model: true, runtime: true },
      sr_eng: { model: true, runtime: true },
    },
  });
});

test("engine-owned evaluator roles are not adopter-overridable even under the dev flag", () => {
  const config = readJson(configExamplePath);
  const evaluatorRuntimeRoles = decompositionDefinition.engine_owned_evaluator_roles
    .filter((role) => decompositionDefinition.runtime_assignment_roles.includes(role));
  assert.deepEqual(evaluatorRuntimeRoles, ["judge"]);

  setRuntimeRoleFields(config, {
    judge: { runtime: "codex", model: "adopter-judge-model" },
  });
  const acceptedRoles = {
    pm: { runtime: "claude", model: "default-pm-model" },
    sr_eng: { runtime: "codex", model: "default-eng-model" },
    judge: { runtime: "claude", model: "factory-judge-model" },
    drafter: { runtime: "claude", model: "default-drafter-model" },
    orchestrator: { runtime: "claude", model: "default-orchestrator-model" },
  };

  validateLinearConfig(config, "test-config", {
    acceptedRuntimeRolesPath: writeAcceptedDefaults(acceptedRoles),
    moduleRootFallback: false,
    env: { [UNPINNED_RUNTIME_DEV_FLAG]: "1" },
  });

  assert.equal(config.workflows.decomposition.roles.judge.runtime, "claude");
  assert.equal(config.workflows.decomposition.roles.judge.model, "factory-judge-model");
  assert.deepEqual(config.workflows.decomposition.role_field_sources.judge, {
    runtime: "accepted_defaults",
    model: "accepted_defaults",
  });
  assert.equal(config.workflows.decomposition.unpinned_runtime?.judge, undefined);

  const judgeAssignment = resolveJudgeRuntimeAssignment(config);
  assert.equal(judgeAssignment.runtime, "claude");
  assert.equal(judgeAssignment.model, "factory-judge-model");
});

test("raw judge config without accepted provenance resolves through factory defaults", () => {
  const config = {
    runtime: {
      adapters: {
        codex: { command: "codex", tool_policy: { linear_write: false } },
        claude: { command: "claude", tool_policy: { linear_write: false } },
      },
    },
    workflows: {
      decomposition: {
        roles: {
          judge: { runtime: "codex", model: "adopter-judge-model" },
        },
      },
    },
  };
  const accepted = readJson(acceptedRuntimeRolesPath);

  const judgeAssignment = resolveJudgeRuntimeAssignment(config);

  assert.equal(judgeAssignment.runtime, accepted.roles.judge.runtime);
  assert.equal(judgeAssignment.model, accepted.roles.judge.model);
});

test("unresolved runtime role field names the accepted defaults layer", () => {
  const config = readJson(configExamplePath);

  assert.throws(
    () =>
      validateLinearConfig(config, "test-config", {
        acceptedRuntimeRolesPath: path.join(os.tmpdir(), "missing-accepted-runtime-roles.json"),
        moduleRootFallback: false,
      }),
    /runtime_role_unresolved:pm\.runtime - not in execution[/\\]evals[/\\]decomposition[/\\]accepted-runtime-roles\.json/,
  );
});

test("doctor runtime role assignment section prints effective values and source layers", () => {
  const config = readJson(configExamplePath);
  config.workflows.decomposition.roles.pm.model = "adopter-pm-model";
  const defaultsPath = writeAcceptedDefaults({
    pm: { runtime: "claude", model: "default-pm-model" },
    sr_eng: { runtime: "codex", model: "default-eng-model" },
    judge: { runtime: "claude", model: "default-judge-model" },
    drafter: { runtime: "claude", model: "default-drafter-model" },
    orchestrator: { runtime: "claude", model: "default-orchestrator-model" },
  });
  validateLinearConfig(config, "test-config", {
    acceptedRuntimeRolesPath: defaultsPath,
    moduleRootFallback: false,
    env: { [UNPINNED_RUNTIME_DEV_FLAG]: "1" },
  });

  assert.deepEqual(formatRuntimeRoleAssignmentsSection(config), [
    "runtime role assignments:",
    "- pm.runtime: claude (accepted_defaults)",
    "- pm.model: adopter-pm-model (adopter_config)",
    "- sr_eng.runtime: codex (accepted_defaults)",
    "- sr_eng.model: default-eng-model (accepted_defaults)",
    "- judge.runtime: claude (accepted_defaults)",
    "- judge.model: default-judge-model (accepted_defaults)",
    "- drafter.runtime: claude (accepted_defaults)",
    "- drafter.model: default-drafter-model (accepted_defaults)",
    "- orchestrator.runtime: claude (accepted_defaults)",
    "- orchestrator.model: default-orchestrator-model (accepted_defaults)",
  ]);
});

test("accepted runtime-role defaults validator fails closed on unknown keys and roles", () => {
  const accepted = readJson(acceptedRuntimeRolesPath);
  const unknownKey = structuredClone(accepted);
  unknownKey.roles.pm.extra = true;
  assert.throws(
    () => validateAcceptedRuntimeRoleDefaults(unknownKey, "accepted-runtime-roles.json"),
    /accepted_runtime_roles_invalid: .*roles\.pm keys/,
  );

  const unknownRole = structuredClone(accepted);
  unknownRole.roles.policy_writer = { runtime: "codex", model: "gpt-5.5" };
  assert.throws(
    () => validateAcceptedRuntimeRoleDefaults(unknownRole, "accepted-runtime-roles.json"),
    /accepted_runtime_roles_invalid: .*roles keys/,
  );
});

test("validateLinearConfig captures the runtime-defaults ref at config load", () => {
  const config = readJson(configExamplePath);
  const defaultsPath = writeAcceptedDefaults({
    pm: { runtime: "claude", model: "default-pm-model" },
    sr_eng: { runtime: "codex", model: "default-eng-model" },
    judge: { runtime: "claude", model: "default-judge-model" },
    drafter: { runtime: "claude", model: "default-drafter-model" },
    orchestrator: { runtime: "claude", model: "default-orchestrator-model" },
  });

  validateLinearConfig(config, "test-config", {
    repoRoot,
    acceptedRuntimeRolesPath: defaultsPath,
    moduleRootFallback: false,
  });

  const captured = config.workflows.decomposition.accepted_runtime_defaults_ref;
  assert.ok(captured, "the runtime-defaults ref should be captured at config load");
  assert.equal(captured.target_key, RUNTIME_ROLE_DEFAULTS_TARGET_KEY);
  assert.match(captured.accepted_baseline_id, /^sha256:/);
  assert.equal(typeof captured.snapshot_sha256, "string");
});

test("dev-flagged tunable overrides still capture accepted defaults for evaluator-owned roles", () => {
  const config = readJson(configExamplePath);
  setRuntimeRoleFields(config, {
    pm: { runtime: "codex", model: "adopter-pm-model" },
    sr_eng: { runtime: "claude", model: "adopter-eng-model" },
    drafter: { runtime: "codex", model: "adopter-drafter-model" },
    orchestrator: { runtime: "codex", model: "adopter-orchestrator-model" },
  });
  const defaultsPath = writeAcceptedDefaults({
    pm: { runtime: "claude", model: "default-pm-model" },
    sr_eng: { runtime: "codex", model: "default-eng-model" },
    judge: { runtime: "claude", model: "default-judge-model" },
    drafter: { runtime: "claude", model: "default-drafter-model" },
    orchestrator: { runtime: "claude", model: "default-orchestrator-model" },
  });

  validateLinearConfig(config, "test-config", {
    repoRoot,
    acceptedRuntimeRolesPath: defaultsPath,
    moduleRootFallback: false,
    env: { [UNPINNED_RUNTIME_DEV_FLAG]: "1" },
  });

  assert.ok(config.workflows.decomposition.accepted_runtime_defaults_ref);
  assert.deepEqual(config.workflows.decomposition.role_field_sources.judge, {
    runtime: "accepted_defaults",
    model: "accepted_defaults",
  });
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function projectRuntimeRoleFields(roles) {
  return {
    pm: { runtime: roles.pm.runtime, model: roles.pm.model },
    sr_eng: { runtime: roles.sr_eng.runtime, model: roles.sr_eng.model },
    judge: { runtime: roles.judge.runtime, model: roles.judge.model },
    drafter: { runtime: roles.drafter.runtime, model: roles.drafter.model },
    orchestrator: { runtime: roles.orchestrator.runtime, model: roles.orchestrator.model },
  };
}

function allRoleSources(source) {
  return Object.fromEntries(
    decompositionDefinition.runtime_assignment_roles.map((role) => [
      role,
      { runtime: source, model: source },
    ]),
  );
}

function setRuntimeRoleFields(config, byRole) {
  for (const [role, fields] of Object.entries(byRole)) {
    config.workflows.decomposition.roles[role] ??= {};
    Object.assign(config.workflows.decomposition.roles[role], fields);
  }
}

function writeAcceptedDefaults(roles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "accepted-runtime-roles-"));
  const filePath = path.join(root, "accepted-runtime-roles.json");
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schema_version: "teami-accepted-runtime-roles/v1",
      _note: "test defaults",
      roles,
    }, null, 2)}\n`,
    "utf8",
  );
  return filePath;
}
