import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCliOutput } from "../src/cli/cli-output.mjs";
import { renderCuratedHelp, renderHomeScreen } from "../src/cli/dispatch.mjs";
import { renderDoctorReport } from "../src/cli/doctor-report.mjs";
import { runGatewayCommand } from "../src/cli/runner-command.mjs";
import { runFinalGate } from "../src/cli/linear-setup-command.mjs";
import { loadLinearConfig } from "../src/config.mjs";
import {
  emptyDomainRegistry,
  makeDomainRecord,
  writeDomainRegistry,
} from "../src/domain-registry.mjs";

// All surfaces resolve config from the default repo-relative path; clear any inherited override.
delete process.env.TEAMI_LINEAR_CONFIG;

const ESC = String.fromCharCode(27); // ANSI escape (U+001B)
const realRepoRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleConfigPath = path.join(realRepoRoot, "execution", "integrations", "linear", "config.example.json");

function makeActiveRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "af-conf-active-"));
  const target = path.join(repoRoot, "execution", "integrations", "linear", "config.example.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(exampleConfigPath, target);
  const registry = emptyDomainRegistry();
  registry.domains.push(
    makeDomainRecord({
      domainId: "main",
      status: "active",
      workspaceId: "workspace-main",
      workspaceName: "Example Workspace",
      teamId: "team-main",
      teamKey: "AF",
      teamName: "Teami",
      teamNameLastSeenAt: "2026-06-11T00:00:00.000Z",
    }),
  );
  writeDomainRegistry({ repoRoot }, registry);
  return repoRoot;
}

// Render every adopter-facing surface (home, curated help, doctor, gateway status, init's
// verifying-setup block) into one stream with the given color/unicode mode.
async function renderAllAdopterSurfaces({ color, unicode }) {
  const writes = [];
  const stream = { isTTY: false, write: (chunk) => (writes.push(String(chunk)), true) };
  const output = createCliOutput({ color, unicode, stream, errStream: stream });

  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "af-conf-home-"));
  renderHomeScreen({ repoRoot: emptyRepo, output });
  fs.rmSync(emptyRepo, { recursive: true, force: true });

  renderCuratedHelp(output, { all: true });

  renderDoctorReport(
    [
      { name: "Setup", state: "ok", message: "ready", showMessage: true },
      { name: "GitHub", state: "warn", message: "missing the repo scope", fix: "gh auth refresh -s repo" },
      { name: "Gateway", state: "fail", message: "not running", fix: "npm run init" },
    ],
    output,
  );

  const activeRepo = makeActiveRepo();
  const config = loadLinearConfig({ repoRoot: activeRepo });
  const savedExit = process.exitCode;
  await runGatewayCommand({ context: { config, repoRoot: activeRepo, output }, command: "gateway", args: ["status"] });
  process.exitCode = savedExit;
  fs.rmSync(activeRepo, { recursive: true, force: true });

  const savedExit2 = process.exitCode;
  await runFinalGate({
    config: {},
    repoRoot: process.cwd(),
    cachePath: "linear-cache.json",
    domainId: "domain-one",
    output,
    runSmoke: async () => ({ ok: true, results: [] }),
    runDoctor: async () => [{ name: "domain registry", ok: true }],
  });
  process.exitCode = savedExit2;

  return writes.join("");
}

test("non-TTY adopter output across home/help/doctor/gateway-status/init is color- and animation-free", async () => {
  const text = await renderAllAdopterSurfaces({ color: false, unicode: false });
  assert.ok(!text.includes(ESC), "no ANSI escape codes on a non-TTY stream");
  assert.ok(!text.includes("\r"), "no carriage-return animation on a non-TTY stream");
});

test("ASCII fallback renders across the adopter surfaces when Unicode is off", async () => {
  const text = await renderAllAdopterSurfaces({ color: false, unicode: false });
  for (const glyph of ["✓", "✗", "●", "○", "→", "·", "⚠", "▸", "…"]) {
    assert.ok(!text.includes(glyph), `Unicode glyph U+${glyph.codePointAt(0).toString(16)} must not appear when Unicode is off`);
  }
  // The ASCII forms carry the meaning instead.
  assert.match(text, /\[off\]/, "the stopped status dot degrades to the [off] text label");
  assert.match(text, /x Gateway/, "the doctor fail mark degrades to ASCII 'x'");
  assert.match(text, /\+ /, "the doctor ok mark degrades to ASCII '+'");
});

test("STYLE.md conformance: no raw ANSI escapes live outside cli-output.mjs", () => {
  const cliDir = path.resolve(import.meta.dirname, "../src/cli");
  for (const file of fs.readdirSync(cliDir)) {
    if (!file.endsWith(".mjs") || file === "cli-output.mjs") continue;
    const source = fs.readFileSync(path.join(cliDir, file), "utf8");
    assert.ok(
      !source.includes("\\x1b") && !source.includes("\\u001b") && !source.includes(ESC),
      `${file} must not contain raw ANSI escapes - render through cli-output instead`,
    );
  }
});
