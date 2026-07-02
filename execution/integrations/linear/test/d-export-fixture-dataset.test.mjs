import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveEvalContract } from "../src/eval-annotation-contract.mjs";
import {
  buildFixtureDatasetExport,
  buildFixtureExportConsentPreview,
  createFixtureExportGrant,
  DEFAULT_FIXTURE_EXPORT_PROFILE,
  fixtureExportGrantPath,
  FIXTURE_DATASET_EXPORT_GRANT_SCHEMA_VERSION,
  readFixtureExportGrant,
  runFixtureDatasetExport,
  validateFixtureExportConsent,
  writeFixtureExportGrant,
} from "../src/fixture-dataset-exporter.mjs";
import { decompositionDefinition } from "../src/workflows/decomposition/definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const contract = resolveEvalContract(decompositionDefinition, repoRoot);

function tempRepoRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `teami-d-export-${label}-`));
}

function sampleRecord(overrides = {}) {
  return {
    id: "example-1",
    input: {
      gradeability: "full_input",
      judge_fixture_input: {
        project_intent: {
          id: "proj-1",
          name: "Onboarding email refresh",
          description: "Refresh the activation roadmap.",
          content: "## Goal\nReach the first useful action in one session.",
          status: "Planned",
          labels: [{ id: "label-1", name: "Growth" }],
          existing_issues: [{
            id: "issue-existing",
            identifier: "ENG-1",
            title: "Existing onboarding task",
            state: { id: "state-1", name: "Todo", type: "unstarted" },
            labels: [],
          }],
        },
        terminal_status: "completed",
        terminal_reason: "synthesis_complete",
        final_issues: [{
          decomposition_key: "onboarding/copy",
          title: "Draft onboarding copy",
          issue_body_markdown: "Implement the copy update in `src/onboarding.ts`.",
          acceptance_criteria: ["Copy is approved"],
          depends_on: [],
        }],
        discovery_issues: [],
        dependency_relations: [],
        project_update_markdown: "Decomposed the onboarding refresh into one executable issue.",
        open_questions_markdown: null,
        phase_packet_summaries: [{
          schema_version: "linear-decomposition-phase-packet/v1", // PHASE-SURVIVOR(decomposition judge-input legitimately carries phase_packet_summaries; only the phase router was retired, the packet wire-format is kept)
          run_id: "run-1",
          phase: "orchestrator_output",
          status: "commit",
          reason: "synthesis_complete",
          context_digest: "loaded project snapshot",
          assumptions: [],
          constraints: [],
          risks: [],
          project_update_markdown: "Decomposed the onboarding refresh.",
        }],
      },
      maintainer_supplied_context: {
        rubric_version: "1.0.0",
        failure_taxonomy_version: "1.0.0",
        allowed_failure_modes: [],
      },
    },
    output: {
      terminal_status: "completed",
      terminal_reason: "synthesis_complete",
    },
    metadata: {
      schema_version: "decomposition-eval-example/v1",
      reference: {
        human_annotations: [{
          name: "quality",
          label: "pass",
          score: 0.9,
          failure_modes: [],
          explanation: "Human fixture label; should not be exported raw.",
        }],
        human_annotation_ids: ["anno-human-1"],
        expected_label: "pass",
        expected_score: 0.9,
        provenance: {
          label_source: "explicit_human",
          label_status: "GOLD",
          labeled_at: "2026-06-10T00:05:00.000Z",
          annotator_id: "adopter-fixture-owner",
        },
      },
      rubric_version: "1.0.0",
      failure_taxonomy_version: "1.0.0",
      source_trace_id: "0af7651916cd43dd8448eb211c80319c",
      source_run_id: "run-1",
      source_target_ids: ["issue-1"],
      produced_identity_refs: [{
        effect_id: "linear_issues",
        provider: "linear",
        resource_kind: "linear_issue",
        target_ids: ["issue-1"],
      }],
      dataset_split: "train",
    },
    ...overrides,
  };
}

function grant(options = {}) {
  return createFixtureExportGrant({
    repoRoot,
    definitions: [decompositionDefinition],
    consentedBy: "fixture-owner",
    now: () => new Date("2026-06-29T12:00:00.000Z"),
    ...options,
  });
}

test("D-export digests or excludes rich roadmap/code by default and wraps rows in the git-v1 envelope", () => {
  const built = buildFixtureDatasetExport({
    records: [sampleRecord()],
    definition: decompositionDefinition,
    evalContract: contract,
    grant: grant(),
    dataset: { dataset_id: "DS1", dataset_version_id: "DSV2" },
    generatedAt: "2026-06-29T12:00:00.000Z",
  });

  assert.equal(built.ok, true);
  assert.equal(built.status, "built");
  assert.equal(built.jsonl_entries.length, 1);
  const wrapped = built.jsonl_entries[0];
  const row = wrapped.artifact;
  assert.equal(row.artifact_kind, "fixture_dataset");
  assert.equal(row.expected_label, "pass");
  assert.equal(row.expected_score, 0.9);
  assert.equal(row.provenance.label_source, "explicit_human");
  assert.equal(row.input.project_intent.content.digest_kind, "sha256");
  assert.equal(row.input.project_intent.description.digest_kind, "sha256");
  assert.equal(row.input.final_issues.digest_kind, "sha256");
  assert.equal(row.input.project_update_markdown.digest_kind, "sha256");
  assert.equal(row.input.project_intent.labels, undefined);
  assert.equal(row.input.project_intent.existing_issues, undefined);
  assert.equal(row.metadata.workflow_type, "decomposition");
  assert.equal(row.metadata.eval_namespace, "execution/evals/decomposition");
  assert.deepEqual(row.metadata.source_target_ids, ["issue-1"]);

  const serialized = JSON.stringify(wrapped);
  assert.doesNotMatch(serialized, /Implement the copy update/);
  assert.doesNotMatch(serialized, /human_annotations|human_annotation_ids|judge_settings|adopter_judge/);
  assert.equal(wrapped.destination.destination_type, "git-v1");
  assert.equal(wrapped.retention_class, "fixture_dataset_git_v1");
  assert.match(wrapped.delete_token, /^fixture-delete:/);
  assert.equal(wrapped.ack_status, "not_submitted_git_v1");
  assert.equal(wrapped.hosted_v2.ack_status, "inert_git_v1_artifact");
  assert.equal(built.manifest.aggregate_signal_report.emitted, false);
  assert.equal(built.manifest.aggregate_signal_report.uploadable_as_dataset, false);
});

test("D-export releases raw roadmap/code only under explicit raw opt-in", () => {
  const built = buildFixtureDatasetExport({
    records: [sampleRecord()],
    definition: decompositionDefinition,
    evalContract: contract,
    grant: grant({
      rawOptInPaths: [
        "input.project_intent.content",
        "input.final_issues",
      ],
    }),
    dataset: { dataset_id: "DS1", dataset_version_id: "DSV2" },
    generatedAt: "2026-06-29T12:00:00.000Z",
  });

  assert.equal(built.ok, true);
  const row = built.jsonl_entries[0].artifact;
  assert.equal(row.input.project_intent.content, "## Goal\nReach the first useful action in one session.");
  assert.equal(row.input.final_issues[0].issue_body_markdown, "Implement the copy update in `src/onboarding.ts`.");
  assert.equal(row.input.project_intent.description.digest_kind, "sha256");
  assert.equal(row.input.project_intent.labels, undefined);
});

test("D-export fails the whole payload when injected credentials are present, even under digested fields", () => {
  const record = sampleRecord();
  record.input.judge_fixture_input.project_intent.content =
    ["Bearer ", "abcdefghijklmnop"].join("");
  const built = buildFixtureDatasetExport({
    records: [record],
    definition: decompositionDefinition,
    evalContract: contract,
    grant: grant(),
    dataset: { dataset_id: "DS1", dataset_version_id: "DSV2" },
  });

  assert.equal(built.ok, false);
  assert.equal(built.state, "cannot_promote");
  assert.equal(built.reason, "token_or_secret_like");
  assert.ok(built.secret_paths.some((entry) => entry.includes("project_intent.content")));
});

test("D-export fails closed on unknown fixture fields", () => {
  const record = sampleRecord();
  record.input.judge_fixture_input.project_intent.new_raw_field = "newly captured field";
  const built = buildFixtureDatasetExport({
    records: [record],
    definition: decompositionDefinition,
    evalContract: contract,
    grant: grant(),
    dataset: { dataset_id: "DS1", dataset_version_id: "DSV2" },
  });

  assert.equal(built.ok, false);
  assert.equal(built.state, "needs_sanitization");
  assert.equal(built.reason, "unclassified_content");
  assert.ok(built.unclassified_paths.some((entry) =>
    entry.includes("$.input.project_intent.new_raw_field")));
});

test("D-export reads frozen D-capture label provenance without recomputing annotations or outcomes", () => {
  const built = buildFixtureDatasetExport({
    records: [sampleRecord()],
    definition: decompositionDefinition,
    evalContract: contract,
    grant: grant(),
    dataset: { dataset_id: "DS1", dataset_version_id: "DSV2" },
    annotationReader: () => {
      throw new Error("annotation reader must not be called during export");
    },
    outcomeReader: () => {
      throw new Error("outcome reader must not be called during export");
    },
  });

  assert.equal(built.ok, true);
  const row = built.jsonl_entries[0].artifact;
  assert.equal(row.expected_label, "pass");
  assert.equal(row.provenance.label_source, "explicit_human");
  assert.equal(row.provenance.label_status, "GOLD");
});

test("D-export consent re-prompts on new fields, raw tiers, functions, or destinations", () => {
  const baseGrant = grant();

  const newDestinationPreview = buildFixtureExportConsentPreview({
    repoRoot,
    definitions: [decompositionDefinition],
    destination: {
      destination_type: "git-v1",
      destination_id: "different_maintainer_remote",
      write_path: "deferred_adopter_push_wiring",
    },
  });
  assert.equal(validateFixtureExportConsent({ grant: baseGrant, preview: newDestinationPreview }).re_prompt_required, true);

  const expandedProfile = {
    ...DEFAULT_FIXTURE_EXPORT_PROFILE,
    fields: {
      ...DEFAULT_FIXTURE_EXPORT_PROFILE.fields,
      "metadata.new_safe_field": {
        tier: "allow",
        policy: { allow: "string" },
        default_tier: null,
        reason: null,
      },
    },
  };
  const newFieldPreview = buildFixtureExportConsentPreview({
    repoRoot,
    definitions: [decompositionDefinition],
    profile: expandedProfile,
  });
  assert.equal(validateFixtureExportConsent({ grant: baseGrant, preview: newFieldPreview }).re_prompt_required, true);

  const rawPreview = buildFixtureExportConsentPreview({
    repoRoot,
    definitions: [decompositionDefinition],
    rawOptInPaths: ["input.project_intent.content"],
  });
  assert.equal(validateFixtureExportConsent({ grant: baseGrant, preview: rawPreview }).re_prompt_required, true);

  const syntheticDefinition = {
    ...decompositionDefinition,
    workflow_type: "synthetic",
  };
  const functionPreview = buildFixtureExportConsentPreview({
    repoRoot,
    definitions: [decompositionDefinition, syntheticDefinition],
  });
  assert.equal(validateFixtureExportConsent({ grant: baseGrant, preview: functionPreview }).re_prompt_required, true);
});

test("D-export supervisor path reads latest rich-example dataset and writes JSONL plus manifest", async () => {
  const tempRoot = tempRepoRoot("run");
  const writtenGrant = writeFixtureExportGrant({
    repoRoot: tempRoot,
    definitions: [decompositionDefinition],
    consentedBy: "fixture-owner",
    now: () => new Date("2026-06-29T12:00:00.000Z"),
  });
  assert.equal(writtenGrant.grant.schema_version, FIXTURE_DATASET_EXPORT_GRANT_SCHEMA_VERSION);
  assert.equal(readFixtureExportGrant({ repoRoot: tempRoot }).ok, true);
  assert.equal(fixtureExportGrantPath(tempRoot), writtenGrant.grant_path);

  const calls = [];
  const routes = {
    "GET /v1/datasets": jsonResponse({
      data: [{ id: "DS1", name: contract.rich_example_dataset_name }],
    }),
    "GET /v1/datasets/DS1/versions": jsonResponse({
      data: [{ version_id: "DSV2" }],
      next_cursor: null,
    }),
    "GET /v1/datasets/DS1/examples": jsonResponse({
      data: { examples: [sampleRecord()] },
    }),
  };
  const result = await runFixtureDatasetExport({
    repoRoot: tempRoot,
    definitions: [decompositionDefinition],
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      projectName: "teami",
    }),
    fetchImpl: fetchRouter(routes, calls),
    now: () => new Date("2026-06-29T12:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "exported");
  assert.equal(result.row_count, 1);
  assert.equal(fs.existsSync(result.jsonl_path), true);
  assert.equal(fs.existsSync(result.manifest_path), true);
  const jsonl = fs.readFileSync(result.jsonl_path, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(jsonl.length, 1);
  assert.equal(jsonl[0].artifact.artifact_kind, "fixture_dataset");
  assert.equal(jsonl[0].dataset_version, "DSV2");
  const manifest = JSON.parse(fs.readFileSync(result.manifest_path, "utf8"));
  assert.equal(manifest.artifact_kinds.includes("fixture_dataset"), true);
  assert.equal(manifest.manifests[0].dataset.latest_version, true);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.pathname}`),
    [
      "GET /v1/datasets",
      "GET /v1/datasets/DS1/versions",
      "GET /v1/datasets/DS1/examples",
    ],
  );

  const second = await runFixtureDatasetExport({
    repoRoot: tempRoot,
    definitions: [decompositionDefinition],
    ensureReady: async () => ({
      ok: true,
      appUrl: "http://127.0.0.1:6006",
      projectName: "teami",
    }),
    fetchImpl: fetchRouter(routes, []),
    now: () => new Date("2026-06-29T12:01:00.000Z"),
  });
  assert.equal(second.status, "idempotent");
  assert.equal(second.idempotent, true);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function fetchRouter(routes, calls) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    calls.push({
      method,
      pathname: parsed.pathname,
      search: parsed.search,
      body: init.body ? JSON.parse(init.body) : null,
    });
    const route = routes[`${method} ${parsed.pathname}`];
    if (!route) throw new Error(`unexpected Phoenix request: ${method} ${parsed.pathname}`);
    if (typeof route === "function") return route({ parsed, init });
    return typeof route.clone === "function" ? route.clone() : route;
  };
}
