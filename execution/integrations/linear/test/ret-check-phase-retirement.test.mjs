import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadLinearConfig } from "../src/config.mjs";
import { resolveRoleRuntimeAssignments } from "../src/runtime-adapters.mjs";

// ---------------------------------------------------------------------------
// RET-CHECK gate (Seam 5 of the agent-driven-orchestrator breakdown).
//
// Proves that no MISLEADING phase-machinery vocabulary silently survives the
// retirement of the deterministic phase router. It scans the decomposition
// PATH SET for the three machinery-token sets enumerated in Seam 5 and asserts
// ZERO un-sentineled hits BEYOND an explicit baseline allowlist of the current
// (pre-retirement) survivors.
//
// Lifecycle:
//   - TODAY (pre-retirement) the tree is full of these tokens, so the baseline
//     is seeded with every current un-sentineled hit and the gate is GREEN.
//   - When a NEW un-sentineled machinery token is introduced (not in the
//     baseline, not carrying the sentinel), the gate goes RED.
//   - Later issues delete dead survivors; each deletion lets the
//     matching baseline entry fall out (reported by the staleness diagnostic,
//     never fatal). The baseline is driven toward the honest floor: remaining
//     live resume vocabulary, live offline checks, and legacy-artifact reads.
//
// Conventions honored:
//   - A line carrying the literal "PHASE-SURVIVOR(<reason>)" sentinel is a
//     deliberate, allowed survivor and is NOT counted as a hit.
//   - This gate FILE excludes ITSELF from its own scan (its token list and the
//     sentinel string would otherwise self-trip).
//   - The bare-word \bphase\b grep is ADVISORY only (it misses snake/camel
//     compounds like phase_packets); the token sets below are the real gate.
// ---------------------------------------------------------------------------

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..", "..");
const DEFAULT_LINEAR_CONFIG_PATH = path.join(
  "execution",
  "integrations",
  "linear",
  "config.example.json",
);
const SUBAGENT_RUNTIME_SCHEMA_PATHS = new Set([
  path.resolve(
    REPO_ROOT,
    "execution",
    "integrations",
    "linear",
    "schemas",
    "subagent-turn.schema.json",
  ),
  path.resolve(
    REPO_ROOT,
    "execution",
    "integrations",
    "linear",
    "schemas",
    "subagent-turn.strict-generation.schema.json",
  ),
]);
const RETIRED_PHASE_SCHEMA_BASENAME = `${["phase", "packet"].join("-")}.schema.json`;

function toRepoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

function assertSubagentSchemaPath(value, label) {
  assert.equal(typeof value, "string", `${label} must be a schema path`);
  const resolved = path.resolve(REPO_ROOT, value);
  assert.equal(
    resolved.includes(RETIRED_PHASE_SCHEMA_BASENAME),
    false,
    `${label} must not point at ${RETIRED_PHASE_SCHEMA_BASENAME}`,
  );
  assert.ok(
    SUBAGENT_RUNTIME_SCHEMA_PATHS.has(resolved),
    `${label} must resolve to a subagent-turn schema, got ${value}`,
  );
}

// The literal sentinel marking a deliberately-retained phase token. Built by
// concatenation so this very line is not itself a sentinel.
const SENTINEL = ["PHASE", "SURVIVOR"].join("-");

// This gate file's own repo-relative path, excluded from the scan so its token
// regexes + sentinel literal do not self-trip.
const SELF_RELPATH = toRepoRelative(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Token sets (Seam 5) -- three INDEPENDENTLY-ASSERTABLE groups.
//
// Each token is a regex. Compounds use explicit alternation; the trailing "*"
// in the spec (buildRuntimePhasePrompt*) is a prefix match. Word boundaries
// keep identifier tokens from matching inside unrelated longer identifiers,
// while the hyphenated/underscored compounds are matched literally.
// ---------------------------------------------------------------------------

const TOKEN_SET_A_ROUTER = [
  { name: "PHASE_OUTCOMES", regex: /\bPHASE_OUTCOMES\b/ },
  { name: "selectNextOrchestrationPhase", regex: /\bselectNextOrchestrationPhase\b/ },
  { name: "roleForPhase", regex: /\broleForPhase\b/ },
  { name: "terminalDecisionForPackets", regex: /\bterminalDecisionForPackets\b/ },
  { name: "runDecompositionPhases", regex: /\brunDecompositionPhases\b/ },
  { name: "legacyPhasePacketCompatibility", regex: /\blegacyPhasePacketCompatibility\b/ },
  { name: "isAllowedPhaseOutcome", regex: /\bisAllowedPhaseOutcome\b/ },
  { name: "ACCEPTED_PHASE_PROMPT_TARGET_KEYS", regex: /\bACCEPTED_PHASE_PROMPT_TARGET_KEYS\b/ },
];

const TOKEN_SET_B_RUNTIME_PROMPT_AND_SCHEMA = [
  { name: "DECOMPOSITION_PHASES", regex: /\bDECOMPOSITION_PHASES\b/ },
  { name: "RUNTIME_PHASE_PROMPT_REQUIRED_SECTIONS", regex: /\bRUNTIME_PHASE_PROMPT_REQUIRED_SECTIONS\b/ },
  // buildRuntimePhasePrompt* -- prefix match (buildRuntimePhasePrompt,
  // buildRuntimePhasePromptSections, ...).
  { name: "buildRuntimePhasePrompt*", regex: /\bbuildRuntimePhasePrompt[A-Za-z0-9_]*/ },
  { name: "runtimePromptSectionsForPhase", regex: /\bruntimePromptSectionsForPhase\b/ },
  { name: "PHASE_PACKET_SCHEMA_VERSION", regex: /\bPHASE_PACKET_SCHEMA_VERSION\b/ },
  // phase-packet -- the hyphenated module/schema token (import specifiers,
  // schema $id refs, prose). Hyphen is a non-word char so no \b on the right.
  { name: "phase-packet", regex: /phase-packet/ },
];

const TOKEN_SET_C_PACKET_FLOW = [
  { name: "phase_packets", regex: /\bphase_packets\b/ },
  { name: "phasePackets", regex: /\bphasePackets\b/ },
  { name: "accepted_packets", regex: /\baccepted_packets\b/ },
  { name: "acceptedPackets", regex: /\bacceptedPackets\b/ },
  { name: "validatePhasePacketContract", regex: /\bvalidatePhasePacketContract\b/ },
  { name: "canonicalPhasePacketSchema", regex: /\bcanonicalPhasePacketSchema\b/ },
  { name: "parseAndValidateRuntimePacketOutput", regex: /\bparseAndValidateRuntimePacketOutput\b/ },
  { name: "evaluateAcceptedPacketSufficiencyOffline", regex: /\bevaluateAcceptedPacketSufficiencyOffline\b/ },
  { name: "missing_phase_packets", regex: /\bmissing_phase_packets\b/ },
];

const TOKEN_SETS = {
  "set-a-router": TOKEN_SET_A_ROUTER,
  "set-b-runtime-prompt-and-schema": TOKEN_SET_B_RUNTIME_PROMPT_AND_SCHEMA,
  "set-c-packet-flow": TOKEN_SET_C_PACKET_FLOW,
};

// Flat list of every machinery token (all three sets) for the inventory sweep.
const ALL_TOKENS = Object.values(TOKEN_SETS).flat();

// ---------------------------------------------------------------------------
// Path set (Seam 5, EXPANDED to all plan section 5a(d) surfaces).
//
// Resolved relative to the repo root (derived from import.meta.url) so the
// scan works regardless of cwd. We recurse the four roots below. The explicit
// roots cover everything Seam 5 enumerates:
//   - execution/integrations/linear/src  (incl. promotion/ read-model +
//     materializer/drafter, cli/, workflows/decomposition/, and
//     deterministic-check-emission.mjs)
//   - execution/integrations/linear/schemas  (the phase-packet schema files)
//   - execution/evals/decomposition  (incl. failure-taxonomy.json, the
//     accepted-prompt snapshots + prompt text, phoenix-assets.json, fixtures)
//   - execution/integrations/linear/test  (the decomposition tests + fixtures;
//     the gate file itself is excluded via SELF_RELPATH)
//
// We scan source/text/data files only. node_modules and VCS dirs are skipped.
// ---------------------------------------------------------------------------

const PATH_SET_ROOTS = [
  "execution/engine",
  "execution/integrations/linear/src",
  "execution/integrations/linear/schemas",
  "execution/evals/decomposition",
  "execution/integrations/linear/test",
];

const SCANNED_EXTENSIONS = new Set([".mjs", ".cjs", ".js", ".json", ".md"]);

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

function listScannableFiles() {
  const files = [];
  for (const root of PATH_SET_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    if (!fs.existsSync(absRoot)) {
      continue;
    }
    walk(absRoot, files);
  }
  // Stable ordering for deterministic dumps + messages.
  return files.sort();
}

function walk(absDir, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      walk(path.join(absDir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }
    const rel = toRepoRelative(path.join(absDir, entry.name));
    if (rel === SELF_RELPATH) {
      continue; // the gate file excludes itself from its own scan.
    }
    out.push(path.join(absDir, entry.name));
  }
}

// A hit is keyed by file + token + the trimmed matched line text. This key is
// line-number-INDEPENDENT (so unrelated edits above a survivor do not churn the
// baseline) yet unique enough to identify the survivor, and it disappears
// cleanly when a later issue deletes the line -- making the baseline easy to
// shrink toward empty. The KEY_SEP separator cannot collide with a repo path or
// a token name, so the key round-trips for the diagnostic.
//
// The gate counts OCCURRENCES per key rather than collapsing them to set
// membership: two textually-identical survivors of the same token in the same
// file share a key, so a NEW such duplicate would be invisible to a membership
// test. Counting (current > baseline) catches it. The baseline therefore lists
// each survivor with its true multiplicity (re-seed via RET_CHECK_DUMP=1).
const KEY_SEP = " ::: ";

function hitKey(relpath, tokenName, lineText) {
  const parts = [relpath, tokenName, lineText.trim()];
  return parts.join(KEY_SEP);
}

// Scan the path set for a given list of tokens. Returns a Map<key, entry> where
// entry = { count, relpath, token, line, text }: count is the number of
// un-sentineled occurrences of that key across the tree; the line/text fields
// are a representative (first-seen) occurrence for diagnostics. Lines carrying
// the sentinel are skipped (deliberate survivors).
function scanTokens(tokens) {
  const hits = new Map();
  for (const absFile of listScannableFiles()) {
    const rel = toRepoRelative(absFile);
    const lines = fs.readFileSync(absFile, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.includes(SENTINEL)) {
        continue; // deliberate survivor -- not a hit.
      }
      for (const token of tokens) {
        if (token.regex.test(line)) {
          const key = hitKey(rel, token.name, line);
          const existing = hits.get(key);
          if (existing) {
            existing.count += 1; // another occurrence of the same survivor.
          } else {
            hits.set(key, { count: 1, relpath: rel, token: token.name, line: i + 1, text: line.trim() });
          }
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Baseline allowlist -- the CURRENT (pre-retirement) un-sentineled survivors.
//
// Keyed by `${relpath}${KEY_SEP}${token}${KEY_SEP}${trimmedLine}` (see hitKey).
// Generated by running this file once with RET_CHECK_DUMP=1 against the
// pre-retirement tree (see the dump block at the bottom). It is a plain data
// array so later issues can delete lines from the scanned files and let the
// matching entries here fall out (stale entries are reported by the staleness
// diagnostic, never fatal).
//
// MULTIPLICITY MATTERS: a key that occurs N times in the tree appears N times
// in this array. The gate sanctions exactly that many occurrences; an (N+1)th
// textually-identical survivor trips the gate as a NEW occurrence. The dump
// mode emits each key with the right multiplicity, so always re-seed via it.
//
// SHRINK ME: delete only genuinely dead phase-machinery survivors. The honest
// floor is not empty while live resume vocabulary, live offline checks, and
// legacy-artifact reads still carry their persisted/wire-format names.
//
// AUDITED 2026-06-22 (F2-followup #4): the staleness diagnostic reports 0 stale
// entries — every allowlisted occurrence is still present in the tree, so this is
// a DELIBERATE floor of live tokens, not removed-token cruft. The hygiene test
// below prints the floor's composition by reason (wire-format schema /
// legacy-artifact construction in tests / live code / accepted-asset prose) so the
// list is auditable rather than opaque. Genuinely shrinking it now would mean
// removing live functionality or rewriting accepted assets — out of scope here.
// ---------------------------------------------------------------------------

const BASELINE_ALLOWLIST = [
  "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md ::: phase-packet ::: 6. Relevant phase-packet summaries.",
  "execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md ::: phase-packet ::: present, phase-packet summaries, and the rubric and failure taxonomy versions",
  "execution/evals/decomposition/example.schema.json ::: phase_packets ::: \"phase_packets\",",
  "execution/evals/decomposition/example.schema.json ::: phase_packets ::: \"phase_packets\": { \"type\": \"array\" },",
  "execution/evals/decomposition/phoenix-assets.json ::: evaluateAcceptedPacketSufficiencyOffline ::: \"code_path\": \"execution/integrations/linear/src/quality.mjs#evaluateAcceptedPacketSufficiencyOffline\"",
  "execution/integrations/linear/schemas/phase-packet.schema.json ::: phase-packet ::: \"$id\": \"linear-decomposition-phase-packet/v1\",",
  "execution/integrations/linear/schemas/phase-packet.schema.json ::: phase-packet ::: \"const\": \"linear-decomposition-phase-packet/v1\"",
  "execution/integrations/linear/schemas/phase-packet.strict-generation.schema.json ::: phase-packet ::: \"$id\": \"linear-decomposition-phase-packet/strict-generation/v1\",",
  "execution/integrations/linear/schemas/phase-packet.strict-generation.schema.json ::: phase-packet ::: \"const\": \"linear-decomposition-phase-packet/v1\"",
  "execution/integrations/linear/src/cli/dispatch.mjs ::: accepted_packets ::: [\"Accepted packets\", describeAcceptedPackets(result.accepted_packets)],",
  "execution/integrations/linear/src/decomposition-quality-judge.mjs ::: phase_packets ::: || (artifact.phase_packets || []).findLast((packet) => packet?.status === \"pause\");",
  "execution/integrations/linear/src/decomposition-quality-judge.mjs ::: phase_packets ::: return (artifact.phase_packets || []).map((packet) => ({",
  "execution/integrations/linear/src/decomposition-quality-judge.mjs ::: phase-packet ::: // Open Questions prose, phase-packet summaries, rubric/taxonomy versions.",
  "execution/integrations/linear/src/deterministic-check-emission.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline,",
  "execution/integrations/linear/src/deterministic-check-emission.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline(checkInputs.accepted_packet_sufficiency),",
  "execution/integrations/linear/src/deterministic-check-emission.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline(acceptedPacketSufficiencyInput),",
  "execution/integrations/linear/src/deterministic-check-emission.mjs ::: phase_packets ::: if (![\"commit\", \"pause\"].includes(artifact?.kind) && Array.isArray(artifact?.phase_packets)) {",
  "execution/integrations/linear/src/deterministic-check-emission.mjs ::: phase_packets ::: return { phasePackets: artifact.phase_packets };",
  "execution/integrations/linear/src/deterministic-check-emission.mjs ::: phasePackets ::: return { phasePackets: artifact.phase_packets };",
  "execution/integrations/linear/src/eval-content-gate.mjs ::: phase_packets ::: phase_packets: { array: phasePacketSummaryPolicy },",
  "execution/integrations/linear/src/eval-content-gate.mjs ::: phase-packet ::: // phase-packet summaries, final issue bodies, dependency summaries, authored",
  "execution/integrations/linear/src/eval-status.mjs ::: phase_packets ::: const packets = Array.isArray(artifact.phase_packets) ? artifact.phase_packets : [];",
  "execution/integrations/linear/src/phase-contract.mjs ::: PHASE_PACKET_SCHEMA_VERSION ::: export const PHASE_PACKET_SCHEMA_VERSION = \"linear-decomposition-phase-packet/v1\";",
  "execution/integrations/linear/src/phase-contract.mjs ::: PHASE_PACKET_SCHEMA_VERSION ::: if (packet.schema_version !== PHASE_PACKET_SCHEMA_VERSION) {",
  "execution/integrations/linear/src/phase-contract.mjs ::: phase-packet ::: export const PHASE_PACKET_SCHEMA_VERSION = \"linear-decomposition-phase-packet/v1\";",
  "execution/integrations/linear/src/quality.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: // evaluateAcceptedPacketSufficiencyOffline",
  "execution/integrations/linear/src/quality.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: export function evaluateAcceptedPacketSufficiencyOffline({",
  "execution/integrations/linear/src/quality.mjs ::: phasePackets ::: phasePackets = [],",
  "execution/integrations/linear/src/quality.mjs ::: phasePackets ::: collectPhasePacketSufficiencyFailures(phasePackets, failureModes);",
  "execution/integrations/linear/src/quality.mjs ::: phasePackets ::: const packetCount = Array.isArray(phasePackets) ? phasePackets.length : 0;",
  "execution/integrations/linear/src/quality.mjs ::: phasePackets ::: function collectPhasePacketSufficiencyFailures(phasePackets, failureModes) {",
  "execution/integrations/linear/src/quality.mjs ::: phasePackets ::: for (const packet of phasePackets || []) {",
  "execution/integrations/linear/src/rich-promotion.mjs ::: phase_packets ::: phase_packets: [terminalOutputSummary(artifact, terminal)],",
  "execution/integrations/linear/src/runtime-adapters.mjs ::: acceptedPackets ::: acceptedPackets,",
  "execution/integrations/linear/src/runtime-adapters.mjs ::: acceptedPackets ::: for (const packet of acceptedPackets || []) {",
  "execution/integrations/linear/src/runtime-adapters.mjs ::: parseAndValidateRuntimePacketOutput ::: export function parseAndValidateRuntimePacketOutput(output, { runId } = {}) {",
  "execution/integrations/linear/src/runtime-adapters.mjs ::: phase-packet ::: \"phase-packet.schema.json\",",
  "execution/integrations/linear/src/runtime-adapters.mjs ::: phase-packet ::: // wrapper: the same unwrapping rules phase-packet parsing uses (raw JSON,",
  "execution/engine/trace-contract.mjs ::: phase_packets ::: \"phase_packets\",",
  "execution/integrations/linear/src/workflows/decomposition/artifacts.mjs ::: acceptedPackets ::: acceptedPackets: runtimeEvidencePackets,",
  "execution/integrations/linear/src/workflows/decomposition/definition.mjs ::: PHASE_PACKET_SCHEMA_VERSION ::: PHASE_PACKET_SCHEMA_VERSION,",
  "execution/integrations/linear/src/workflows/decomposition/definition.mjs ::: PHASE_PACKET_SCHEMA_VERSION ::: schema_version: PHASE_PACKET_SCHEMA_VERSION,",
  "execution/integrations/linear/src/workflows/decomposition/definition.mjs ::: phase-packet ::: \"execution/integrations/linear/schemas/phase-packet.schema.json\",",
  "execution/integrations/linear/src/workflows/decomposition/definition.mjs ::: phase-packet ::: \"execution/integrations/linear/schemas/phase-packet.strict-generation.schema.json\",",
  "execution/integrations/linear/src/workflows/decomposition/run-service.mjs ::: acceptedPackets ::: acceptedPackets: [packet],",
  "execution/integrations/linear/test/decomposition-eval-cli.test.mjs ::: phase_packets ::: phase_packets: [],",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: accepted_packets ::: accepted_packets: badRunArtifact().phase_packets,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: acceptedPackets ::: const acceptedPackets = evaluateAcceptedPacketSufficiencyOffline({",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: acceptedPackets ::: name: acceptedPackets.name,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: acceptedPackets ::: identifier: acceptedPackets.identifier,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: acceptedPackets ::: annotation: acceptedPackets,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: const acceptedPackets = evaluateAcceptedPacketSufficiencyOffline({",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: phase_packets ::: phase_packets: phasePackets,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: phase_packets ::: phasePackets: badRunArtifact().phase_packets,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: phase_packets ::: accepted_packets: badRunArtifact().phase_packets,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: phase-packet ::: \"schema_version must be exactly `linear-decomposition-phase-packet/v1`.\",",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: phase-packet ::: schema_version: \"linear-decomposition-phase-packet/v1\",",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: phasePackets ::: const phasePackets = [",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: phasePackets ::: phase_packets: phasePackets,",
  "execution/integrations/linear/test/decomposition-eval-loop-e2e.test.mjs ::: phasePackets ::: phasePackets: badRunArtifact().phase_packets,",
  "execution/integrations/linear/test/decomposition-quality-judge.test.mjs ::: phase_packets ::: phase_packets: [{",
  "execution/integrations/linear/test/decomposition-quality-judge.test.mjs ::: phase-packet ::: schema_version: \"linear-decomposition-phase-packet/v1\",",
  "execution/integrations/linear/test/decomposition-quality-judge.test.mjs ::: phase-packet ::: schema_version: \"linear-decomposition-phase-packet/v1\",",
  "execution/integrations/linear/test/deterministic-check-emission.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline,",
  "execution/integrations/linear/test/deterministic-check-emission.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline({ phasePackets: [] }),",
  "execution/integrations/linear/test/deterministic-check-emission.test.mjs ::: phase_packets ::: artifact.phase_packets = [{",
  "execution/integrations/linear/test/deterministic-check-emission.test.mjs ::: phase_packets ::: phase_packets: [{",
  "execution/integrations/linear/test/deterministic-check-emission.test.mjs ::: phasePackets ::: evaluateAcceptedPacketSufficiencyOffline({ phasePackets: [] }),",
  "execution/integrations/linear/test/eval-contracts.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline,",
  "execution/integrations/linear/test/eval-contracts.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: const failingSufficiency = evaluateAcceptedPacketSufficiencyOffline({ terminalOutput: null });",
  "execution/integrations/linear/test/eval-contracts.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: const parameterizedSufficiency = evaluateAcceptedPacketSufficiencyOffline({",
  "execution/integrations/linear/test/eval-contracts.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: const terminalOutputSufficiency = evaluateAcceptedPacketSufficiencyOffline({",
  "execution/integrations/linear/test/eval-contracts.test.mjs ::: phase-packet ::: \"phase-packet\",",
  "execution/integrations/linear/test/eval-contracts.test.mjs ::: phasePackets ::: phasePackets: [",
  "execution/integrations/linear/test/eval-worklist.test.mjs ::: phase_packets ::: phase_packets: phasePackets,",
  "execution/integrations/linear/test/eval-worklist.test.mjs ::: phasePackets ::: function writeRunArtifactFile(repoRoot, { runId, kind = \"commit\", phasePackets = [] }) {",
  "execution/integrations/linear/test/eval-worklist.test.mjs ::: phasePackets ::: phase_packets: phasePackets,",
  "execution/integrations/linear/test/eval-worklist.test.mjs ::: phasePackets ::: phasePackets: [{ phase: \"pm_product_sufficiency\", status: \"pause\", open_questions_markdown: \"- pricing?\" }],",
  "execution/integrations/linear/test/fixtures/eval-contracts/decomposition-example.invalid-banned-workflow-state-metadata.json ::: phase_packets ::: \"phase_packets\": [],",
  "execution/integrations/linear/test/fixtures/eval-contracts/decomposition-example.invalid-missing-rubric-version.json ::: phase_packets ::: \"phase_packets\": [],",
  "execution/integrations/linear/test/fixtures/eval-contracts/decomposition-example.invalid-terminal-status.json ::: phase_packets ::: \"phase_packets\": [],",
  "execution/integrations/linear/test/fixtures/eval-contracts/decomposition-example.valid.json ::: phase_packets ::: \"phase_packets\": [],",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline,",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: const offline = evaluateAcceptedPacketSufficiencyOffline({",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: evaluateAcceptedPacketSufficiencyOffline ::: evaluateAcceptedPacketSufficiencyOffline({",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: parseAndValidateRuntimePacketOutput,",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: parseAndValidateRuntimePacketOutput(JSON.stringify(pmContinue(\"run-runtime-output\")), {",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: parseAndValidateRuntimePacketOutput(",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: parseAndValidateRuntimePacketOutput(",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: parseAndValidateRuntimePacketOutput(",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: parseAndValidateRuntimePacketOutput(",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: parseAndValidateRuntimePacketOutput(",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: parseAndValidateRuntimePacketOutput(",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: parseAndValidateRuntimePacketOutput ::: assert.throws(() => parseAndValidateRuntimePacketOutput(\"not json\"), /invalid JSON output/);",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: PHASE_PACKET_SCHEMA_VERSION ::: PHASE_PACKET_SCHEMA_VERSION,",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: PHASE_PACKET_SCHEMA_VERSION ::: assert.equal(canonicalRuntimeSchema().$id, PHASE_PACKET_SCHEMA_VERSION);",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: PHASE_PACKET_SCHEMA_VERSION ::: schema_version: PHASE_PACKET_SCHEMA_VERSION,",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: phase_packets ::: phase_packets: [pmContinue(\"run-checkpoint-only\")],",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: phase_packets ::: phase_packets: [pmContinue(\"run-atomic\")],",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: phase_packets ::: phase_packets: [pmContinue(\"run-team-artifact\")],",
  "execution/integrations/linear/test/linear-workflow.test.mjs ::: phase-packet ::: path.join(repoRoot, \"execution/integrations/linear/schemas/phase-packet.schema.json\"),",
  "execution/integrations/linear/test/phoenix-experiment.test.mjs ::: accepted_packets ::: accepted_packets: [{}, {}, {}, {}],",
  "execution/integrations/linear/test/phoenix-experiment.test.mjs ::: phase_packets ::: phase_packets: [],",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: phase_packets: [{",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: \"$.output.phase_packets[0].prompt\",",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: \"$.output.phase_packets[0].tool_transcript\",",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: \"$.output.phase_packets[0].shell_output\",",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: \"$.output.phase_packets[0].repo_snippet\",",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: \"$.output.phase_packets[0].source_refs\",",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: \"$.output.phase_packets[0].source_refs\",",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: assert.equal(removedRules.get(\"$.output.phase_packets[0].prompt\"), \"prompt_content\");",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: assert.equal(removedRules.get(\"$.output.phase_packets[0].shell_output\"), \"shell_output\");",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: assert.equal(removedRules.get(\"$.output.phase_packets[0].source_refs\"), \"source_refs_not_promoted\");",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: const sanitizedPacket = result.value.output.phase_packets[0];",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: entry.rule === \"private_url_redacted\" && entry.path === \"$.output.phase_packets[0].project_update_markdown\"));",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: phase_packets: [terminalOutputSummary()],",
  "execution/integrations/linear/test/rich-promotion.test.mjs ::: phase_packets ::: phase_packets: [{ prompt: \"raw prompt\" }],",
  // DECOMP-FACADE golden captures of the live decomposition phase-PACKET wire-format
  // schemas (a kept survivor — the per-turn packet protocol, NOT retired phase-router machinery):
  "execution/integrations/linear/test/decomp-facade-golden.test.mjs ::: phase-packet ::: \"phase-packet.schema.json\",",
  "execution/integrations/linear/test/decomp-facade-golden.test.mjs ::: phase-packet ::: \"phase-packet.strict-generation.schema.json\",",
  "execution/integrations/linear/test/decomp-facade-golden.test.mjs ::: phase-packet ::: \"execution/integrations/linear/schemas/phase-packet.schema.json\",",
  "execution/integrations/linear/test/decomp-facade-golden.test.mjs ::: phase-packet ::: \"execution/integrations/linear/schemas/phase-packet.strict-generation.schema.json\",",
  "execution/integrations/linear/test/fixtures/decomp-facade/schemas/phase-packet.schema.json ::: phase-packet ::: \"$id\": \"linear-decomposition-phase-packet/v1\",",
  "execution/integrations/linear/test/fixtures/decomp-facade/schemas/phase-packet.schema.json ::: phase-packet ::: \"const\": \"linear-decomposition-phase-packet/v1\"",
  "execution/integrations/linear/test/fixtures/decomp-facade/schemas/phase-packet.strict-generation.schema.json ::: phase-packet ::: \"$id\": \"linear-decomposition-phase-packet/strict-generation/v1\",",
  "execution/integrations/linear/test/fixtures/decomp-facade/schemas/phase-packet.strict-generation.schema.json ::: phase-packet ::: \"const\": \"linear-decomposition-phase-packet/v1\"",
  // EXEC-ENTRY: the execution run path builds accepted packets from runtime evidence,
  // mirroring decomposition's accepted-packet flow (a kept survivor, not retired machinery).
  "execution/integrations/linear/src/trigger-runner.mjs ::: acceptedPackets ::: acceptedPackets: runtimeEvidencePackets,",
  // RV-5: the review run path mirrors the SAME kept accepted-packet flow when assembling its
  // own REVIEW_*-versioned run artifact (a second genuine current survivor, not new machinery).
  "execution/integrations/linear/src/trigger-runner.mjs ::: acceptedPackets ::: acceptedPackets: runtimeEvidencePackets,",
];

// Occurrence counts per key: how many times each survivor key is sanctioned by
// the baseline. Built by tallying duplicate strings in BASELINE_ALLOWLIST so a
// key listed N times sanctions N occurrences in the tree.
const baselineCounts = new Map();
for (const key of BASELINE_ALLOWLIST) {
  baselineCounts.set(key, (baselineCounts.get(key) || 0) + 1);
}

// Why an allowlisted token legitimately survives, derived from its file. Used by
// the hygiene diagnostic to print the floor's composition (auditable, not opaque).
function survivorReason(relpath) {
  if (relpath.includes("/schemas/")) return "live phase-packet/v1 wire-format schema ($id/const)";
  if (relpath.includes("/accepted-prompts/")) return "accepted-asset prose (judge prompt text)";
  if (relpath.includes("/fixtures/") || relpath.endsWith(".test.mjs")) {
    return "test/fixture: legacy-artifact construction + legacy-read coverage";
  }
  if (relpath.includes("/evals/")) return "eval manifest/example schema (legacy fields)";
  if (relpath.endsWith(".mjs")) return "live code: legacy-artifact read / offline check / wire handling";
  return "other";
}

// ---------------------------------------------------------------------------
// The gate: one sub-test per token set. Each asserts that no token in the set
// has an un-sentineled hit OUTSIDE the baseline allowlist.
// ---------------------------------------------------------------------------

// A token set FAILS only when some key's CURRENT occurrence count EXCEEDS the
// baseline-sanctioned count (a NEW occurrence beyond what the baseline allowed,
// including a brand-new key whose baseline count is 0, or an extra copy of an
// already-allowlisted line). current < baseline (a deletion) is NON-fatal --
// surfaced by the staleness diagnostic so deletions only make the gate greener.
function newHitsForSet(tokens) {
  const offenders = [];
  for (const [key, entry] of scanTokens(tokens)) {
    const baseline = baselineCounts.get(key) || 0;
    if (entry.count > baseline) {
      offenders.push({ ...entry, newCount: entry.count - baseline });
    }
  }
  offenders.sort((a, b) =>
    (a.relpath === b.relpath ? a.line - b.line : a.relpath.localeCompare(b.relpath)));
  return offenders;
}

function formatOffenders(offenders) {
  return offenders
    .map((h) => [
      "  ", h.relpath, ":", h.line, "  [", h.token, "]  (+", h.newCount,
      " new occurrence", h.newCount === 1 ? "" : "s", ")  ", h.text,
    ].join(""))
    .join("\n");
}

for (const [setName, tokens] of Object.entries(TOKEN_SETS)) {
  test(`RET-CHECK ${setName}: no NEW un-sentineled phase-machinery tokens`, () => {
    const offenders = newHitsForSet(tokens);
    const message = offenders.length === 0
      ? ""
      : [
        `New un-sentineled phase-machinery token(s) introduced in ${setName}.`,
        `Either retire them, mark a deliberate survivor with`,
        `// ${SENTINEL}(<reason>), or -- only if it is a genuine current`,
        `survivor -- add the hit to BASELINE_ALLOWLIST:`,
        formatOffenders(offenders),
      ].join("\n");
    assert.equal(offenders.length, 0, message);
  });
}

test("RET-CHECK subagent runtime defaults resolve to subagent-turn schemas", () => {
  const config = loadLinearConfig({
    repoRoot: REPO_ROOT,
    configPath: DEFAULT_LINEAR_CONFIG_PATH,
  });
  const assignments = resolveRoleRuntimeAssignments(config, "decomposition");

  for (const role of ["pm", "sr_eng"]) {
    assertSubagentSchemaPath(assignments[role]?.schema_path, `${role}.schema_path`);
    assertSubagentSchemaPath(
      assignments[role]?.generation_schema_path,
      `${role}.generation_schema_path`,
    );
  }
});

// ---------------------------------------------------------------------------
// Baseline hygiene (non-fatal diagnostics):
//   1. Staleness: baseline-sanctioned occurrences that no longer exist (a
//      survivor was deleted/sentineled, in whole or in part -- current count
//      below baseline count). These should be pruned from BASELINE_ALLOWLIST,
//      but staleness is NEVER a failure -- deleting a survivor must make the
//      gate greener, not red.
//   2. Advisory \bphase\b inventory: a coarse count of bare "phase" word
//      occurrences across the path set. ADVISORY only (misses snake/camel
//      compounds) -- printed, never asserted.
// ---------------------------------------------------------------------------

test("RET-CHECK baseline hygiene (diagnostics only, never fails)", () => {
  const currentCounts = new Map();
  for (const [key, entry] of scanTokens(ALL_TOKENS)) {
    currentCounts.set(key, entry.count);
  }

  // Stale = baseline sanctions more occurrences of a key than the tree now has
  // (a removed/sentineled survivor, fully or partly). Reported, never fatal.
  const stale = [];
  for (const [key, baseline] of baselineCounts) {
    const current = currentCounts.get(key) || 0;
    if (current < baseline) {
      stale.push({ key, baseline, current });
    }
  }
  if (stale.length > 0) {
    const pretty = stale
      .map(({ key, baseline, current }) => {
        const [relpath, token] = key.split(KEY_SEP);
        const gone = baseline - current;
        return ["  ", relpath, "  [", token, "]  (-", gone, " of ", baseline, ")"].join("");
      })
      .sort()
      .join("\n");
    console.log(
      `[RET-CHECK] ${stale.length} stale baseline entr`
      + `${stale.length === 1 ? "y" : "ies"} (survivor removed/sentineled -- `
      + `prune from BASELINE_ALLOWLIST):\n${pretty}`,
    );
  }

  let currentTotal = 0;
  for (const n of currentCounts.values()) {
    currentTotal += n;
  }
  console.log(
    `[RET-CHECK] baseline survivor occurrences still present: ${currentTotal} `
    + `(of ${BASELINE_ALLOWLIST.length} allowlisted). Residuals may be live/legacy-read; `
    + `delete only dead phase-machinery residue.`,
  );

  // Composition of the honest floor by WHY each survivor is live -- converts the
  // opaque allowlist into an auditable breakdown (it is a deliberate floor, not a
  // TODO). Self-maintaining: derived from the allowlisted relpaths.
  const byReason = new Map();
  for (const key of BASELINE_ALLOWLIST) {
    const reason = survivorReason(key.split(KEY_SEP)[0]);
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
  }
  const breakdown = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `    ${String(n).padStart(3)}  ${reason}`)
    .join("\n");
  console.log(
    `[RET-CHECK] honest-floor composition (${BASELINE_ALLOWLIST.length} allowlisted, `
    + `${stale.length} stale):\n${breakdown}`,
  );

  // Advisory bare-word inventory.
  let bareCount = 0;
  let bareFiles = 0;
  for (const absFile of listScannableFiles()) {
    const text = fs.readFileSync(absFile, "utf8");
    const matches = text.match(/\bphase\b/gi);
    if (matches) {
      bareCount += matches.length;
      bareFiles += 1;
    }
  }
  console.log(
    `[RET-CHECK] advisory bare-word phase inventory: ${bareCount} occurrence(s) `
    + `across ${bareFiles} file(s) (ADVISORY ONLY -- token sets are the gate).`,
  );

  assert.ok(true);
});

// ---------------------------------------------------------------------------
// Dump mode: `RET_CHECK_DUMP=1 node --test <thisfile>` prints the current
// machinery hits as ready-to-paste BASELINE_ALLOWLIST entries. Used to seed /
// re-seed the baseline. Not part of the assertions.
// ---------------------------------------------------------------------------

if (process.env.RET_CHECK_DUMP === "1") {
  test("RET-CHECK dump current baseline (RET_CHECK_DUMP=1)", () => {
    const hits = [...scanTokens(ALL_TOKENS).values()].sort((a, b) =>
      (a.relpath === b.relpath
        ? (a.token === b.token ? a.line - b.line : a.token.localeCompare(b.token))
        : a.relpath.localeCompare(b.relpath)));
    // Emit each key with its true multiplicity (count copies) so the re-seeded
    // baseline sanctions exactly the occurrences present in the tree.
    const lines = hits.flatMap((h) => {
      const entry = "  " + JSON.stringify(hitKey(h.relpath, h.token, h.text)) + ",";
      return Array.from({ length: h.count }, () => entry);
    });
    console.log("__RET_CHECK_DUMP_START__");
    console.log(lines.join("\n"));
    console.log("__RET_CHECK_DUMP_END__");
    assert.ok(true);
  });
}
