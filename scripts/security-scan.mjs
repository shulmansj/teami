#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = ".gitleaks.toml";
const SEED_PATH = ".security-scan-seed.tmp";
const MAX_FINDINGS = 50;
const SCANNER_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (isDirectRun()) runCli(process.argv.slice(2));

export { scanDir, scanHistory, scanTree };

function runCli(argv) {
  const mode = argv[0];
  try {
    if (mode === "tree") {
      const result = scanTree();
      reportAndExit(result, "tree");
    } else if (mode === "dir") {
      const result = scanDir(argv[1]);
      reportAndExit(result, "dir");
    } else if (mode === "history") {
      const result = scanHistory();
      reportAndExit(result, "history");
    } else if (mode === "seed") {
      runSeedCheck();
    } else {
      fail(`Unknown security scan command: ${mode || "(missing)"}`);
    }
  } catch (error) {
    fail(error?.message || String(error));
  }
}

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function scanTree(options = {}) {
  const repoRoot = gitOutput(["rev-parse", "--show-toplevel"]).trim();
  const config = loadConfig(repoRoot);
  const files = options.files || trackedAndUntrackedFiles(repoRoot);
  const activeSourceMode = sourceModeActive(repoRoot, config);
  return scanFiles({ scanRoot: repoRoot, files, config, activeSourceMode });
}

function scanDir(dirPath) {
  if (!dirPath) fail("dir scan requires a path.");
  const scanRoot = path.resolve(dirPath);
  if (!existsSync(scanRoot)) fail(`dir scan target does not exist: ${dirPath}`);
  if (!statSync(scanRoot).isDirectory()) fail(`dir scan target is not a directory: ${dirPath}`);
  const config = loadConfig(SCANNER_REPO_ROOT);
  return scanFiles({
    scanRoot,
    files: directoryFiles(scanRoot),
    config,
    activeSourceMode: false,
  });
}

function scanFiles({ scanRoot, files, config, activeSourceMode }) {
  const findings = [];
  let scannedFiles = 0;

  for (const repoPath of files) {
    const normalizedPath = normalizeRepoPath(repoPath);
    if (pathAllowed(config.globalAllowlist, normalizedPath)) continue;
    if (activeSourceMode && pathAllowed(config.sourceMode, normalizedPath)) continue;

    const fullPath = path.join(scanRoot, normalizedPath);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) continue;
    const buffer = readFileSync(fullPath);
    if (looksBinary(buffer)) continue;
    const text = buffer.toString("utf8");
    scannedFiles += 1;

    for (const rule of config.rules) {
      if (rule.pathRegex && rule.pathRegex.test(normalizedPath)) {
        const finding = {
          file: normalizedPath,
          line: 1,
          rule,
          match: normalizedPath,
          lineText: normalizedPath,
        };
        if (!findingAllowed({ finding, config, activeSourceMode })) findings.push(finding);
        continue;
      }
      if (!rule.regex) continue;
      rule.regex.lastIndex = 0;
      for (const match of text.matchAll(rule.regex)) {
        const secret = rule.secretGroup ? match[Number(rule.secretGroup)] || match[0] : match[0];
        if (rule.entropy && shannonEntropy(secret) < Number(rule.entropy)) continue;
        const index = match.index || 0;
        const finding = {
          file: normalizedPath,
          line: lineNumberForIndex(text, index),
          rule,
          match: secret,
          lineText: lineAtIndex(text, index),
        };
        if (!findingAllowed({ finding, config, activeSourceMode })) findings.push(finding);
      }
    }
  }

  return {
    findings,
    scannedFiles,
    rules: config.rules.length,
    sourceMode: activeSourceMode,
  };
}

function directoryFiles(scanRoot) {
  const files = [];

  walk(scanRoot, "");
  return files.sort((a, b) => a.localeCompare(b));

  function walk(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile() || isFileSymlink(fullPath, entry)) {
        files.push(relativePath);
      }
    }
  }
}

function isFileSymlink(fullPath, entry) {
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

function scanHistory() {
  const repoRoot = gitOutput(["rev-parse", "--show-toplevel"]).trim();
  const config = loadConfig(repoRoot);
  const findings = [];
  const excludedPathspecs = [
    ":(exclude).gitleaks.toml",
    ":(exclude)scripts/security-scan.mjs",
    ":(exclude)private/**",
  ];

  for (const rule of config.rules.filter((candidate) => candidate.history !== false && !candidate.pathRegex)) {
    const historyRegex = rule.historyRegex || rule.rawRegex;
    if (!historyRegex) continue;
    const result = git(["log", "--all", "-G", historyRegex, "--format=%H", "--", ".", ...excludedPathspecs], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stdout.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
      fail(`git log history scan failed for ${rule.id}`);
    }
    const commits = [...new Set((result.stdout || "").split(/\r?\n/).filter(Boolean))];
    for (const commit of commits) {
      const grep = git(["grep", "-nI", "-E", "-e", historyRegex, commit, "--", ".", ...excludedPathspecs], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (grep.status === 1) continue;
      if (grep.status !== 0) {
        process.stdout.write(grep.stdout || "");
        process.stderr.write(grep.stderr || "");
        fail(`git grep history scan failed for ${rule.id} at ${commit}`);
      }
      for (const line of (grep.stdout || "").split(/\r?\n/).filter(Boolean)) {
        const parsed = parseGitGrepLine(line, commit);
        if (!parsed) continue;
        rule.regex.lastIndex = 0;
        for (const match of parsed.lineText.matchAll(rule.regex)) {
          const secret = rule.secretGroup ? match[Number(rule.secretGroup)] || match[0] : match[0];
          if (rule.entropy && shannonEntropy(secret) < Number(rule.entropy)) continue;
          const finding = {
            file: parsed.file,
            line: parsed.line,
            commit,
            rule,
            match: secret,
            lineText: parsed.lineText,
          };
          if (!findingAllowed({ finding, config, activeSourceMode: false })) findings.push(finding);
        }
      }
    }
  }

  return {
    findings,
    scannedFiles: 0,
    rules: config.rules.filter((candidate) => candidate.history !== false && !candidate.pathRegex).length,
    sourceMode: false,
  };
}

function runSeedCheck() {
  const repoRoot = gitOutput(["rev-parse", "--show-toplevel"]).trim();
  const seedPath = path.join(repoRoot, SEED_PATH);
  // Assemble strict fake seeds at runtime so this scanner's own source is still scanned.
  const seedValue = (...parts) => parts.join("");
  const seedLocalPath = seedValue("C:/", "Users/example/private-repo");
  const seed = [
    "TEAMI_GITHUB_BROKER_TOKEN=afp_live_FAKE_DO_NOT_USE_0123456789abcdef",
    "TEAMI_BROKER_CREDENTIAL_SIGNING_KEY=broker_signing_fake_0123456789abcdef0123456789",
    "setup_grant=tm_setup_v1_sg123456789abc_FAKESECRET0123456789abcdef0123456789",
    "broker=tm_broker_v1.segment0123456789abcdef.signature0123456789abcdef0123456789",
    "runner=ri_runner0123456789abcdef.secret0123456789abcdef",
    `service_role_key=${seedValue(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      ".",
      "eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3MTYwMDAwMDB9",
      ".",
      "fake_signature_0123456789abcdef",
    )}`,
    `private_key=${seedValue("-----BEGIN ", "PRIVATE KEY", "-----")}`,
    `local_checkout_path = "${seedLocalPath}"`,
    "teami domain grant support --repo example/private-repo",
  ].join("\n");

  try {
    writeFileSync(seedPath, `${seed}\n`, "utf8");
    const planted = scanTree();
    if (planted.findings.length === 0) {
      fail("security:secrets:seed did not catch the planted fake secret.");
    }
    rmSync(seedPath, { force: true });
    const cleaned = scanTree();
    if (cleaned.findings.length > 0) {
      printFindings(cleaned.findings);
      fail("security:secrets:seed removed the seed, but the normal tree scan still fails.");
    }
    console.log(`security-scan: seed check passed (caught ${planted.findings.length} planted finding${planted.findings.length === 1 ? "" : "s"}; clean tree scan passed after removal).`);
  } finally {
    if (existsSync(seedPath)) rmSync(seedPath, { force: true });
  }
}

function loadConfig(repoRoot) {
  const configText = readFileSync(path.join(repoRoot, CONFIG_PATH), "utf8");
  const parsed = parseTomlSubset(configText);
  const rules = parsed.rules.map((rule) => compileRule(rule));
  if (rules.length === 0) fail(`${CONFIG_PATH} does not define any scanner rules.`);
  return {
    rules,
    globalAllowlist: compileAllowlist(parsed.globalAllowlist || {}),
    sourceMode: compileSourceMode(parsed.sourceMode || {}),
    sourceRuleAllowlists: (parsed.sourceRuleAllowlists || []).map((allowlist) => compileAllowlist(allowlist)),
  };
}

function compileRule(rule) {
  if (!rule.id) fail(`${CONFIG_PATH} has a rule without an id.`);
  const compiled = {
    ...rule,
    rawRegex: rule.regex,
    historyRegex: rule.history_regex,
    allowlists: (rule.allowlists || []).map((allowlist) => compileAllowlist(allowlist)),
  };
  if (rule.regex) compiled.regex = compileRegex(rule.regex, "g");
  if (rule.path_regex) compiled.pathRegex = compileRegex(rule.path_regex);
  return compiled;
}

function compileSourceMode(sourceMode) {
  return {
    ...sourceMode,
    paths: compilePatterns(sourceMode.paths || []),
  };
}

function compileAllowlist(allowlist) {
  return {
    ...allowlist,
    paths: compilePatterns(allowlist.paths || []),
    regexes: compilePatterns(allowlist.regexes || []),
    rules: new Set(allowlist.rules || []),
  };
}

function compilePatterns(patterns) {
  return patterns.map((pattern) => compileRegex(pattern));
}

function compileRegex(pattern, extraFlags = "") {
  try {
    return new RegExp(pattern, extraFlags);
  } catch (error) {
    fail(`Invalid regex in ${CONFIG_PATH}: ${pattern}: ${error?.message || String(error)}`);
  }
}

function parseTomlSubset(text) {
  const root = { rules: [], sourceRuleAllowlists: [] };
  const lines = text.split(/\r?\n/);
  let target = root;
  let currentRule = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line === "[allowlist]") {
      root.globalAllowlist = {};
      target = root.globalAllowlist;
      currentRule = null;
      continue;
    }
    if (line === "[teami.source_mode]") {
      root.sourceMode = {};
      target = root.sourceMode;
      currentRule = null;
      continue;
    }
    if (line === "[[teami.source_rule_allowlists]]") {
      const allowlist = {};
      root.sourceRuleAllowlists.push(allowlist);
      target = allowlist;
      currentRule = null;
      continue;
    }
    if (line === "[[rules]]") {
      currentRule = { allowlists: [] };
      root.rules.push(currentRule);
      target = currentRule;
      continue;
    }
    if (line === "[[rules.allowlists]]") {
      if (!currentRule) fail(`${CONFIG_PATH}:${index + 1}: rules.allowlists must follow a rule.`);
      const allowlist = {};
      currentRule.allowlists.push(allowlist);
      target = allowlist;
      continue;
    }

    const scalar = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!scalar) continue;
    const key = scalar[1];
    let value = scalar[2].trim();

    if (value === "[") {
      const items = [];
      for (index += 1; index < lines.length; index += 1) {
        const itemLine = lines[index].trim();
        if (itemLine === "]") break;
        if (!itemLine || itemLine.startsWith("#")) continue;
        const item = itemLine.replace(/,$/, "").trim();
        items.push(parseTomlValue(item));
      }
      target[key] = items;
      continue;
    }

    target[key] = parseTomlValue(value.replace(/,$/, "").trim());
  }

  return root;
}

function parseTomlValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const triple = value.match(/^'''([\s\S]*)'''$/);
  if (triple) return triple[1];
  const quoted = value.match(/^"([\s\S]*)"$/);
  if (quoted) return quoted[1].replace(/\\"/g, '"');
  return value;
}

function trackedAndUntrackedFiles(repoRoot) {
  const result = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout?.toString("utf8") || "");
    process.stderr.write(result.stderr?.toString("utf8") || "");
    fail("git ls-files failed while building the security scan file list.");
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

function findingAllowed({ finding, config, activeSourceMode }) {
  if (finding.rule.allowlists.some((allowlist) => allowlistMatches(allowlist, finding))) return true;
  if (!activeSourceMode) return false;
  return config.sourceRuleAllowlists.some((allowlist) => {
    if (allowlist.rules.size > 0 && !allowlist.rules.has(finding.rule.id)) return false;
    return allowlistMatches(allowlist, finding);
  });
}

function allowlistMatches(allowlist, finding) {
  const pathOk = !allowlist.paths?.length || allowlist.paths.some((pattern) => pattern.test(finding.file));
  const regexOk = !allowlist.regexes?.length || allowlist.regexes.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(finding.match) || pattern.test(finding.lineText);
  });
  return pathOk && regexOk;
}

function pathAllowed(allowlist, repoPath) {
  return allowlist?.paths?.some((pattern) => pattern.test(repoPath));
}

function sourceModeActive(repoRoot, config) {
  return Boolean(config.sourceMode?.marker_path && existsSync(path.join(repoRoot, config.sourceMode.marker_path)));
}

function reportAndExit(result, label) {
  if (result.findings.length > 0) {
    printFindings(result.findings);
    fail(`security:secrets ${label} scan found ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}.`);
  }
  const scanned = label === "history" ? "git history" : `${result.scannedFiles} file${result.scannedFiles === 1 ? "" : "s"}`;
  console.log(`security-scan: ${label} scan passed (${scanned}, ${result.rules} rule${result.rules === 1 ? "" : "s"}${result.sourceMode ? ", source-mode private build exclusions active" : ""}).`);
}

function printFindings(findings) {
  for (const finding of findings.slice(0, MAX_FINDINGS)) {
    const commit = finding.commit ? `@${finding.commit.slice(0, 12)}` : "";
    console.error(`${finding.file}:${finding.line}${commit}: ${finding.rule.id}: ${finding.rule.description}`);
    console.error(`  match: ${redact(finding.match)}`);
  }
  if (findings.length > MAX_FINDINGS) {
    console.error(`... ${findings.length - MAX_FINDINGS} more finding${findings.length - MAX_FINDINGS === 1 ? "" : "s"} omitted.`);
  }
}

function parseGitGrepLine(line, commit) {
  const prefix = `${commit}:`;
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const match = rest.match(/^([^:]+):(\d+):(.*)$/);
  if (!match) return null;
  return {
    file: normalizeRepoPath(match[1]),
    line: Number(match[2]),
    lineText: match[3],
  };
}

function redact(value) {
  const text = String(value);
  if (text.length <= 16) return "[redacted]";
  return `${text.slice(0, 8)}...[redacted]...${text.slice(-4)}`;
}

function looksBinary(buffer) {
  return buffer.includes(0);
}

function lineNumberForIndex(text, index) {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (text.charCodeAt(offset) === 10) line += 1;
  }
  return line;
}

function lineAtIndex(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

function shannonEntropy(value) {
  const text = String(value);
  if (!text) return 0;
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function normalizeRepoPath(repoPath) {
  return repoPath.split(path.sep).join("/");
}

function gitOutput(args) {
  const result = git(args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    fail(`git ${args.join(" ")} failed with exit code ${result.status}.`);
  }
  return result.stdout;
}

function git(args, options = {}) {
  return spawnSync(gitCommand(), args, {
    cwd: options.cwd || process.cwd(),
    encoding: options.encoding === "buffer" ? undefined : options.encoding || "utf8",
    stdio: options.stdio || "pipe",
    windowsHide: true,
  });
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function fail(message) {
  console.error(`security-scan: ${message}`);
  process.exit(1);
}
