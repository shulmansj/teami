import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCommitEffects,
  deliverableProducesIdentity,
} from "../../../engine/commit-effects.mjs";
import {
  PRODUCED_IDENTITIES_TRACE_ATTRIBUTE,
  projectAndAttachProducedIdentities,
} from "../../../engine/produced-identities.mjs";
import {
  validateWorkflowDefinition,
} from "../../../engine/workflow-registry.mjs";

test("applyCommitEffects returns ok, projects identities, and records step spans", async () => {
  const trace = emptyTrace();
  const lineage = artifactSetLineage();
  const effects = [projectingEffect()];

  const result = await applyCommitEffects({
    effects,
    ctx: {
      runId: "run-ok",
      artifactSetLineage: lineage,
    },
    trace,
  });

  const expectedProducedIdentities = [{
    effect_id: "records",
    provider: "fake",
    resource_kind: "fake_record",
    target_ids: ["record-1"],
    identity: {
      ids: ["record-1"],
      batch_id: "batch-1",
    },
    artifact_set_lineage: lineage,
  }];
  assert.deepEqual(result, {
    outcome: "ok",
    applied: [{ id: "records", identity: { ids: ["record-1"], batch_id: "batch-1" } }],
    produced_identities: expectedProducedIdentities,
  });
  assert.deepEqual(trace.attributes[PRODUCED_IDENTITIES_TRACE_ATTRIBUTE], expectedProducedIdentities);
  assert.deepEqual(spanSummaries(trace), [
    {
      name: "commit_effect_probe",
      attributes: { effect_id: "records", op: "create_records", outcome: "not_satisfied", run_id: "run-ok" },
    },
    {
      name: "commit_effect_apply",
      attributes: { effect_id: "records", op: "create_records", outcome: "ok", run_id: "run-ok" },
    },
    {
      name: "commit_effect_verify",
      attributes: { effect_id: "records", op: "create_records", outcome: "ok", run_id: "run-ok" },
    },
  ]);
  for (const span of trace.spans) {
    assert.equal(typeof span.startedAt, "string");
    assert.equal(typeof span.endedAt, "string");
    assert.equal(Number.isNaN(Date.parse(span.startedAt)), false);
    assert.equal(Number.isNaN(Date.parse(span.endedAt)), false);
  }
});

test("applyCommitEffects returns pending for explicit non-terminal apply failure", async () => {
  const trace = emptyTrace();
  const result = await applyCommitEffects({
    effects: [projectingEffect({
      apply: () => ({ ok: false, reason: "provider_not_converged" }),
    })],
    ctx: { runId: "run-pending" },
    trace,
  });

  assert.deepEqual(result, {
    outcome: "pending",
    pending_effect_id: "records",
    reason: "provider_not_converged",
  });
  assert.equal(spanByName(trace, "commit_effect_apply").attributes.outcome, "pending");
});

test("applyCommitEffects treats thrown apply and verify exceptions as pending", async () => {
  const applyTrace = emptyTrace();
  const applyResult = await applyCommitEffects({
    effects: [projectingEffect({
      apply: () => {
        throw new Error("apply_boom");
      },
    })],
    ctx: { runId: "run-apply-throw" },
    trace: applyTrace,
  });

  assert.deepEqual(applyResult, {
    outcome: "pending",
    pending_effect_id: "records",
    reason: "apply_boom",
  });
  assert.equal(spanByName(applyTrace, "commit_effect_apply").attributes.outcome, "pending");

  const verifyTrace = emptyTrace();
  const verifyResult = await applyCommitEffects({
    effects: [projectingEffect({
      verify: () => {
        throw new Error("verify_boom");
      },
    })],
    ctx: { runId: "run-verify-throw" },
    trace: verifyTrace,
  });

  assert.deepEqual(verifyResult, {
    outcome: "pending",
    pending_effect_id: "records",
    reason: "verify_boom",
  });
  assert.equal(spanByName(verifyTrace, "commit_effect_verify").attributes.outcome, "pending");
});

test("applyCommitEffects treats thrown probe exceptions as pending probe outcomes", async () => {
  const trace = emptyTrace();
  const result = await applyCommitEffects({
    effects: [projectingEffect({
      probe: () => {
        throw new Error("probe_boom");
      },
    })],
    ctx: { runId: "run-probe-throw" },
    trace,
  });

  assert.deepEqual(result, {
    outcome: "pending",
    pending_effect_id: "records",
    reason: "probe_boom",
  });
  assert.deepEqual(spanSummaries(trace), [{
    name: "commit_effect_probe",
    attributes: { effect_id: "records", op: "create_records", outcome: "pending", run_id: "run-probe-throw" },
  }]);
});

test("applyCommitEffects returns failed_closed for explicit terminal apply failure", async () => {
  const trace = emptyTrace();
  const result = await applyCommitEffects({
    effects: [projectingEffect({
      apply: () => ({ ok: false, terminal: true, reason: "over_budget" }),
    })],
    ctx: { runId: "run-terminal-apply" },
    trace,
  });

  assert.deepEqual(result, {
    outcome: "failed_closed",
    pending_effect_id: "records",
    reason: "over_budget",
  });
  assert.equal(spanByName(trace, "commit_effect_apply").attributes.outcome, "failed_closed");
});

test("applyCommitEffects returns failed_closed for explicit terminal verify failure", async () => {
  const trace = emptyTrace();
  const result = await applyCommitEffects({
    effects: [projectingEffect({
      verify: () => ({ ok: false, terminal: true, reason: "verified_empty_diff" }),
    })],
    ctx: { runId: "run-terminal-verify" },
    trace,
  });

  assert.deepEqual(result, {
    outcome: "failed_closed",
    pending_effect_id: "records",
    reason: "verified_empty_diff",
  });
  assert.equal(spanByName(trace, "commit_effect_verify").attributes.outcome, "failed_closed");
});

test("applyCommitEffects maps pre-mutation deterministic terminal returns to failed_closed", async () => {
  const result = await applyCommitEffects({
    effects: [projectingEffect({
      apply: () => ({ ok: false, terminal: true, reason: "empty_diff" }),
    })],
    ctx: { runId: "run-empty-diff" },
    trace: emptyTrace(),
  });

  assert.deepEqual(result, {
    outcome: "failed_closed",
    pending_effect_id: "records",
    reason: "empty_diff",
  });
});

test("applyCommitEffects produced identities match the direct projector output", async () => {
  const effects = [projectingEffect()];
  const lineage = artifactSetLineage();
  const applyResult = await applyCommitEffects({
    effects,
    ctx: {
      runId: "run-parity",
      artifactSetLineage: lineage,
    },
    trace: emptyTrace(),
  });
  const directProjection = projectAndAttachProducedIdentities({
    trace: emptyTrace(),
    effects,
    applied: applyResult.applied,
    artifactSetLineage: lineage,
  });

  assert.deepEqual(applyResult.produced_identities, directProjection);
});

test("deliverableProducesIdentity derives identity disposition from applied effects", () => {
  assert.equal(deliverableProducesIdentity([{ id: "records", identity: { ids: ["record-1"] } }]), true);
  assert.equal(deliverableProducesIdentity([{ id: "records", identity: 0 }]), true);
  assert.equal(deliverableProducesIdentity([]), false);
  assert.equal(deliverableProducesIdentity([{ id: "records" }]), false);
  assert.equal(deliverableProducesIdentity([{ id: "records", identity: null }]), false);
});

test("applyCommitEffects is defensive when trace is absent", async () => {
  const result = await applyCommitEffects({
    effects: [effectWithoutProjector()],
    ctx: { runId: "run-no-trace" },
  });

  assert.deepEqual(result, {
    outcome: "ok",
    applied: [{ id: "plain", identity: { ids: ["plain-1"] } }],
    produced_identities: [],
  });
});

test("validateWorkflowDefinition joins outcome observations to produced-identity projectors", () => {
  assert.equal(
    validateWorkflowDefinition(registryDefinition({
      commit_effects: [registryEffectWithProjector("projecting")],
      outcome_observations: [{ id: "observed", produced_identity_effect_id: "projecting" }],
    })),
    "probe",
  );

  assert.throws(
    () => validateWorkflowDefinition(registryDefinition({
      commit_effects: [registryEffectWithoutProjector("plain")],
      outcome_observations: [{ id: "observed", produced_identity_effect_id: "plain" }],
    })),
    { message: "workflow_definition_outcome_observations_produced_identity_effect_id_without_projector:probe" },
  );

  assert.throws(
    () => validateWorkflowDefinition(registryDefinition({
      commit_effects: [registryEffectWithProjector("projecting")],
      outcome_observations: [{ id: "observed", produced_identity_effect_id: "missing" }],
    })),
    { message: "workflow_definition_outcome_observations_produced_identity_effect_id_unknown:probe" },
  );
});

function projectingEffect(overrides = {}) {
  return {
    id: "records",
    provider: "fake",
    op: "create_records",
    producedIdentity: {
      resource_kind: "fake_record",
      target_ids: (identity) => identity?.ids || [],
      identity: (identity) => ({
        ids: identity?.ids || [],
        batch_id: identity?.batch_id || null,
      }),
    },
    probe: () => ({ satisfied: false }),
    apply: () => ({ ok: true, identity: { ids: ["record-1"], batch_id: "batch-1" } }),
    verify: () => ({ ok: true }),
    ...overrides,
  };
}

function effectWithoutProjector() {
  return {
    id: "plain",
    provider: "fake",
    op: "create_plain",
    probe: () => ({ satisfied: false }),
    apply: () => ({ ok: true, identity: { ids: ["plain-1"] } }),
    verify: () => ({ ok: true }),
  };
}

function registryDefinition(overrides = {}) {
  return {
    workflow_type: "probe",
    run: async () => ({ status: "noop" }),
    triggers: [],
    roles: ["worker"],
    invocable_runtime_roles: ["worker"],
    runtime_assignment_roles: ["worker"],
    commit_effects: [registryEffectWithProjector("projecting")],
    driver: "worker",
    driver_governing_target_key: "prompt/probe/worker",
    eval_namespace: "test/probe",
    commitPayload: {
      assembleCommitPayload: () => ({}),
      validateCommitPayload: () => ({ ok: true, failureReasons: [] }),
      qualityGateInput: () => null,
    },
    artifact_schema: { schema_version: "x", kinds: [] },
    ...overrides,
  };
}

function registryEffectWithProjector(id) {
  return {
    id,
    provider: "fake",
    op: "create_records",
    producedIdentity: {
      resource_kind: "fake_record",
      target_ids: (identity) => identity?.ids || [],
      identity: (identity) => ({ ids: identity?.ids || [] }),
    },
  };
}

function registryEffectWithoutProjector(id) {
  return {
    id,
    provider: "fake",
    op: "create_plain",
  };
}

function artifactSetLineage() {
  return {
    lineage_scope: "artifact_set",
    produced_by_turn_id: "turn-2",
    commit_decision_turn_id: "turn-2",
    informed_by_turn_ids: ["turn-1"],
    source_refs: ["project-1"],
  };
}

function emptyTrace() {
  return {
    attributes: {},
    spans: [],
    annotations: [],
  };
}

function spanSummaries(trace) {
  return trace.spans.map((span) => ({
    name: span.name,
    attributes: span.attributes,
  }));
}

function spanByName(trace, name) {
  return trace.spans.find((span) => span.name === name);
}
