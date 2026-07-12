import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomicJson } from "../execution/engine/atomic-file.mjs";

export const CANARY_CLEANUP_SCHEMA_VERSION = "teami-live-canary-cleanup/v1";
export const GITHUB_REPO_NOT_FOUND_FAILURE = "github_repo_not_found";

export function canaryCleanupReceiptPath(home) {
  return path.join(path.resolve(home), "canary-cleanup.json");
}

export function writeCanaryCleanupReceipt({
  home,
  setupId = null,
  domainId = null,
  domainName,
  linearTeam = null,
  githubRepo,
  linearAbsenceVerifiedAt = null,
  githubAbsenceVerifiedAt = null,
  oauthRevocationVerifiedAt = null,
} = {}) {
  const filePath = canaryCleanupReceiptPath(home);
  let previous = null;
  if (fs.existsSync(filePath)) previous = readCanaryCleanupReceipt(home);
  const resolvedDomainName = requiredString(
    domainName || previous?.domain_name,
    "canary_cleanup_domain_name_required",
  );
  const resolvedLinearTeam = linearTeam ? {
    id: optionalString(linearTeam.id),
    key: optionalString(linearTeam.key),
    name: requiredString(linearTeam.name, "canary_cleanup_linear_team_name_required"),
  } : previous?.linear_team || null;
  const resolvedGitHubRepo = requiredString(githubRepo, "canary_cleanup_github_repo_required");
  const linearIdentity = resolvedLinearTeam?.id || resolvedDomainName;
  const cleanupIdentity = cleanupReceiptIdentity(linearIdentity, resolvedGitHubRepo);
  const requestedLinearProofAt = optionalString(linearAbsenceVerifiedAt);
  const requestedGitHubProofAt = optionalString(githubAbsenceVerifiedAt);
  const requestedRevocationProofAt = optionalString(oauthRevocationVerifiedAt);
  const previousLinearProofAt = previous?.linear_absence_verified_for === linearIdentity
    ? optionalString(previous.linear_absence_verified_at)
    : null;
  const previousGitHubProofAt = previous?.github_absence_verified_for === resolvedGitHubRepo
    ? optionalString(previous.github_absence_verified_at)
    : null;
  const previousRevocationProofAt = previous?.oauth_revocation_verified_for === cleanupIdentity
    ? optionalString(previous.oauth_revocation_verified_at)
    : null;
  const receipt = {
    schema_version: CANARY_CLEANUP_SCHEMA_VERSION,
    status: linearTeam?.id || previous?.linear_team?.id ? "cleanup_required" : "cleanup_planned",
    setup_id: optionalString(setupId) || previous?.setup_id || null,
    domain_id: optionalString(domainId) || previous?.domain_id || null,
    domain_name: resolvedDomainName,
    linear_team: resolvedLinearTeam,
    github_repo: resolvedGitHubRepo,
    linear_absence_verified_at: requestedLinearProofAt || previousLinearProofAt,
    linear_absence_verified_for: requestedLinearProofAt
      ? linearIdentity
      : previousLinearProofAt ? linearIdentity : null,
    github_absence_verified_at: requestedGitHubProofAt || previousGitHubProofAt,
    github_absence_verified_for: requestedGitHubProofAt
      ? resolvedGitHubRepo
      : previousGitHubProofAt ? resolvedGitHubRepo : null,
    oauth_revocation_verified_at: requestedRevocationProofAt || previousRevocationProofAt,
    oauth_revocation_verified_for: requestedRevocationProofAt
      ? cleanupIdentity
      : previousRevocationProofAt ? cleanupIdentity : null,
    planned_at: previous?.planned_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeAtomicJson({ filePath, value: receipt, validate: validateReceipt });
  return receipt;
}

export function readCanaryCleanupReceipt(home) {
  const receipt = JSON.parse(fs.readFileSync(canaryCleanupReceiptPath(home), "utf8"));
  validateReceipt(receipt);
  return receipt;
}

export async function verifyAndFinalizeCanaryCleanup({
  receipt,
  listLinearTeams,
  listGitHubRepos,
  recordRemoteAbsence,
  recordOAuthRevocation,
  revokeLocalCredential,
  deleteLocalCredential,
  removeCanaryHome,
} = {}) {
  validateReceipt(receipt);
  if (typeof recordRemoteAbsence !== "function") {
    throw new Error("canary_cleanup_remote_absence_recorder_required");
  }
  if (typeof recordOAuthRevocation !== "function") {
    throw new Error("canary_cleanup_oauth_revocation_recorder_required");
  }
  const linearAlreadyVerified = receipt.linear_absence_verified_for === linearReceiptIdentity(receipt) &&
    isIsoInstant(receipt.linear_absence_verified_at);
  const githubAlreadyVerified = receipt.github_absence_verified_for === receipt.github_repo &&
    isIsoInstant(receipt.github_absence_verified_at);
  const teams = linearAlreadyVerified ? [] : await listLinearTeams();
  const repos = githubAlreadyVerified ? [] : await listGitHubRepos();
  const linearAbsent = linearAlreadyVerified || !teams.some((team) => receipt.linear_team?.id
    ? team?.id === receipt.linear_team.id
    : String(team?.name || "") === receipt.domain_name);
  const githubAbsent = githubAlreadyVerified ||
    !repos.some((repo) => String(repo).toLowerCase() === receipt.github_repo.toLowerCase());
  if ((!linearAlreadyVerified && linearAbsent) || (!githubAlreadyVerified && githubAbsent)) {
    await recordRemoteAbsence({ linearAbsent, githubAbsent });
  }
  if (!linearAbsent || !githubAbsent) {
    return {
      ok: false,
      status: "cleanup_required",
      linear_absent: linearAbsent,
      github_absent: githubAbsent,
      remaining: [
        ...(!linearAbsent ? [`Linear team ${receipt.linear_team?.name || receipt.domain_name}${receipt.linear_team?.key ? ` (${receipt.linear_team.key})` : ""}`] : []),
        ...(!githubAbsent ? [`GitHub repo ${receipt.github_repo}`] : []),
      ],
    };
  }
  const revocationAlreadyVerified = receipt.oauth_revocation_verified_for ===
      cleanupReceiptIdentity(linearReceiptIdentity(receipt), receipt.github_repo) &&
    isIsoInstant(receipt.oauth_revocation_verified_at);
  if (!revocationAlreadyVerified) {
    const revocation = await revokeLocalCredential();
    if (revocation?.revokeVerified !== true) {
      return {
        ok: false,
        status: "cleanup_required",
        linear_absent: true,
        github_absent: true,
        oauth_revocation_verified: false,
        remaining: ["Linear OAuth grant revocation"],
      };
    }
    await recordOAuthRevocation();
  }
  await deleteLocalCredential();
  await removeCanaryHome();
  return {
    ok: true,
    status: "cleanup_verified",
    linear_absent: true,
    github_absent: true,
    oauth_revocation_verified: true,
    local_credential_removed: true,
    local_home_removed: true,
  };
}

export function exactGitHubRepoLookup(result, expectedRepo, {
  authenticatedLogin,
  authenticatedScopes = [],
} = {}) {
  requiredString(expectedRepo, "canary_cleanup_github_repo_required");
  const owner = expectedRepo.split("/")[0];
  if (!authenticatedLogin || authenticatedLogin.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("linear_canary_cleanup_github_owner_authority_unverified");
  }
  const scopes = new Set(authenticatedScopes.map((scope) => String(scope).trim().toLowerCase()));
  if (!scopes.has("repo")) {
    throw new Error("linear_canary_cleanup_github_private_repo_scope_unverified");
  }
  if (result?.ok === true) {
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("linear_canary_cleanup_github_lookup_invalid_json");
    }
    const nameWithOwner = requiredString(
      parsed?.nameWithOwner,
      "linear_canary_cleanup_github_lookup_invalid_identity",
    );
    if (nameWithOwner.toLowerCase() !== expectedRepo.toLowerCase()) {
      throw new Error("linear_canary_cleanup_github_lookup_identity_mismatch");
    }
    return [nameWithOwner];
  }
  const cleanFailure = result?.outcome === "failed" &&
    result?.timedOut !== true &&
    result?.outputTruncated !== true &&
    !result?.signal;
  if (cleanFailure && result?.failureCode === GITHUB_REPO_NOT_FOUND_FAILURE) return [];
  const diagnostic = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  if (cleanFailure &&
      /HTTP\s+404\b|Could not resolve to a Repository with the name/i.test(diagnostic)) return [];
  throw new Error(`linear_canary_cleanup_github_lookup_ambiguous:${result?.outcome || result?.status || "failed"}`);
}

export function classifyExactGitHubRepoLookupFailure({ stdout = "", stderr = "" } = {}) {
  const diagnostic = `${stdout}\n${stderr}`;
  return /HTTP\s+404\b|Could not resolve to a Repository with the name/i.test(diagnostic)
    ? GITHUB_REPO_NOT_FOUND_FAILURE
    : null;
}

function validateReceipt(receipt) {
  if (receipt?.schema_version !== CANARY_CLEANUP_SCHEMA_VERSION ||
      !["cleanup_planned", "cleanup_required"].includes(receipt.status)) {
    throw new Error("canary_cleanup_receipt_invalid");
  }
  if (receipt.setup_id !== null) requiredString(receipt.setup_id, "canary_cleanup_receipt_invalid");
  if (receipt.domain_id !== null) requiredString(receipt.domain_id, "canary_cleanup_receipt_invalid");
  requiredString(receipt.domain_name, "canary_cleanup_receipt_invalid");
  if (receipt.linear_team !== null) requiredString(receipt.linear_team?.name, "canary_cleanup_receipt_invalid");
  requiredString(receipt.github_repo, "canary_cleanup_receipt_invalid");
  validateAbsenceProof({
    verifiedAt: receipt.linear_absence_verified_at,
    verifiedFor: receipt.linear_absence_verified_for,
    expectedIdentity: linearReceiptIdentity(receipt),
  });
  validateAbsenceProof({
    verifiedAt: receipt.github_absence_verified_at,
    verifiedFor: receipt.github_absence_verified_for,
    expectedIdentity: receipt.github_repo,
  });
  validateAbsenceProof({
    verifiedAt: receipt.oauth_revocation_verified_at,
    verifiedFor: receipt.oauth_revocation_verified_for,
    expectedIdentity: cleanupReceiptIdentity(linearReceiptIdentity(receipt), receipt.github_repo),
  });
  return true;
}

function validateAbsenceProof({ verifiedAt, verifiedFor, expectedIdentity } = {}) {
  if (verifiedAt == null && verifiedFor == null) return;
  if (!isIsoInstant(verifiedAt) || verifiedFor !== expectedIdentity) {
    throw new Error("canary_cleanup_receipt_invalid");
  }
}

function linearReceiptIdentity(receipt) {
  return receipt.linear_team?.id || receipt.domain_name;
}

function cleanupReceiptIdentity(linearIdentity, githubRepo) {
  return `${linearIdentity}|${githubRepo}`;
}

function isIsoInstant(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function assertDisposableCanaryHome(home, { tempRoot = os.tmpdir() } = {}) {
  const resolved = path.resolve(requiredString(home, "linear_canary_home_required"));
  const resolvedTemp = fs.realpathSync(path.resolve(tempRoot));
  if (!resolved.startsWith(`${resolvedTemp}${path.sep}`)) {
    throw new Error("linear_canary_home_must_be_under_os_temp");
  }
  if (!path.basename(resolved).startsWith("teami-linear-canary-")) {
    throw new Error("linear_canary_home_requires_teami_linear_canary_prefix");
  }
  let cursor = resolved;
  while (cursor !== resolvedTemp) {
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || comparablePath(fs.realpathSync(cursor)) !== comparablePath(cursor)) {
        throw new Error("linear_canary_home_reparse_or_symlink_forbidden");
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("linear_canary_home_must_be_under_os_temp");
    cursor = parent;
  }
  return resolved;
}

function requiredString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
