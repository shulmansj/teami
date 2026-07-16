import { addAnnotation, recordSpan } from "../../trace.mjs";
import { evaluatePauseState } from "../../quality.mjs";
import { applyCommitEffects } from "../../../../../engine/commit-effects.mjs";
import { normalizeMarkdown } from "../../project-body.mjs";
import {
  issueDependencies,
  issueKey,
} from "../../linear/matching-utils.mjs";
import { applyProjectNeedsPrincipalComment } from "../../linear/project-needs-principal-comment.mjs";
import { resolveIssueStatuses } from "../../linear/shape-resolver.mjs";
import {
  findProjectUpdateByBodyRunId,
  postAuthoredProjectUpdate,
} from "./discovery-commit.mjs";
import {
  createOrReuseExecutionIssues,
  decompositionKeyForIssue,
  findIssueByDecompositionKey,
} from "./issue-commit.mjs";

export const ARTIFACT_TEAM_MISMATCH_REASON = "artifact_team_mismatch";
export const ARTIFACT_TEAM_CONTEXT_REQUIRED_REASON = "artifact_team_context_required";
export const ARTIFACT_PROJECT_MISMATCH_REASON = "artifact_project_mismatch";
export const LINEAR_ISSUES_EFFECT_ID = "linear_issues";

export const DECOMPOSITION_COMMIT_EFFECTS = Object.freeze([
  Object.freeze({
    id: LINEAR_ISSUES_EFFECT_ID,
    provider: "linear",
    op: "create_issues",
    producedIdentity: Object.freeze({
      resource_kind: "linear_issue",
      target_ids: linearIssuesTargetIds,
      identity: linearIssuesProducedIdentity,
    }),
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
  cache = null,
  replayed = false,
  teamContext = null,
  onBeforeLinearMutation = null,
  payload = artifact?.payload || null,
  runId = artifact?.run_id || null,
  environment = artifact?.environment || null,
  durable_record = null,
  commitEffects = DECOMPOSITION_COMMIT_EFFECTS,
}) {
  validateReplayArtifactTeam({ artifact, teamContext, replayed });
  if (artifact.kind === "checkpoint") {
    throw new Error("Persisted run checkpoint has no terminal Linear mutation artifact to replay.");
  }
  validateReplayArtifactProject({ artifact, projectId: project?.id, replayed });
  if (artifact.kind === "pause") {
    return pauseProjectFromArtifact({
      client,
      project,
      shape,
      cache,
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
    artifactSetLineage: artifact?.artifact_set_lineage,
  };
  const applyResult = await applyCommitEffects({ effects: commitEffects, ctx, trace });
  if (applyResult.outcome !== "ok") {
    recordSpan(trace, "commit_effect_pending", {
      pending_effect_id: applyResult.pending_effect_id,
      reason: applyResult.reason,
      run_id: artifact.run_id,
      // A single durable commit intent has been written; provider effects are
      // not a cross-provider transaction and converge by idempotent replay.
      atomicity: "durable_commit_intent_not_provider_transaction",
    });
    if (shouldThrowPendingEffect) {
      throw new Error(applyResult.reason || `commit_effect_pending:${applyResult.pending_effect_id}`);
    }
    return {
      status: "pending",
      pending_effect_id: applyResult.pending_effect_id,
      reason: applyResult.reason,
      trace,
    };
  }

  const linearIssues = applyResult.applied.find((effect) => effect.id === LINEAR_ISSUES_EFFECT_ID);
  const producedIdentities = applyResult.produced_identities;
  const artifactWithProducedIdentities = {
    ...artifact,
    produced_identities: producedIdentities,
  };
  const result = linearIssues?.identity?.result || {
    status: "completed",
    applied: applyResult.applied,
    trace,
  };
  return {
    ...result,
    produced_identities: producedIdentities,
    artifact: artifactWithProducedIdentities,
  };
}

export function validateReplayArtifactTeam({ artifact, teamContext, replayed = false } = {}) {
  if (!replayed) return;
  if (!teamContext?.teamRef) {
    throw new Error(`${ARTIFACT_TEAM_CONTEXT_REQUIRED_REASON}: replay requires a resolved TeamContext.`);
  }
  if (artifact?.team_ref !== teamContext.teamRef) {
    throw new Error(
      `${ARTIFACT_TEAM_MISMATCH_REASON}: artifact team_ref ${artifact?.team_ref || "missing"} does not match resolved team ${teamContext.teamRef}.`,
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

export async function pauseProjectFromArtifact({ client, project, shape, cache, artifact, trace, replayed, onBeforeLinearMutation }) {
  const packet = artifact.pause_packet;
  const isFailedClosed = artifact.source === "failed_closed";
  // A product-question pause and a safety `failed_closed` stop present to the human IDENTICALLY:
  // one app-authored comment on the project + a move to Principal Escalation — no project-body edit,
  // no Discovery issues, no project update. (Design ruling 2026-07-07: the two kinds of stop must
  // not feel different to the user; both are simply "a project that needs your attention".) The only
  // difference is the comment's content: a pause carries its open questions; a failed_closed stop
  // carries its authored "why I stopped" summary (falling back to its open questions).
  const commentMarkdown = isFailedClosed
    ? (packet.project_update_markdown || packet.open_questions_markdown)
    : packet.open_questions_markdown;

  await onBeforeLinearMutation?.({ artifactKind: artifact.kind, runId: artifact.run_id, trace });
  const escalationResult = await applyProjectNeedsPrincipalComment({
    client,
    projectId: project.id,
    runId: artifact.run_id,
    questionsMarkdown: commentMarkdown,
    statusId: shape.projectStatuses.needs_principal.id,
    cache: cache || shape.cache || null,
  });
  if (escalationResult.outcome !== "ok") {
    throw new Error(`Linear project pause comment/status mutation failed: ${escalationResult.reason || "unknown_reason"}`);
  }

  const verifiedProject = await client.getProjectContext(project.id);
  if (verifiedProject?.status?.id !== shape.projectStatuses.needs_principal.id) {
    throw new Error("Linear project pause status verification failed.");
  }
  addAnnotation(
    trace,
    evaluatePauseState({
      project: verifiedProject,
      attentionStatusId: shape.projectStatuses.needs_principal.id,
      appIdentityId: (cache || shape.cache || {}).app_identity_id,
    }),
  );
  recordSpan(trace, "create_linear_issues_or_pause_project", {
    action: "pause_project",
    phase: packet.phase,
    reason: packet.reason,
    replayed,
    source: artifact.source,
  });

  return {
    status: "paused",
    reason: packet.reason,
    comment: escalationResult.comment,
    trace,
  };
}

export async function commitIssuesFromArtifact({ client, config, project, shape, artifact, trace, replayed, onBeforeLinearMutation }) {
  const issueStatuses = shape.issueStatuses ||
    await resolveIssueStatuses(client, config, shape.team.id, shape.cache, { failClosed: true });
  await onBeforeLinearMutation?.({ artifactKind: artifact.kind, runId: artifact.run_id, trace });
  const projectBodyContent = projectBodyUpdateContent(artifact);
  if (projectBodyContent !== null) {
    await client.updateProject(project.id, {
      content: projectBodyContent,
    });
  }
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
    statusId: shape.projectStatuses.in_progress.id,
  });

  const flaggedHumanReviewIssues = humanReviewFlaggedFinalIssues(artifact.final_issues);
  recordSpan(trace, "create_linear_issues_or_pause_project", {
    action: "create_or_reuse_execution_issues",
    replayed,
    issues_created: creation.created.length,
    issues_reused: creation.reused.length,
    final_issue_count: Array.isArray(artifact.final_issues) ? artifact.final_issues.length : 0,
    human_review_flagged_count: flaggedHumanReviewIssues.length,
    human_review_flagged_issue_keys: flaggedHumanReviewIssues.map(issueKey),
    dependency_relations_created: creation.relationsCreated.length,
    dependency_relations_reused: creation.relationsReused.length,
    idempotent: creation.created.length === 0 && creation.relationsCreated.length === 0,
    ...(projectBodyContent !== null ? { project_body_updated: true } : {}),
    moved_project_to_status_id: shape.projectStatuses.in_progress.id,
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
  return { ok: true, identity };
}

async function verifyLinearIssuesEffect(ctx) {
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

  const expectedStatusId = ctx.shape.projectStatuses.in_progress.id;
  if (project.status?.id !== expectedStatusId) {
    return { ok: false, reason: "linear_project_status_not_started" };
  }
  const expectedProjectBodyContent = projectBodyUpdateContent(ctx.artifact);
  if (
    expectedProjectBodyContent !== null &&
    !sameMarkdown(project.content, expectedProjectBodyContent)
  ) {
    return { ok: false, reason: "linear_project_body_update_missing" };
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

function humanReviewFlaggedFinalIssues(finalIssues) {
  if (!Array.isArray(finalIssues)) return [];
  return finalIssues.filter((issue) => issue?.requires_human_review === true);
}

function projectBodyUpdateContent(artifact) {
  const update = artifact?.project_body_update ?? artifact?.payload?.project_body_update ?? null;
  if (update === null || update === undefined) return null;
  if (typeof update === "string") return normalizeMarkdown(update);
  if (typeof update?.content === "string" && update.content.trim() !== "") {
    return normalizeMarkdown(update.content);
  }
  throw new Error("project_body_update.content is required when project_body_update is present.");
}

function sameMarkdown(actual, expected) {
  return normalizeMarkdown(actual || "") === normalizeMarkdown(expected || "");
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

function linearIssuesTargetIds(identity) {
  return stringIds(identity?.issue_ids);
}

function linearIssuesProducedIdentity(identity) {
  return {
    issue_ids: stringIds(identity?.issue_ids),
    dependency_relation_ids: stringIds(identity?.dependency_relation_ids),
    project_update_id: identity?.project_update_id || null,
  };
}

function stringIds(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value || "")).filter(Boolean);
}
