import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const exportedManifestPath = path.join(
  repoRoot,
  "private",
  "publication",
  "exported-tree-manifest.json",
);

const SUPERSEDED_HEADER = Object.freeze([
  "Status: superseded",
  "Current product path: no",
]);

const EXPECTED_SUPERSEDED_DOCS = Object.freeze([
  "docs/contracts/team-context.md",
  "docs/contracts/phase-0-doc-alignment.md",
  "docs/contracts/wake-team-identity.md",
]);

const CURRENT_OWNER_DOCS = Object.freeze([
  "README.md",
  "docs/operating-model.md",
  "docs/adoption.md",
  "docs/self-improvement.md",
  "execution/integrations/linear/README.md",
]);

const RETIRED_CONCEPTS = Object.freeze([
  "hosted inbox",
  "hosted credential",
  "hosted status",
  "hosted service",
  "hosted wake storage",
  "github app",
  "token broker",
  "local supervisor",
  "always-on supervisor",
  "supervisor credential",
  "machine-off",
  "machine is off",
  "webhook",
  "remote runner",
  "remote callback",
  "background service",
  "daemon",
  "os autostart",
  "login service",
  "hosted broker",
  "hosted endpoint",
  "cloud sync",
  "cloud synchronization",
]);

// Every current exported mention of a retired architecture term must live inside
// one exact, reviewed statement. This is intentionally strict: a nearby "not"
// cannot bless an unrelated positive claim, and edits to a sanctioned statement
// require an explicit guard update in the same protected change.
const SANCTIONED_CURRENT_MENTIONS = Object.freeze({
  "AGENTS.md": Object.freeze([
    "There is no hosted inbox, webhook, GitHub App, or retained admin authority.",
  ]),
  "CHANGELOG.md": Object.freeze([
    "Setup recovery no longer depends on remote callbacks or remote wake state.",
  ]),
  "CLAUDE.md": Object.freeze([
    "No hosted inbox, webhook, GitHub App, or retained admin authority.",
  ]),
  "docs/adoption.md": Object.freeze([
    "There is no hosted inbox, GitHub App, token broker, retained admin authority, or always-running service in the supported path.",
  ]),
  "docs/contracts/authority-custody-defaults.md": Object.freeze([
    "Teami has no hosted inbox, GitHub App, token broker, always-on supervisor, maintainer-operated adopter authority, or hidden machine-off execution path.",
    "Its GitHub-hosted schedule does not mean an adopter factory keeps working while the adopter's machine is off.",
  ]),
  "docs/contracts/teami-product-trust-record.md": Object.freeze([
    "There is no hosted inbox, hosted credential custody, GitHub App, token broker, cloud synchronization, or maintainer-operated adopter path.",
    "When it is stopped or the machine is off, Teami performs no work and makes no external change.",
    "It does not imply a background service or machine-off behavior.",
  ]),
  "docs/operating-model.md": Object.freeze([
    "There is no hosted inbox, hosted credential custody, GitHub App, token broker, or always-on supervisor in the supported product.",
    "When it is stopped or the machine is off, Teami makes no external change; Linear remains the queue and the next foreground poll reconciles eligible work.",
  ]),
  "docs/promotion-acceptance-policy.md": Object.freeze([
    "no webhooks, no outbound custom actions, no PXI/plugin hooks, and no inbound user-defined tools.",
    "If a future Phoenix version exposes a supported custom action, webhook, or tool-calling surface",
  ]),
  "docs/self-improvement.md": Object.freeze([
    "The product promise is explicit local operation, not a hidden login service.",
    "No hosted inbox, GitHub App, token broker, or retained administrator grant sits behind this loop.",
    "it should not imply machine-off writes or out-of-band notifications.",
    "While the machine is off, nothing local can notify the user and nothing should update Linear.",
    "It does not mean machine-off writes.",
    "Phoenix should not be treated as a daemon the user must babysit.",
  ]),
  "execution/evals/decomposition/README.md": Object.freeze([
    "no merge, mark-ready, review, comment, webhook, workflow, or admin codepath.",
  ]),
  "execution/integrations/linear/README.md": Object.freeze([
    "It is a foreground command, not an installed background service.",
    "When the command is stopped or the machine is off, Teami makes no external change; Linear remains the queue until the next local poll.",
    "no always-on supervisor or hidden machine-off path is part of the product.",
  ]),
  "execution/integrations/linear/test/fixtures/decomp-facade/project-update.md": Object.freeze([
    "Decomposed the Event Trigger Webhook Inbox project into an agent-ready issue set.",
  ]),
  "README.md": Object.freeze([
    "there is no hosted inbox, credential service, GitHub App, or token broker.",
    "When that foreground command is stopped or the machine is off, Teami does no work and makes no external change.",
  ]),
});

test("superseded trust docs carry machine-checkable tombstones and stay out of all current exported docs", () => {
  const contractPaths = fs.readdirSync(path.join(repoRoot, "docs", "contracts"))
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => `docs/contracts/${name}`);
  const discoveredSuperseded = contractPaths
    .filter((repoPath) => isSuperseded(readRepoFile(repoPath)))
    .sort();
  assert.deepEqual(
    discoveredSuperseded,
    [...EXPECTED_SUPERSEDED_DOCS].sort(),
    "superseded contract inventory must be explicit",
  );

  for (const repoPath of EXPECTED_SUPERSEDED_DOCS) {
    const text = readRepoFile(repoPath);
    for (const header of SUPERSEDED_HEADER) {
      assert.match(text, new RegExp(`^${escapeRegex(header)}$`, "m"), `${repoPath} must declare ${header}`);
    }
    assert.match(text, /^Superseded by: /m, `${repoPath} must name the current owner`);
  }

  for (const currentPath of exportedMarkdownPaths()) {
    if (isSuperseded(readRepoFile(currentPath))) continue;
    const text = readRepoFile(currentPath).toLowerCase();
    for (const supersededPath of EXPECTED_SUPERSEDED_DOCS) {
      const basename = path.posix.basename(supersededPath).toLowerCase();
      assert.equal(
        text.includes(basename),
        false,
        `${currentPath} must not link ${supersededPath} as current guidance`,
      );
    }
  }
});

test("current exported docs do not positively promise retired hosted or unattended architecture", () => {
  const markdownPaths = exportedMarkdownPaths();
  assert.ok(markdownPaths.length > 0, "exported Markdown inventory must not be empty");

  const exportedSet = new Set(markdownPaths);
  for (const repoPath of CURRENT_OWNER_DOCS) {
    assert.ok(exportedSet.has(repoPath), `${repoPath} must remain in the exported Markdown inventory`);
  }
  for (const repoPath of currentContractPaths()) {
    assert.ok(exportedSet.has(repoPath), `${repoPath} is a current contract and must remain exported`);
  }

  const findings = [];
  for (const repoPath of markdownPaths) {
    const sourceText = readRepoFile(repoPath);
    if (repoPath === "CHANGELOG.md") {
      assert.match(sourceText, /Historical entries:\s+released-version sections preserve what shipped at that\s+time/i);
    }
    const text = repoPath === "CHANGELOG.md" ? currentChangelogSection(sourceText) : sourceText;
    if (isSuperseded(text)) continue;
    for (const paragraph of markdownParagraphs(text)) {
      const normalized = normalizeProse(paragraph).toLowerCase();
      for (const concept of RETIRED_CONCEPTS) {
        let fromIndex = 0;
        while (true) {
          const index = normalized.indexOf(concept, fromIndex);
          if (index < 0) break;
          if (!isSanctionedCurrentMention(repoPath, normalized, index, concept.length)) {
            findings.push({ repoPath, concept, paragraph: compact(paragraph) });
          }
          fromIndex = index + concept.length;
        }
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `retired trust concepts require an exact sanctioned statement or a superseded tombstone:\n${JSON.stringify(findings, null, 2)}`,
  );
});

test("retired-term exceptions cannot be satisfied by unrelated nearby negation", () => {
  const bypass = "Teami never loses work because a hosted inbox stores it while you are away.".toLowerCase();
  const bypassIndex = bypass.indexOf("hosted inbox");
  assert.equal(isSanctionedCurrentMention("README.md", bypass, bypassIndex, "hosted inbox".length), false);

  const sanctioned = "There is no hosted inbox, GitHub App, token broker, retained admin authority, or always-running service in the supported path.".toLowerCase();
  const sanctionedIndex = sanctioned.indexOf("hosted inbox");
  assert.equal(
    isSanctionedCurrentMention("docs/adoption.md", sanctioned, sanctionedIndex, "hosted inbox".length),
    true,
  );
});

test("owner docs pin the manual local gateway, non-retained admin, ambient GitHub, and unshipped execution truth", () => {
  const ownerText = new Map(
    CURRENT_OWNER_DOCS.map((repoPath) => [repoPath, normalizeProse(readRepoFile(repoPath))]),
  );

  for (const repoPath of ["README.md", "docs/operating-model.md", "execution/integrations/linear/README.md"]) {
    const text = ownerText.get(repoPath);
    assert.match(text, /foreground (?:gateway|command)/i, `${repoPath} must identify the foreground gateway command`);
    assert.match(text, /machine is off/i, `${repoPath} must state machine-off behavior plainly`);
    assert.match(text, /makes? no external change|does no work/i, `${repoPath} must deny machine-off effects`);
  }

  for (const repoPath of ["README.md", "docs/adoption.md", "execution/integrations/linear/README.md"]) {
    const text = ownerText.get(repoPath);
    assert.match(text, /one-time/i, `${repoPath} must disclose the one-time admin exception`);
    assert.match(text, /non-retained|never the runtime credential|discards? the admin grant/i, `${repoPath} must deny retained admin authority`);
    assert.match(text, /ambient .*git\/?`?gh|existing local git\/?`?gh|local git\/?`?gh/i, `${repoPath} must identify ambient GitHub authority`);
  }

  for (const repoPath of ["README.md", "docs/operating-model.md", "docs/adoption.md", "execution/integrations/linear/README.md"]) {
    assert.match(
      ownerText.get(repoPath),
      /product-repo write-capable execution (?:and pr effects )?(?:is|are) not shipped/i,
      `${repoPath} must state that product-repo execution is unshipped`,
    );
  }
});

test("current trust contracts pin explicit setup consent and separate external canaries", () => {
  const productTrust = normalizeProse(readRepoFile("docs/contracts/teami-product-trust-record.md"));
  const authority = normalizeProse(readRepoFile("docs/contracts/authority-custody-defaults.md"));

  for (const [repoPath, text] of [
    ["docs/contracts/teami-product-trust-record.md", productTrust],
    ["docs/contracts/authority-custody-defaults.md", authority],
  ]) {
    assert.match(text, /status: current/i, `${repoPath} must be current`);
    assert.match(text, /explicit (?:confirmation|consent)/i, `${repoPath} must require explicit setup consent`);
    assert.match(text, /workspace-wide linear read\/write/i, `${repoPath} must disclose Linear scope`);
    assert.match(text, /claude plugin/i, `${repoPath} must disclose plugin registration`);
    assert.match(text, /local teami.*phoenix|local teami\/phoenix/i, `${repoPath} must disclose local state effects`);
  }

  for (const canary of ["real Claude CLI", "disposable Linear", "real MCP", "GraphQL"]) {
    assert.match(
      `${productTrust}\n${authority}`,
      new RegExp(escapeRegex(canary), "i"),
      `current contracts must name the ${canary} canary`,
    );
  }
  assert.match(`${productTrust}\n${authority}`, /deterministic suite remains credential-free|credential-free deterministic tests/i);
});

test("OpenWiki CI requires Git evidence instead of optional connector state", () => {
  const workflowPath = path.join(repoRoot, ".github", "workflows", "openwiki-update.yml");
  if (!fs.existsSync(workflowPath)) {
    assert.equal(
      fs.existsSync(path.join(repoRoot, "openwiki")),
      false,
      "the public artifact must omit the private OpenWiki publication surface",
    );
    return;
  }
  const workflow = readRepoFile(".github/workflows/openwiki-update.yml");
  assert.match(workflow, /OPENWIKI_CLI_VERSION: 0\.0\.2/);
  assert.match(workflow, /npm install --global "openwiki@\$OPENWIKI_CLI_VERSION"/);
  assert.match(workflow, /openwiki --update --print/);
  assert.match(workflow, /checked-out Git repository and the supplied Git change summary as the source of truth/);
  assert.match(workflow, /recorded openwiki\/\.last-update\.json gitHead through HEAD/);
  assert.match(workflow, /Do not infer freshness from optional connector configuration/);
  assert.doesNotMatch(workflow, /\$HOME\/\.openwiki\/wiki/);
});

function readRepoFile(repoPath) {
  return fs.readFileSync(path.join(repoRoot, ...normalizeRepoPath(repoPath).split("/")), "utf8");
}

function isSuperseded(text) {
  return SUPERSEDED_HEADER.every((header) => new RegExp(`^${escapeRegex(header)}$`, "m").test(text));
}

function markdownParagraphs(text) {
  return String(text)
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\r?\n/g, " ").trim())
    .filter(Boolean);
}

function isSanctionedCurrentMention(repoPath, normalizedParagraph, index, length) {
  const statements = SANCTIONED_CURRENT_MENTIONS[repoPath] || [];
  for (const statement of statements) {
    const normalizedStatement = normalizeProse(statement).toLowerCase();
    let statementIndex = normalizedParagraph.indexOf(normalizedStatement);
    while (statementIndex >= 0) {
      if (statementIndex <= index && statementIndex + normalizedStatement.length >= index + length) {
        return true;
      }
      statementIndex = normalizedParagraph.indexOf(normalizedStatement, statementIndex + 1);
    }
  }
  return false;
}

function exportedMarkdownPaths() {
  if (fs.existsSync(exportedManifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(exportedManifestPath, "utf8"));
    return manifest.files
      .map((entry) => normalizeRepoPath(entry.source_path || entry.path))
      .filter((repoPath) => repoPath.toLowerCase().endsWith(".md"))
      .filter((repoPath) => fs.existsSync(path.join(repoRoot, ...repoPath.split("/"))));
  }
  return walkPublicMarkdownPaths(repoRoot);
}

function walkPublicMarkdownPaths(directory) {
  const skipDirectories = new Set([".git", ".teami", ".claude", "node_modules", "coverage", "dist", "tmp"]);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkPublicMarkdownPaths(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(normalizeRepoPath(path.relative(repoRoot, fullPath)));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function currentContractPaths() {
  return fs.readdirSync(path.join(repoRoot, "docs", "contracts"))
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => `docs/contracts/${name}`)
    .filter((repoPath) => {
      const text = readRepoFile(repoPath);
      return /^Status: current$/m.test(text) && /^Current product path: yes$/m.test(text);
    });
}

function normalizeProse(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function currentChangelogSection(text) {
  const match = String(text).match(/## \[Unreleased\][\s\S]*?(?=\n## \[[^\]]+\])/);
  assert.ok(match, "CHANGELOG.md must have a bounded Unreleased section");
  return match[0];
}

function normalizeRepoPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function compact(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 280);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
