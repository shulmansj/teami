import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  getWorkflowDefinition,
  registeredWorkflowTypes,
} from "../../../engine/workflow-registry.mjs";
import { renameWithRetry } from "../../../engine/run-store.mjs";
import {
  resolveEvalContract,
} from "./eval-annotation-contract.mjs";
import {
  findTokenShapedContent,
  sanitizeAndClassifyContent,
} from "./eval-content-gate.mjs";
import {
  ensurePhoenixReady,
} from "./local-phoenix-manager.mjs";
import {
  phoenixFetchJson,
} from "./phoenix-self-improvement.mjs";
import {
  canonicalJsonStringify,
} from "./project-snapshot-store.mjs";
import {
  computeExampleContentHash,
} from "./rich-promotion.mjs";
import {
  decompositionDefinition,
} from "./workflows/decomposition/definition.mjs";
import { resolveTeamiHome, teamiHomePaths } from "./app-home.mjs";

export const FIXTURE_DATASET_ROW_SCHEMA_VERSION =
  "teami-fixture-dataset-row/v1";
export const FIXTURE_DATASET_EXPORT_MANIFEST_SCHEMA_VERSION =
  "teami-fixture-dataset-export-manifest/v1";
export const FIXTURE_DATASET_EXPORT_GRANT_SCHEMA_VERSION =
  "teami-fixture-dataset-export-grant/v1";
export const FIXTURE_DATASET_EXPORT_PROFILE_SCHEMA_VERSION =
  "teami-fixture-export-profile/v1";
export const FIXTURE_DATASET_EXPORT_PRODUCER_VERSION = "fixture-dataset-exporter/v1";

const DEFAULT_DESTINATION = Object.freeze({
  destination_type: "git-v1",
  destination_id: "maintainer_fixture_contribution_remote",
  write_path: "deferred_adopter_push_wiring",
});

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DELETE_TOKEN_PREFIX = "fixture-delete";
const RAW_OPT_IN_EXPORT_REASON = "fixture_export_raw_opt_in_not_granted";
const DEFAULT_EXCLUDED_REASON = "fixture_export_default_excluded";

const stringPolicy = Object.freeze({ allow: "string" });
const scalarPolicy = Object.freeze({ allow: "scalar" });
const digestPolicy = Object.freeze({
  object: {
    digest_kind: { allow: "string" },
    sha256: { allow: "string" },
    byte_length: { allow: "scalar" },
    value_type: { allow: "string" },
    item_count: { allow: "scalar" },
    redaction: { allow: "string" },
  },
});
const labelPolicy = Object.freeze({
  object: {
    id: stringPolicy,
    name: stringPolicy,
  },
});
const existingIssuePolicy = Object.freeze({
  object: {
    id: stringPolicy,
    identifier: stringPolicy,
    title: stringPolicy,
    state: {
      object: {
        id: stringPolicy,
        name: stringPolicy,
        type: stringPolicy,
      },
    },
    labels: { array: labelPolicy },
  },
});
const finalIssuePolicy = Object.freeze({
  object: {
    decomposition_key: stringPolicy,
    decompositionKey: stringPolicy,
    title: stringPolicy,
    issue_body_markdown: stringPolicy,
    issueBodyMarkdown: stringPolicy,
    assignment: stringPolicy,
    output: stringPolicy,
    acceptanceCriteria: { array: stringPolicy },
    acceptance_criteria: { array: stringPolicy },
    depends_on: { array: stringPolicy },
    dependsOn: { array: stringPolicy },
  },
});
const dependencyRelationPolicy = Object.freeze({
  object: {
    blocking: stringPolicy,
    blocked: stringPolicy,
  },
});
const phasePacketPolicy = Object.freeze({
  object: {
    schema_version: stringPolicy,
    run_id: stringPolicy,
    phase: stringPolicy,
    status: stringPolicy,
    reason: stringPolicy,
    context_digest: stringPolicy,
    assumptions: { array: stringPolicy },
    constraints: { array: stringPolicy },
    risks: { array: stringPolicy },
    open_questions_markdown: stringPolicy,
    project_update_markdown: stringPolicy,
    technical_explanation_markdown: stringPolicy,
    perspectives_run: {
      array: {
        object: {
          role: stringPolicy,
          outcome: stringPolicy,
          evidence_ref: stringPolicy,
          failure_code: stringPolicy,
        },
      },
    },
  },
});
const provenancePolicy = Object.freeze({
  object: {
    label_source: stringPolicy,
    label_status: stringPolicy,
    labeled_at: stringPolicy,
    annotator_id: stringPolicy,
  },
});
const producedIdentityRefPolicy = Object.freeze({
  object: {
    effect_id: stringPolicy,
    provider: stringPolicy,
    resource_kind: stringPolicy,
    target_ids: { array: stringPolicy },
  },
});

function field({ tier = "allow", policy, defaultTier = null, reason = null } = {}) {
  return Object.freeze({ tier, policy, default_tier: defaultTier, reason });
}

export const DEFAULT_FIXTURE_EXPORT_PROFILE = Object.freeze({
  schema_version: FIXTURE_DATASET_EXPORT_PROFILE_SCHEMA_VERSION,
  profile_id: "maintainer-fixture-dataset/git-v1",
  profile_version: "1.0.0",
  fields: Object.freeze({
    artifact_kind: field({ policy: stringPolicy }),
    schema_version: field({ policy: stringPolicy }),

    "input.project_intent.id": field({ policy: stringPolicy }),
    "input.project_intent.name": field({ policy: stringPolicy }),
    "input.project_intent.description": field({
      tier: "raw_opt_in",
      defaultTier: "digest",
      policy: stringPolicy,
    }),
    "input.project_intent.content": field({
      tier: "raw_opt_in",
      defaultTier: "digest",
      policy: stringPolicy,
    }),
    "input.project_intent.status": field({ policy: stringPolicy }),
    "input.project_intent.labels": field({
      tier: "default",
      policy: { array: labelPolicy },
      reason: "roadmap_labels_default_excluded",
    }),
    "input.project_intent.existing_issues": field({
      tier: "default",
      policy: { array: existingIssuePolicy },
      reason: "roadmap_existing_issues_default_excluded",
    }),
    "input.terminal_status": field({ policy: stringPolicy }),
    "input.terminal_reason": field({ policy: stringPolicy }),
    "input.final_issues": field({
      tier: "raw_opt_in",
      defaultTier: "digest",
      policy: { array: finalIssuePolicy },
    }),
    "input.dependency_relations": field({ policy: { array: dependencyRelationPolicy } }),
    "input.project_update_markdown": field({
      tier: "raw_opt_in",
      defaultTier: "digest",
      policy: stringPolicy,
    }),
    "input.open_questions_markdown": field({
      tier: "raw_opt_in",
      defaultTier: "digest",
      policy: stringPolicy,
    }),
    "input.phase_packet_summaries": field({
      tier: "digest",
      policy: { array: phasePacketPolicy },
    }),

    expected_label: field({ policy: stringPolicy }),
    expected_score: field({ policy: scalarPolicy }),
    provenance: field({ policy: provenancePolicy }),

    "metadata.eval_namespace": field({ policy: stringPolicy }),
    "metadata.workflow_type": field({ policy: stringPolicy }),
    "metadata.rubric_version": field({ policy: stringPolicy }),
    "metadata.failure_taxonomy_version": field({ policy: stringPolicy }),
    "metadata.workspace_maturity": field({ policy: stringPolicy }),
    "metadata.project_category": field({ policy: stringPolicy }),
    "metadata.project_impact_level": field({ policy: stringPolicy }),
    "metadata.lifecycle_state": field({ policy: stringPolicy }),
    "metadata.process_version": field({ policy: stringPolicy }),
    "metadata.source_trace_id": field({ policy: stringPolicy }),
    "metadata.source_run_id": field({ policy: stringPolicy }),
    "metadata.source_target_ids": field({ policy: { array: stringPolicy } }),
    "metadata.produced_identity_refs": field({ policy: { array: producedIdentityRefPolicy } }),
    "metadata.dataset_split": field({ policy: stringPolicy }),
    "metadata.content_retention": field({ policy: stringPolicy }),
    "metadata.source_example_id": field({ policy: stringPolicy }),
    "metadata.source_dataset_id": field({ policy: stringPolicy }),
    "metadata.source_dataset_version_id": field({ policy: stringPolicy }),
  }),
});

export function defaultFixtureExportDir(home = resolveTeamiHome()) {
  return path.join(teamiHomePaths({ home }).home, "fixture-exports");
}

export function fixtureExportGrantPath(home = resolveTeamiHome()) {
  return path.join(defaultFixtureExportDir(home), "consent-grant.json");
}

export function fixtureExportLogPath(home = resolveTeamiHome()) {
  return path.join(defaultFixtureExportDir(home), "export-log.jsonl");
}

export function buildFixtureExportConsentPreview({
  repoRoot = process.cwd(),
  definitions = [decompositionDefinition],
  profile = DEFAULT_FIXTURE_EXPORT_PROFILE,
  destination = DEFAULT_DESTINATION,
  rawOptInPaths = [],
} = {}) {
  const resolvedDefinitions = resolveDefinitionList(definitions);
  const functionScopes = resolvedDefinitions.map((definition) => {
    const contract = resolveExportEvalContract(definition, repoRoot);
    return {
      workflow_type: definition.workflow_type,
      eval_namespace: definition.eval_namespace,
      rich_example_dataset_name: contract.rich_example_dataset_name || null,
      eval_configured: contract.eval_configured === true,
    };
  });
  const normalizedRawOptIns = normalizeRawOptInPaths(rawOptInPaths, profile);
  const scope = {
    schema_version: "teami-fixture-export-consent-scope/v1",
    destination: normalizeDestination(destination),
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    profile_field_hash: sha256CanonicalJson(profile.fields || {}),
    raw_opt_in_paths: normalizedRawOptIns,
    functions: functionScopes,
  };
  return {
    ok: true,
    scope,
    scope_hash: sha256CanonicalJson(scope),
    profile,
    destination: scope.destination,
    raw_opt_in_paths: normalizedRawOptIns,
    repo_root_pseudonym: workspacePseudonym(repoRoot),
  };
}

export function createFixtureExportGrant({
  repoRoot = process.cwd(),
  definitions = [decompositionDefinition],
  profile = DEFAULT_FIXTURE_EXPORT_PROFILE,
  destination = DEFAULT_DESTINATION,
  rawOptInPaths = [],
  consentGrantId = null,
  consentedBy = null,
  now = () => new Date(),
} = {}) {
  const preview = buildFixtureExportConsentPreview({
    repoRoot,
    definitions,
    profile,
    destination,
    rawOptInPaths,
  });
  const grantedAt = normalizeNow(now).toISOString();
  const grantId =
    consentGrantId ||
    `fixture_export_grant_${preview.scope_hash.slice(0, 16)}`;
  return {
    schema_version: FIXTURE_DATASET_EXPORT_GRANT_SCHEMA_VERSION,
    consent_grant_id: grantId,
    status: "active",
    granted_at: grantedAt,
    latest_confirmed_at: grantedAt,
    consented_by: textOrNull(consentedBy),
    workspace_pseudonym: preview.repo_root_pseudonym,
    scope_hash: preview.scope_hash,
    scope: preview.scope,
    raw_opt_in_paths: preview.raw_opt_in_paths,
    capabilities: {
      periodic_batched_export: true,
      per_batch_review_required: false,
      pausable: true,
      opt_outable: true,
      pre_ingestion_reversible: true,
      transport_push: "deferred_git_v1_only",
    },
  };
}

export function writeFixtureExportGrant({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  grantPath = fixtureExportGrantPath(home),
  ...options
} = {}) {
  const grant = createFixtureExportGrant({ repoRoot, ...options });
  writeJsonAtomic(grantPath, grant);
  return { ok: true, grant, grant_path: grantPath };
}

export function readFixtureExportGrant({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  grantPath = fixtureExportGrantPath(home),
} = {}) {
  void repoRoot;
  try {
    if (!fs.existsSync(grantPath)) {
      return { ok: false, reason: "fixture_export_consent_required", grant_path: grantPath };
    }
    const grant = JSON.parse(fs.readFileSync(grantPath, "utf8"));
    if (grant.schema_version !== FIXTURE_DATASET_EXPORT_GRANT_SCHEMA_VERSION) {
      return { ok: false, reason: "invalid_fixture_export_grant", grant_path: grantPath };
    }
    return { ok: true, grant, grant_path: grantPath };
  } catch (error) {
    return {
      ok: false,
      reason: "fixture_export_grant_unreadable",
      detail: error.message,
      grant_path: grantPath,
    };
  }
}

export function validateFixtureExportConsent({
  grant,
  preview,
} = {}) {
  if (!grant) {
    return { ok: false, reason: "fixture_export_consent_required", re_prompt_required: true };
  }
  if (grant.status === "paused") {
    return { ok: false, reason: "fixture_export_paused", paused: true };
  }
  if (grant.status === "revoked") {
    return { ok: false, reason: "fixture_export_opted_out", opted_out: true };
  }
  if (grant.status !== "active") {
    return { ok: false, reason: "fixture_export_grant_inactive", re_prompt_required: true };
  }
  if (grant.scope_hash !== preview?.scope_hash) {
    return {
      ok: false,
      reason: "fixture_export_consent_scope_changed",
      re_prompt_required: true,
      old_scope_hash: grant.scope_hash || null,
      new_scope_hash: preview?.scope_hash || null,
    };
  }
  return { ok: true };
}

export function buildFixtureDatasetExport({
  records = [],
  definition = decompositionDefinition,
  evalContract = null,
  profile = DEFAULT_FIXTURE_EXPORT_PROFILE,
  destination = DEFAULT_DESTINATION,
  grant = null,
  dataset = {},
  repoRoot = process.cwd(),
  generatedAt = new Date().toISOString(),
  annotationReader = null,
  outcomeReader = null,
} = {}) {
  void annotationReader;
  void outcomeReader;
  const contract = evalContract || resolveExportEvalContract(definition, repoRoot);
  if (contract.eval_configured !== true || !contract.rich_example_dataset_name) {
    return {
      ok: true,
      status: "skipped",
      reason: contract.reason || "rich_example_dataset_not_configured",
      workflow_type: definition.workflow_type,
      eval_namespace: definition.eval_namespace,
    };
  }
  const rawOptInPaths = grant?.raw_opt_in_paths || [];
  const compiled = compileFixtureExportProfile({ profile, rawOptInPaths });
  if (!compiled.ok) return compiled;

  const rows = [];
  const skipped = [];
  for (const record of records) {
    const normalized = normalizeFixtureDatasetRecord({
      record,
      definition,
      contract,
      dataset,
    });
    if (!normalized.ok) {
      if (normalized.skip === true) skipped.push(normalized);
      else return normalized;
      continue;
    }
    const gated = gateFixtureDatasetRow({
      row: normalized.row,
      compiled,
      profile,
      workflowType: definition.workflow_type,
    });
    if (!gated.ok) return gated;
    rows.push({
      source_example_id: normalized.source_example_id,
      row: gated.row,
      content_hash: computeExampleContentHash(gated.row),
      sanitizer_report: mergeSanitizerReports(gated.audit_report, gated.export_report),
    });
  }

  const destinationRecord = normalizeDestination(destination);
  const batchHash = sha256CanonicalJson(rows.map((entry) => entry.row));
  const submissionId = `fixture_export_${batchHash.slice(0, 16)}`;
  const jsonlEntries = rows.map((entry) => {
    const envelope = buildTransportEnvelope({
      submissionId,
      row: entry.row,
      rowContentHash: entry.content_hash,
      grant,
      profile,
      destination: destinationRecord,
      dataset,
      generatedAt,
      repoRoot,
    });
    return {
      ...envelope,
      artifact: entry.row,
    };
  });
  const jsonl = jsonlEntries.length > 0
    ? `${jsonlEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    : "";
  const manifest = {
    schema_version: FIXTURE_DATASET_EXPORT_MANIFEST_SCHEMA_VERSION,
    artifact_kind: "fixture_dataset_export_manifest",
    export_id: submissionId,
    generated_at: generatedAt,
    producer_version: FIXTURE_DATASET_EXPORT_PRODUCER_VERSION,
    destination: destinationRecord,
    profile: {
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      raw_opt_in_paths: [...compiled.raw_opt_in_paths],
    },
    consent_grant_id: grant?.consent_grant_id || null,
    workspace_pseudonym: grant?.workspace_pseudonym || workspacePseudonym(repoRoot),
    dataset: {
      name: contract.rich_example_dataset_name,
      dataset_id: dataset.dataset_id || null,
      dataset_version_id: dataset.dataset_version_id || null,
      latest_version: true,
    },
    workflow_type: definition.workflow_type,
    eval_namespace: definition.eval_namespace,
    row_count: rows.length,
    skipped_count: skipped.length,
    batch_content_hash: batchHash,
    artifact_kinds: ["fixture_dataset"],
    aggregate_signal_report: {
      builder_status: "deferred",
      emitted: false,
      uploadable_as_dataset: false,
    },
    sanitizer_reports: rows.map((entry) => ({
      source_example_id: entry.source_example_id,
      content_hash: entry.content_hash,
      report: entry.sanitizer_report,
    })),
    skipped,
  };
  return {
    ok: true,
    status: rows.length > 0 ? "built" : "idle",
    export_id: submissionId,
    batch_content_hash: batchHash,
    jsonl,
    jsonl_entries: jsonlEntries,
    manifest,
    rows,
    skipped,
  };
}

export async function runFixtureDatasetExport({
  repoRoot = process.cwd(),
  home = resolveTeamiHome(),
  definitions = [decompositionDefinition],
  workflowTypes = null,
  profile = DEFAULT_FIXTURE_EXPORT_PROFILE,
  destination = DEFAULT_DESTINATION,
  grant = null,
  grantPath = fixtureExportGrantPath(home),
  outputDir = defaultFixtureExportDir(home),
  ensureReady = ensurePhoenixReady,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  now = () => new Date(),
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const resolvedDefinitions = workflowTypes
    ? resolveDefinitionsByWorkflowTypes(workflowTypes)
    : resolveDefinitionList(definitions);
  const grantRead = grant
    ? { ok: true, grant, grant_path: grantPath }
    : readFixtureExportGrant({ repoRoot, home, grantPath });
  const resolvedGrant = grantRead.grant;
  const preview = buildFixtureExportConsentPreview({
    repoRoot,
    definitions: resolvedDefinitions,
    profile,
    destination,
    rawOptInPaths: resolvedGrant?.raw_opt_in_paths || [],
  });
  if (!grantRead.ok) {
    return {
      ok: true,
      status: "skipped",
      reason: grantRead.reason,
      re_prompt_required: true,
      grant_path: grantRead.grant_path,
      preview,
    };
  }
  const consent = validateFixtureExportConsent({ grant: resolvedGrant, preview });
  if (!consent.ok) {
    return {
      ok: true,
      status: "skipped",
      reason: consent.reason,
      re_prompt_required: consent.re_prompt_required === true,
      paused: consent.paused === true,
      opted_out: consent.opted_out === true,
      grant_path: grantPath,
      preview,
    };
  }

  const ready = await ensureReady({ repoRoot, fetchImpl, onProgress });
  if (!ready.ok) {
    return {
      ok: false,
      status: "blocked",
      reason: ready.reason || "local_phoenix_unavailable",
    };
  }

  const generatedAt = normalizeNow(now).toISOString();
  const built = [];
  const skipped = [];
  for (const definition of resolvedDefinitions) {
    const contract = resolveExportEvalContract(definition, repoRoot);
    if (contract.eval_configured !== true || !contract.rich_example_dataset_name) {
      skipped.push({
        workflow_type: definition.workflow_type,
        eval_namespace: definition.eval_namespace,
        reason: contract.reason || "rich_example_dataset_not_configured",
      });
      continue;
    }
    const datasetRead = await readLatestRichExampleDataset({
      appUrl: ready.appUrl,
      datasetName: contract.rich_example_dataset_name,
      fetchImpl,
      timeoutMs,
    });
    if (!datasetRead.ok) {
      skipped.push({
        workflow_type: definition.workflow_type,
        eval_namespace: definition.eval_namespace,
        reason: datasetRead.reason,
        dataset_name: contract.rich_example_dataset_name,
      });
      continue;
    }
    const exportBuild = buildFixtureDatasetExport({
      records: datasetRead.records,
      definition,
      evalContract: contract,
      profile,
      destination,
      grant: resolvedGrant,
      dataset: datasetRead.dataset,
      repoRoot,
      generatedAt,
    });
    if (!exportBuild.ok) return exportBuild;
    built.push(exportBuild);
  }

  const active = built.filter((entry) => entry.rows?.length > 0);
  if (active.length === 0) {
    return {
      ok: true,
      status: "idle",
      reason: "no_fixture_rows_to_export",
      skipped,
      output_dir: outputDir,
    };
  }
  const batchContentHash = sha256CanonicalJson(active.map((entry) => entry.batch_content_hash));
  const existing = findExistingExportByBatchHash({ repoRoot, home, outputDir, batchContentHash });
  if (existing) {
    return {
      ok: true,
      status: "idempotent",
      idempotent: true,
      batch_content_hash: batchContentHash,
      manifest_path: existing.manifest_path,
      jsonl_path: existing.jsonl_path,
      log_path: fixtureExportLogPath(home),
    };
  }

  const exportId = `fixture_export_${compactTimestamp(generatedAt)}_${batchContentHash.slice(0, 12)}`;
  const exportDir = path.join(outputDir, exportId);
  const jsonlPath = path.join(exportDir, "fixture_dataset.jsonl");
  const manifestPath = path.join(exportDir, "manifest.json");
  const jsonl = active.map((entry) => entry.jsonl.trimEnd()).filter(Boolean).join("\n");
  const manifest = {
    schema_version: FIXTURE_DATASET_EXPORT_MANIFEST_SCHEMA_VERSION,
    artifact_kind: "fixture_dataset_export_batch_manifest",
    export_id: exportId,
    generated_at: generatedAt,
    producer_version: FIXTURE_DATASET_EXPORT_PRODUCER_VERSION,
    destination: normalizeDestination(destination),
    consent_grant_id: resolvedGrant.consent_grant_id,
    workspace_pseudonym: resolvedGrant.workspace_pseudonym,
    batch_content_hash: batchContentHash,
    artifact_kinds: ["fixture_dataset"],
    jsonl_path: path.relative(repoRoot, jsonlPath).replace(/\\/g, "/"),
    manifests: active.map((entry) => entry.manifest),
    skipped,
  };
  writeTextAtomic(jsonlPath, `${jsonl}\n`);
  writeJsonAtomic(manifestPath, manifest);
  const logEvent = {
    schema_version: "teami-fixture-dataset-export-log/v1",
    event: "fixture_dataset_export_written",
    export_id: exportId,
    generated_at: generatedAt,
    batch_content_hash: batchContentHash,
    manifest_path: path.relative(repoRoot, manifestPath).replace(/\\/g, "/"),
    jsonl_path: manifest.jsonl_path,
    row_count: active.reduce((total, entry) => total + entry.manifest.row_count, 0),
    destination_type: manifest.destination.destination_type,
  };
  appendJsonLine(fixtureExportLogPath(home), logEvent);
  onProgress(`fixture export: wrote ${manifest.jsonl_path}`);
  return {
    ok: true,
    status: "exported",
    export_id: exportId,
    batch_content_hash: batchContentHash,
    manifest_path: manifestPath,
    jsonl_path: jsonlPath,
    log_path: fixtureExportLogPath(home),
    row_count: logEvent.row_count,
    skipped,
  };
}

export async function readLatestRichExampleDataset({
  appUrl,
  datasetName,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  const datasets = await phoenixFetchJson({
    appUrl,
    pathname: "/v1/datasets",
    searchParams: { name: datasetName, limit: "1" },
    fetchImpl,
    timeoutMs,
  });
  const dataset = (datasets?.data || []).find((candidate) => candidate?.name === datasetName) || null;
  const datasetId = dataset?.id || dataset?.dataset_id || null;
  if (!datasetId) return { ok: false, reason: "rich_example_dataset_not_found", dataset_name: datasetName };
  const versions = await phoenixFetchJson({
    appUrl,
    pathname: `/v1/datasets/${encodeURIComponent(datasetId)}/versions`,
    searchParams: { limit: "1" },
    fetchImpl,
    timeoutMs,
  });
  const version = versions?.data?.[0] || null;
  const datasetVersionId = version?.version_id || version?.id || null;
  if (!datasetVersionId) {
    return { ok: false, reason: "rich_example_dataset_version_not_found", dataset_name: datasetName };
  }
  const examples = await phoenixFetchJson({
    appUrl,
    pathname: `/v1/datasets/${encodeURIComponent(datasetId)}/examples`,
    searchParams: { version_id: datasetVersionId },
    fetchImpl,
    timeoutMs,
  });
  return {
    ok: true,
    dataset: {
      name: datasetName,
      dataset_id: datasetId,
      dataset_version_id: datasetVersionId,
    },
    records: parseExamplesBody(examples),
  };
}

export function compileFixtureExportProfile({
  profile = DEFAULT_FIXTURE_EXPORT_PROFILE,
  rawOptInPaths = [],
} = {}) {
  const rawOptIns = normalizeRawOptInPaths(rawOptInPaths, profile);
  const tree = buildProfileTree(profile.fields || {});
  return {
    ok: true,
    tree,
    raw_opt_in_paths: rawOptIns,
    audit_policy: compilePolicyNode(tree, { mode: "audit", rawOptIns: new Set(rawOptIns) }),
    export_policy: compilePolicyNode(tree, { mode: "export", rawOptIns: new Set(rawOptIns) }),
  };
}

function normalizeFixtureDatasetRecord({
  record,
  definition,
  contract,
  dataset,
} = {}) {
  const input = cloneJson(record?.input ?? record?.inputs?.[0] ?? null);
  const metadataRaw = cloneJson(record?.metadata ?? record?.metadatas?.[0] ?? {});
  const reference = cloneJson(metadataRaw?.reference ?? record?.reference ?? {});
  const judgeInput = cloneJson(input?.judge_fixture_input ?? input ?? null);
  if (!isRecord(judgeInput)) {
    return { ok: false, reason: "fixture_judge_input_missing", record_id: record?.id || null };
  }
  if (input?.gradeability && input.gradeability !== "full_input") {
    return {
      ok: false,
      skip: true,
      reason: "fixture_not_full_input",
      source_example_id: record?.id || null,
    };
  }
  const provenance = isRecord(reference?.provenance) ? cloneJson(reference.provenance) : null;
  if (!provenance || !reference.expected_label) {
    return {
      ok: false,
      skip: true,
      reason: "fixture_label_not_frozen",
      source_example_id: record?.id || null,
    };
  }
  if (provenance.label_source !== "explicit_human" || provenance.label_status !== "GOLD") {
    return {
      ok: false,
      skip: true,
      reason: "fixture_label_not_gold",
      label_source: provenance.label_source || null,
      label_status: provenance.label_status || null,
      source_example_id: record?.id || null,
    };
  }
  const expectedLabel = String(reference.expected_label);
  if (!contract.quality_labels.includes(expectedLabel)) {
    return {
      ok: false,
      reason: "expected_label_outside_namespace",
      expected_label: expectedLabel,
      workflow_type: definition.workflow_type,
    };
  }
  const extraMetadata = fixtureMetadataExtras(metadataRaw);
  const row = {
    artifact_kind: "fixture_dataset",
    schema_version: FIXTURE_DATASET_ROW_SCHEMA_VERSION,
    input: judgeInput,
    expected_label: expectedLabel,
    ...(reference.expected_score !== undefined && reference.expected_score !== null
      ? { expected_score: Number(reference.expected_score) }
      : {}),
    provenance,
    metadata: {
      eval_namespace: definition.eval_namespace,
      workflow_type: definition.workflow_type,
      rubric_version: metadataRaw.rubric_version || contract.rubric_version,
      failure_taxonomy_version:
        metadataRaw.failure_taxonomy_version || contract.failure_taxonomy_version,
      workspace_maturity: metadataRaw.workspace_maturity || null,
      project_category: metadataRaw.project_category || null,
      project_impact_level: metadataRaw.project_impact_level || null,
      lifecycle_state: metadataRaw.lifecycle_state || null,
      process_version: metadataRaw.process_version || null,
      source_trace_id: metadataRaw.source_trace_id || null,
      source_run_id: metadataRaw.source_run_id || null,
      source_target_ids: Array.isArray(metadataRaw.source_target_ids)
        ? [...metadataRaw.source_target_ids]
        : [],
      produced_identity_refs: Array.isArray(metadataRaw.produced_identity_refs)
        ? cloneJson(metadataRaw.produced_identity_refs)
        : [],
      dataset_split: metadataRaw.dataset_split || null,
      content_retention: metadataRaw.content_retention || null,
      source_example_id: record?.id || null,
      source_dataset_id: dataset.dataset_id || record?.dataset_id || null,
      source_dataset_version_id: dataset.dataset_version_id || record?.dataset_version_id || null,
      ...extraMetadata,
    },
  };
  if (Object.hasOwn(row, "expected_score")) {
    if (!Number.isFinite(row.expected_score) || row.expected_score < 0 || row.expected_score > 1) {
      return { ok: false, reason: "expected_score_invalid", source_example_id: record?.id || null };
    }
  }
  const banned = contract.findBannedWorkflowStateMetadataKeys(row.metadata);
  if (banned.length > 0) {
    return {
      ok: false,
      reason: `workflow_state_keys_banned_in_fixture_metadata:${banned.join(",")}`,
      source_example_id: record?.id || null,
    };
  }
  return { ok: true, row, source_example_id: record?.id || null };
}

const FIXTURE_METADATA_KEYS = new Set([
  "schema_version",
  "reference",
  "eval_namespace",
  "workflow_type",
  "rubric_version",
  "failure_taxonomy_version",
  "workspace_maturity",
  "project_category",
  "project_impact_level",
  "lifecycle_state",
  "process_version",
  "source_trace_id",
  "source_run_id",
  "source_target_ids",
  "produced_identity_refs",
  "dataset_split",
  "content_retention",
]);

function fixtureMetadataExtras(metadataRaw = {}) {
  if (!isRecord(metadataRaw)) return {};
  const extras = {};
  for (const [key, value] of Object.entries(metadataRaw)) {
    if (FIXTURE_METADATA_KEYS.has(key)) continue;
    extras[key] = cloneJson(value);
  }
  return extras;
}

function gateFixtureDatasetRow({
  row,
  compiled,
  profile,
  workflowType,
} = {}) {
  const rawSecretPaths = findTokenShapedContent(row);
  if (rawSecretPaths.length > 0) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "token_or_secret_like",
      label: "fixture_dataset_export",
      workflow_type: workflowType,
      secret_paths: rawSecretPaths,
    };
  }
  const audit = sanitizeAndClassifyContent({
    value: row,
    policy: compiled.audit_policy,
    label: "fixture_dataset_export_audit",
  });
  if (!audit.ok) {
    return { ...audit, workflow_type: workflowType };
  }
  const transformed = transformByProfile(row, compiled.tree, {
    rawOptIns: new Set(compiled.raw_opt_in_paths),
  });
  const exported = sanitizeAndClassifyContent({
    value: transformed,
    policy: compiled.export_policy,
    label: "fixture_dataset_export",
  });
  if (!exported.ok) {
    return { ...exported, workflow_type: workflowType };
  }
  if (findTokenShapedContent(exported.value).length > 0) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "token_or_secret_like",
      label: "fixture_dataset_export",
      workflow_type: workflowType,
    };
  }
  return {
    ok: true,
    row: exported.value,
    audit_report: audit.report,
    export_report: exported.report,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
  };
}

function buildTransportEnvelope({
  submissionId,
  row,
  rowContentHash,
  grant,
  profile,
  destination,
  dataset,
  generatedAt,
  repoRoot,
} = {}) {
  const dedupeKey = `sha256:${rowContentHash}`;
  const deleteTokenHash = sha256CanonicalJson({
    submissionId,
    dedupeKey,
    destination,
    generatedAt,
  }).slice(0, 32);
  return {
    schema_version: "teami-transport-envelope/v1",
    artifact_kind: "fixture_dataset",
    submission_id: submissionId,
    workspace_pseudonym: grant?.workspace_pseudonym || workspacePseudonym(repoRoot),
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    consent_grant_id: grant?.consent_grant_id || null,
    dataset_version: dataset.dataset_version_id || null,
    producer_version: FIXTURE_DATASET_EXPORT_PRODUCER_VERSION,
    dedupe_key: dedupeKey,
    retention_class: "fixture_dataset_git_v1",
    delete_token: `${DELETE_TOKEN_PREFIX}:${deleteTokenHash}`,
    ack_status: "not_submitted_git_v1",
    hosted_v2: {
      retention_class: "fixture_dataset_hosted_v2_deferred",
      ack_status: "inert_git_v1_artifact",
      delete_token_actionable: false,
    },
    destination,
  };
}

function buildProfileTree(fields) {
  const root = { children: new Map(), spec: null, path: "" };
  for (const [fieldPath, spec] of Object.entries(fields || {})) {
    const segments = fieldPath.split(".").filter(Boolean);
    if (segments.length === 0) throw new Error("fixture_export_profile_field_path_required");
    let cursor = root;
    for (const segment of segments) {
      if (!cursor.children.has(segment)) {
        const childPath = cursor.path ? `${cursor.path}.${segment}` : segment;
        cursor.children.set(segment, { children: new Map(), spec: null, path: childPath });
      }
      cursor = cursor.children.get(segment);
    }
    cursor.spec = { ...spec, path: fieldPath };
  }
  return root;
}

function compilePolicyNode(node, { mode, rawOptIns }) {
  if (node.spec) return policyForSpec(node.spec, { mode, rawOptIns });
  const object = {};
  for (const [key, child] of node.children.entries()) {
    object[key] = compilePolicyNode(child, { mode, rawOptIns });
  }
  return { object };
}

function policyForSpec(spec, { mode, rawOptIns }) {
  const tier = spec.tier || "allow";
  if (mode === "audit") {
    if (tier === "default") {
      return { exclude: spec.reason || DEFAULT_EXCLUDED_REASON };
    }
    return spec.policy;
  }
  if (tier === "allow") return spec.policy;
  if (tier === "default") {
    return { exclude: spec.reason || DEFAULT_EXCLUDED_REASON };
  }
  if (tier === "digest") return digestPolicy;
  if (tier === "raw_opt_in") {
    if (rawOptIns.has(spec.path)) return spec.policy;
    if (spec.default_tier === "digest") return digestPolicy;
    return { exclude: spec.reason || RAW_OPT_IN_EXPORT_REASON };
  }
  throw new Error(`fixture_export_profile_tier_unsupported:${tier}`);
}

const REMOVE_FIELD = Symbol("remove-field");

function transformByProfile(value, node, { rawOptIns }) {
  if (node.spec) {
    return transformBySpec(value, node.spec, { rawOptIns });
  }
  if (!isRecord(value)) return cloneJson(value);
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    const child = node.children.get(key);
    if (!child) {
      result[key] = cloneJson(nested);
      continue;
    }
    const transformed = transformByProfile(nested, child, { rawOptIns });
    if (transformed !== REMOVE_FIELD) result[key] = transformed;
  }
  return result;
}

function transformBySpec(value, spec, { rawOptIns }) {
  const tier = spec.tier || "allow";
  if (tier === "allow") return cloneJson(value);
  if (tier === "default") return REMOVE_FIELD;
  if (tier === "digest") return digestValue(value);
  if (tier === "raw_opt_in") {
    if (rawOptIns.has(spec.path)) return cloneJson(value);
    if (spec.default_tier === "digest") return digestValue(value);
    return REMOVE_FIELD;
  }
  throw new Error(`fixture_export_profile_tier_unsupported:${tier}`);
}

function digestValue(value) {
  const canonical = canonicalJsonStringify(value);
  return {
    digest_kind: "sha256",
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
    byte_length: Buffer.byteLength(canonical, "utf8"),
    value_type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    item_count: Array.isArray(value) ? value.length : null,
    redaction: "digest_only",
  };
}

function normalizeRawOptInPaths(rawOptInPaths, profile) {
  const fields = profile.fields || {};
  const normalized = [...new Set((rawOptInPaths || []).map((entry) => String(entry || "").trim()).filter(Boolean))]
    .sort();
  for (const fieldPath of normalized) {
    const spec = fields[fieldPath];
    if (!spec) throw new Error(`fixture_export_raw_opt_in_path_unknown:${fieldPath}`);
    if (spec.tier !== "raw_opt_in") {
      throw new Error(`fixture_export_raw_opt_in_path_not_raw_tier:${fieldPath}`);
    }
  }
  return normalized;
}

function resolveDefinitionList(definitions) {
  if (!Array.isArray(definitions) || definitions.length === 0) return [decompositionDefinition];
  return definitions;
}

function resolveDefinitionsByWorkflowTypes(workflowTypes) {
  const types = Array.isArray(workflowTypes) && workflowTypes.length > 0
    ? workflowTypes
    : registeredWorkflowTypes();
  return types.map((workflowType) => getWorkflowDefinition(workflowType));
}

function resolveExportEvalContract(definition, repoRoot) {
  const contract = resolveEvalContract(definition, repoRoot);
  if (contract.eval_configured === true || definition?.workflow_type !== "decomposition") {
    return contract;
  }
  return resolveEvalContract(definition, MODULE_REPO_ROOT);
}

function parseExamplesBody(body) {
  if (Array.isArray(body?.data?.examples)) return body.data.examples;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function findExistingExportByBatchHash({ repoRoot, home = resolveTeamiHome(), outputDir, batchContentHash }) {
  const logPath = fixtureExportLogPath(home);
  if (!fs.existsSync(logPath)) return null;
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.batch_content_hash !== batchContentHash) continue;
      const manifestPath = path.resolve(repoRoot, entry.manifest_path || "");
      const jsonlPath = path.resolve(repoRoot, entry.jsonl_path || "");
      if (
        manifestPath.startsWith(path.resolve(outputDir)) &&
        jsonlPath.startsWith(path.resolve(outputDir)) &&
        fs.existsSync(manifestPath) &&
        fs.existsSync(jsonlPath)
      ) {
        return { manifest_path: manifestPath, jsonl_path: jsonlPath };
      }
    } catch {
      // A corrupt local log line should not block a fresh export.
    }
  }
  return null;
}

function mergeSanitizerReports(a = {}, b = {}) {
  const removed = [...(a.removed || []), ...(b.removed || [])];
  const transformed = [...(a.transformed || []), ...(b.transformed || [])];
  return {
    content_gate_version: b.content_gate_version || a.content_gate_version || null,
    removed,
    transformed,
    removed_count: removed.length,
    transformed_count: transformed.length,
  };
}

function normalizeDestination(destination = DEFAULT_DESTINATION) {
  return {
    destination_type: destination.destination_type || "git-v1",
    destination_id: destination.destination_id || "maintainer_fixture_contribution_remote",
    write_path: destination.write_path || "deferred_adopter_push_wiring",
  };
}

function workspacePseudonym(repoRoot) {
  return `workspace_${createHash("sha256").update(path.resolve(repoRoot), "utf8").digest("hex").slice(0, 16)}`;
}

function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex");
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactTimestamp(value) {
  return String(value).replace(/[^0-9A-Za-z]/g, "").slice(0, 17) || "unknown";
}

function normalizeNow(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value : new Date(value);
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, text, "utf8");
  renameWithRetry(tempPath, filePath);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}
