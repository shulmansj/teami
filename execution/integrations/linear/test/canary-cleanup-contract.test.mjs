import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertDisposableCanaryHome,
  classifyExactGitHubRepoLookupFailure,
  exactGitHubRepoLookup,
  readCanaryCleanupReceipt,
  verifyAndFinalizeCanaryCleanup,
  writeCanaryCleanupReceipt,
} from "../../../../scripts/canary-cleanup-contract.mjs";

const receipt = {
  schema_version: "teami-live-canary-cleanup/v1",
  status: "cleanup_required",
  setup_id: "setup-1",
  domain_id: "domain-1",
  domain_name: "Teami Canary",
  linear_team: { id: "team-1", key: "TEA", name: "Teami Canary" },
  github_repo: "acme/teami-canary",
  recorded_at: "2026-07-11T00:00:00.000Z",
};

test("canary cleanup stays resumable and retains local authority while either remote exists", async () => {
  const calls = [];
  const result = await verifyAndFinalizeCanaryCleanup({
    receipt,
    listLinearTeams: async () => [{ id: "team-1" }],
    listGitHubRepos: async () => [],
    recordRemoteAbsence: async () => {},
    recordOAuthRevocation: async () => {},
    revokeLocalCredential: async () => ({ revokeVerified: true }),
    deleteLocalCredential: async () => calls.push("credential"),
    removeCanaryHome: async () => calls.push("home"),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.remaining, ["Linear team Teami Canary (TEA)"]);
  assert.deepEqual(calls, []);
});

test("canary cleanup removes local credential before exact home only after both remotes are absent", async () => {
  const calls = [];
  const result = await verifyAndFinalizeCanaryCleanup({
    receipt,
    listLinearTeams: async () => [],
    listGitHubRepos: async () => ["acme/another-repo"],
    recordRemoteAbsence: async () => {},
    recordOAuthRevocation: async () => calls.push("revocation-proof"),
    revokeLocalCredential: async () => { calls.push("revoke"); return { revokeVerified: true }; },
    deleteLocalCredential: async () => calls.push("credential"),
    removeCanaryHome: async () => calls.push("home"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["revoke", "revocation-proof", "credential", "home"]);
});

test("canary cleanup retains the credential and home when provider revocation is unverified", async () => {
  const calls = [];
  const result = await verifyAndFinalizeCanaryCleanup({
    receipt,
    listLinearTeams: async () => [],
    listGitHubRepos: async () => [],
    recordRemoteAbsence: async () => calls.push("remote-proof"),
    recordOAuthRevocation: async () => calls.push("unexpected-revocation-proof"),
    revokeLocalCredential: async () => ({ revokeVerified: false }),
    deleteLocalCredential: async () => calls.push("credential"),
    removeCanaryHome: async () => calls.push("home"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.oauth_revocation_verified, false);
  assert.deepEqual(calls, ["remote-proof"]);
});

test("canary cleanup resumes from durable remote-absence proofs after OAuth revocation", async () => {
  const calls = [];
  const result = await verifyAndFinalizeCanaryCleanup({
    receipt: {
      ...receipt,
      linear_absence_verified_at: "2026-07-11T01:00:00.000Z",
      linear_absence_verified_for: "team-1",
      github_absence_verified_at: "2026-07-11T01:00:00.000Z",
      github_absence_verified_for: "acme/teami-canary",
    },
    listLinearTeams: async () => { throw new Error("must not re-query Linear"); },
    listGitHubRepos: async () => { throw new Error("must not re-query GitHub"); },
    recordRemoteAbsence: async () => calls.push("unexpected-proof-write"),
    recordOAuthRevocation: async () => calls.push("revocation-proof"),
    revokeLocalCredential: async () => { calls.push("revoke"); return { revokeVerified: true }; },
    deleteLocalCredential: async () => calls.push("credential"),
    removeCanaryHome: async () => calls.push("home"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["revoke", "revocation-proof", "credential", "home"]);
});

test("canary cleanup resumes after durable revocation proof even when the token is gone", async () => {
  const calls = [];
  const cleanupIdentity = "team-1|acme/teami-canary";
  const result = await verifyAndFinalizeCanaryCleanup({
    receipt: {
      ...receipt,
      linear_absence_verified_at: "2026-07-11T01:00:00.000Z",
      linear_absence_verified_for: "team-1",
      github_absence_verified_at: "2026-07-11T01:00:00.000Z",
      github_absence_verified_for: "acme/teami-canary",
      oauth_revocation_verified_at: "2026-07-11T01:01:00.000Z",
      oauth_revocation_verified_for: cleanupIdentity,
    },
    listLinearTeams: async () => { throw new Error("must not re-query Linear"); },
    listGitHubRepos: async () => { throw new Error("must not re-query GitHub"); },
    recordRemoteAbsence: async () => calls.push("unexpected-remote-proof"),
    recordOAuthRevocation: async () => calls.push("unexpected-revocation-proof"),
    revokeLocalCredential: async () => { throw new Error("must not re-revoke missing token"); },
    deleteLocalCredential: async () => calls.push("credential"),
    removeCanaryHome: async () => calls.push("home"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["credential", "home"]);
});

test("canary cleanup rejects a durable absence proof for another remote identity", async () => {
  await assert.rejects(
    () => verifyAndFinalizeCanaryCleanup({
      receipt: {
        ...receipt,
        linear_absence_verified_at: "2026-07-11T01:00:00.000Z",
        linear_absence_verified_for: "different-team",
      },
      listLinearTeams: async () => [],
      listGitHubRepos: async () => [],
      recordRemoteAbsence: async () => {},
      recordOAuthRevocation: async () => {},
      revokeLocalCredential: async () => ({ revokeVerified: true }),
      deleteLocalCredential: async () => {},
      removeCanaryHome: async () => {},
    }),
    /canary_cleanup_receipt_invalid/,
  );
});

test("receipt writer invalidates absence and revocation proofs when target identity changes", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-linear-canary-proof-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proofAt = "2026-07-11T01:00:00.000Z";
  writeCanaryCleanupReceipt({
    home,
    domainName: "Teami Canary",
    linearTeam: receipt.linear_team,
    githubRepo: receipt.github_repo,
    linearAbsenceVerifiedAt: proofAt,
    githubAbsenceVerifiedAt: proofAt,
    oauthRevocationVerifiedAt: proofAt,
  });

  writeCanaryCleanupReceipt({
    home,
    domainName: "Teami Canary",
    linearTeam: receipt.linear_team,
    githubRepo: "acme/new-canary",
  });
  let updated = readCanaryCleanupReceipt(home);
  assert.equal(updated.linear_absence_verified_for, "team-1");
  assert.equal(updated.github_absence_verified_at, null);
  assert.equal(updated.oauth_revocation_verified_at, null);

  writeCanaryCleanupReceipt({
    home,
    domainName: "Teami Canary",
    linearTeam: receipt.linear_team,
    githubRepo: "acme/new-canary",
    linearAbsenceVerifiedAt: proofAt,
    githubAbsenceVerifiedAt: proofAt,
    oauthRevocationVerifiedAt: proofAt,
  });
  writeCanaryCleanupReceipt({
    home,
    domainName: "Teami Canary",
    linearTeam: { id: "team-2", key: "NEW", name: "Teami Canary 2" },
    githubRepo: "acme/new-canary",
  });
  updated = readCanaryCleanupReceipt(home);
  assert.equal(updated.linear_absence_verified_at, null);
  assert.equal(updated.github_absence_verified_for, "acme/new-canary");
  assert.equal(updated.oauth_revocation_verified_at, null);
});

test("exact GitHub absence accepts only an explicit not-found response", () => {
  const failureCode = classifyExactGitHubRepoLookupFailure({
    stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/teami-canary'.",
  });
  assert.equal(failureCode, "github_repo_not_found");
  assert.deepEqual(exactGitHubRepoLookup({
    ok: false,
    status: 1,
    failureCode,
    outcome: "failed",
    timedOut: false,
    outputTruncated: false,
    signal: null,
    stderr: "[captured failure output redacted]",
  }, receipt.github_repo, { authenticatedLogin: "acme", authenticatedScopes: ["repo"] }), []);
  assert.throws(
    () => exactGitHubRepoLookup({
      ok: false,
      failureCode,
      outcome: "timed_out",
      timedOut: true,
      outputTruncated: true,
      signal: "termination_unconfirmed",
      stderr: "[captured failure output redacted]",
    }, receipt.github_repo, { authenticatedLogin: "acme", authenticatedScopes: ["repo"] }),
    /github_lookup_ambiguous:timed_out/,
  );
  assert.deepEqual(exactGitHubRepoLookup({
    ok: false,
    status: 1,
    outcome: "failed",
    timedOut: false,
    outputTruncated: false,
    signal: null,
    stderr: "HTTP 404: Not Found (https://api.github.test/repos/acme/teami-canary)",
  }, receipt.github_repo, { authenticatedLogin: "acme", authenticatedScopes: ["repo"] }), []);
  assert.throws(
    () => exactGitHubRepoLookup({
      ok: false,
      status: 1,
      outcome: "timed_out",
      stderr: "request timed out",
    }, receipt.github_repo, { authenticatedLogin: "acme", authenticatedScopes: ["repo"] }),
    /github_lookup_ambiguous:timed_out/,
  );
  assert.throws(
    () => exactGitHubRepoLookup({
      ok: false,
      outcome: "timed_out",
      timedOut: true,
      outputTruncated: false,
      signal: null,
      stderr: "HTTP 404: Not Found",
    }, receipt.github_repo, { authenticatedLogin: "acme", authenticatedScopes: ["repo"] }),
    /github_lookup_ambiguous:timed_out/,
  );
  assert.throws(
    () => exactGitHubRepoLookup({
      ok: true,
      stdout: JSON.stringify({ nameWithOwner: "acme/different" }),
    }, receipt.github_repo, { authenticatedLogin: "acme", authenticatedScopes: ["repo"] }),
    /identity_mismatch/,
  );
  assert.throws(
    () => exactGitHubRepoLookup({
      ok: false,
      status: 1,
      stderr: "HTTP 404: Not Found",
    }, receipt.github_repo, { authenticatedLogin: "different-owner", authenticatedScopes: ["repo"] }),
    /owner_authority_unverified/,
  );
  assert.throws(
    () => exactGitHubRepoLookup({
      ok: false,
      status: 1,
      stderr: "HTTP 404: Not Found",
    }, receipt.github_repo, { authenticatedLogin: "acme", authenticatedScopes: ["read:org"] }),
    /private_repo_scope_unverified/,
  );
});

test("recursive canary cleanup is confined to an exact prefixed child of the OS temp root", (t) => {
  const syntheticTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teami-canary-test-temp-root-"));
  t.after(() => fs.rmSync(syntheticTempRoot, { recursive: true, force: true }));
  const outsideSyntheticTempRoot = path.join(os.tmpdir(), "teami-linear-canary-danger");
  assert.throws(
    () => assertDisposableCanaryHome(outsideSyntheticTempRoot, { tempRoot: syntheticTempRoot }),
    /must_be_under_os_temp/,
  );
});
