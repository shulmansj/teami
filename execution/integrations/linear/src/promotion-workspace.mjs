import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createGitHubInstallationTokenAskPass } from "./github-askpass.mjs";
import { resolveDefaultBranchRef } from "./promotion-policy.mjs";

// Internal promotion workspace (CONSTRAINTS #14/#15/#16): repo-writing
// promotion work happens ONLY in a dedicated internal clone under
// .agentic-factory/promotion-workspace/ (gitignored local custody), never by
// mutating the adopter's active checkout. Dry-run connections record the push
// intent; real GitHub connections push only with a broker-minted, short-lived
// GitHub App installation token.
//
// Commits are attributed to a BOT IDENTITY PLACEHOLDER, never the adopter
// (CONSTRAINTS #25); configure the real GitHub App bot identity at GitHub setup.

export const PROMOTION_BRANCH_NAMESPACE = "agentic-factory/promotion";

export function controllerNamespacePr(pr) {
  const headRef = pr?.head?.ref ?? pr?.head_ref ?? null;
  return typeof headRef === "string" && headRef.startsWith(`${PROMOTION_BRANCH_NAMESPACE}/`);
}

export const PROMOTION_BOT_IDENTITY_PLACEHOLDER = Object.freeze({
  // Replace with the installed GitHub App bot identity
  // (e.g. "agentic-factory[bot]" + the App's noreply address) at GitHub setup.
  name: "agentic-factory[bot] (placeholder)",
  email: "agentic-factory-bot@placeholder.invalid",
});

const PROMOTION_TRAILER_KEYS = Object.freeze({
  envelope: "Agentic-Factory-Promotion-Envelope",
  instance: "Agentic-Factory-Promotion-Instance",
  target: "Agentic-Factory-Promotion-Target",
});

const PROMOTION_CANDIDATE_KINDS = Object.freeze([
  "prompt", "evaluator_prompt", "rule", "schema", "code_evaluator", "policy",
]);

// Single definition of the marker grammar; promote-candidate re-exports these
// so every consumer (controller, drafter, tests) shares one source of truth.
export const PROMOTION_MARKER_KEY = "agentic_factory_promotion";
export const PROMOTION_MARKER_SENTINEL_BEGIN = "<!-- agentic_factory_promotion:begin -->";
export const PROMOTION_MARKER_SENTINEL_END = "<!-- agentic_factory_promotion:end -->";

export function defaultPromotionWorkspaceDir(repoRoot = process.cwd()) {
  return path.resolve(repoRoot, ".agentic-factory", "promotion-workspace");
}

export function promotionWorkspaceCloneDir(workspaceDir) {
  return path.join(workspaceDir, "repo");
}

export function defaultRunGit(args, { cwd, env } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// Deterministic branch namespace (CONSTRAINTS #15):
// agentic-factory/promotion/<candidate-target-slug>/<short-envelope-hash>.
// The slug flattens the candidate_target_key's slashes so the target stays
// readable while the short envelope hash disambiguates proposal instances.
export function promotionBranchName({ candidateTargetKey, envelopeHash }) {
  const slug = String(candidateTargetKey)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("invalid_candidate_target_key_for_branch_name");
  const short = String(envelopeHash).slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(short)) throw new Error("invalid_envelope_hash_for_branch_name");
  return `${PROMOTION_BRANCH_NAMESPACE}/${slug}/${short}`;
}

const SAFE_PROMOTION_BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

export function validatePromotionBranchRef(branch) {
  if (typeof branch !== "string" || branch.trim() !== branch || branch.length === 0) {
    return { ok: false, reason: "promotion_branch_ref_invalid" };
  }
  if (
    !branch.startsWith(`${PROMOTION_BRANCH_NAMESPACE}/`)
    || branch.startsWith("refs/")
    || branch.includes(":")
  ) {
    return { ok: false, reason: "promotion_branch_ref_not_in_namespace" };
  }
  if (
    !SAFE_PROMOTION_BRANCH_PATTERN.test(branch)
    || branch.includes("..")
    || branch.includes("@{")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.split("/").some((segment) => segment === "." || segment === ".." || segment.endsWith(".lock"))
  ) {
    return { ok: false, reason: "promotion_branch_ref_invalid" };
  }
  return {
    ok: true,
    branch,
    full_ref: `refs/heads/${branch}`,
  };
}

// Ensures the internal clone exists, is up to date with the local origin, and
// is CLEAN. A dirty internal worktree fails closed (the dirty-worktree gate
// applies to the internal workspace, not the adopter checkout).
export function ensurePromotionWorkspace({
  repoRoot = process.cwd(),
  workspaceDir = null,
  runGit = defaultRunGit,
} = {}) {
  const dir = workspaceDir || defaultPromotionWorkspaceDir(repoRoot);
  const cloneDir = promotionWorkspaceCloneDir(dir);
  if (!fs.existsSync(path.join(cloneDir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    const clone = runGit(["clone", "--no-hardlinks", repoRoot, cloneDir], { cwd: dir });
    if (!clone.ok) {
      return {
        ok: false,
        reason: "internal_clone_failed",
        detail: clone.stderr.trim() || clone.stdout.trim(),
      };
    }
  } else {
    const fetch = runGit(["fetch", "origin", "--prune"], { cwd: cloneDir });
    if (!fetch.ok) {
      return {
        ok: false,
        reason: "internal_clone_fetch_failed",
        detail: fetch.stderr.trim() || fetch.stdout.trim(),
      };
    }
  }
  const status = runGit(["status", "--porcelain"], { cwd: cloneDir });
  if (!status.ok) {
    return { ok: false, reason: "internal_clone_status_failed", detail: status.stderr.trim() };
  }
  if (status.stdout.trim() !== "") {
    return {
      ok: false,
      reason: "internal_workspace_dirty",
      detail:
        `the internal promotion workspace has uncommitted changes (${cloneDir}); refusing to draft on a dirty internal worktree. Clean or delete the workspace and re-run.`,
      dirty_paths: status.stdout.trim().split("\n").map((line) => line.slice(3)),
    };
  }
  const head = resolveDefaultBranchRef({ internalCloneDir: cloneDir, runGit });
  if (!head.ok) return head;
  return { ok: true, workspaceDir: dir, cloneDir, defaultBranchRef: head.ref };
}

export function listPromotionBranches({ cloneDir, runGit = defaultRunGit } = {}) {
  const result = runGit(
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/${PROMOTION_BRANCH_NAMESPACE}/`],
    { cwd: cloneDir },
  );
  if (!result.ok) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function branchExists({ cloneDir, branch, runGit = defaultRunGit } = {}) {
  return runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: cloneDir }).ok;
}

// Reads a committed file from a branch tip without checking it out (used to
// compare an existing branch's committed marker against the current envelope).
export function readFileFromBranch({ cloneDir, branch, relativePath, runGit = defaultRunGit } = {}) {
  const result = runGit(["show", `${branch}:${relativePath}`], { cwd: cloneDir });
  if (!result.ok) return null;
  return result.stdout;
}

function isValidPromotionEnvelopeHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isValidPromotionProposalInstanceId(value) {
  return typeof value === "string" && /^prop-[0-9a-f]{12}$/.test(value);
}

function parsePromotionCandidateTargetKey(key) {
  if (typeof key !== "string") return { ok: false };
  const segments = key.split("/");
  if (segments.length < 3 || segments.some((segment) => !segment.trim())) return { ok: false };
  const [candidateKind, scope, ...slot] = segments;
  if (!PROMOTION_CANDIDATE_KINDS.includes(candidateKind)) return { ok: false };
  return { ok: true, candidate_kind: candidateKind, scope, artifact_slot: slot.join("/") };
}

function isValidPromotionCandidateTargetKey(value) {
  return parsePromotionCandidateTargetKey(value).ok;
}

function validatePromotionTrailerFacts({
  normalizedEnvelopeHash,
  proposalInstanceId,
  candidateTargetKey,
} = {}) {
  if (!isValidPromotionEnvelopeHash(normalizedEnvelopeHash)) {
    return { ok: false, field: "normalizedEnvelopeHash" };
  }
  if (!isValidPromotionProposalInstanceId(proposalInstanceId)) {
    return { ok: false, field: "proposalInstanceId" };
  }
  if (!isValidPromotionCandidateTargetKey(candidateTargetKey)) {
    return { ok: false, field: "candidateTargetKey" };
  }
  return {
    ok: true,
    trailers: {
      envelope: normalizedEnvelopeHash,
      instance: proposalInstanceId,
      target: candidateTargetKey,
    },
  };
}

function resolvePromotionTrailerFacts({
  files,
  normalizedEnvelopeHash,
  proposalInstanceId,
  candidateTargetKey,
} = {}) {
  const marker = Object.values(files || {})
    .flatMap((content) => parsePromotionMarkersFromDocument(content))
    .find(Boolean);
  if (normalizedEnvelopeHash !== undefined && !isValidPromotionEnvelopeHash(normalizedEnvelopeHash)) {
    return { ok: false, field: "normalizedEnvelopeHash" };
  }
  if (proposalInstanceId !== undefined && !isValidPromotionProposalInstanceId(proposalInstanceId)) {
    return { ok: false, field: "proposalInstanceId" };
  }
  if (candidateTargetKey !== undefined && !isValidPromotionCandidateTargetKey(candidateTargetKey)) {
    return { ok: false, field: "candidateTargetKey" };
  }
  return validatePromotionTrailerFacts({
    normalizedEnvelopeHash: normalizedEnvelopeHash ?? marker?.normalized_envelope_hash,
    proposalInstanceId: proposalInstanceId ?? marker?.proposal_instance_id,
    candidateTargetKey: candidateTargetKey ?? marker?.candidate_target_key,
  });
}

function formatPromotionTrailerParagraph({ envelope, instance, target }) {
  return [
    `${PROMOTION_TRAILER_KEYS.envelope}: ${envelope}`,
    `${PROMOTION_TRAILER_KEYS.instance}: ${instance}`,
    `${PROMOTION_TRAILER_KEYS.target}: ${target}`,
  ].join("\n");
}

function parsePromotionTrailerParagraph(paragraph) {
  const seen = new Set();
  const values = {};
  let sawExpectedKey = false;
  let sawMalformedLine = false;
  for (const rawLine of String(paragraph ?? "").split("\n")) {
    const line = rawLine.replace(/[ \t]+$/g, "");
    if (!line.trim()) continue;
    const match = line.match(/^([^:\s][^:]*):[ \t]*(.*)$/);
    if (!match) {
      sawMalformedLine = true;
      continue;
    }
    const key = match[1];
    const value = match[2].trim();
    const name = Object.entries(PROMOTION_TRAILER_KEYS).find(([, trailerKey]) => trailerKey === key)?.[0];
    if (!name) continue;
    sawExpectedKey = true;
    if (seen.has(name)) return { ok: false, reason: "trailers_malformed" };
    seen.add(name);
    values[name] = value;
  }
  if (!sawExpectedKey) return { ok: false, reason: "trailers_absent" };
  if (sawMalformedLine
    || !isValidPromotionEnvelopeHash(values.envelope)
    || !isValidPromotionProposalInstanceId(values.instance)
    || !isValidPromotionCandidateTargetKey(values.target)) {
    return { ok: false, reason: "trailers_malformed" };
  }
  return {
    ok: true,
    trailers: {
      envelope: values.envelope,
      instance: values.instance,
      target: values.target,
    },
  };
}

function lastNonEmptyParagraph(message) {
  const normalized = String(message ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const paragraphs = normalized.split(/\n[ \t]*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : "";
}

export function readPromotionCommitTrailers({ cloneDir, branch, runGit = defaultRunGit } = {}) {
  const result = runGit(["log", "-1", "--pretty=%B", branch, "--"], { cwd: cloneDir });
  if (!result.ok) return { ok: false, reason: "trailers_absent" };
  return parsePromotionTrailerParagraph(lastNonEmptyParagraph(result.stdout));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PROMOTION_SENTINEL_REGION_PATTERN = new RegExp(
  `${escapeRegExp(PROMOTION_MARKER_SENTINEL_BEGIN)}([\\s\\S]*?)${escapeRegExp(PROMOTION_MARKER_SENTINEL_END)}`,
  "g",
);
const PROMOTION_MARKER_FENCE_PATTERN = /```json\s*\n([\s\S]*?)```/g;

function parsePromotionMarkersFromDocument(body) {
  if (typeof body !== "string") return [];
  const markers = [];
  PROMOTION_SENTINEL_REGION_PATTERN.lastIndex = 0;
  let regionMatch;
  while ((regionMatch = PROMOTION_SENTINEL_REGION_PATTERN.exec(body)) !== null) {
    PROMOTION_MARKER_FENCE_PATTERN.lastIndex = 0;
    let fenceMatch;
    while ((fenceMatch = PROMOTION_MARKER_FENCE_PATTERN.exec(regionMatch[1])) !== null) {
      try {
        const parsed = JSON.parse(fenceMatch[1]);
        if (parsed && typeof parsed === "object" && parsed[PROMOTION_MARKER_KEY]) {
          markers.push(parsed[PROMOTION_MARKER_KEY]);
        }
      } catch {
        // Not a parseable promotion marker.
      }
    }
  }
  return markers;
}

export function verifyPromotionBranchEnvelope({
  cloneDir,
  branch,
  envelopeHash,
  proposalInstanceId,
  candidateTargetKey,
  proposalRelativePath,
  recordedCommitSha = null,
  runGit = defaultRunGit,
} = {}) {
  // Resume integrity: when the registry recorded the branch-tip SHA for this
  // envelope, the live branch tip MUST still equal it before we trust any
  // committed content on the branch — a moved/rewritten branch tip means the
  // recorded commit is no longer at HEAD, so resume fails closed. The guard
  // only runs when a recorded SHA is present: envelopes recorded before this
  // field existed (commit_sha null/absent) keep their prior behavior.
  if (typeof recordedCommitSha === "string" && recordedCommitSha.length > 0) {
    const tip = runGit(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: cloneDir });
    const tipSha = tip.ok ? tip.stdout.trim() : null;
    if (tipSha !== recordedCommitSha) {
      return {
        verified: false,
        reason: "branch_tip_sha_mismatch",
        method: "branch_tip_sha",
        recorded_commit_sha: recordedCommitSha,
        branch_tip_sha: tipSha,
      };
    }
  }
  const commitTrailers = readPromotionCommitTrailers({ cloneDir, branch, runGit });
  if (commitTrailers.ok) {
    const matches = commitTrailers.trailers.envelope === envelopeHash
      && commitTrailers.trailers.instance === proposalInstanceId
      && commitTrailers.trailers.target === candidateTargetKey;
    return matches
      ? { verified: true, method: "commit_trailers", trailers: commitTrailers.trailers }
      : {
          verified: false,
          reason: "branch_envelope_mismatch",
          method: "commit_trailers",
          trailers: commitTrailers.trailers,
        };
  }
  if (commitTrailers.reason === "trailers_malformed") {
    return {
      verified: false,
      reason: "promotion_trailers_malformed",
      method: "commit_trailers",
    };
  }
  const committedDoc = readFileFromBranch({
    cloneDir,
    branch,
    relativePath: proposalRelativePath,
    runGit,
  });
  const committedMarker = committedDoc ? parsePromotionMarkersFromDocument(committedDoc)[0] : null;
  if (!committedMarker || committedMarker.normalized_envelope_hash !== envelopeHash) {
    return {
      verified: false,
      reason: "branch_envelope_mismatch",
      method: "proposal_document",
      committedMarker,
    };
  }
  return { verified: true, method: "proposal_document", committedMarker };
}

// Creates (or checks out) the deterministic promotion branch from the remote
// default branch — base derives from origin's default branch, never from the
// adopter's active checkout (CONSTRAINTS #15).
export function checkoutPromotionBranch({
  cloneDir,
  branch,
  defaultBranchRef,
  runGit = defaultRunGit,
} = {}) {
  if (branchExists({ cloneDir, branch, runGit })) {
    const checkout = runGit(["checkout", branch], { cwd: cloneDir });
    if (!checkout.ok) {
      return { ok: false, reason: "branch_checkout_failed", detail: checkout.stderr.trim() };
    }
    return { ok: true, created: false, branch };
  }
  const create = runGit(["checkout", "-b", branch, defaultBranchRef], { cwd: cloneDir });
  if (!create.ok) {
    return { ok: false, reason: "branch_create_failed", detail: create.stderr.trim() };
  }
  return { ok: true, created: true, branch };
}

// CASE-INSENSITIVE on purpose (outside-review FIX 3): on Windows (and any
// case-insensitive filesystem) `.GITHUB/Workflows/x.yml` is the same effective
// path as `.github/workflows/x.yml`, so the block normalizes case before
// matching instead of trusting the staged spelling.
const WORKFLOWS_DIR_PATTERN = /^\.github[\\/]+workflows[\\/]/i;
const GITHUB_DIR_PATTERN = /^\.github([\\/]|$)/i;
const SYMLINK_MODE = "120000";

function normalizeStagedPath(entry) {
  return String(entry).replace(/^["']|["']$/g, "");
}

export function findWorkflowsDirPaths(paths = []) {
  return paths.filter((entry) => WORKFLOWS_DIR_PATTERN.test(normalizeStagedPath(entry)));
}

// Parses `git diff --cached --raw -z` output into structured entries so the
// pre-commit block can see modes (symlinks), statuses, and BOTH sides of a
// rename/copy. -z framing: a metadata token starting with ":" followed by one
// path token (two for R/C statuses), all NUL-separated.
export function parseRawCachedDiff(output) {
  const tokens = String(output ?? "").split("\0");
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const meta = tokens[index];
    if (!meta || !meta.startsWith(":")) continue;
    const match = meta.match(/^:(\d{6}) (\d{6}) (\S+) (\S+) ([A-Z])(\d*)$/);
    if (!match) continue;
    const status = match[5];
    const paths = [];
    if (tokens[index + 1] !== undefined) paths.push(tokens[index + 1]);
    if ((status === "R" || status === "C") && tokens[index + 2] !== undefined) {
      paths.push(tokens[index + 2]);
      index += 2;
    } else {
      index += 1;
    }
    entries.push({
      old_mode: match[1],
      new_mode: match[2],
      status,
      // `-z` output is LITERAL (git does not quote/escape paths under -z), so do
      // NOT strip quote characters here: a path whose real name has a leading or
      // trailing quote must be compared EXACTLY, or it could masquerade as an
      // allowlisted path and slip the ownership allowlist (outside-review). The
      // `git reset` on a block uses these same exact paths, so the real staged
      // path is what gets reset.
      paths: paths.filter((entry) => typeof entry === "string" && entry.length > 0),
    });
  }
  return entries;
}

// Evaluates the staged raw diff against the protected-path rules
// (outside-review FIX 3, CONSTRAINTS #9):
//   1. ANY staged path (rename SOURCE and DESTINATION included) whose
//      case-insensitive normalization starts with .github/workflows/ blocks.
//   2. ANY staged symlink (old or new mode 120000) under .github/** blocks —
//      a link created, replaced, or removed there could resolve into or stand
//      in for workflow paths, so symlinks are blocked in that subtree
//      entirely (simplest robust rule).
export function findBlockedStagedEntries(rawDiffEntries = []) {
  const blocked = [];
  for (const entry of rawDiffEntries) {
    const workflowPaths = entry.paths.filter((p) => WORKFLOWS_DIR_PATTERN.test(p));
    for (const blockedPath of workflowPaths) {
      blocked.push({ path: blockedPath, rule: "workflows_dir", status: entry.status });
    }
    const isSymlink = entry.old_mode === SYMLINK_MODE || entry.new_mode === SYMLINK_MODE;
    if (isSymlink) {
      for (const blockedPath of entry.paths) {
        if (GITHUB_DIR_PATTERN.test(blockedPath) && !workflowPaths.includes(blockedPath)) {
          blocked.push({ path: blockedPath, rule: "github_symlink", status: entry.status });
        }
      }
    }
  }
  return blocked;
}

// Normalizes a path for allowlist membership comparison. Mirrors the
// materializer's normalizePathForCompare (forward slashes, posix-normalized,
// leading "./" and "/" stripped, lowercased) so the staged-diff allowlist and
// the materializer's own validateBehaviorDiff agree on what counts as the same
// path on case-insensitive filesystems (Windows).
function normalizePathForAllowlist(filePath) {
  const slashed = String(filePath ?? "").replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashed);
  const withoutLeadingCurrent = normalized.replace(/^(\.\/)+/, "");
  const withoutLeadingSlash = withoutLeadingCurrent.replace(/^\/+/, "");
  return withoutLeadingSlash === "." ? "" : withoutLeadingSlash.toLowerCase();
}

// POSITIVE-allowlist check (workspace-scoping / ownership): every staged path —
// INCLUDING a rename's SOURCE and DESTINATION — must be a member of the target's
// manifest-derived allowed set. Returns the staged paths that fall OUTSIDE the
// set (the violations). An empty allowlist would block everything, so the caller
// only invokes this when it has a non-empty allowed set.
export function findStagedPathsOutsideAllowlist(rawDiffEntries = [], allowedPaths = []) {
  const allowedSet = new Set(allowedPaths.map(normalizePathForAllowlist).filter(Boolean));
  const violations = [];
  const seen = new Set();
  for (const entry of rawDiffEntries) {
    for (const stagedPath of entry.paths) {
      if (allowedSet.has(normalizePathForAllowlist(stagedPath))) continue;
      if (seen.has(stagedPath)) continue;
      seen.add(stagedPath);
      violations.push({ path: stagedPath, status: entry.status });
    }
  }
  return violations;
}

function validateDraftWorkspacePath({ cloneDir, relativePath } = {}) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return { ok: false, offender: relativePath };
  }
  if (
    path.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || /^[A-Za-z]:/.test(relativePath)
  ) {
    return { ok: false, offender: relativePath };
  }
  const resolvedCloneDir = path.resolve(cloneDir);
  const resolvedPath = path.resolve(resolvedCloneDir, relativePath);
  const rel = path.relative(resolvedCloneDir, resolvedPath);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, offender: relativePath };
  }
  const ancestry = validateDraftPathAncestry({
    resolvedCloneDir,
    resolvedPath,
    relativePath,
  });
  if (!ancestry.ok) return ancestry;
  return { ok: true, absolute: resolvedPath };
}

function validateDraftPathAncestry({ resolvedCloneDir, resolvedPath, relativePath } = {}) {
  let cloneReal;
  try {
    cloneReal = fs.realpathSync.native(resolvedCloneDir);
  } catch (error) {
    return {
      ok: false,
      reason: "draft_path_escapes_workspace",
      offender: relativePath,
      detail: `could not resolve internal clone realpath: ${error.message}`,
    };
  }

  const parentDir = path.dirname(resolvedPath);
  const parentRel = path.relative(resolvedCloneDir, parentDir);
  const parts = parentRel ? parentRel.split(path.sep).filter(Boolean) : [];
  let current = resolvedCloneDir;
  let deepestExisting = resolvedCloneDir;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      return {
        ok: false,
        reason: "draft_path_escapes_workspace",
        offender: relativePath,
        detail: `could not inspect draft path ancestor ${path.relative(resolvedCloneDir, current)}: ${error.message}`,
      };
    }
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        reason: "draft_path_symlink_ancestor",
        offender: relativePath,
        ancestor: path.relative(resolvedCloneDir, current) || ".",
      };
    }
    deepestExisting = current;
  }

  let deepestReal;
  try {
    deepestReal = fs.realpathSync.native(deepestExisting);
  } catch (error) {
    return {
      ok: false,
      reason: "draft_path_escapes_workspace",
      offender: relativePath,
      detail: `could not resolve draft path ancestor realpath: ${error.message}`,
    };
  }
  if (!pathContainedWithin(cloneReal, deepestReal)) {
    return {
      ok: false,
      reason: "draft_path_escapes_workspace",
      offender: relativePath,
      ancestor: path.relative(resolvedCloneDir, deepestExisting) || ".",
    };
  }
  return { ok: true };
}

function pathContainedWithin(parent, child) {
  const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const normalizedChild = process.platform === "win32" ? child.toLowerCase() : child;
  const rel = path.relative(normalizedParent, normalizedChild);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

// Writes + stages the draft files and commits them on the current branch with
// the bot identity placeholder. BLOCKS any staged diff touching
// .github/workflows/** BEFORE the commit (CONSTRAINTS #9) — checked over the
// full staged RAW diff (case-insensitive, rename sources AND destinations,
// symlink modes), not just the declared files, so nothing staged out of band
// can ride along either.
//
// When `allowedPaths` is provided (the controller always passes the target's
// manifest-derived allowed set), the commit additionally enforces a POSITIVE
// path ALLOWLIST over the SAME full staged RAW diff (workspace-scoping /
// ownership): EVERY changed path — rename SOURCE and DESTINATION included — must
// be a member of the target's allowed set, or the commit fails closed and the
// staged paths are reset. This is checked against the REAL `git diff`, not the
// materializer's self-reported file list, so a path staged out of band cannot
// ride along. `allowedPaths` omitted/null disables the allowlist (the workflows
// block still runs) — used by unit tests that exercise other facets.
export function commitPromotionDraft({
  cloneDir,
  files,
  message,
  normalizedEnvelopeHash,
  proposalInstanceId,
  candidateTargetKey,
  allowedPaths = null,
  botIdentity = PROMOTION_BOT_IDENTITY_PLACEHOLDER,
  runGit = defaultRunGit,
} = {}) {
  const declaredPaths = Object.keys(files || {});
  if (declaredPaths.length === 0) return { ok: false, reason: "no_draft_files" };
  const safeDeclaredPaths = new Map();
  for (const relativePath of declaredPaths) {
    const validation = validateDraftWorkspacePath({ cloneDir, relativePath });
    if (!validation.ok) {
      return {
        ok: false,
        reason: validation.reason || "draft_path_escapes_workspace",
        path: validation.offender,
        ...(validation.ancestor ? { ancestor: validation.ancestor } : {}),
        ...(validation.detail ? { detail: validation.detail } : {}),
      };
    }
    safeDeclaredPaths.set(relativePath, validation.absolute);
  }
  const trailerFacts = resolvePromotionTrailerFacts({
    files,
    normalizedEnvelopeHash,
    proposalInstanceId,
    candidateTargetKey,
  });
  if (!trailerFacts.ok) {
    return {
      ok: false,
      reason: "promotion_trailer_input_malformed",
      field: trailerFacts.field,
    };
  }
  const declaredWorkflowPaths = findWorkflowsDirPaths(declaredPaths);
  if (declaredWorkflowPaths.length > 0) {
    return {
      ok: false,
      reason: "workflows_dir_diff_blocked",
      detail: `promotion diffs may not touch .github/workflows/** (CONSTRAINTS #9): ${declaredWorkflowPaths.join(", ")}`,
      blocked_paths: declaredWorkflowPaths,
    };
  }
  // POSITIVE allowlist, enforced BEFORE any filesystem write (workspace-scoping /
  // ownership): every DECLARED file must be in the target's allowed set, or the
  // commit fails closed with NOTHING written to the workspace. The post-stage
  // staged-diff allowlist below still runs to catch out-of-band staged paths and
  // rename source/destination that the declared list cannot see.
  if (Array.isArray(allowedPaths) && allowedPaths.length > 0) {
    const allowedSet = new Set(allowedPaths.map(normalizePathForAllowlist).filter(Boolean));
    const declaredOutsideAllowlist = [...new Set(declaredPaths)]
      .filter((declaredPath) => !allowedSet.has(normalizePathForAllowlist(declaredPath)));
    if (declaredOutsideAllowlist.length > 0) {
      return {
        ok: false,
        reason: "promotion_path_not_in_allowlist",
        detail:
          `declared promotion file(s) outside the target's allowed set (blocked before any filesystem write; allowed: ${allowedPaths.join(", ")}): ${declaredOutsideAllowlist.join(", ")}`,
        blocked_paths: declaredOutsideAllowlist,
        allowed_paths: [...allowedPaths],
      };
    }
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = safeDeclaredPaths.get(relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }
  const add = runGit(["add", "--", ...declaredPaths], { cwd: cloneDir });
  if (!add.ok) return { ok: false, reason: "git_add_failed", detail: add.stderr.trim() };
  // RAW -z staged diff: modes expose symlinks; R/C entries expose the rename
  // SOURCE and DESTINATION; -z framing survives unusual filenames.
  const staged = runGit(["diff", "--cached", "--raw", "-z"], { cwd: cloneDir });
  if (!staged.ok) return { ok: false, reason: "git_diff_failed", detail: staged.stderr.trim() };
  const rawEntries = parseRawCachedDiff(staged.stdout);
  const stagedPaths = [...new Set(rawEntries.flatMap((entry) => entry.paths))];
  const blockedEntries = findBlockedStagedEntries(rawEntries);
  if (blockedEntries.length > 0) {
    runGit(["reset", "--", ...stagedPaths], { cwd: cloneDir });
    const blockedPaths = [...new Set(blockedEntries.map((entry) => entry.path))];
    return {
      ok: false,
      reason: "workflows_dir_diff_blocked",
      detail:
        `promotion diffs may not touch .github/workflows/** (case-insensitive, rename source/destination included) or stage symlinks under .github/** (CONSTRAINTS #9): ${blockedEntries
          .map((entry) => `${entry.path} [${entry.rule}/${entry.status}]`)
          .join(", ")}`,
      blocked_paths: blockedPaths,
      blocked_entries: blockedEntries,
    };
  }
  // POSITIVE path allowlist (workspace-scoping / ownership): when the caller
  // supplies the target's manifest-derived allowed set, EVERY staged path
  // (rename source + destination, anything staged out of band) must be a member
  // or the commit fails closed and the staged paths are reset. Checked over the
  // REAL staged diff above, never the declared/self-reported file list.
  if (Array.isArray(allowedPaths) && allowedPaths.length > 0) {
    const outsideAllowlist = findStagedPathsOutsideAllowlist(rawEntries, allowedPaths);
    if (outsideAllowlist.length > 0) {
      runGit(["reset", "--", ...stagedPaths], { cwd: cloneDir });
      const outsidePaths = [...new Set(outsideAllowlist.map((entry) => entry.path))];
      return {
        ok: false,
        reason: "promotion_path_not_in_allowlist",
        detail:
          `promotion commit staged path(s) outside the target's allowed set (rename source/destination included; allowed: ${allowedPaths.join(", ")}): ${outsideAllowlist
            .map((entry) => `${entry.path} [${entry.status}]`)
            .join(", ")}`,
        blocked_paths: outsidePaths,
        blocked_entries: outsideAllowlist,
        allowed_paths: [...allowedPaths],
      };
    }
  }
  const commit = runGit(
    [
      "-c", `user.name=${botIdentity.name}`,
      "-c", `user.email=${botIdentity.email}`,
      "commit", "-m", message,
      "-m", formatPromotionTrailerParagraph(trailerFacts.trailers),
    ],
    { cwd: cloneDir },
  );
  if (!commit.ok) return { ok: false, reason: "git_commit_failed", detail: commit.stderr.trim() };
  const sha = runGit(["rev-parse", "HEAD"], { cwd: cloneDir });
  return {
    ok: true,
    commit_sha: sha.ok ? sha.stdout.trim() : null,
    staged_paths: stagedPaths,
    bot_identity: botIdentity,
  };
}

// Dry-run push-equivalent. The workflows-dir block above runs BEFORE this
// push-equivalent by construction.
export function pushBranchPlaceholder({ branch } = {}) {
  const ref = validatePromotionBranchRef(branch);
  if (!ref.ok) {
    return {
      ok: false,
      pushed: false,
      dry_run: true,
      branch,
      reason: ref.reason,
    };
  }
  return {
    ok: true,
    pushed: false,
    dry_run: true,
    branch,
    todo: "Dry-run GitHub connection: no branch was pushed. Re-run after real GitHub setup verifies the broker-backed App installation.",
  };
}

export function pushPromotionBranchWithInstallationToken({
  cloneDir,
  owner,
  repo,
  branch,
  token,
  runGit = defaultRunGit,
} = {}) {
  if (!cloneDir) return { ok: false, reason: "promotion_workspace_required" };
  if (!owner || !repo || !branch) return { ok: false, reason: "github_push_identity_required" };
  if (!token) return { ok: false, reason: "github_installation_token_required" };
  const ref = validatePromotionBranchRef(branch);
  if (!ref.ok) return { ok: false, reason: ref.reason };

  const askpass = createGitHubInstallationTokenAskPass({ token });
  try {
    const result = runGit(
      [
        "push",
        `https://github.com/${owner}/${repo}.git`,
        `${ref.full_ref}:${ref.full_ref}`,
      ],
      {
        cwd: cloneDir,
        env: {
          ...askpass.env,
        },
      },
    );
    if (!result.ok) {
      return {
        ok: false,
        reason: "github_promotion_branch_push_failed",
        detail: result.stderr.trim() || result.stdout.trim(),
      };
    }
    return {
      ok: true,
      pushed: true,
      dry_run: false,
      branch,
      ref: ref.full_ref,
      remote: `https://github.com/${owner}/${repo}.git`,
    };
  } finally {
    askpass.cleanup();
  }
}
