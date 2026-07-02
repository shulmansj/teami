import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX,
  assertGhAuthStatusResult,
  assertGitHubLocalUatBinding,
  assertGitHubLocalUatProvenance,
  assertLocalAmbientGitHubSelection,
  buildGitHubLocalUatPrBody,
  githubLocalUatBranchName,
  parseGitHubLocalUatArgs,
  scanGitHubCredentialLeaks,
} from "../uat/github-local-uat.mjs";

test("github-local UAT args parse flags and env without touching GitHub", () => {
  const parsed = parseGitHubLocalUatArgs([
    "--repo-root",
    "C:/Users/example/factory",
    "--workspace-dir",
    "C:/Users/example/factory-uat",
    "--branch-prefix",
    "af-uat-github-local/custom",
    "--keep-artifacts",
  ], {});

  assert.equal(parsed.repoRoot, path.resolve("C:/Users/example/factory"));
  assert.equal(parsed.workspaceDir, path.resolve("C:/Users/example/factory-uat"));
  assert.equal(parsed.branchPrefix, "af-uat-github-local/custom");
  assert.equal(parsed.keepArtifacts, true);

  const envParsed = parseGitHubLocalUatArgs([], {
    TEAMI_GITHUB_LOCAL_UAT_BRANCH_PREFIX: "env-prefix",
    TEAMI_GITHUB_LOCAL_UAT_KEEP_ARTIFACTS: "1",
  });
  assert.equal(envParsed.branchPrefix, "env-prefix");
  assert.equal(envParsed.keepArtifacts, true);
  assert.equal(parseGitHubLocalUatArgs([], {}).branchPrefix, DEFAULT_GITHUB_LOCAL_UAT_BRANCH_PREFIX);
});

test("github-local UAT rejects unsafe branch prefixes before live I/O", () => {
  assert.throws(
    () => parseGitHubLocalUatArgs(["--branch-prefix", "bad:prefix"], {}),
    /invalid github local UAT branch prefix/,
  );
  assert.equal(
    githubLocalUatBranchName({ branchPrefix: "af-uat-github-local", stamp: "20260625T010203" }),
    "teami/promotion/af-uat-github-local/20260625T010203",
  );
});

test("github-local UAT binding guard fails before gh or network work", () => {
  assert.throws(
    () => assertGitHubLocalUatBinding({ ok: false, reason: "missing_github_connection_state" }),
    /GitHub behavior repo is not bound/,
  );
  assert.throws(
    () => assertGitHubLocalUatBinding({
      ok: true,
      connection_mode: "dry_run",
      repo: { owner: "acme", repo: "widgets" },
      real_push_enabled: false,
      default_branch: "main",
    }),
    /requires a real local_ambient connection/,
  );
  const arbitraryRepoBinding = {
    ok: true,
    connection_mode: "real",
    repo: { owner: "acme", repo: "widgets" },
    real_push_enabled: true,
    default_branch: "main",
  };
  assert.equal(
    assertGitHubLocalUatBinding(arbitraryRepoBinding),
    arbitraryRepoBinding,
  );
});

test("github-local UAT local ambient assertion pins selection", () => {
  const repoIdentity = {
    connection_mode: "real",
    real_push_enabled: true,
  };
  const selection = {
    mode: "local_ambient",
    transport: { kind: "local_ambient" },
    realPushEnabled: true,
  };

  assert.equal(assertLocalAmbientGitHubSelection({ selection, repoIdentity }), true);
  assert.throws(
    () => assertLocalAmbientGitHubSelection({
      selection: { ...selection, mode: "dry_run", transport: { kind: "dry_run" } },
      repoIdentity,
    }),
    /selection_mode_not_local_ambient/,
  );
});

test("github-local UAT gh auth guard redacts diagnostics", () => {
  const leaked = "ghp_" + "a".repeat(16);
  assert.throws(
    () => assertGhAuthStatusResult({ ok: false, stderr: `GITHUB_TOKEN=${leaked}` }),
    (error) => {
      assert.match(error.message, /GitHub CLI is not logged in/);
      assert.match(error.message, /GITHUB_TOKEN=\[redacted\]/);
      assert.equal(error.message.includes(leaked), false);
      return true;
    },
  );
  assert.equal(assertGhAuthStatusResult({ ok: true }), true);
});

test("github-local UAT credential scanner uses GitHub redaction semantics", () => {
  const clean = scanGitHubCredentialLeaks({
    body: "GitHub mode local_ambient; push auth ssh; GH_TOKEN=[redacted]",
    env: { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(clean.ok, true);

  const pat = "github_pat_" + "b".repeat(24);
  const classic = "ghs_" + "c".repeat(16);
  const leaked = scanGitHubCredentialLeaks({
    body: `token ${pat}`,
    env: { GH_TOKEN: classic, Authorization: "Bearer " + "d".repeat(16) },
  });
  assert.equal(leaked.ok, false);
  assert.deepEqual(
    leaked.findings.map((finding) => finding.path),
    ["records.body", "records.env.GH_TOKEN", "records.env.Authorization"],
  );
  for (const finding of leaked.findings) {
    assert.equal(finding.excerpt.includes(pat), false);
    assert.equal(finding.excerpt.includes(classic), false);
  }
});

test("github-local UAT PR body and evidence carry visible run provenance", () => {
  const runId = "github-local-uat-20260625T010203-abcdef";
  const branch = "teami/promotion/af-uat-github-local/20260625T010203";
  const selection = {
    mode: "local_ambient",
    owner: "acme",
    repo: "widgets",
    defaultBranch: "main",
    checkoutPath: "C:/Users/example/teami",
    pushAuth: "ssh",
    realPushEnabled: true,
  };
  const prProvenance = {
    schema_version: "teami-pr-provenance/v1",
    source_run_id: runId,
    experiment_receipt_id: `github-local-uat:${runId}`,
    phoenix_experiment_id: runId,
    proposal_instance_id: "prop-abcdefabcdef",
    normalized_envelope_hash: "a".repeat(64),
    candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass",
    produced_at: "2026-06-25T01:02:03.000Z",
    github_auth_mode: "local_ambient",
    push_auth: "ssh",
  };
  const prBody = buildGitHubLocalUatPrBody({
    runId,
    branch,
    startedAt: "2026-06-25T01:02:03.000Z",
    selection,
    prProvenance,
  });

  assert.match(prBody, /## Provenance/);
  assert.match(prBody, new RegExp(`Source run: ${runId}`));
  assert.match(prBody, /GitHub write custody: GitHub mode local_ambient; push auth ssh/);
  assert.equal(
    assertGitHubLocalUatProvenance({
      prBody,
      evidence: { payload: { pr_provenance: prProvenance } },
      runId,
    }),
    true,
  );
});
