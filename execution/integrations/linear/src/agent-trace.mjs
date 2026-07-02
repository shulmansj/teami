import { createLocalPhoenixTraceSink } from "./local-phoenix-trace-sink.mjs";
import { createTrace, recordSpan as recordTraceSpan } from "./trace.mjs";

export async function startAgentTrace({
  agent_role,
  run_id,
  resource,
  domain_id,
  workflow_type,
  repoRoot = process.cwd(),
  sinkFactory = createLocalPhoenixTraceSink,
  ensureReady,
  statusProbe,
  fetchImpl,
  now,
  idFactory,
  onProgress,
  runnerReadyTimeoutMs,
} = {}) {
  requireNonEmpty(agent_role, "agent_role");
  requireNonEmpty(run_id, "run_id");
  requireNonEmpty(domain_id, "domain_id");
  requireNonEmpty(workflow_type, "workflow_type");
  const normalizedResource = normalizeResource(resource);
  requireNonEmpty(normalizedResource?.kind, "resource.kind");
  requireNonEmpty(normalizedResource?.id, "resource.id");
  requireNonEmpty(normalizedResource?.label, "resource.label");

  const githubIdentity = githubIdentityForResource(normalizedResource);
  const trace = createTrace(workflow_type, {
    run_id,
    "workflow.name": workflow_type,
    "teami.domain_id": domain_id,
    "teami.agent_role": agent_role,
    "resource.kind": normalizedResource.kind,
    "resource.id": normalizedResource.id,
    "resource.label": normalizedResource.label,
    ...(githubIdentity.id ? { "github.behavior_repo_id": githubIdentity.id } : {}),
    ...(githubIdentity.label ? { "github.behavior_repo_label": githubIdentity.label } : {}),
  });

  let sink = null;
  let session = null;
  let startupError = null;
  try {
    sink = sinkFactory({
      repoRoot,
      ensureReady,
      statusProbe,
      fetchImpl,
      now,
      idFactory,
      onProgress,
      runnerReadyTimeoutMs,
    });
    session = await sink.startAgentRun({
      runId: run_id,
      domainId: domain_id,
      workflowType: workflow_type,
      agentRole: agent_role,
      resource: normalizedResource,
      githubBehaviorRepoId: githubIdentity.id,
      githubBehaviorRepoLabel: githubIdentity.label,
    });
  } catch (error) {
    startupError = error;
  }

  let finishPromise = null;
  return {
    trace,
    spanSink: {
      recordSpan(name, attributes = {}) {
        try {
          const resolvedAttributes = typeof attributes === "function" ? attributes() : attributes;
          return recordTraceSpan(trace, name, resolvedAttributes);
        } catch {
          return null;
        }
      },
    },
    finish({ status = "completed", reason = null } = {}) {
      finishPromise ||= finishAgentTrace({
        sink,
        session,
        trace,
        status,
        reason,
        startupError,
      });
      return finishPromise;
    },
  };
}

async function finishAgentTrace({
  sink,
  session,
  trace,
  status,
  reason,
  startupError,
}) {
  try {
    if (!sink || !session) {
      return {
        status: "trace_unavailable",
        reason: startupError?.message || "trace_session_unavailable",
      };
    }
    return await sink.finishRun({
      session,
      result: { status, reason, trace },
    }) || { status: "trace_unknown", reason: "trace_finish_returned_empty" };
  } catch (error) {
    return { status: "trace_delivery_failed", reason: error.message };
  } finally {
    try {
      await sink?.shutdown?.();
    } catch {
      // Observability cleanup must not change the agent outcome.
    }
  }
}

function normalizeResource(resource) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return null;
  return {
    kind: firstPresent(resource.kind),
    id: firstPresent(resource.id),
    label: firstPresent(resource.label),
  };
}

function githubIdentityForResource(resource) {
  const isGithubBehaviorRepo = String(resource?.kind || "").toLowerCase() === "github_behavior_repo";
  return {
    id: isGithubBehaviorRepo ? resource.id : null,
    label: isGithubBehaviorRepo ? resource.label : null,
  };
}

function requireNonEmpty(value, name) {
  if (!firstPresent(value)) throw new Error(`${name} is required for standalone agent traces.`);
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}
