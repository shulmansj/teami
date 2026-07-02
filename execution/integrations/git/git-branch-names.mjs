import { createHash } from "node:crypto";

export const GIT_REPO_COMMIT_BRANCH_PREFIX = "af/execution/";

export function branchNameForIssue(issueIdentifier) {
  const identifier = nonEmptyString(issueIdentifier);
  if (!identifier) throw new Error("git_repo_issue_identifier_required");
  const slug = issueIdentifierSlug(identifier);
  const shortHash = createHash("sha256").update(identifier, "utf8").digest("hex").slice(0, 8);
  const branch = `${GIT_REPO_COMMIT_BRANCH_PREFIX}${slug}-${shortHash}`;
  const validation = validateGitBranchRef(branch);
  if (!validation.ok) throw new Error(validation.reason);
  return branch;
}

export function validateGitBranchRef(ref) {
  const value = typeof ref === "string" ? ref : "";
  if (value === "" || value.trim() !== value) return invalid("git_repo_branch_invalid");
  if (value.startsWith("/") || value.endsWith("/")) return invalid("git_repo_branch_invalid");
  if (value.startsWith("refs/heads/")) return invalid("git_repo_branch_invalid");
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return invalid("git_repo_branch_invalid");
  if (value.endsWith(".") || value.endsWith(".lock")) return invalid("git_repo_branch_invalid");
  if (/[\x00-\x20\x7f~^:?*\[\\\]]/.test(value)) return invalid("git_repo_branch_invalid");
  const segments = value.split("/");
  if (segments.some((segment) =>
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.startsWith(".") ||
    segment.endsWith(".lock"))) {
    return invalid("git_repo_branch_invalid");
  }
  return { ok: true, ref: value };
}

function issueIdentifierSlug(identifier) {
  return identifier
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "issue";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function invalid(reason) {
  return { ok: false, reason };
}
