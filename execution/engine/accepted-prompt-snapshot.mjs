import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { evalNamespacePaths } from "./eval-namespace.mjs";

const MODULE_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DEFAULT_EVAL_DEFINITION = Object.freeze({ eval_namespace: "execution/evals/decomposition" });

export class AcceptedPromptSnapshotError extends Error {
  constructor(reason, detail = null) {
    super(detail ? `${reason}:${detail}` : reason);
    this.name = "AcceptedPromptSnapshotError";
    this.reason = reason;
    this.code = reason;
    this.detail = detail;
  }
}

export function loadAcceptedPromptSnapshot({
  repoRoot = MODULE_REPO_ROOT,
  definition = DEFAULT_EVAL_DEFINITION,
  targetKey,
  includeHeaderInContent = false,
  failOnDrift = true,
  rejectUnsafeContent = true,
  parseContentSections = true,
} = {}) {
  if (!targetKey || typeof targetKey !== "string") {
    throw new AcceptedPromptSnapshotError("accepted_prompt_target_key_missing");
  }
  const manifestPath = path.resolve(repoRoot, evalNamespacePaths(definition).manifest);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new AcceptedPromptSnapshotError("accepted_prompt_manifest_unreadable", error.message);
  }
  const entry = (manifest.prompts || []).find((prompt) => prompt.target_key === targetKey);
  if (!entry) {
    throw new AcceptedPromptSnapshotError("accepted_prompt_manifest_entry_missing", targetKey);
  }
  const snapshotPath = resolveRepoRelativeSnapshotPath(repoRoot, entry.snapshot_path);
  let snapshotBytes;
  try {
    snapshotBytes = fs.readFileSync(snapshotPath);
  } catch (error) {
    throw new AcceptedPromptSnapshotError("accepted_prompt_snapshot_unreadable", error.message);
  }
  const snapshotSha256 = createHash("sha256").update(snapshotBytes).digest("hex");
  const expectedSha256 = entry.snapshot_sha256;
  const drift = snapshotSha256 !== expectedSha256;
  if (drift && failOnDrift) {
    throw new AcceptedPromptSnapshotError(
      "accepted_prompt_snapshot_drift",
      `snapshot ${snapshotPath} hashes to ${snapshotSha256} but phoenix-assets.json pins ${expectedSha256}`,
    );
  }
  const snapshotText = snapshotBytes.toString("utf8");
  const { header, contentText } = splitAcceptedPromptSnapshot(snapshotText);
  if (rejectUnsafeContent) assertSafeAcceptedPromptContent(contentText);
  const sections = parseContentSections ? parseAcceptedPromptContentSections(contentText) : {};
  return {
    manifest,
    entry,
    snapshotPath,
    header,
    contentBytes: includeHeaderInContent ? snapshotText : contentBytesFromSections(sections, contentText),
    sections,
    snapshotSha256,
    expectedSha256,
    drift,
  };
}

export function parseAcceptedPromptSnapshotSections(snapshotText, { rejectUnsafeContent = true } = {}) {
  if (typeof snapshotText !== "string" || snapshotText.trim() === "") {
    throw new AcceptedPromptSnapshotError("accepted_prompt_snapshot_empty");
  }
  const { header, contentText } = splitAcceptedPromptSnapshot(snapshotText);
  if (rejectUnsafeContent) assertSafeAcceptedPromptContent(contentText);
  return {
    header,
    contentText,
    sections: parseAcceptedPromptContentSections(contentText),
  };
}

function resolveRepoRelativeSnapshotPath(repoRoot, snapshotPath) {
  if (typeof snapshotPath !== "string" || snapshotPath.trim() === "") {
    throw new AcceptedPromptSnapshotError("accepted_prompt_snapshot_path_invalid", String(snapshotPath ?? ""));
  }
  const normalized = snapshotPath.replace(/\\/g, "/");
  if (
    path.isAbsolute(normalized)
    || normalized === "."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    throw new AcceptedPromptSnapshotError("accepted_prompt_snapshot_path_invalid", snapshotPath);
  }
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.resolve(resolvedRoot, normalized);
  const rootWithSeparator = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (
    resolvedPath !== resolvedRoot
    && !resolvedPath.toLowerCase().startsWith(rootWithSeparator.toLowerCase())
  ) {
    throw new AcceptedPromptSnapshotError("accepted_prompt_snapshot_path_invalid", snapshotPath);
  }
  return resolvedPath;
}

function splitAcceptedPromptSnapshot(snapshotText) {
  const match = snapshotText.match(/^(# [^\r\n]*\r?\n\r?\n```yaml\r?\n[\s\S]*?\r?\n```\r?\n)(?:\r?\n)?/);
  if (!match) {
    throw new AcceptedPromptSnapshotError("accepted_prompt_snapshot_header_invalid");
  }
  return {
    header: match[1],
    contentText: snapshotText.slice(match[0].length),
  };
}

function assertSafeAcceptedPromptContent(contentText) {
  for (const sentinel of [
    "<!-- agentic_factory_promotion:begin -->",
    "<!-- agentic_factory_promotion:end -->",
  ]) {
    if (contentText.includes(sentinel)) {
      throw new AcceptedPromptSnapshotError("accepted_prompt_snapshot_forbidden_sentinel", sentinel);
    }
  }
  if (contentText.includes("{{") || contentText.includes("}}")) {
    throw new AcceptedPromptSnapshotError("accepted_prompt_snapshot_template_placeholder");
  }
}

function parseAcceptedPromptContentSections(contentText) {
  const sections = {};
  let currentName = null;
  let currentLines = [];
  const flush = () => {
    if (!currentName) return;
    while (currentLines[0] === "") currentLines.shift();
    while (currentLines.at(-1) === "") currentLines.pop();
    sections[currentName] = currentLines.join("\n");
  };
  for (const line of contentText.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      currentName = line.slice(3).trim();
      currentLines = [];
      continue;
    }
    if (currentName) currentLines.push(line);
  }
  flush();
  return sections;
}

function contentBytesFromSections(sections, fallbackContentText) {
  const values = Object.values(sections);
  if (values.length > 0) return values.join("\n\n");
  return fallbackContentText;
}
