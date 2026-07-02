import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadAcceptedPromptSnapshot,
} from "../../../engine/accepted-prompt-snapshot.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

// The library-subagent accepted-prompt targets that ship as repo snapshots. The
// phase-prompt builder is retired (the orchestrator loads these bodies via the
// roster), so these tests now cover only the accepted-prompt SNAPSHOT LOADER —
// drift, manifest-entry, path-safety, and content-safety — which stays live.
const PROMPT_TARGETS = [
  "prompt/decomposition/pm_product_sufficiency_pass",
  "prompt/decomposition/sr_eng_grounding_pass",
  "prompt/decomposition/pm_synthesis",
  "prompt/decomposition/sr_eng_blocker_check",
];

test("snapshot git blob bytes hash to the manifest pins with autocrlf enabled", () => {
  const manifest = readPhoenixAssetsManifest();
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "accepted-prompt-git-"));

  execGit(["init"], tempRepo);
  execGit(["config", "core.autocrlf", "true"], tempRepo);
  execGit(["config", "user.email", "test@example.invalid"], tempRepo);
  execGit(["config", "user.name", "Accepted Prompt Test"], tempRepo);

  for (const entry of phasePromptEntries(manifest)) {
    const sourcePath = path.join(repoRoot, entry.snapshot_path);
    const destinationPath = path.join(tempRepo, entry.snapshot_path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }

  execGit(["add", "execution/evals/decomposition/accepted-prompts"], tempRepo);
  execGit(["commit", "-m", "accepted prompt snapshots"], tempRepo);

  for (const entry of phasePromptEntries(manifest)) {
    const gitBytes = execGit(["show", `HEAD:${entry.snapshot_path}`], tempRepo);
    assert.equal(sha256(gitBytes), entry.snapshot_sha256, entry.target_key);
  }
});

test("accepted prompt loader fails closed on drift, missing manifest entries, and bad paths", () => {
  const [targetKey] = phaseTargetKeys();
  const manifest = readPhoenixAssetsManifest();
  const entry = manifest.prompts.find((prompt) => prompt.target_key === targetKey);
  const originalBytes = fs.readFileSync(path.join(repoRoot, entry.snapshot_path));

  const driftRepo = writePromptFixtureRepo({
    snapshotOverrides: new Map([[entry.snapshot_path, Buffer.concat([originalBytes, Buffer.from("\nTampered.\n")])]]),
  });
  assertSnapshotError(
    () => loadAcceptedPromptSnapshot({ repoRoot: driftRepo, targetKey }),
    "accepted_prompt_snapshot_drift",
  );

  const missingEntryRepo = writePromptFixtureRepo({
    mutateManifest: (draftManifest) => {
      draftManifest.prompts = draftManifest.prompts.filter((prompt) => prompt.target_key !== targetKey);
    },
  });
  assertSnapshotError(
    () => loadAcceptedPromptSnapshot({ repoRoot: missingEntryRepo, targetKey }),
    "accepted_prompt_manifest_entry_missing",
  );

  const badPathRepo = writePromptFixtureRepo({
    mutateManifest: (draftManifest) => {
      const draftEntry = draftManifest.prompts.find((prompt) => prompt.target_key === targetKey);
      draftEntry.snapshot_path = "../outside.md";
      draftEntry.snapshot_sha256 = sha256(Buffer.from("outside"));
    },
  });
  assertSnapshotError(
    () => loadAcceptedPromptSnapshot({ repoRoot: badPathRepo, targetKey }),
    "accepted_prompt_snapshot_path_invalid",
  );
});

test("accepted prompt loader rejects promotion sentinels and template placeholders in content", () => {
  const [targetKey] = phaseTargetKeys();
  const manifest = readPhoenixAssetsManifest();
  const entry = manifest.prompts.find((prompt) => prompt.target_key === targetKey);
  const originalText = fs.readFileSync(path.join(repoRoot, entry.snapshot_path), "utf8");

  for (const [suffix, expectedReason] of [
    ["\n<!-- teami_promotion:begin -->\n", "accepted_prompt_snapshot_forbidden_sentinel"],
    ["\n{{candidate_prompt_body}}\n", "accepted_prompt_snapshot_template_placeholder"],
  ]) {
    const unsafeBytes = Buffer.from(`${originalText}${suffix}`, "utf8");
    const unsafeRepo = writePromptFixtureRepo({
      snapshotOverrides: new Map([[entry.snapshot_path, unsafeBytes]]),
      mutateManifest: (draftManifest) => {
        const draftEntry = draftManifest.prompts.find((prompt) => prompt.target_key === targetKey);
        draftEntry.snapshot_sha256 = sha256(unsafeBytes);
      },
    });
    assertSnapshotError(
      () => loadAcceptedPromptSnapshot({ repoRoot: unsafeRepo, targetKey }),
      expectedReason,
    );
  }
});

test("accepted prompt loader parses the yaml header away from the prompt body", () => {
  for (const targetKey of PROMPT_TARGETS) {
    const snapshot = loadAcceptedPromptSnapshot({ repoRoot, targetKey });
    assert.match(snapshot.header, /^# Accepted /);
    assert.match(snapshot.header, /prompt_version: unpinned-initial/);
    // The loaded BODY (what the orchestrator hands a library subagent) carries
    // none of the snapshot header / yaml front-matter.
    assert.doesNotMatch(snapshot.contentBytes, /^# Accepted /m, targetKey);
    assert.doesNotMatch(snapshot.contentBytes, /prompt_version: unpinned-initial/, targetKey);
    assert.doesNotMatch(snapshot.contentBytes, /```yaml/, targetKey);
    assert.doesNotMatch(snapshot.contentBytes, /target_key: prompt\/decomposition\//, targetKey);
  }
});

function readPhoenixAssetsManifest(root = repoRoot) {
  return JSON.parse(
    fs.readFileSync(path.join(root, "execution", "evals", "decomposition", "phoenix-assets.json"), "utf8"),
  );
}

function phaseTargetKeys() {
  return [...PROMPT_TARGETS];
}

function phasePromptEntries(manifest = readPhoenixAssetsManifest()) {
  return phaseTargetKeys().map((targetKey) => {
    const entry = manifest.prompts.find((prompt) => prompt.target_key === targetKey);
    assert.ok(entry, `missing manifest entry for ${targetKey}`);
    return entry;
  });
}

function writePromptFixtureRepo({
  mutateManifest = () => {},
  snapshotOverrides = new Map(),
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "accepted-prompt-loader-"));
  const manifest = readPhoenixAssetsManifest();
  mutateManifest(manifest);

  const manifestPath = path.join(tempRoot, "execution", "evals", "decomposition", "phoenix-assets.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const targetKey of phaseTargetKeys()) {
    const entry = manifest.prompts.find((prompt) => prompt.target_key === targetKey);
    if (!entry || !isSafeRelativePath(entry.snapshot_path)) continue;
    const sourcePath = path.join(repoRoot, entry.snapshot_path);
    const destinationPath = path.join(tempRoot, entry.snapshot_path);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const bytes = snapshotOverrides.get(entry.snapshot_path) ?? fs.readFileSync(sourcePath);
    fs.writeFileSync(destinationPath, bytes);
  }
  return tempRoot;
}

function isSafeRelativePath(candidate) {
  return typeof candidate === "string"
    && candidate.trim() !== ""
    && !path.isAbsolute(candidate)
    && !candidate.replace(/\\/g, "/").startsWith("../")
    && !candidate.replace(/\\/g, "/").includes("/../");
}

function assertSnapshotError(fn, expectedReason) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error?.code, expectedReason);
      assert.equal(error?.reason, expectedReason);
      return true;
    },
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function execGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
