import { addAnnotation, recordSpan } from "../../trace.mjs";
import { renderAuthoredIssueBody } from "../../issue-body.mjs";
import { setOpenQuestionsMarkdown } from "../../project-body.mjs";
import { evaluatePauseState } from "../../quality.mjs";
import { applyCommitEffects } from "../../../../../engine/commit-effects.mjs";
import {
  discoveryIssuesForProject,
  isIssueOpen,
  issueHasLabel,
  issueDependencies,
  issueKey,
} from "../../linear/matching-utils.mjs";
import { resolveIssueStatuses } from "../../linear/shape-resolver.mjs";
import {
  createOrReuseDiscoveryIssues,
  findProjectUpdateByBodyRunId,
  postAuthoredProjectUpdate,
  verifyOpenQuestionsAndPauseState,
  verifyOpenQuestionsMarkdown,
} from "./discovery-commit.mjs";
import {
  createOrReuseExecutionIssues,
  decompositionKeyForIssue,
  findIssueByDecompositionKey,
} from "./issue-commit.mjs";

export const ARTIFACT_DOMAIN_MISMATCH_REASON = "artifact_domain_mismatch";
export const ARTIFACT_DOMAIN_CONTEXT_REQUIRED_REASON = "artifact_domain_context_required";
export const ARTIFACT_PROJECT_MISMATCH_REASON = "artifact_project_mismatch";
export const LINEAR_ISSUES_EFFECT_ID = "linear_issues";

export const DECOMPOSITION_COMMIT_EFFECTS = Object.freeze([
  Object.freeze({
    id: LINEAR_ISSUES_EFFECT_ID,
    provider: "linear",
    op: "create_issues",
    probe: probeLinearIssuesEffect,
    apply: applyLinearIssuesEffect,
    verify: verifyLinearIssuesEffect,
  }),
]);

export async function applyPersistedArtifact({
  client,
  config,
  shape,
  project,
  artifact,
  trace,
  repoRoot,
  runStoreDir,
  replayed = false,
  domainContext = null,
  onBeforeLinearMutation = null,
  payload = artifact?.payload || null,
  runId = artifact?.run_id || null,
  environment = artifact?.environment || null,
  durable_record = null,
  commitEffects = DECOMPOSITION_COMMIT_EFFECTS,
}) {
  validateReplayArtifactDomain({ artifact, domainContext, replayed });
  if (artifact.kind === "checkpoint") {
    throw new Error("Persisted run checkpoint has no terminal Linear mutation artifact to replay.");
  }
  validateReplayArtifactProject({ artifact, projectId: project?.id, replayed });
  if (artifact.kind === "pause") {
    return pauseProjectFromArtifact({
      client,
      project,
      shape,
      artifact,
      trace,
      repoRoot,
      runStoreDir,
      replayed,
      onBeforeLinearMutation,
    });
  }
  if (artifact.kind === "commit") {
    return applyCommitArtifactEffects({
      client,
      config,
      project,
      shape,
      artifact,
      payload,
      trace,
      replayed,
      onBeforeLinearMutation,
      runId,
      environment,
      durable_record,
      commitEffects,
    });
  }
  if (artifact.kind === "resume") {
    return resumeFromArtifact({ client, project, shape, artifact, trace, replayed, onBeforeLinearMutation });
  }
  throw new Error(`Unknown persisted artifact kind: ${artifact.kind}`);
}

export async function maybeApplyPersistedArtifact({ evalMode = false, artifact, trace, ...options }) {
  if (evalMode) {
    recordSpan(trace, "eval_mode_non_mutating", {
      run_id: artifact.run_id,
      artifact_kind: artifact.kind,
      mutation_skipped: true,
    });
    return {
      status: "evaluated",
      artifact,
      mutationSkipped: true,
      trace,
    };
  }
  return applyPersistedArtifact({ ...options, artifact, trace });
}

async function applyCommitArtifactEffects({
  client,
  config,
  project,
  shape,
  artifact,
  payload,
  trace,
  replayed,
  onBeforeLinearMutation,
  runId,
  environment,
  durable_record,
  commitEffects,
}) {
  const shouldThrowPendingEffect = typeof onBeforeLinearMutation === "function";
  const ctx = {
    client,
    config,
    project,
    shape,
    artifact,
    payload,
    trace,
    replayed,
    onBeforeLinearMutation,
    runId,
    environment,
    durable_record,
    linearIssuesAppliedIdentity: null,
  };
  const applied = await applyCommitEffects({ effects: commitEffects, ctx });
  if (!applied.ok) {
    recordSpan(trace, "commit_effect_pending", {
      pending_effect_id: applied.pending_effect_id,
      reason: applied.reason,
      run_id: artifact.run_id,
      // A single durable commit intent has been written; provider effects are
      // not a cross-provider transaction and converge by idempotent replay.
      atomicity: "durable_commit_intent_not_provider_transaction",
    });
    if (shouldThrowPendingEffect) {
      throw new Error(applied.reason || `commit_effect_pending:${applied.pending_effect_id}`);
    }
    return {
      status: "pending",
      pending_effect_id: applied.pending_effect_id,
      reason: applied.reason,
      trace,
    };
  }

  const linearIssues = applied.applied.find((effect) => effect.id === LINEAR_ISSUES_EFFECT_ID);
  return linearIssues?.identity?.result || {
    status: "completed",
    applied: applied.applied,
    trace,
  };
}

export function validateReplayArtifactDomain({ artifact, domainContext, replayed = false } = {}) {
  if (!replayed) return;
  if (!domainContext?.domainId) {
    throw new Error(`${ARTIFACT_DOMAIN_CONTEXT_REQUIRED_REASON}: replay requires a resolved DomainContext.`);
  }
  if (artifact?.domain_id !== domainContext.domainId) {
    throw new Error(
      `${ARTIFACT_DOMAIN_MISMATCH_REASON}: artifact domain_id ${artifact?.domain_id || "missing"} does not match resolved domain ${domainContext.domainId}.`,
    );
  }
}

export function validateReplayArtifactProject({ artifact, projectId, replayed = false } = {}) {
  if (!replayed) return;
  if (!artifact?.linear_project_id || artifact.linear_project_id !== projectId) {
    throw new Error(
      `${ARTIFACT_PROJECT_MISMATCH_REASON}: artifact linear_project_id ${artifact?.linear_project_id || "missing"} does not match requested project ${projectId || "missing"}.`,
    );
  }
}

export async function pauseProjectFromArtifact({ client, project, shape, artifact, trace, replayed, onBeforeLinearMutation }) {
  const packet = artifact.pause_packet;
  const content = setOpenQuestionsMarkdown(project.content || "", packet.open_questions_markdown);
  const labelIds = new Set((project.labels || []).map((label) => label.id));
  labelIds.add(shape.projectLabels.hasOpenQuestions.id);

  await onBeforeLinearMutation?.({ artifactKind: artifact.kind, runId: artifact.run_id, trace });
  await client.updateProject(project.id, {
    content,
    labelIds: [...labelIds],
    statusId: shape.projectStatuses.backlog.id,
  });

  const discoveryResult = await createOrReuseDiscoveryIssues({
    client,
    project,
    shape,
    discoveryIssues: artifact.discovery_issues || [],
  });
  const verifiedProject = await verifyOpenQuestionsAndPauseState({
    client,
    projectId: project.id,
    shape,
    openQuestionsMarkdown: packet.open_questions_markdown,
  });
  const updateResult = await postAuthoredProjectUpdate({
    client,
    projectId: project.id,
    runId: artifact.run_id,
    projectUpdateMarkdown: packet.project_update_markdown,
  });

  recordSpan(trace, "create_linear_issues_or_pause_project", {
    action: "pause_project",
    phase: packet.phase,
    reason: packet.reason,
    replayed,
    discovery_issue_created_count: discoveryResult.created.length,
    discovery_issue_reused_count: discoveryResult.reused.length,
    open_questions_replaced_from_authored_markdown: true,
  });
  recordSpan(trace, "post_project_update", {
    action: updateResult.created ? "created" : "reused",
    run_id: artifact.run_id,
    exact_authored_markdown: true,
  });
  addAnnotation(
    trace,
    evaluatePauseState({
      project: verifiedProject,
      hasOpenQuestionsLabelId: shape.projectLabels.hasOpenQuestions.id,
      backlogStatusId: shape.projectStatuses.backlog.id,
    }),
  );

  return {
    status: "paused",
    reason: packet.reason,
    discoveryIssues: discoveryResult.issues,
    discoveryIssuesCreated: discoveryResult.created,
    discoveryIssuesReused: discoveryResult.reused,
    projectUpdate: updateResult.update,
    trace,
  };
}

export async function commitIssuesFromArtifact({ client, config, project, shape, artifact, trace, replayed, onBeforeLinearMutation }) {
  const issueStatuses = await resolveIssueStatuses(client, config, shape.team.id);
  await onBeforeLinearMutation?.({ artifactKind: artifact.kind, runId: artifact.run_id, trace });
  const creation = await createOrReuseExecutionIssues({
    client,
    config,
    project,
    shape: {
      ...shape,
      issueStatuses,
    },
    issues: artifact.final_issues,
  });

  await client.updateProject(project.id, {
    statusId: shape.projectStatuses.started.id,
  });

  recordSpan(trace, "create_linear_issues_or_pause_project", {
    action: "create_or_reuse_execution_issues",
    replayed,
    issues_created: creation.created.length,
    issues_reused: creation.reused.length,
    dependency_relations_created: creation.relationsCreated.length,
    dependency_relations_reused: creation.relationsReused.length,
    idempotent: creation.created.length === 0 && creation.relationsCreated.length === 0,
    moved_project_to_status_id: shape.projectStatuses.started.id,
  });

  const updateResult = await postAuthoredProjectUpdate({
    client,
    projectId: project.id,
    runId: artifact.run_id,
    projectUpdateMarkdown: artifact.project_update_markdown,
  });
  recordSpan(trace, "post_project_update", {
    action: updateResult.created ? "created" : "reused",
    run_id: artifact.run_id,
    exact_authored_markdown: true,
  });

  return { status: "completed", ...creation, projectUpdate: updateResult.update, trace };
}

async function probeLinearIssuesEffect(ctx) {
  const checked = await readLinearIssuesEffectState(ctx);
  if (checked.ok) return { satisfied: true, identity: checked.identity };
  return { satisfied: false, reason: checked.reason };
}

async function applyLinearIssuesEffect(ctx) {
  const result = await commitIssuesFromArtifact({
    client: ctx.client,
    config: ctx.config,
    project: ctx.project,
    shape: ctx.shape,
    artifact: ctx.artifact,
    trace: ctx.trace,
    replayed: ctx.replayed,
    onBeforeLinearMutation: ctx.onBeforeLinearMutation,
  });
  if (result?.status !== "completed") {
    return { ok: false, reason: "linear_issues_apply_not_completed" };
  }
  const identity = linearIssuesIdentityFromResult(result);
  ctx.linearIssuesAppliedIdentity = identity;
  return { ok: true, identity };
}

async function verifyLinearIssuesEffect(ctx) {
  if (ctx.linearIssuesAppliedIdentity?.result?.status === "completed") {
    return { ok: true, identity: ctx.linearIssuesAppliedIdentity };
  }
  try {
    const checked = await readLinearIssuesEffectState(ctx);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    return { ok: true, identity: checked.identity };
  } catch (error) {
    return { ok: false, reason: error?.message || "linear_issues_verify_failed" };
  }
}

async function readLinearIssuesEffectState(ctx) {
  const finalIssues = finalIssuesForEffect(ctx);
  if (!Array.isArray(finalIssues) || finalIssues.length === 0) {
    return { ok: false, reason: "linear_issues_final_issues_missing" };
  }

  const project = await ctx.client.getProjectContext(ctx.project.id);
  const projectIssuesByKey = new Map(
    (project.issues || [])
      .map((issue) => [decompositionKeyForIssue(issue), issue])
      .filter(([key]) => typeof key === "string" && key !== ""),
  );
  const issueByKey = new Map();
  for (const issue of finalIssues) {
    const key = issueKey(issue);
    const existing =
      projectIssuesByKey.get(key) ||
      await findIssueByDecompositionKey(ctx.client, ctx.project.id, key);
    if (!existing) return { ok: false, reason: "linear_issue_missing" };
    issueByKey.set(key, existing);
  }

  const expectedStatusId = ctx.shape.projectStatuses.started.id;
  if (project.status?.id !== expectedStatusId) {
    return { ok: false, reason: "linear_project_status_not_started" };
  }

  const runId = ctx.runId || ctx.artifact?.run_id;
  const projectUpdate = await findAuthoredProjectUpdate({
    client: ctx.client,
    projectId: ctx.project.id,
    runId,
  });
  if (!projectUpdate) return { ok: false, reason: "linear_project_update_missing" };

  const relations = [];
  for (const issue of finalIssues) {
    const dependentIssue = issueByKey.get(issueKey(issue));
    for (const dependencyKey of issueDependencies(issue)) {
      const blockingIssue = issueByKey.get(dependencyKey);
      if (!blockingIssue) return { ok: false, reason: "linear_dependency_issue_missing" };
      const relation = await findLinearDependencyRelation({
        client: ctx.client,
        project,
        blockingIssue,
        dependentIssue,
      });
      if (!relation) return { ok: false, reason: "linear_dependency_relation_missing" };
      relations.push(relation);
    }
  }

  return {
    ok: true,
    identity: linearIssuesIdentityFromVerifiedState({
      issues: [...issueByKey.values()],
      relations,
      project,
      projectUpdate,
      trace: ctx.trace,
    }),
  };
}

function finalIssuesForEffect(ctx) {
  return ctx.artifact?.final_issues || ctx.payload?.final_issues || ctx.artifact?.payload?.final_issues;
}

async function findAuthoredProjectUpdate({ client, projectId, runId }) {
  if (typeof runId !== "string" || runId.trim() === "") return null;
  return (
    (await client.findProjectUpdateByRunId?.(projectId, runId)) ||
    (await findProjectUpdateByBodyRunId(client, projectId, runId))
  );
}

async function findLinearDependencyRelation({ client, project, blockingIssue, dependentIssue }) {
  if (typeof client.findIssueRelation === "function") {
    const relation = await client.findIssueRelation({
      issueId: blockingIssue.id,
      relatedIssueId: dependentIssue.id,
      type: "blocks",
    });
    if (relation) return relation;
  }

  if (typeof client.getIssueContext === "function") {
    const issue = await client.getIssueContext(blockingIssue.id);
    const relation = relationFromIssue(issue, { blockingIssue, dependentIssue });
    if (relation) return relation;
  }

  for (const issue of project.issues || []) {
    const relation = relationFromIssue(issue, { blockingIssue, dependentIssue });
    if (relation) return relation;
  }
  return null;
}

function relationFromIssue(issue, { blockingIssue, dependentIssue }) {
  return (
    (issue?.relations || []).find((relation) =>
      relation.type === "blocks" &&
      relation.issue?.id === blockingIssue.id &&
      relation.relatedIssue?.id === dependentIssue.id,
    ) || null
  );
}

function linearIssuesIdentityFromResult(result) {
  return {
    issue_ids: [...(result.created || []), ...(result.reused || [])].map((issue) => issue.id),
    dependency_relation_ids: [
      ...(result.relationsCreated || []),
      ...(result.relationsReused || []),
    ].map((relation) => relation.id),
    project_update_id: result.projectUpdate?.id || null,
    result,
  };
}

function linearIssuesIdentityFromVerifiedState({ issues, relations, project, projectUpdate, trace }) {
  return {
    issue_ids: issues.map((issue) => issue.id),
    dependency_relation_ids: relations.map((relation) => relation.id),
    project_status_id: project.status?.id || null,
    project_update_id: projectUpdate.id || null,
    result: {
      status: "completed",
      created: [],
      reused: issues,
      relationsCreated: [],
      relationsReused: relations,
      projectUpdate,
      trace,
    },
  };
}

export async function resumeFromArtifact({ client, project, shape, artifact, trace, replayed, onBeforeLinearMutation }) {
  const packet = artifact.packet;

  await onBeforeLinearMutation?.({ artifactKind: artifact.kind, runId: artifact.run_id, trace });
  for (const update of packet?.discovery_issue_updates || []) {
    if (!client.updateIssue) {
      throw new Error("Linear client cannot update Discovery issue evidence.");
    }
    const discoveryKey = update.discovery_key || update.decompositionKey;
    const expectedIssue = await findIssueByDecompositionKey(client, project.id, discoveryKey);
    if (!expectedIssue || expectedIssue.id !== (update.issue_id || update.issueId)) {
      throw new Error("Discovery issue update does not match the current project and discovery key.");
    }
    if (!issueHasLabel(expectedIssue, shape.issueLabels.discovery.id)) {
      throw new Error("Discovery issue update target is missing the Discovery label.");
    }
    await client.updateIssue(expectedIssue.id, {
      description: renderAuthoredIssueBody({
        decompositionKey: discoveryKey,
        issueBodyMarkdown: update.body_markdown,
      }),
      stateId: update.state_id || update.stateId,
    });
  }

  const refreshedBeforeGate = await client.getProjectContext(project.id);
  const content = setOpenQuestionsMarkdown(
    refreshedBeforeGate.content || "",
    packet.open_questions_markdown,
  );
  const discoveryIssues = discoveryIssuesForProject(refreshedBeforeGate, shape);
  const openDiscoveryIssueCount = discoveryIssues.filter(isIssueOpen).length;
  const hasRemainingOpenQuestions = packet.open_questions_markdown.trim() !== "";
  const canReturnToPlanned = !hasRemainingOpenQuestions && openDiscoveryIssueCount === 0;
  const labelIds = new Set((refreshedBeforeGate.labels || []).map((label) => label.id));
  if (canReturnToPlanned) labelIds.delete(shape.projectLabels.hasOpenQuestions.id);
  else labelIds.add(shape.projectLabels.hasOpenQuestions.id);

  await client.updateProject(project.id, {
    content,
    labelIds: [...labelIds],
    statusId: canReturnToPlanned ? shape.projectStatuses.planned.id : shape.projectStatuses.backlog.id,
  });

  const verifiedProject = await client.getProjectContext(project.id);
  verifyOpenQuestionsMarkdown(verifiedProject, packet.open_questions_markdown);
  const updateResult = await postAuthoredProjectUpdate({
    client,
    projectId: project.id,
    runId: artifact.run_id,
    projectUpdateMarkdown: packet.project_update_markdown,
  });

  recordSpan(trace, "create_linear_issues_or_pause_project", {
    action: "resume_project",
    replayed,
    returned_to_planned: canReturnToPlanned,
    open_discovery_issue_count: openDiscoveryIssueCount,
    has_remaining_open_questions: hasRemainingOpenQuestions,
  });
  recordSpan(trace, "post_project_update", {
    action: updateResult.created ? "created" : "reused",
    run_id: artifact.run_id,
    exact_authored_markdown: true,
  });

  return {
    status: canReturnToPlanned ? "resumed" : "still_paused",
    project: verifiedProject,
    projectUpdate: updateResult.update,
    openDiscoveryIssueCount,
    hasRemainingOpenQuestions,
    trace,
  };
}
