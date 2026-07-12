import { findTokenShapedContent } from "../linear/src/eval-content-gate.mjs";

const SECRET_PATH_SEGMENT = /^(?:\.env(?:\..+)?|credentials?(?:\..+)?|secrets?(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc)$/i;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

export async function scanStagedContent({
  runGit,
  workingDir,
  gitEnv = {},
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  if (typeof runGit !== "function") return failed("staged_guard_git_runner_missing");
  const listed = await runGit(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRTUXB"], {
    cwd: workingDir,
    env: gitEnv,
  });
  if (!listed?.ok) return failed("staged_guard_list_failed");
  const paths = String(listed.stdout || "").split("\0").filter(Boolean);
  const findings = [];
  let totalBytes = 0;

  for (const relativePath of paths) {
    const pathFinding = stagedPathFinding(relativePath);
    if (pathFinding) findings.push(pathFinding);

    const stage = await runGit(["ls-files", "--stage", "-z", "--", relativePath], {
      cwd: workingDir,
      env: gitEnv,
    });
    if (!stage?.ok) {
      findings.push({ path: relativePath, rule: "staged_metadata_unreadable" });
      continue;
    }
    const mode = String(stage.stdout || "").slice(0, 6);
    if (!REGULAR_FILE_MODES.has(mode)) {
      findings.push({ path: relativePath, rule: mode === "120000" ? "symlink" : mode === "160000" ? "gitlink" : "non_regular", mode });
      continue;
    }

    const shown = await runGit(["show", `:${relativePath}`], { cwd: workingDir, env: gitEnv });
    if (!shown?.ok) {
      findings.push({ path: relativePath, rule: "staged_blob_unreadable" });
      continue;
    }
    const content = String(shown.stdout || "");
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    if (bytes > maxFileBytes) findings.push({ path: relativePath, rule: "file_size_limit", bytes });
    if (totalBytes > maxTotalBytes) findings.push({ path: relativePath, rule: "total_size_limit", bytes: totalBytes });
    if (content.includes("\0") || content.includes("\uFFFD")) {
      findings.push({ path: relativePath, rule: "binary_or_invalid_utf8" });
      continue;
    }
    if (findTokenShapedContent(content).length > 0) {
      findings.push({ path: relativePath, rule: "token_shaped_content" });
    }
  }

  return {
    ok: findings.length === 0,
    reason: findings.length === 0 ? null : "staged_content_rejected",
    report: {
      scanned_files: paths.length,
      total_bytes: totalBytes,
      findings,
    },
  };
}

function stagedPathFinding(relativePath) {
  if (typeof relativePath !== "string" || relativePath === "" || relativePath.includes("\0")) {
    return { path: String(relativePath || ""), rule: "invalid_path" };
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    return { path: relativePath, rule: "path_escape" };
  }
  const segment = relativePath.split(/[\\/]/).find((entry) => SECRET_PATH_SEGMENT.test(entry));
  return segment ? { path: relativePath, rule: "secret_shaped_path" } : null;
}

function failed(reason) {
  return { ok: false, reason, report: { scanned_files: 0, total_bytes: 0, findings: [] } };
}
