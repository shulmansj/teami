#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DENO_VERSION = "2.8.3";
const DENO_NPM_PACKAGE = `deno@${DENO_VERSION}`;
const LOCKFILE = "deno.lock";
const FUNCTIONS_DIR = path.join("supabase", "functions");
const EDGE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const ALLOWED_LICENSES = new Set(["0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]);

const mode = process.argv[2];

try {
  if (mode === "lock") {
    edgeLock();
  } else if (mode === "check") {
    edgeCheck();
  } else if (mode === "audit") {
    edgeAudit();
  } else if (mode === "self-test") {
    selfTest();
  } else {
    fail(`Unknown edge dependency command: ${mode || "(missing)"}`);
  }
} catch (error) {
  fail(error?.message || String(error));
}

function edgeLock() {
  const entrypoints = edgeFunctionEntrypoints();
  ensureNotGitIgnored(LOCKFILE);
  ensurePinnedDeno();
  const tempLockfile = `${LOCKFILE}.tmp-${process.pid}`;
  try {
    if (existsSync(tempLockfile)) rmSync(tempLockfile, { force: true });
    runDeno([
      "check",
      `--lock=${tempLockfile}`,
      "--no-config",
      "--node-modules-dir=auto",
      "--reload=npm:",
      ...entrypoints,
    ]);
    if (!existsSync(tempLockfile)) fail(`Deno did not create ${tempLockfile}.`);
    copyFileSync(tempLockfile, LOCKFILE);
  } finally {
    if (existsSync(tempLockfile)) rmSync(tempLockfile, { force: true });
  }
  console.log(`Regenerated ${LOCKFILE} for ${entrypoints.length} Edge Function entr${entrypoints.length === 1 ? "y" : "ies"}.`);
}

function edgeCheck() {
  const entrypoints = edgeFunctionEntrypoints();
  ensureNotGitIgnored(LOCKFILE);
  if (!existsSync(LOCKFILE)) {
    fail(`${LOCKFILE} is missing. Run npm run edge:lock and commit the generated lockfile.`);
  }
  ensurePinnedDeno();
  runDeno([
    "check",
    `--lock=${LOCKFILE}`,
    "--frozen=true",
    "--no-config",
    "--node-modules-dir=auto",
    ...entrypoints,
  ]);
  console.log(`Verified ${LOCKFILE} freshness and type-checked ${entrypoints.length} Edge Function entr${entrypoints.length === 1 ? "y" : "ies"}.`);
}

function edgeAudit() {
  ensureNoUnclassifiedRemoteImports();
  const imports = npmImports();
  validateNpmImports(imports);
  const lockedPackages = lockedNpmPackagesFromLockfile();
  if (lockedPackages.length === 0) {
    if (imports.length > 0) {
      fail(`${LOCKFILE} contains no npm graph even though Edge Functions import npm packages. Run npm run edge:lock.`);
    }
    console.log("No npm packages found in deno.lock; license and vulnerability audit has no npm surface.");
    return;
  }
  assertImportsPresentInLock(imports, lockedPackages);
  const dependencies = dependencyMapFromLockedPackages(lockedPackages);
  const tempRoot = mkdtempSync(path.join(tmpdir(), "agentic-factory-edge-audit-"));
  try {
    writeFileSync(
      path.join(tempRoot, "package.json"),
      `${JSON.stringify({
        name: "agentic-factory-edge-audit",
        private: true,
        type: "module",
        dependencies,
      }, null, 2)}\n`,
    );
    console.log(`Auditing ${lockedPackages.length} npm package${lockedPackages.length === 1 ? "" : "s"} from ${LOCKFILE} in ${tempRoot}`);
    runNpm(["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { cwd: tempRoot });
    runNpm(["audit", "--omit=dev", "--audit-level=low"], { cwd: tempRoot });
    const packages = installedPackages(path.join(tempRoot, "node_modules"));
    assertInstalledPackagesMatchLock({ installed: packages, locked: lockedPackages });
    const disallowed = packages.filter((pkg) => !licenseAllowed(pkg.license));
    if (disallowed.length > 0) {
      for (const pkg of disallowed) {
        console.error(`Disallowed or missing license: ${pkg.name}@${pkg.version} => ${pkg.license || "(missing)"}`);
      }
      fail("Edge npm license audit failed. Update the package, remove it, or make an explicit license policy decision.");
    }
    console.log(`Edge npm audit passed: ${packages.length} installed package${packages.length === 1 ? "" : "s"} have allowed licenses and npm reported no vulnerabilities at audit-level=low.`);
  } finally {
    if (tempRoot.startsWith(tmpdir())) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

function selfTest() {
  const lock = {
    npm: {
      "plain@1.2.3": {},
      "@scope/pkg@2.3.4": {},
      "plain@2.0.0": {},
    },
  };
  const packages = lockedNpmPackagesFromObject(lock, "self-test lock");
  assert(packages.length === 3, "expected three parsed lock packages");
  const dependencies = dependencyMapFromLockedPackages(packages);
  assert(dependencies["@scope/pkg"] === "2.3.4", "single-version scoped package should keep package name");
  assert(Object.values(dependencies).includes("npm:plain@1.2.3"), "duplicate plain package should use an npm alias for 1.2.3");
  assert(Object.values(dependencies).includes("npm:plain@2.0.0"), "duplicate plain package should use an npm alias for 2.0.0");

  const rejected = remoteImportsFromSource({
    file: "supabase/functions/example/index.ts",
    text: 'import "https://example.com/mod.ts";\nconst local = await import("./local.ts");\n',
  });
  assert(rejected.length === 1 && rejected[0].specifier === "https://example.com/mod.ts", "https import should be rejected");

  const allowed = remoteImportsFromSource({
    file: "supabase/functions/example/index.ts",
    text: 'import jwt from "npm:jsonwebtoken@9.0.2";\nexport * from "./local.ts";\n',
  });
  assert(allowed.length === 0, "npm and local imports should not be remote import failures");
  console.log("edge-deps self-test passed.");
}

function edgeFunctionEntrypoints() {
  if (!existsSync(FUNCTIONS_DIR)) fail(`Missing ${FUNCTIONS_DIR}.`);
  const entries = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(FUNCTIONS_DIR, entry.name, "index.ts"))
    .filter((entrypoint) => existsSync(entrypoint))
    .map(toDenoPath)
    .sort();
  if (entries.length === 0) fail(`No Edge Function entrypoints found under ${FUNCTIONS_DIR}.`);
  return entries;
}

function npmImports() {
  const files = sourceFiles(FUNCTIONS_DIR);
  const imports = [];
  const importPattern = /["']npm:([^"']+)["']/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      imports.push({ file: toDenoPath(file), specifier: `npm:${match[1]}` });
    }
  }
  return imports;
}

function validateNpmImports(imports) {
  for (const npmImport of imports) {
    const parsed = parseNpmSpecifier(npmImport.specifier);
    if (!parsed) {
      fail(`Unsupported npm import in ${npmImport.file}: ${npmImport.specifier}. Use npm:<package>@<exact-version>.`);
    }
    if (!exactSemver(parsed.version)) {
      fail(`Unpinned npm import in ${npmImport.file}: ${npmImport.specifier}. Use an exact x.y.z version.`);
    }
  }
}

function parseNpmSpecifier(specifier) {
  const body = specifier.replace(/^npm:/, "");
  const packageAndVersion = packageVersionPart(body);
  const versionAt = packageAndVersion.lastIndexOf("@");
  if (versionAt <= 0) return null;
  const name = packageAndVersion.slice(0, versionAt);
  const version = packageAndVersion.slice(versionAt + 1);
  if (!name || !version) return null;
  return { name, version };
}

function parseLockedNpmPackageKey(key) {
  const versionAt = key.lastIndexOf("@");
  if (versionAt <= 0) return null;
  const name = key.slice(0, versionAt);
  const version = key.slice(versionAt + 1);
  if (!name || !version || !exactSemver(version)) return null;
  return { name, version, key };
}

function lockedNpmPackagesFromLockfile() {
  if (!existsSync(LOCKFILE)) fail(`${LOCKFILE} is missing. Run npm run edge:lock before npm run edge:audit.`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(LOCKFILE, "utf8"));
  } catch (error) {
    fail(`Unable to parse ${LOCKFILE}: ${error?.message || String(error)}`);
  }
  return lockedNpmPackagesFromObject(parsed, LOCKFILE);
}

function lockedNpmPackagesFromObject(lock, label) {
  if (!lock || typeof lock !== "object") fail(`${label} is not a JSON object.`);
  if (!lock.npm || typeof lock.npm !== "object" || Array.isArray(lock.npm)) return [];
  const packages = [];
  for (const key of Object.keys(lock.npm).sort()) {
    const parsed = parseLockedNpmPackageKey(key);
    if (!parsed) fail(`Unsupported npm lock entry in ${label}: ${key}`);
    packages.push(parsed);
  }
  return packages;
}

function dependencyMapFromLockedPackages(packages) {
  const byName = new Map();
  for (const pkg of packages) {
    const versions = byName.get(pkg.name) || [];
    versions.push(pkg.version);
    byName.set(pkg.name, versions);
  }
  const dependencies = {};
  for (const pkg of packages) {
    const versions = byName.get(pkg.name) || [];
    const duplicateName = versions.length > 1;
    const dependencyName = duplicateName ? auditAliasForPackage(pkg) : pkg.name;
    dependencies[dependencyName] = duplicateName ? `npm:${pkg.name}@${pkg.version}` : pkg.version;
  }
  return Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)));
}

function auditAliasForPackage(pkg) {
  return `edge-audit-${pkg.name.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]+/g, "-")}-${pkg.version.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

function assertImportsPresentInLock(imports, lockedPackages) {
  const locked = new Set(lockedPackages.map((pkg) => `${pkg.name}@${pkg.version}`));
  for (const npmImport of imports) {
    const parsed = parseNpmSpecifier(npmImport.specifier);
    if (!locked.has(`${parsed.name}@${parsed.version}`)) {
      fail(`${npmImport.specifier} in ${npmImport.file} is not present in ${LOCKFILE}. Run npm run edge:lock.`);
    }
  }
}

function assertInstalledPackagesMatchLock({ installed, locked }) {
  const installedSet = new Set(installed.map((pkg) => `${pkg.name}@${pkg.version}`));
  const lockedSet = new Set(locked.map((pkg) => `${pkg.name}@${pkg.version}`));
  const missing = [...lockedSet].filter((pkg) => !installedSet.has(pkg));
  const extra = [...installedSet].filter((pkg) => !lockedSet.has(pkg));
  if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) console.error(`Installed npm audit graph is missing locked package(s): ${missing.join(", ")}`);
    if (extra.length > 0) console.error(`Installed npm audit graph contains package(s) not in ${LOCKFILE}: ${extra.join(", ")}`);
    fail(`Installed npm audit graph does not match ${LOCKFILE}.`);
  }
}

function ensureNoUnclassifiedRemoteImports() {
  const findings = [];
  for (const file of sourceFiles(FUNCTIONS_DIR)) {
    findings.push(...remoteImportsFromSource({ file: toDenoPath(file), text: readFileSync(file, "utf8") }));
  }
  if (findings.length === 0) return;
  for (const finding of findings) {
    console.error(`Unclassified remote Edge import: ${finding.file}: ${finding.specifier}`);
  }
  fail("Remote Edge imports using http:, https:, or jsr: are not classified by this audit gate. Vendor them, convert to npm:, or add an explicit reviewed classifier.");
}

function remoteImportsFromSource({ file, text }) {
  const findings = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s*)?["']((?:https?:|jsr:)[^"']+)["']/g,
    /\bimport\s*\(\s*["']((?:https?:|jsr:)[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ file, specifier: match[1] });
    }
  }
  return findings;
}

function packageVersionPart(body) {
  if (!body.startsWith("@")) {
    const slash = body.indexOf("/");
    return slash === -1 ? body : body.slice(0, slash);
  }
  const firstSlash = body.indexOf("/");
  if (firstSlash === -1) return body;
  const secondSlash = body.indexOf("/", firstSlash + 1);
  return secondSlash === -1 ? body : body.slice(0, secondSlash);
}

function sourceFiles(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(fullPath));
    } else if (entry.isFile() && EDGE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(fullPath);
    }
  }
  return found.sort();
}

function installedPackages(nodeModulesDir) {
  const packages = [];
  for (const packageJson of packageJsonFiles(nodeModulesDir)) {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8"));
    if (!parsed.name || !parsed.version) continue;
    packages.push({
      name: parsed.name,
      version: parsed.version,
      license: normalizedLicense(parsed),
    });
  }
  return packages.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

function packageJsonFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const packageJson = path.join(fullPath, "package.json");
      if (existsSync(packageJson)) files.push(packageJson);
      const nestedNodeModules = path.join(fullPath, "node_modules");
      if (existsSync(nestedNodeModules) && statSync(nestedNodeModules).isDirectory()) {
        files.push(...packageJsonFiles(nestedNodeModules));
      }
      if (entry.name.startsWith("@")) files.push(...packageJsonFiles(fullPath));
    }
  }
  return [...new Set(files)];
}

function normalizedLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type.trim();
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses
      .map((license) => typeof license === "string" ? license : license?.type)
      .filter(Boolean)
      .join(" OR ");
  }
  return "";
}

function licenseAllowed(license) {
  return ALLOWED_LICENSES.has(license);
}

function ensurePinnedDeno() {
  const result = spawnNpm(["exec", "--yes", "--package", DENO_NPM_PACKAGE, "--", "deno", "--version"], {
    encoding: "utf8",
  });
  if (result.error) fail(`Unable to run pinned ${DENO_NPM_PACKAGE}: ${result.error.message}`);
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    fail(`Pinned ${DENO_NPM_PACKAGE} is unavailable. Check npm registry access and retry.`);
  }
  const firstLine = result.stdout.split(/\r?\n/)[0] || "";
  if (!firstLine.startsWith(`deno ${DENO_VERSION} `)) {
    process.stdout.write(result.stdout || "");
    fail(`Expected Deno ${DENO_VERSION}, got: ${firstLine}`);
  }
  process.stdout.write(result.stdout);
}

function runDeno(args) {
  runNpm(["exec", "--yes", "--package", DENO_NPM_PACKAGE, "--", "deno", ...args]);
}

function runNpm(args, options = {}) {
  const result = spawnNpm(args, {
    cwd: options.cwd || process.cwd(),
    stdio: "inherit",
  });
  if (result.error) fail(`Unable to run npm: ${result.error.message}`);
  if (result.status !== 0) fail(`npm ${args.join(" ")} failed with exit code ${result.status}.`);
}

function spawnNpm(args, options = {}) {
  const stdio = options.stdio || (options.encoding ? "pipe" : "inherit");
  if (process.platform !== "win32") {
    return spawnSync("npm", args, {
      cwd: options.cwd || process.cwd(),
      encoding: options.encoding,
      stdio,
      windowsHide: true,
    });
  }
  const commandLine = ["npm", ...args].map(quoteWindowsCmdArg).join(" ");
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
    cwd: options.cwd || process.cwd(),
    encoding: options.encoding,
    stdio,
    windowsHide: true,
  });
}

function ensureNotGitIgnored(repoRelativePath) {
  const result = spawnSync(gitCommand(), ["check-ignore", "-q", "--", repoRelativePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) fail(`Unable to run git check-ignore: ${result.error.message}`);
  if (result.status === 0) fail(`${repoRelativePath} is ignored by git. Remove the ignore rule before running Edge dependency checks.`);
  if (result.status !== 1) fail(`git check-ignore failed for ${repoRelativePath} with exit code ${result.status}.`);
}

function exactSemver(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function toDenoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function quoteWindowsCmdArg(value) {
  const arg = String(value);
  if (/^[A-Za-z0-9_/:=.,@+\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function assert(condition, message) {
  if (!condition) fail(`self-test failed: ${message}`);
}

function fail(message) {
  console.error(`edge-deps: ${message}`);
  process.exit(1);
}
