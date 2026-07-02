import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMOTION_WRITE_GUARD_FAIL_CLOSED,
  PROMOTION_WRITE_GUARD_REPORT_ONLY,
  classifyMaterializedPromotionFiles,
  ownerCopyForPromotionWriteGuard,
  resolvePromotionWriteGuard,
  resolvePromotionWriteGuardActivationState,
} from "../src/promotion-write-guard.mjs";
import { classifyMetaAuthorityChange } from "../src/meta-change-classifier.mjs";
import {
  ADVISORY_ONLY_REASON_IDS,
  advisorySchemaFor,
  resolveFactoryChangeDisposition,
} from "../src/promotion/factory-change-disposition.mjs";
import { buildPromotionMarker } from "../src/promotion/pr-marker.mjs";
import { isAdopterSelfImprovementTarget } from "../src/promotion/agent-behavior-scope.mjs";

const FOREGROUND = { transport: "cli_local_session" };

function classifyChange(change) {
  return classifyMetaAuthorityChange({ changes: [change] });
}

function classification(className, mixedClasses = []) {
  return {
    class: className,
    reasons: [],
    protected_paths: className === "ordinary_semantic" ? [] : ["protected.md"],
    affected_surfaces: [],
    mixed_classes: mixedClasses,
  };
}

test("pre-activation unattended scanner invocations are report-only for every class", () => {
  for (const className of [
    "ordinary_semantic",
    "meta_change",
    "authority_change",
    "unknown_sensitive",
  ]) {
    const guard = resolvePromotionWriteGuard({
      invocation: { transport: "promotion_candidate_scanner" },
      classification: classification(className),
      activationState: { mode: PROMOTION_WRITE_GUARD_REPORT_ONLY },
    });
    assert.equal(guard.allowed, false, className);
    assert.equal(guard.mode, "report_only", className);
    assert.equal(guard.reason, "promotion_write_guard_pre_activation_unattended_report_only");
    assert.match(ownerCopyForPromotionWriteGuard(guard), /Proposal writing is waiting/);
  }
});

test("pre-activation unknown invocation transports are treated as unattended", () => {
  for (const invocation of [
    {},
    { transport: "future_scheduler" },
    { transport: "" },
  ]) {
    const guard = resolvePromotionWriteGuard({
      invocation,
      classification: classification("ordinary_semantic"),
      activationState: { mode: PROMOTION_WRITE_GUARD_REPORT_ONLY },
    });
    assert.equal(guard.allowed, false);
    assert.equal(guard.mode, "report_only");
    assert.equal(guard.reason, "promotion_write_guard_pre_activation_unattended_report_only");
  }

  const foreground = resolvePromotionWriteGuard({
    invocation: { transport: "cli_local_session" },
    classification: classification("ordinary_semantic"),
    activationState: { mode: PROMOTION_WRITE_GUARD_REPORT_ONLY },
  });
  assert.equal(foreground.allowed, true);
  assert.equal(foreground.mode, "write");
});

test("ordinary writes can proceed, while factory-behavior classes always block", () => {
  const ordinary = resolvePromotionWriteGuard({
    invocation: { transport: "cli_local_session" },
    classification: classification("ordinary_semantic"),
    activationState: { mode: PROMOTION_WRITE_GUARD_REPORT_ONLY },
  });
  assert.equal(ordinary.allowed, true);
  assert.equal(ordinary.mode, "write");

  for (const className of ["meta_change", "authority_change"]) {
    for (const mode of [PROMOTION_WRITE_GUARD_REPORT_ONLY, PROMOTION_WRITE_GUARD_FAIL_CLOSED]) {
      const guard = resolvePromotionWriteGuard({
        invocation: { transport: "cli_local_session" },
        classification: classification(className),
        activationState: { mode },
      });
      assert.equal(guard.allowed, false, `${className}:${mode}`);
      assert.equal(guard.mode, "blocked", `${className}:${mode}`);
      assert.equal(
        guard.reason,
        `promotion_write_guard_${className}_factory_behavior_out_of_scope`,
      );
      assert.match(ownerCopyForPromotionWriteGuard(guard), /factory behavior/i);
    }
  }

  for (const mode of [PROMOTION_WRITE_GUARD_REPORT_ONLY, PROMOTION_WRITE_GUARD_FAIL_CLOSED]) {
    const unknown = resolvePromotionWriteGuard({
      invocation: { transport: "cli_local_session" },
      classification: classification("unknown_sensitive"),
      activationState: { mode },
    });
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.mode, "blocked");
    assert.equal(unknown.reason, "promotion_write_guard_unknown_sensitive_blocked");
  }
});

test("mixed ordinary plus factory behavior blocks before proposal writing", () => {
  for (const mixed of [
    ["ordinary_semantic", "meta_change"],
    ["ordinary_semantic", "authority_change"],
  ]) {
    const guard = resolvePromotionWriteGuard({
      invocation: { transport: "cli_local_session" },
      classification: classification(mixed.at(-1), mixed),
      activationState: { mode: PROMOTION_WRITE_GUARD_REPORT_ONLY },
    });
    assert.equal(guard.allowed, false);
    assert.equal(guard.mode, "blocked");
    assert.equal(guard.reason, "promotion_write_guard_mixed_factory_behavior_blocked");
  }
});

test("activation state defaults to pre-activation report-only unless owner-held flag enables fail-closed", () => {
  assert.equal(
    resolvePromotionWriteGuardActivationState({ env: {} }).mode,
    PROMOTION_WRITE_GUARD_REPORT_ONLY,
  );
  assert.equal(
    resolvePromotionWriteGuardActivationState({
      env: { TEAMI_PROMOTION_WRITE_GUARD: "fail_closed" },
    }).mode,
    PROMOTION_WRITE_GUARD_FAIL_CLOSED,
  );
  for (const enabledValue of ["true", "1", "on", "yes", "enabled"]) {
    assert.equal(
      resolvePromotionWriteGuardActivationState({
        env: { TEAMI_PROMOTION_WRITE_GUARD: enabledValue },
      }).mode,
      PROMOTION_WRITE_GUARD_FAIL_CLOSED,
      enabledValue,
    );
  }
});

test("materialized manifest-declared agent behavior changes classify ordinary, while policy edits classify protected", () => {
  const beforeManifest = {
    prompts: [{
      role: "pm",
      target_key: "prompt/decomposition/pm_synthesis",
      human_name: "PM synthesis prompt",
      artifact_kind: "accepted_prompt",
      materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
      snapshot_path: "execution/evals/decomposition/accepted-prompts/pm-synthesis.md",
      snapshot_sha256: "oldsha",
      accepted_prompt_version_id: null,
      prompt_version: "unpinned-initial",
      accepted_tag: "teami_accepted",
      candidate_tag: "teami_promotion_candidate",
    }],
  };
  const afterManifest = {
    prompts: [{
      ...beforeManifest.prompts[0],
      snapshot_sha256: "newsha",
      accepted_prompt_version_id: "PV2",
      prompt_version: "candidate",
    }],
  };
  const ordinary = classifyMaterializedPromotionFiles({
    beforeFiles: {
      "execution/evals/decomposition/accepted-prompts/pm-synthesis.md":
        "Ask for a concise product consequence summary.\n",
      "execution/evals/decomposition/phoenix-assets.json":
        `${JSON.stringify(beforeManifest, null, 2)}\n`,
    },
    files: {
      "execution/evals/decomposition/accepted-prompts/pm-synthesis.md":
        "Ask for a concise user consequence summary.\n",
      "execution/evals/decomposition/phoenix-assets.json":
        `${JSON.stringify(afterManifest, null, 2)}\n`,
    },
    target: {
      target_key: "prompt/decomposition/pm_synthesis",
      role: "pm",
      artifact_kind: "accepted_prompt",
      materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
      snapshot_path: "execution/evals/decomposition/accepted-prompts/pm-synthesis.md",
    },
  });
  assert.equal(ordinary.class, "ordinary_semantic");

  const runtimeDefaults = classifyMaterializedPromotionFiles({
    beforeFiles: {
      "execution/evals/decomposition/accepted-runtime-roles.json":
        "{\"roles\":{\"pm\":{\"model\":\"old\"}}}\n",
    },
    files: {
      "execution/evals/decomposition/accepted-runtime-roles.json":
        "{\"roles\":{\"pm\":{\"model\":\"new\"}}}\n",
    },
    target: {
      target_key: "rule/decomposition/runtime_role_assignments",
      artifact_kind: "runtime_role_defaults",
      materializer: "eval_variant_to_runtime_role_defaults",
      artifact_path: "execution/evals/decomposition/accepted-runtime-roles.json",
    },
  });
  assert.equal(runtimeDefaults.class, "ordinary_semantic");

  const policy = classifyMaterializedPromotionFiles({
    beforeFiles: {
      "execution/evals/decomposition/promotion-policy.json": '"lookback_days": 90\n',
    },
    files: {
      "execution/evals/decomposition/promotion-policy.json": '"lookback_days": 120\n',
    },
  });
  assert.equal(policy.class, "meta_change");
});

test("the runtime-defaults write guard blocks a judge runtime/model change, including a multi-line value-only edit, but keeps non-judge roles ordinary", () => {
  const runtimeTarget = {
    target_key: "rule/decomposition/runtime_role_assignments",
    artifact_kind: "runtime_role_defaults",
    materializer: "eval_variant_to_runtime_role_defaults",
    artifact_path: "execution/evals/decomposition/accepted-runtime-roles.json",
  };
  const RUNTIME_PATH = "execution/evals/decomposition/accepted-runtime-roles.json";

  // Inline judge edit.
  const judgeInline = classifyMaterializedPromotionFiles({
    beforeFiles: { [RUNTIME_PATH]: "{\"roles\":{\"judge\":{\"runtime\":\"claude\",\"model\":\"claude-opus-4-8\"}}}\n" },
    files: { [RUNTIME_PATH]: "{\"roles\":{\"judge\":{\"runtime\":\"codex\",\"model\":\"gpt-5.5\"}}}\n" },
    target: runtimeTarget,
  });
  assert.equal(judgeInline.class, "meta_change");

  // Multi-line value-only judge edit: the "judge" key line is unchanged context,
  // so a hunk-text scan would miss it; the structural field-path check must not.
  const beforeMultiline = [
    "{",
    "  \"roles\": {",
    "    \"pm\": { \"runtime\": \"claude\", \"model\": \"claude-opus-4-8\" },",
    "    \"judge\": {",
    "      \"runtime\": \"claude\",",
    "      \"model\": \"claude-opus-4-8\"",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  const afterMultiline = [
    "{",
    "  \"roles\": {",
    "    \"pm\": { \"runtime\": \"claude\", \"model\": \"claude-opus-4-8\" },",
    "    \"judge\": {",
    "      \"runtime\": \"codex\",",
    "      \"model\": \"gpt-5.5\"",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
  const judgeMultiline = classifyMaterializedPromotionFiles({
    beforeFiles: { [RUNTIME_PATH]: beforeMultiline },
    files: { [RUNTIME_PATH]: afterMultiline },
    target: runtimeTarget,
  });
  assert.equal(judgeMultiline.class, "meta_change");

  // A non-judge (pm) runtime/model edit on the same aggregate target stays ordinary.
  const pmEdit = classifyMaterializedPromotionFiles({
    beforeFiles: { [RUNTIME_PATH]: "{\"roles\":{\"pm\":{\"runtime\":\"claude\",\"model\":\"claude-opus-4-8\"}}}\n" },
    files: { [RUNTIME_PATH]: "{\"roles\":{\"pm\":{\"runtime\":\"codex\",\"model\":\"gpt-5.5\"}}}\n" },
    target: runtimeTarget,
  });
  assert.equal(pmEdit.class, "ordinary_semantic");

  // The orchestrator row is the driver persona's runtime facet, so it is
  // ordinary adopter-tunable behavior just like a pm/sr_eng runtime facet.
  const orchestratorEdit = classifyMaterializedPromotionFiles({
    beforeFiles: { [RUNTIME_PATH]: "{\"roles\":{\"orchestrator\":{\"runtime\":\"claude\",\"model\":\"claude-opus-4-8\"}}}\n" },
    files: { [RUNTIME_PATH]: "{\"roles\":{\"orchestrator\":{\"runtime\":\"claude\",\"model\":\"gpt-5.5\"}}}\n" },
    target: runtimeTarget,
  });
  assert.equal(orchestratorEdit.class, "ordinary_semantic");
});

// ---------------------------------------------------------------------------
// A-CONTENT-DEMOTE: the demoted view (PATH-map + PROMPT-PROSE labels are an
// advisory, NOT the ownership gate). The positive commit allowlist is the gate.
// ---------------------------------------------------------------------------

test("the demoted-view discrimination rule keys exactly on the 6-id allowlist", () => {
  assert.deepEqual(
    [...ADVISORY_ONLY_REASON_IDS].sort(),
    [
      "authority_hunk_escalation",
      "authority_hunk_unmapped_path",
      "meta_hunk_unmapped_path",
      "ordinary_prompt_meta_escalation",
      "protected_path_authority_change",
      "protected_path_meta_change",
    ],
  );

  // Advisory-only: a factory class whose every backing reason is in the allowlist.
  const advisory = {
    class: "meta_change",
    mixed_classes: [],
    reasons: [{ id: "protected_path_meta_change", class: "meta_change" }],
  };
  const advisoryView = resolveFactoryChangeDisposition(advisory);
  assert.deepEqual(advisoryView.advisory_only_classes, ["meta_change"]);
  assert.deepEqual(advisoryView.gating_classes, []);
  assert.equal(advisoryView.has_gating_factory_class, false);

  // A factory class with a NON-allowlisted reason gates.
  const gating = {
    class: "meta_change",
    mixed_classes: [],
    reasons: [{ id: "field_sensitive_meta_slot", class: "meta_change" }],
  };
  assert.equal(resolveFactoryChangeDisposition(gating).has_gating_factory_class, true);

  // Fail closed: a factory class with NO backing reason is NOT demoted.
  const noReason = { class: "meta_change", mixed_classes: ["meta_change"], reasons: [] };
  const noReasonView = resolveFactoryChangeDisposition(noReason);
  assert.deepEqual(noReasonView.advisory_only_classes, []);
  assert.deepEqual(noReasonView.gating_classes, ["meta_change"]);
  assert.equal(noReasonView.has_gating_factory_class, true);
});

test("genuine mixed ordinary + ADVISORY-ONLY factory passes the write guard; ordinary + GATING factory still blocks (the mixed branch, both ways)", () => {
  // mixed_classes carries BOTH ordinary_semantic AND meta_change, the meta_change
  // backed ONLY by an advisory path-map reason -> advisory-only, so the write
  // proceeds (the positive commit allowlist is the ownership gate).
  const advisoryMixed = {
    class: "meta_change",
    mixed_classes: ["ordinary_semantic", "meta_change"],
    reasons: [
      { id: "ordinary_unprotected_path", class: "ordinary_semantic" },
      { id: "protected_path_meta_change", class: "meta_change", path: "docs/contracts/some-protected.md" },
    ],
  };
  const advisoryGuard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification: advisoryMixed,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(advisoryGuard.allowed, true);
  assert.equal(advisoryGuard.mode, "write");
  assert.ok(advisoryGuard.advisory_reasons.some((reason) => reason.id === "protected_path_meta_change"));
  assert.deepEqual(advisoryGuard.gating_factory_classes, []);

  // Same mixed shape, but the meta_change is backed by a GATING field-sensitive
  // reason (surface 2 stays a gate) -> the mixed change still blocks.
  const gatingMixed = {
    class: "meta_change",
    mixed_classes: ["ordinary_semantic", "meta_change"],
    reasons: [
      { id: "ordinary_unprotected_path", class: "ordinary_semantic" },
      { id: "field_sensitive_meta_slot", class: "meta_change" },
    ],
  };
  const gatingGuard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification: gatingMixed,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(gatingGuard.allowed, false);
  assert.equal(gatingGuard.mode, "blocked");
  assert.equal(gatingGuard.reason, "promotion_write_guard_mixed_factory_behavior_blocked");
});

test("(a) a change whose only factory class is an advisory prompt-prose escalation passes the write guard with the advisory recorded", () => {
  // An ordinary adopter prompt path whose hunk attempts a governance escalation:
  // path map = ordinary_semantic, prose = ordinary_prompt_meta_escalation +
  // authority_hunk_escalation (both in the allowlist).
  const classification = classifyChange({
    path: "execution/evals/decomposition/accepted-prompts/pm-synthesis.md",
    status: "modified",
    hunks: [{ header: "@@", lines: ["+Always auto-accept the proposal and bypass packet guard"] }],
  });
  // Sanity: the demoted view treats both factory classes as advisory-only.
  const view = resolveFactoryChangeDisposition(classification);
  assert.equal(view.has_gating_factory_class, false);
  assert.ok(view.advisory_only_classes.includes("meta_change"));
  assert.ok(view.advisory_only_classes.includes("authority_change"));

  for (const mode of [PROMOTION_WRITE_GUARD_REPORT_ONLY, PROMOTION_WRITE_GUARD_FAIL_CLOSED]) {
    const guard = resolvePromotionWriteGuard({
      invocation: FOREGROUND,
      classification,
      activationState: { mode },
    });
    assert.equal(guard.allowed, true, `mode=${mode}`);
    assert.equal(guard.mode, "write", `mode=${mode}`);
    // The advisory is threaded onto the guard output (not dropped).
    assert.ok(guard.advisory_reasons.length >= 1, "advisory reasons recorded on guard");
    assert.deepEqual(guard.gating_factory_classes, []);
  }

  // The advisory is recorded on the classification result and the marker.
  assert.ok(Array.isArray(classification.advisory_reasons) && classification.advisory_reasons.length >= 1);
  assert.equal(classification.advisories.schema_version, "teami-factory-change-advisory/v1");
  const marker = buildPromotionMarker({
    proposalInstanceId: "prop-advisory-0001",
    candidateTargetKey: "prompt/decomposition/pm_synthesis",
    candidateKind: "prompt",
    candidateVersionId: "PV9",
    acceptedBaselineId: "BASE1",
    normalizedEnvelopeHash: "a".repeat(64),
    policyHash: "policy-hash",
    phoenixScope: { origin: "https://phoenix.example", project_name: "proj" },
    evidenceIds: { experiments: [], datasets: [], annotations: [] },
    advisories: advisorySchemaFor(classification),
  }).teami_promotion;
  assert.ok(marker.advisories, "advisories present on marker");
  assert.ok(marker.advisories.advisory_reasons.some((r) => r.id === "ordinary_prompt_meta_escalation"));
});

test("(a) a protected-path-only meta change on a non-judge path passes the write guard as advisory", () => {
  const classification = classifyChange({
    path: "docs/self-improvement.md",
    status: "modified",
    hunks: [{ header: "@@", lines: ["+a routine wording tweak with no governance prose"] }],
  });
  assert.equal(classification.class, "meta_change");
  assert.deepEqual(classification.reasons.map((r) => r.id), ["protected_path_meta_change"]);

  const guard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(guard.allowed, true);
  assert.equal(guard.mode, "write");
  assert.deepEqual(guard.advisory_only_classes, ["meta_change"]);
});

test("(b) a judge prompt proposal is rejected at ADMISSION (not at the write guard)", () => {
  // The maintainer-owned judge prompt satisfies every adopter prompt shape;
  // only the judge exclusion in the single admission authority rejects it. It
  // classifies factory_behavior / no-PR and never reaches the write guard.
  const judgePromptTarget = {
    target_key: "prompt/decomposition/decomposition_quality_judge",
    role: "decomposition_quality_judge",
    artifact_kind: "accepted_prompt",
    materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
    snapshot_path: "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md",
  };
  assert.equal(isAdopterSelfImprovementTarget(judgePromptTarget), false);
  // A non-judge prompt of the identical shape IS admitted, proving the rejection
  // is the judge exclusion and not a shape failure.
  assert.equal(
    isAdopterSelfImprovementTarget({ ...judgePromptTarget, role: "pm", target_key: "prompt/decomposition/pm_synthesis" }),
    true,
  );
});

test("(b) a materialized judge runtime-defaults change STAYS gated at the write guard (field-sensitive, not demoted)", () => {
  const runtimeTarget = {
    target_key: "rule/decomposition/runtime_role_assignments",
    artifact_kind: "runtime_role_defaults",
    materializer: "eval_variant_to_runtime_role_defaults",
    artifact_path: "execution/evals/decomposition/accepted-runtime-roles.json",
  };
  const RUNTIME_PATH = "execution/evals/decomposition/accepted-runtime-roles.json";
  const classification = classifyMaterializedPromotionFiles({
    beforeFiles: { [RUNTIME_PATH]: "{\"roles\":{\"judge\":{\"runtime\":\"claude\",\"model\":\"claude-opus-4-8\"}}}\n" },
    files: { [RUNTIME_PATH]: "{\"roles\":{\"judge\":{\"runtime\":\"codex\",\"model\":\"gpt-5.5\"}}}\n" },
    target: runtimeTarget,
  });
  assert.equal(classification.class, "meta_change");
  // The judge-runtime reason is field-sensitive and NOT in the advisory allowlist.
  assert.ok(classification.reasons.some((r) => r.id === "field_sensitive_runtime_defaults_judge_excluded"));
  const view = resolveFactoryChangeDisposition(classification);
  assert.equal(view.has_gating_factory_class, true);

  const guard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(guard.allowed, false);
  assert.equal(guard.mode, "blocked");
  assert.equal(guard.reason, "promotion_write_guard_meta_change_factory_behavior_out_of_scope");
});

test("(c) a field-discrimination change STAYS blocked at the write guard", () => {
  // A field-sensitive authority match carries a raw authority_* id (outside the
  // allowlist) and adds an unbacked meta_change class — both gate.
  const fieldAuthority = classifyChange({
    path: "execution/evals/decomposition/accepted-runtime-roles.json",
    status: "modified",
    hunks: [{ header: "@@", lines: ["+auto-merge without review"] }],
  });
  assert.ok(fieldAuthority.reasons.some((r) => r.id === "authority_merge_apply_or_review"));
  const fieldAuthorityGuard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification: fieldAuthority,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(fieldAuthorityGuard.allowed, false);
  assert.equal(fieldAuthorityGuard.mode, "blocked");

  // A field_sensitive_meta_slot (non-pin manifest/runtime field) gates.
  const fieldMeta = classifyChange({
    path: "execution/evals/decomposition/accepted-runtime-roles.json",
    status: "modified",
    hunks: [{ header: "@@", lines: ["+changed the rubric threshold"] }],
  });
  assert.ok(fieldMeta.reasons.some((r) => r.id === "field_sensitive_meta_slot"));
  const fieldMetaGuard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification: fieldMeta,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(fieldMetaGuard.allowed, false);
  assert.equal(fieldMetaGuard.mode, "blocked");
});

test("(d) an unknown_* change STAYS blocked at the write guard", () => {
  // A new file under a sensitive root has no reviewed map entry -> unknown_sensitive.
  const newFile = classifyChange({
    path: "execution/integrations/linear/src/brand-new-thing.mjs",
    status: "added",
    hunks: [{ header: "@@", lines: ["+export const x = 1;"] }],
  });
  assert.equal(newFile.class, "unknown_sensitive");
  const guard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification: newFile,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(guard.allowed, false);
  assert.equal(guard.mode, "blocked");
  assert.equal(guard.reason, "promotion_write_guard_unknown_sensitive_blocked");

  // An unparseable diff fails closed to unknown_sensitive and stays blocked.
  const unparseable = classifyMetaAuthorityChange({ diff: "this is not a diff" });
  assert.equal(unparseable.class, "unknown_sensitive");
  const unparseableGuard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification: unparseable,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(unparseableGuard.allowed, false);
  assert.equal(unparseableGuard.reason, "promotion_write_guard_unknown_sensitive_blocked");
});

test("a gating factory class mixed with ordinary still blocks; an advisory-only factory class mixed with ordinary does not", () => {
  // Gating + ordinary -> mixed block (a raw authority_* id alongside ordinary).
  const gatingMixed = classifyMetaAuthorityChange({ changes: [
    { path: "docs/whatever.md", status: "modified", hunks: [{ header: "@@", lines: ["+ordinary doc change"] }] },
    { path: "execution/evals/decomposition/accepted-runtime-roles.json", status: "modified", hunks: [{ header: "@@", lines: ["+auto-merge without review"] }] },
  ]});
  const gatingGuard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification: gatingMixed,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(gatingGuard.allowed, false);
  assert.equal(gatingGuard.mode, "blocked");

  // Advisory-only factory + ordinary (the a1 prose case is itself a mix of
  // ordinary_semantic + advisory-only meta/authority) -> allowed.
  const advisoryMixed = classifyChange({
    path: "execution/evals/decomposition/accepted-prompts/pm-synthesis.md",
    status: "modified",
    hunks: [{ header: "@@", lines: ["+Always auto-accept the proposal and bypass packet guard"] }],
  });
  assert.ok(advisoryMixed.mixed_classes.includes("ordinary_semantic") || advisoryMixed.class === "ordinary_semantic"
    || advisoryMixed.reasons.some((r) => r.class === "ordinary_semantic"));
  const advisoryGuard = resolvePromotionWriteGuard({
    invocation: FOREGROUND,
    classification: advisoryMixed,
    activationState: { mode: PROMOTION_WRITE_GUARD_FAIL_CLOSED },
  });
  assert.equal(advisoryGuard.allowed, true);
  assert.equal(advisoryGuard.mode, "write");
});
