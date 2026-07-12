import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveEvalContract } from "../../../engine/eval-annotation-contract.mjs";
import { schemaErrors } from "../src/eval-structural-validator.mjs";
import { runDecompositionQualityJudge } from "../src/decomposition-quality-judge.mjs";
import { reviewDefinition } from "../src/workflows/review/definition.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const REVIEW_TRACE_ID = "22222222222222222222222222222222";
const REVIEW_RUN_ID = "review-run-1";
const HEAD_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const reviewExampleSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "execution", "evals", "review", "example.schema.json"), "utf8"),
);

test("review GOLD human-labeled fixture uses the verdict-shaped input contract without outcome telemetry", () => {
  const contract = resolveEvalContract(reviewDefinition, repoRoot);
  const fixture = reviewGoldFixture(contract);
  const errors = schemaErrors(reviewExampleSchema, fixture, reviewExampleSchema);

  assert.deepEqual(errors, []);
  assert.equal(fixture.reference.expected_label, "pass");
  assert.equal(fixture.reference.provenance.label_source, "explicit_human");
  assert.equal(fixture.reference.provenance.label_status, "GOLD");
  assert.equal(fixture.input.judge_fixture_input.review_correctness_signal.source, "human_gold_label");
  assert.deepEqual(
    reviewDefinition.outcome_observations.map((observation) => observation.id),
    ["review_af_review_status_outcome"],
  );
});

test("general Judge writes quality tagged review for a Reviewer verdict fixture hermetically", async () => {
  const contract = resolveEvalContract(reviewDefinition, repoRoot);
  const fixture = reviewGoldFixture(contract);
  const posts = [];
  const invocations = [];

  const result = await runDecompositionQualityJudge({
    repoRoot,
    evalRepoRoot: repoRoot,
    definition: reviewDefinition,
    evalContract: contract,
    runId: REVIEW_RUN_ID,
    traceId: REVIEW_TRACE_ID,
    judgeInputs: {
      ...fixture.input.judge_fixture_input,
      ...fixture.input.maintainer_supplied_context,
    },
    config: reviewJudgeConfig(),
    recordReceipt: false,
    workspaceMaturity: "new",
    ensureReady: async () => ({ ok: true, appUrl: "http://127.0.0.1:6006" }),
    runCommand: async (...args) => {
      invocations.push(args);
      return JSON.stringify({
        label: "pass",
        score: 0.94,
        explanation: "The Reviewer correctly requested changes for the missing validation evidence.",
        failure_modes: [],
      });
    },
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.pathname, "/v1/trace_annotations");
      assert.equal(parsed.searchParams.get("sync"), "true");
      posts.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ data: [{ id: "review-quality-annotation-1" }] });
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.judge_state, "judged");
  assert.equal(result.workflow_type, "review");
  assert.equal(result.eval_namespace, "execution/evals/review");
  assert.equal(result.storage, "phoenix_native");
  assert.deepEqual(result.annotation_ids, ["review-quality-annotation-1"]);
  assert.equal(invocations.length, 1);
  const prompt = runtimePromptFromCommand(invocations[0][0]);
  assert.match(prompt, /"reviewer_review"/);
  assert.match(prompt, /"verdict": "request-changes"/);

  assert.equal(posts.length, 1);
  const wire = posts[0].data[0];
  assert.equal(wire.name, "quality");
  assert.equal(wire.annotator_kind, "LLM");
  assert.equal(wire.identifier, "review_quality_judge_v1:review-judge-model");
  assert.equal(wire.trace_id, REVIEW_TRACE_ID);
  assert.equal(wire.result.label, "pass");
  assert.equal(wire.result.score, 0.9);
  assert.equal(wire.metadata.workflow_type, "review");
  assert.equal(wire.metadata.eval_namespace, "execution/evals/review");
  assert.equal(wire.metadata.rubric_version, contract.rubric_version);
  assert.equal(wire.metadata.failure_taxonomy_version, contract.failure_taxonomy_version);
  assert.equal(wire.metadata.source_run_id, REVIEW_RUN_ID);
  assert.deepEqual(wire.metadata.failure_modes, []);
});

function reviewGoldFixture(contract) {
  const body = "Request changes: the PR changes behavior but does not include focused validation evidence.";
  return {
    schema_version: "review-eval-example/v1",
    input: {
      gradeability: "full_input",
      judge_fixture_input: {
        reviewed_pr: {
          provider: "github",
          owner: "acme",
          repo: "product",
          pull_request_number: 7,
          head_sha: HEAD_SHA,
          base_ref: "main",
          title: "Validate billing retry handling",
          body: "Implements retry handling for billing webhooks.",
          issue_context: {
            identifier: "AF-7",
            title: "Require validation for retry handling",
          },
          diff: [
            "diff --git a/src/billing.js b/src/billing.js",
            "+export function retryWebhook(event) { return event.retryCount < 3; }",
          ].join("\n"),
          test_evidence: [{
            kind: "focused_tests",
            command: "node --test billing-retry.test.mjs",
            result: "not_run",
          }],
        },
        reviewer_review: {
          verdict: "request-changes",
          reasoning: body,
          body,
          reviewed_head_sha: HEAD_SHA,
          comments: [],
          source_refs: [{ kind: "github_pull_request", id: "acme/product#7" }],
          assumptions: [],
          constraints: [],
          risks: ["Missing focused validation can hide billing retry regressions."],
        },
        review_correctness_signal: {
          source: "human_gold_label",
          verdict_correct: true,
          summary: "Human label confirms request-changes was correct because the PR lacked required validation evidence.",
          known_limitations: [],
        },
      },
      maintainer_supplied_context: {
        rubric_version: contract.rubric_version,
        failure_taxonomy_version: contract.failure_taxonomy_version,
        allowed_failure_modes: [...contract.allowed_failure_modes],
      },
      source_type: "github_pull_request_review_snapshot",
      run_envelope: {
        workflow_version: "1.0.0",
        allowed_source_boundaries: ["captured_pr_diff", "captured_review_payload"],
        runtime_assignments: {
          reviewer: "codex:test-reviewer",
          orchestrator: "codex:test-orchestrator",
        },
      },
      source_refs: [`github:acme/product#7@${HEAD_SHA}`],
    },
    output: {
      disposition: "request-changes",
      body,
      reviewed_head_sha: HEAD_SHA,
      comments: [],
    },
    reference: {
      expected_label: "pass",
      expected_score: 0.9,
      provenance: {
        label_source: "explicit_human",
        label_status: "GOLD",
        labeled_at: "2026-06-28T00:00:00.000Z",
        annotator_id: "stand-in-adopter",
      },
    },
    metadata: {
      eval_namespace: "execution/evals/review",
      workflow_type: "review",
      workspace_maturity: "new",
      project_category: "code",
      project_impact_level: "medium",
      lifecycle_state: "active",
      dataset_split: "test",
      process_version: "review-outcome-proof-v1",
      rubric_version: contract.rubric_version,
      failure_taxonomy_version: contract.failure_taxonomy_version,
      source_trace_id: REVIEW_TRACE_ID,
      source_run_id: REVIEW_RUN_ID,
      source_target_ids: [`acme/product@${HEAD_SHA}:af-review`],
      content_retention: "sanitized_fixture",
    },
  };
}

function runtimePromptFromCommand(command) {
  if (typeof command.stdinInput === "string") return command.stdinInput;
  const index = command.args.indexOf("-p");
  if (index >= 0) {
    const promptArg = command.args[index + 1];
    if (typeof promptArg === "string" && promptArg.startsWith("@")) {
      return fs.readFileSync(promptArg.slice(1), "utf8");
    }
    return promptArg;
  }
  return command.args.at(-1);
}

function reviewJudgeConfig() {
  return {
    runtime: {
      adapters: {
        codex: { command: "codex", tool_policy: { linear_write: false } },
      },
    },
    workflows: {
      review: {
        roles: {
          review_quality_judge: { runtime: "codex", model: "review-judge-model" },
        },
        role_field_sources: {
          review_quality_judge: { runtime: "accepted_defaults", model: "accepted_defaults" },
        },
      },
    },
  };
}

test("review commit payload treats explicit null comments as absent (strict-schema null-union convention)", async () => {
  const { assembleCommitPayload, validateCommitPayload } = await import("../src/workflows/review/commit-payload.mjs");
  const payload = assembleCommitPayload({
    disposition: "approve",
    body: "looks good",
    reviewed_head_sha: "de6a10a87b0ccc7468f327e7d590dff0e1d40267",
    comments: null,
    human_briefing: null,
  });
  assert.equal(Object.hasOwn(payload, "comments"), false, "null comments must not ride the payload");
  const verdict = validateCommitPayload(payload);
  assert.deepEqual(verdict, { ok: true, failureReasons: [] });
});
