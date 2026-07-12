import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSuggestedDraftPrompt,
  materializePromotionCandidate,
  resolveMaterializerTarget,
  validateBehaviorDiff,
} from "../src/promotion-materializer.mjs";
import { resolveTrustedPromotionArtifacts } from "../src/promotion/trusted-artifacts.mjs";

const repoCheckout = path.resolve(import.meta.dirname, "../../../..");
const phoenixAssetsPath = "execution/evals/decomposition/phoenix-assets.json";
const acceptedPromptPath = "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md";
const acceptedRuntimeRolesPath = "execution/evals/decomposition/accepted-runtime-roles.json";
const reviewPhoenixAssetsPath = "execution/evals/review/phoenix-assets.json";
const reviewReviewerPromptPath = "execution/evals/review/accepted-prompts/reviewer.md";
const phoenixAssetsText = fs.readFileSync(path.join(repoCheckout, phoenixAssetsPath), "utf8");
const acceptedPromptText = fs.readFileSync(path.join(repoCheckout, acceptedPromptPath), "utf8");
const acceptedRuntimeRolesText = fs.readFileSync(path.join(repoCheckout, acceptedRuntimeRolesPath), "utf8");
const reviewPhoenixAssetsText = fs.readFileSync(path.join(repoCheckout, reviewPhoenixAssetsPath), "utf8");
const reviewReviewerPromptText = fs.readFileSync(path.join(repoCheckout, reviewReviewerPromptPath), "utf8");
const phoenixAssets = JSON.parse(phoenixAssetsText);
const reviewPhoenixAssets = JSON.parse(reviewPhoenixAssetsText);
const failureTaxonomy = JSON.parse(
  fs.readFileSync(
    path.join(repoCheckout, "execution", "evals", "decomposition", "failure-taxonomy.json"),
    "utf8",
  ),
);
const reviewFailureTaxonomy = JSON.parse(
  fs.readFileSync(
    path.join(repoCheckout, "execution", "evals", "review", "failure-taxonomy.json"),
    "utf8",
  ),
);

test("trusted promotion artifact reads fail closed on rule snapshot drift", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-trusted-artifacts-"));
  const manifestPath = path.join(root, phoenixAssetsPath);
  const taxonomyPath = path.join(root, "execution", "evals", "decomposition", "failure-taxonomy.json");
  const runtimeRolesPath = path.join(root, acceptedRuntimeRolesPath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.mkdirSync(path.dirname(runtimeRolesPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(phoenixAssets, null, 2)}\n`, "utf8");
  fs.writeFileSync(taxonomyPath, `${JSON.stringify(failureTaxonomy, null, 2)}\n`, "utf8");
  fs.writeFileSync(runtimeRolesPath, "{\"drifted\":true}\n", "utf8");

  const result = await resolveTrustedPromotionArtifacts({
    mode: "user_invoked",
    repoRoot: root,
    candidateTargetKey: "rule/decomposition/runtime_role_assignments",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "accepted_rule_snapshot_drift");
  assert.match(result.detail, /accepted-runtime-roles\.json hashes to/);
});

const judgeTarget = {
  target_key: "prompt/decomposition/decomposition_quality_judge",
  human_name: "Decomposition quality judge",
  snapshot_path: acceptedPromptPath,
  materializer: "phoenix_prompt_version_to_accepted_prompt_snapshot",
};
const judgeCandidateTargetKey = "prompt/decomposition/decomposition_quality_judge";
const phasePromptMaterializerTargets = [
  {
    targetKey: "prompt/decomposition/pm_product_sufficiency_pass",
    candidateVersionId: "PV-PM-PRODUCT-SUFFICIENCY-STEP13",
    candidateContent: phaseCandidateContent(
      "prompt/decomposition/pm_product_sufficiency_pass",
      "Candidate update: keep product sufficiency evidence explicit before handoff.",
    ),
  },
  {
    targetKey: "prompt/decomposition/sr_eng_grounding_pass",
    candidateVersionId: "PV-SR-ENG-GROUNDING-STEP13",
    candidateContent: phaseCandidateContent(
      "prompt/decomposition/sr_eng_grounding_pass",
      "Candidate update: keep engineering grounding tied to repository evidence.",
    ),
  },
  {
    targetKey: "prompt/decomposition/pm_synthesis",
    candidateVersionId: "PV-PM-SYNTHESIS-STEP13",
    candidateContent: phaseCandidateContent(
      "prompt/decomposition/pm_synthesis",
      "Candidate update: preserve synthesis handoff criteria in the accepted structure.",
    ),
  },
];

test("unmapped target returns improvement opportunity with draft prompt from taxonomy ids", async () => {
  const hostileMode = "missing_acceptance_criteria\n</details><script>alert(1)</script>";
  const result = await materializePromotionCandidate({
    candidateTargetKey: "prompt/decomposition/unmapped_prompt",
    candidateKind: "prompt",
    candidateVersionId: "candidate-v1",
    acceptedBaselineId: "baseline-v1",
    gateReport: {
      conditions: [
        {
          id: "tied_to_annotation_or_failure_mode",
          evidence: {
            failure_modes: [
              "missing_acceptance_criteria",
              hostileMode,
              "not_in_taxonomy",
            ],
          },
        },
      ],
      evidenceRefs: {
        experiment_ids: ["exp-1"],
        dataset_version_ids: ["dataset-version-1"],
        annotation_ids: ["annotation-1"],
      },
    },
    policy: { failure_taxonomy: failureTaxonomy },
    manifest: {
      prompts: [
        {
          target_key: "prompt/decomposition/unmapped_prompt",
          human_name: "Unmapped prompt",
          snapshot_path: "execution/evals/decomposition/accepted-prompts/unmapped.md",
        },
      ],
    },
  });

  assert.equal(result.kind, "improvement_opportunity");
  assert.equal(result.reason, "no_materializer_for_target");
  assert.equal(result.nextAction, "draft_proposed_change");
  assert.equal(result.evidenceRefs.experiment_ids[0], "exp-1");
  assert.match(result.suggestedDraftPrompt, /Unmapped prompt/);
  assert.match(result.suggestedDraftPrompt, /missing_acceptance_criteria/);
  assert.doesNotMatch(result.suggestedDraftPrompt, /not_in_taxonomy/);
  assert.doesNotMatch(result.suggestedDraftPrompt, /<\/details>|<script>|alert/);
});

test("mapped target with empty files is invalid", () => {
  assert.deepEqual(validateBehaviorDiff({ files: {}, target: judgeTarget }), {
    ok: false,
    reason: "empty_file_set",
  });
});

test("proposal paths are banned after normalization", () => {
  const validSnapshot = {
    [judgeTarget.snapshot_path]: "accepted prompt",
  };
  for (const bannedPath of [
    "execution/evals/decomposition/proposals/x.md",
    "execution\\evals\\decomposition\\proposals\\x.md",
    "tmp\\..\\execution\\evals\\decomposition\\proposals\\x.md",
    "EXECUTION/EVALS/DECOMPOSITION/PROPOSALS/x.md",
  ]) {
    const result = validateBehaviorDiff({
      files: {
        ...validSnapshot,
        [bannedPath]: "proposal",
      },
      target: judgeTarget,
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "proposals_path_banned",
    });
  }
});

test("file set without a mapped artifact path is invalid", () => {
  const result = validateBehaviorDiff({
    files: {
      "execution/evals/decomposition/README.md": "docs only",
    },
    target: judgeTarget,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "no_mapped_artifact_path",
  });
});

test("secret-shaped materialized file content is blocked", () => {
  const token = "s" + "k-" + "a".repeat(20);
  const result = validateBehaviorDiff({
    files: {
      [judgeTarget.snapshot_path]: `new prompt\n${token}\n`,
    },
    target: judgeTarget,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "cannot_promote_secret_content",
  });
});

test("suggested draft prompt drops hostile unknown failure-mode ids", () => {
  const prompt = buildSuggestedDraftPrompt({
    target: { human_name: "Safe target" },
    failureModeIds: [
      "missing_acceptance_criteria",
      "\"><script>@steve [approve](http://evil.invalid)",
      "unknown_mode",
      "missing_assumptions",
    ],
    taxonomy: failureTaxonomy,
  });

  assert.match(prompt, /Safe target/);
  assert.match(prompt, /missing_acceptance_criteria/);
  assert.match(prompt, /missing_assumptions/);
  assert.doesNotMatch(prompt, /script|@steve|http:\/\/evil|unknown_mode/);
  assert.doesNotMatch(prompt, /[<>\[\]"\n]/);
});

test("judge target resolves from manifest metadata", () => {
  const result = resolveMaterializerTarget({
    manifest: phoenixAssets,
    candidateTargetKey: "prompt/decomposition/decomposition_quality_judge",
  });
  assert.equal(result.ok, true);
  assert.equal(result.target.human_name, "Decomposition quality judge");
  assert.equal(
    result.target.materializer,
    "phoenix_prompt_version_to_accepted_prompt_snapshot",
  );
  assert.ok(result.target.mapped_artifact_paths.includes(
    "execution/evals/decomposition/phoenix-assets.json",
  ));
});

test("runtime role rule target resolves from manifest metadata", () => {
  const result = resolveMaterializerTarget({
    manifest: phoenixAssets,
    candidateTargetKey: "rule/decomposition/runtime_role_assignments",
  });
  assert.equal(result.ok, true);
  assert.equal(result.target.human_name, "Runtime role assignments");
  assert.equal(result.target.artifact_kind, "runtime_role_defaults");
  assert.equal(result.target.materializer, "eval_variant_to_runtime_role_defaults");
  assert.ok(result.target.mapped_artifact_paths.includes(acceptedRuntimeRolesPath));
});

test("review reviewer prompt materializer updates the review snapshot and review manifest pin", async () => {
  const candidateTargetKey = "prompt/review/reviewer";
  const target = resolveMaterializerTarget({
    manifest: reviewPhoenixAssets,
    candidateTargetKey,
  });
  assert.equal(target.ok, true);
  assert.equal(target.target.snapshot_path, reviewReviewerPromptPath);
  assert.equal(target.target.manifest_path, reviewPhoenixAssetsPath);
  assert.ok(target.target.mapped_artifact_paths.includes(reviewPhoenixAssetsPath));

  const candidateVersionId = "PV-REVIEW-REVIEWER-1";
  const candidateContent = [
    reviewReviewerPromptText.replace(/\n+$/g, ""),
    "",
    "## Candidate Calibration",
    "",
    "Name concrete blocking evidence before requesting changes.",
  ].join("\n");
  const result = await materializePromotionCandidate({
    candidateTargetKey,
    candidateKind: "prompt",
    candidateVersionId,
    acceptedBaselineId: target.target.accepted_prompt_version_id || `sha256:${target.target.snapshot_sha256}`,
    resolvedCandidate: promptVersionResponse({
      id: candidateVersionId,
      content: candidateContent,
    }),
    resolvedBaseline: {
      files: {
        [reviewReviewerPromptPath]: reviewReviewerPromptText,
        [reviewPhoenixAssetsPath]: reviewPhoenixAssetsText,
      },
    },
    currentAcceptedSnapshotContent: reviewReviewerPromptText,
    manifestContent: reviewPhoenixAssetsText,
    gateReport: {
      failure_modes: ["review_missed_regression"],
    },
    policy: { failure_taxonomy: reviewFailureTaxonomy },
    manifest: reviewPhoenixAssets,
  });

  assert.equal(result.kind, "behavior_diff", JSON.stringify(result));
  assert.deepEqual(
    Object.keys(result.files).sort(),
    [reviewReviewerPromptPath, reviewPhoenixAssetsPath].sort(),
  );

  const snapshotBytes = result.files[reviewReviewerPromptPath];
  const snapshotSha256 = sha256Hex(snapshotBytes);
  assert.equal(snapshotBytes, `${candidateContent}\n`);

  const manifestBytes = result.files[reviewPhoenixAssetsPath];
  const manifest = JSON.parse(manifestBytes);
  const promptEntry = manifest.prompts.find((entry) => entry.target_key === candidateTargetKey);
  assert.equal(promptEntry.accepted_prompt_version_id, candidateVersionId);
  assert.equal(promptEntry.snapshot_sha256, snapshotSha256);
  assert.equal(promptEntry.prompt_version, candidateVersionId);
  assert.equal(promptEntry.manifest_path, reviewPhoenixAssetsPath);
  assertOnlyPromptEntryPinsChanged({
    before: reviewPhoenixAssets,
    after: manifest,
    targetKey: candidateTargetKey,
  });

  assert.deepEqual(result.changedArtifacts.map((entry) => entry.path), [
    reviewReviewerPromptPath,
    reviewPhoenixAssetsPath,
  ]);
  assert.equal(result.changedArtifacts[0].kind, "accepted_prompt");
  assert.equal(result.changedArtifacts[1].kind, "manifest_pin");
  assert.deepEqual(validateBehaviorDiff({ files: result.files, target: target.target }), { ok: true });
});

test("prompt candidate routing targets are derived from materializer manifest metadata", () => {
  const candidateTaggedPrompts = phoenixAssets.prompts.filter((entry) => entry.candidate_tag);
  const manifestCandidateKeys = candidateTaggedPrompts.map((entry) => entry.target_key).sort();

  // The judge carries no candidate_tag (maintainer-owned evaluator, excluded
  // from adopter self-improvement); every adopter-owned prompt routes — the four
  // phase personas plus the orchestrator governing prompt (an adopter-tunable
  // persona, the same primitive as pm/sr_eng, seeded by I-2a). Sorted, the
  // governing key leads (orchestrator_* < pm_* < sr_*).
  assert.deepEqual(manifestCandidateKeys, [
    "prompt/decomposition/orchestrator_governing",
    "prompt/decomposition/pm_product_sufficiency_pass",
    "prompt/decomposition/pm_synthesis",
    "prompt/decomposition/sr_eng_blocker_check",
    "prompt/decomposition/sr_eng_grounding_pass",
  ]);

  for (const manifestEntry of candidateTaggedPrompts) {
    assert.equal(
      manifestEntry.materializer,
      "phoenix_prompt_version_to_accepted_prompt_snapshot",
      manifestEntry.target_key,
    );
    assert.equal(manifestEntry.artifact_kind, "accepted_prompt", manifestEntry.target_key);
    assert.equal(typeof manifestEntry.snapshot_path, "string", manifestEntry.target_key);
  }
});

test("judge prompt-version materializer round-trips Phoenix CHAT system content into snapshot and manifest pin", async () => {
  const candidateVersionId = "UHJvbXB0VmVyc2lvbjoxMjM=";
  const candidateContent = [
    "# Candidate Judge",
    "",
    "## Required inputs",
    "",
    "Use the supplied decomposition packet.",
  ].join("\n");

  const result = await materializeJudgeCandidate({
    candidateVersionId,
    resolvedCandidate: promptVersionResponse({ id: candidateVersionId, content: candidateContent }),
  });

  assert.equal(result.kind, "behavior_diff");
  const snapshotBytes = result.files[acceptedPromptPath];
  const snapshotSha256 = sha256Hex(snapshotBytes);
  assert.equal(snapshotBytes, `${candidateContent}\n`);

  const manifestBytes = result.files[phoenixAssetsPath];
  const manifest = JSON.parse(manifestBytes);
  const promptEntry = manifest.prompts.find((entry) => entry.target_key === judgeCandidateTargetKey);
  assert.equal(promptEntry.accepted_prompt_version_id, candidateVersionId);
  assert.equal(promptEntry.snapshot_sha256, snapshotSha256);
  assert.equal(promptEntry.prompt_version, candidateVersionId);
  assert.equal(result.changedArtifacts[0].path, acceptedPromptPath);
  assert.equal(result.changedArtifacts[0].kind, "accepted_prompt");
  assert.equal(result.changedArtifacts[0].new_sha256, snapshotSha256);
  assert.equal(result.changedArtifacts[1].path, phoenixAssetsPath);
  assert.equal(result.changedArtifacts[1].kind, "manifest_pin");

  const repeated = await materializeJudgeCandidate({
    candidateVersionId,
    resolvedCandidate: promptVersionResponse({ id: candidateVersionId, content: candidateContent }),
    manifestContent: manifestBytes,
  });
  assert.equal(repeated.kind, "behavior_diff");
  assert.equal(repeated.files[phoenixAssetsPath], manifestBytes);
});

test("phase prompt materializer terminal-blocks uncomposable candidate content", async () => {
  const targetCase = phasePromptMaterializerTargets[0];
  const uncomposable = [
    "# Candidate PM Product Sufficiency",
    "",
    "## Decision frame",
    "",
    "This omits the accepted prompt snapshot yaml header and required sections.",
  ].join("\n");
  const result = await materializePromptTargetCandidate({
    targetKey: targetCase.targetKey,
    candidateVersionId: "PV-PHASE-UNCOMPOSABLE",
    resolvedCandidate: promptVersionResponse({
      id: "PV-PHASE-UNCOMPOSABLE",
      content: uncomposable,
    }),
  });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "candidate_prompt_not_composable");
  assert.equal(result.blockClass, "terminal");
  assert.match(result.detail, /yaml header fence|parse failed|missing required section/);
});

test("judge prompt materializer still materializes unsectioned candidate content", async () => {
  const unsectioned = [
    "# Candidate Judge",
    "",
    "## Decision frame",
    "",
    "Judge candidates are materialized as raw accepted prompt snapshots.",
  ].join("\n");
  const result = await materializeJudgeCandidate({
    candidateVersionId: "PV-JUDGE-UNSECTIONED",
    resolvedCandidate: promptVersionResponse({
      id: "PV-JUDGE-UNSECTIONED",
      content: unsectioned,
    }),
  });

  assert.equal(result.kind, "behavior_diff");
  assert.equal(result.files[acceptedPromptPath], `${unsectioned}\n`);
});

for (const targetCase of phasePromptMaterializerTargets) {
  test(`${targetCase.targetKey} prompt-version materializer updates only its snapshot and manifest pin`, async () => {
    const target = manifestPromptEntry(targetCase.targetKey);
    const currentSnapshotContent = snapshotTextForManifestEntry(target);
    const result = await materializePromptTargetCandidate({
      targetKey: targetCase.targetKey,
      candidateVersionId: targetCase.candidateVersionId,
      resolvedCandidate: promptVersionResponse({
        id: targetCase.candidateVersionId,
        content: targetCase.candidateContent,
      }),
      currentAcceptedSnapshotContent: currentSnapshotContent,
    });

    assert.equal(result.kind, "behavior_diff", JSON.stringify(result));
    assert.deepEqual(
      Object.keys(result.files).sort(),
      [target.snapshot_path, phoenixAssetsPath].sort(),
    );

    const snapshotBytes = result.files[target.snapshot_path];
    const snapshotSha256 = sha256Hex(snapshotBytes);
    assert.equal(snapshotBytes, `${targetCase.candidateContent}\n`);

    const manifestBytes = result.files[phoenixAssetsPath];
    const manifest = JSON.parse(manifestBytes);
    const promptEntry = manifest.prompts.find((entry) => entry.target_key === targetCase.targetKey);
    assert.equal(promptEntry.accepted_prompt_version_id, targetCase.candidateVersionId);
    assert.equal(promptEntry.snapshot_sha256, snapshotSha256);
    assert.equal(promptEntry.prompt_version, targetCase.candidateVersionId);
    assertOnlyPromptEntryPinsChanged({
      before: phoenixAssets,
      after: manifest,
      targetKey: targetCase.targetKey,
    });

    assert.deepEqual(result.changedArtifacts.map((entry) => entry.path), [
      target.snapshot_path,
      phoenixAssetsPath,
    ]);
    assert.equal(result.changedArtifacts[0].kind, "accepted_prompt");
    assert.equal(result.changedArtifacts[0].old_sha256, sha256Hex(currentSnapshotContent));
    assert.equal(result.changedArtifacts[0].new_sha256, snapshotSha256);
    assert.equal(result.changedArtifacts[1].kind, "manifest_pin");
    assert.equal(result.changedArtifacts[1].old_sha256, sha256Hex(phoenixAssetsText));
    assert.equal(result.changedArtifacts[1].new_sha256, sha256Hex(manifestBytes));
    for (const artifact of result.changedArtifacts) {
      assert.match(artifact.old_sha256, /^[0-9a-f]{64}$/);
      assert.match(artifact.new_sha256, /^[0-9a-f]{64}$/);
      assert.notEqual(artifact.old_sha256, artifact.new_sha256);
    }
  });
}

test("judge prompt-version materializer blocks missing, wrong-template, and empty content as evidence repair", async () => {
  const cases = [
    {
      name: "missing system message",
      resolvedCandidate: promptVersionResponse({
        content: "content",
        messages: [{ role: "user", content: "content" }],
      }),
    },
    {
      name: "wrong template format",
      resolvedCandidate: promptVersionResponse({ content: "content", templateFormat: "F_STRING" }),
    },
    {
      name: "empty system content",
      resolvedCandidate: promptVersionResponse({ content: "" }),
    },
    {
      name: "ambiguous raw and envelope shapes",
      resolvedCandidate: {
        id: "PV-top",
        template_type: "CHAT",
        template_format: "NONE",
        template: { type: "chat", messages: [{ role: "system", content: "top" }] },
        data: promptVersionObject({ id: "PV-data", content: "data" }),
      },
    },
  ];

  for (const entry of cases) {
    const result = await materializeJudgeCandidate({
      candidateVersionId: "PV1",
      resolvedCandidate: entry.resolvedCandidate,
    });
    assert.equal(result.kind, "blocked", entry.name);
    assert.equal(result.reason, "candidate_prompt_content_unavailable", entry.name);
    assert.equal(result.blockClass, "evidence_repair", entry.name);
  }
});

test("judge prompt-version materializer blocks byte-identical snapshot output as terminal no diff", async () => {
  const result = await materializeJudgeCandidate({
    candidateVersionId: "PV1",
    resolvedCandidate: promptVersionResponse({ id: "PV1", content: acceptedPromptText }),
  });

  assert.deepEqual(result, {
    kind: "blocked",
    reason: "materializer_produced_no_diff",
    blockClass: "terminal",
  });
});

test("judge prompt-version materializer blocks token-shaped candidate content through behavior diff validator", async () => {
  const token = "s" + "k-" + "a".repeat(20);
  const result = await materializeJudgeCandidate({
    candidateVersionId: "PV1",
    resolvedCandidate: promptVersionResponse({
      id: "PV1",
      content: `# Candidate Judge\n\n${token}`,
    }),
  });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "cannot_promote_secret_content");
  assert.equal(result.blockClass, "evidence_repair");
});

test("judge prompt-version materializer treats sentinels and fences as snapshot data while sanitizing summary headings", async () => {
  const longHeading = `## Section with \`code\` <tag> ${"x".repeat(120)}`;
  const candidateContent = [
    "# Candidate `Judge` <marker>",
    "",
    "<<<PROMOTION_MARKER>>>",
    "",
    longHeading,
    "",
    "```json",
    "{\"label\":\"pass\"}",
    "```",
  ].join("\n");

  const result = await materializeJudgeCandidate({
    candidateVersionId: "PV1",
    resolvedCandidate: promptVersionResponse({ id: "PV1", content: candidateContent }),
  });

  assert.equal(result.kind, "behavior_diff");
  assert.match(result.files[acceptedPromptPath], /<<<PROMOTION_MARKER>>>/);
  assert.match(result.files[acceptedPromptPath], /```json/);
  const summaryText = JSON.stringify(result.humanSummary);
  assert.doesNotMatch(summaryText, /```|<<<|>>>|`|<|>/);
  assert.equal(result.humanSummary.header_block_present.old, true);
  assert.equal(result.humanSummary.header_block_present.new, false);
  for (const heading of result.humanSummary.added_markdown_section_headings) {
    assert.ok(heading.length <= 80, heading);
  }
});

test("judge prompt-version materializer preserves manifest formatting except the three pin fields", async () => {
  const candidateVersionId = "UHJvbXB0VmVyc2lvbjo0NTY=";
  const result = await materializeJudgeCandidate({
    candidateVersionId,
    resolvedCandidate: promptVersionResponse({
      id: candidateVersionId,
      content: "# Candidate Judge\n\n## Prompt\n\nNew prompt body.",
    }),
  });

  assert.equal(result.kind, "behavior_diff");
  const manifestBytes = result.files[phoenixAssetsPath];
  const before = JSON.parse(phoenixAssetsText);
  const after = JSON.parse(manifestBytes);
  const beforeComparable = scrubPromptPinFields(before);
  const afterComparable = scrubPromptPinFields(after);
  assert.deepEqual(afterComparable, beforeComparable);
  assert.equal(manifestBytes.endsWith("\n"), phoenixAssetsText.endsWith("\n"));
  assert.doesNotMatch(manifestBytes, /\r/);

  const beforeLines = phoenixAssetsText.split("\n");
  const afterLines = manifestBytes.split("\n");
  assert.equal(afterLines.length, beforeLines.length);
  const changedLines = [];
  for (let index = 0; index < beforeLines.length; index += 1) {
    if (beforeLines[index] !== afterLines[index]) changedLines.push(afterLines[index]);
  }
  assert.deepEqual(
    changedLines.map((line) => line.trim().split(":")[0].replaceAll("\"", "")),
    ["accepted_prompt_version_id", "snapshot_sha256", "prompt_version"],
  );
  for (const line of changedLines) {
    assert.match(line, /^      "/);
  }
});

test("runtime role materializer updates accepted defaults from receipt overrides only", async () => {
  const result = await materializeRuntimeRoleCandidate({
    role_overrides: {
      pm: { model: "gpt-5.5" },
      sr_eng: { runtime: "claude" },
    },
  });
  assert.equal(result.kind, "behavior_diff");
  // Two-file atomic write: the accepted artifact AND the manifest pin (P-PIN).
  assert.deepEqual(
    Object.keys(result.files).sort(),
    [acceptedRuntimeRolesPath, phoenixAssetsPath].sort(),
  );

  const before = JSON.parse(acceptedRuntimeRolesText);
  const after = JSON.parse(result.files[acceptedRuntimeRolesPath]);
  assert.equal(after.roles.pm.runtime, before.roles.pm.runtime);
  assert.equal(after.roles.pm.model, "gpt-5.5");
  assert.equal(after.roles.sr_eng.runtime, "claude");
  assert.equal(after.roles.sr_eng.model, before.roles.sr_eng.model);
  assert.equal(after.roles.judge.runtime, before.roles.judge.runtime);
  assert.equal(after.roles.judge.model, before.roles.judge.model);
  assert.equal(result.files[acceptedRuntimeRolesPath], `${JSON.stringify(after, null, 2)}\n`);

  // The manifest rule pin is updated atomically to sha256(new accepted bytes), and
  // ONLY the pin changes (byte-preserving) — the rest of the manifest is untouched.
  const newArtifactBytes = result.files[acceptedRuntimeRolesPath];
  const expectedPin = createHash("sha256").update(newArtifactBytes, "utf8").digest("hex");
  const manifestBytes = result.files[phoenixAssetsPath];
  const afterManifest = JSON.parse(manifestBytes);
  const ruleEntry = afterManifest.rules.find(
    (entry) => entry.target_key === "rule/decomposition/runtime_role_assignments",
  );
  assert.equal(ruleEntry.snapshot_sha256, expectedPin);
  const beforeManifest = JSON.parse(phoenixAssetsText);
  beforeManifest.rules.find(
    (entry) => entry.target_key === "rule/decomposition/runtime_role_assignments",
  ).snapshot_sha256 = expectedPin;
  assert.deepEqual(afterManifest, beforeManifest);
  assert.equal(manifestBytes.endsWith("\n"), phoenixAssetsText.endsWith("\n"));
  assert.doesNotMatch(manifestBytes, /\r/);

  assert.deepEqual(result.humanSummary, {
    kind: "runtime_role_defaults",
    changes: [
      { role: "pm", field: "model", old: "claude-opus-4-8", new: "gpt-5.5" },
      { role: "sr_eng", field: "runtime", old: "codex", new: "claude" },
    ],
    disclosure: "Adopters without explicit role overrides change behavior when this merges.",
  });

  const target = resolveMaterializerTarget({
    manifest: phoenixAssets,
    candidateTargetKey: "rule/decomposition/runtime_role_assignments",
  }).target;
  assert.deepEqual(validateBehaviorDiff({ files: result.files, target }), { ok: true });
});

test("runtime role materializer treats the orchestrator row as the driver persona runtime facet", async () => {
  const result = await materializeRuntimeRoleCandidate({
    role_overrides: {
      orchestrator: { model: "gpt-5.5" },
    },
  });
  assert.equal(result.kind, "behavior_diff");

  const before = JSON.parse(acceptedRuntimeRolesText);
  const after = JSON.parse(result.files[acceptedRuntimeRolesPath]);
  assert.equal(after.roles.orchestrator.runtime, before.roles.orchestrator.runtime);
  assert.equal(after.roles.orchestrator.model, "gpt-5.5");
  assert.deepEqual(result.humanSummary.changes, [
    {
      role: "orchestrator",
      field: "model",
      old: before.roles.orchestrator.model,
      new: "gpt-5.5",
    },
  ]);
});

test("runtime role materializer terminal-blocks a judge runtime/model override (maintainer-owned evaluator)", async () => {
  // The judge is excluded by the single adopter self-improvement authority, so a
  // judge runtime override is a terminal factory-behavior block, NOT an
  // evidence_repair retry — even when paired with a legitimate adopter role edit.
  const result = await materializeRuntimeRoleCandidate({
    role_overrides: {
      pm: { model: "gpt-5.5" },
      judge: { runtime: "codex" },
    },
  });
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "runtime_default_judge_excluded");
  assert.equal(result.blockClass, "terminal");
  assert.equal(result.scope, "factory_behavior");
});

test("runtime role materializer blocks missing overrides as evidence repair", async () => {
  const result = await materializeRuntimeRoleCandidate({ role_overrides: {} });
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "candidate_role_overrides_unavailable",
    blockClass: "evidence_repair",
  });
});

test("validateBehaviorDiff blocks a runtime-defaults change missing or mismatching its manifest pin (P-PIN)", () => {
  const target = resolveMaterializerTarget({
    manifest: phoenixAssets,
    candidateTargetKey: "rule/decomposition/runtime_role_assignments",
  }).target;
  const newArtifactBytes = `${JSON.stringify({ ...JSON.parse(acceptedRuntimeRolesText), _t: 1 }, null, 2)}\n`;
  // Artifact changed but the manifest pin file is absent from the diff entirely.
  assert.deepEqual(
    validateBehaviorDiff({ files: { [acceptedRuntimeRolesPath]: newArtifactBytes }, target }),
    { ok: false, reason: "runtime_defaults_manifest_pin_missing" },
  );
  // Manifest present but its rule pin is the committed (OLD) hash — does not match
  // sha256(new artifact bytes).
  assert.deepEqual(
    validateBehaviorDiff({
      files: {
        [acceptedRuntimeRolesPath]: newArtifactBytes,
        [phoenixAssetsPath]: phoenixAssetsText,
      },
      target,
    }),
    { ok: false, reason: "runtime_defaults_manifest_pin_mismatch" },
  );
});

test("validateBehaviorDiff and the materializer fail-close on duplicate manifest rule entries (P-PIN-001)", async () => {
  const target = resolveMaterializerTarget({
    manifest: phoenixAssets,
    candidateTargetKey: "rule/decomposition/runtime_role_assignments",
  }).target;
  const newArtifactBytes = `${JSON.stringify({ ...JSON.parse(acceptedRuntimeRolesText), _t: 1 }, null, 2)}\n`;
  const correctPin = createHash("sha256").update(newArtifactBytes, "utf8").digest("hex");
  // A manifest with TWO rules carrying the same target_key — even with a correct pin on
  // the first, the ambiguity fails closed (a duplicate could leave a second stale pin).
  const dupManifest = JSON.parse(phoenixAssetsText);
  const dupRule = dupManifest.rules.find(
    (entry) => entry.target_key === "rule/decomposition/runtime_role_assignments",
  );
  dupRule.snapshot_sha256 = correctPin;
  dupManifest.rules.push({ ...dupRule });
  const dupManifestBytes = `${JSON.stringify(dupManifest, null, 2)}\n`;

  assert.deepEqual(
    validateBehaviorDiff({
      files: { [acceptedRuntimeRolesPath]: newArtifactBytes, [phoenixAssetsPath]: dupManifestBytes },
      target,
    }),
    { ok: false, reason: "runtime_defaults_manifest_pin_missing" },
  );

  // The materializer itself refuses to produce a diff against an ambiguous manifest.
  const result = await materializeRuntimeRoleCandidate({
    role_overrides: { pm: { model: "gpt-5.5" } },
    manifestContent: dupManifestBytes,
  });
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "manifest_rule_target_not_unique");
});

test("runtime role materializer still blocks secret-shaped defaults output", async () => {
  const token = "s" + "k-" + "a".repeat(20);
  const result = await materializeRuntimeRoleCandidate({
    role_overrides: {
      pm: { model: token },
    },
  });
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "cannot_promote_secret_content");
  assert.equal(result.blockClass, "evidence_repair");
});

function phaseCandidateContent(targetKey, extraLine) {
  const currentSnapshot = snapshotTextForManifestEntry(manifestPromptEntry(targetKey)).replace(/\n+$/g, "");
  return `${currentSnapshot}\n\n${extraLine}`;
}

function materializeJudgeCandidate({
  candidateVersionId,
  resolvedCandidate,
  currentAcceptedSnapshotContent = acceptedPromptText,
  manifestContent = phoenixAssetsText,
} = {}) {
  return materializePromotionCandidate({
    candidateTargetKey: judgeCandidateTargetKey,
    candidateKind: "prompt",
    candidateVersionId,
    acceptedBaselineId: phoenixAssets.prompts[0].accepted_prompt_version_id
      || `sha256:${phoenixAssets.prompts[0].snapshot_sha256}`,
    resolvedCandidate,
    resolvedBaseline: {
      files: {
        [acceptedPromptPath]: currentAcceptedSnapshotContent,
        [phoenixAssetsPath]: manifestContent,
      },
    },
    currentAcceptedSnapshotContent,
    manifestContent,
    gateReport: {
      failure_modes: ["missing_acceptance_criteria"],
    },
    policy: { failure_taxonomy: failureTaxonomy },
    manifest: phoenixAssets,
  });
}

function materializePromptTargetCandidate({
  targetKey,
  candidateVersionId,
  resolvedCandidate,
  currentAcceptedSnapshotContent,
  manifestContent = phoenixAssetsText,
} = {}) {
  const target = manifestPromptEntry(targetKey);
  const snapshotContent = currentAcceptedSnapshotContent ?? snapshotTextForManifestEntry(target);
  return materializePromotionCandidate({
    candidateTargetKey: targetKey,
    candidateKind: "prompt",
    candidateVersionId,
    acceptedBaselineId: target.accepted_prompt_version_id || `sha256:${target.snapshot_sha256}`,
    resolvedCandidate,
    resolvedBaseline: {
      files: {
        [target.snapshot_path]: snapshotContent,
        [phoenixAssetsPath]: manifestContent,
      },
    },
    currentAcceptedSnapshotContent: snapshotContent,
    manifestContent,
    gateReport: {
      failure_modes: ["missing_acceptance_criteria"],
    },
    policy: { failure_taxonomy: failureTaxonomy },
    manifest: phoenixAssets,
  });
}

function materializeRuntimeRoleCandidate({ role_overrides, manifestContent = phoenixAssetsText } = {}) {
  return materializePromotionCandidate({
    candidateTargetKey: "rule/decomposition/runtime_role_assignments",
    candidateKind: "rule",
    candidateVersionId: "runtime-role-candidate",
    acceptedBaselineId: "accepted-runtime-role-baseline",
    resolvedReceipt: {
      launch: {
        candidate: {
          role_overrides,
        },
      },
    },
    currentAcceptedSnapshotContent: acceptedRuntimeRolesText,
    manifestContent,
    gateReport: {
      failure_modes: ["missing_acceptance_criteria"],
    },
    policy: { failure_taxonomy: failureTaxonomy },
    manifest: phoenixAssets,
  });
}

function promptVersionResponse({
  id = "PV1",
  content,
  messages,
  templateFormat = "NONE",
  templateType = "CHAT",
  templateObjectType = "chat",
} = {}) {
  return {
    data: promptVersionObject({
      id,
      content,
      messages,
      templateFormat,
      templateType,
      templateObjectType,
    }),
  };
}

function promptVersionObject({
  id = "PV1",
  content,
  messages,
  templateFormat = "NONE",
  templateType = "CHAT",
  templateObjectType = "chat",
} = {}) {
  return {
    id,
    template: {
      type: templateObjectType,
      messages: messages || [{ role: "system", content }],
    },
    template_type: templateType,
    template_format: templateFormat,
  };
}

function manifestPromptEntry(targetKey) {
  const entry = phoenixAssets.prompts.find((prompt) => prompt.target_key === targetKey);
  assert.ok(entry, targetKey);
  return entry;
}

function snapshotTextForManifestEntry(entry) {
  return fs.readFileSync(path.join(repoCheckout, ...entry.snapshot_path.split("/")), "utf8");
}

function assertOnlyPromptEntryPinsChanged({ before, after, targetKey } = {}) {
  assert.equal(after.prompts.length, before.prompts.length);
  for (let index = 0; index < before.prompts.length; index += 1) {
    const beforeEntry = before.prompts[index];
    const afterEntry = after.prompts[index];
    assert.equal(afterEntry.target_key, beforeEntry.target_key);
    if (beforeEntry.target_key !== targetKey) {
      assert.equal(JSON.stringify(afterEntry), JSON.stringify(beforeEntry), beforeEntry.target_key);
      continue;
    }
    assert.equal(
      JSON.stringify(scrubPromptEntryPinFields(afterEntry)),
      JSON.stringify(scrubPromptEntryPinFields(beforeEntry)),
      targetKey,
    );
    assert.deepEqual(changedEntryKeys({ before: beforeEntry, after: afterEntry }), [
      "accepted_prompt_version_id",
      "snapshot_sha256",
      "prompt_version",
    ]);
  }
}

function changedEntryKeys({ before, after } = {}) {
  return Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
}

function scrubPromptEntryPinFields(entry) {
  const copy = structuredClone(entry);
  copy.accepted_prompt_version_id = "__PIN__";
  copy.snapshot_sha256 = "__SHA__";
  copy.prompt_version = "__PIN__";
  return copy;
}

function scrubPromptPinFields(manifest, targetKey = judgeCandidateTargetKey) {
  const copy = structuredClone(manifest);
  const entry = copy.prompts.find((prompt) => prompt.target_key === targetKey);
  entry.accepted_prompt_version_id = "__PIN__";
  entry.snapshot_sha256 = "__SHA__";
  entry.prompt_version = "__PIN__";
  return copy;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
