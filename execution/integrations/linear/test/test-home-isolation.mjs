import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_HOME_ROOT_ENV = "TEAMI_TEST_HOME";

const SUITE_ROOT_PREFIX = "teami-test-suite-";
const PROCESS_HOME_PREFIX = "teami-test-process-";

export function prepareTestHomeEnvironment({ env = process.env, tempDir = os.tmpdir() } = {}) {
  const inheritedRealHome = nonEmpty(env.TEAMI_HOME);
  const suppliedRoot = nonEmpty(env[TEST_HOME_ROOT_ENV]);
  const ownsRoot = suppliedRoot === null;
  const root = ownsRoot
    ? fs.mkdtempSync(path.join(path.resolve(tempDir), SUITE_ROOT_PREFIX))
    : ensureExplicitTestRoot(suppliedRoot, inheritedRealHome);

  const childEnv = { ...env, [TEST_HOME_ROOT_ENV]: root };
  delete childEnv.TEAMI_HOME;

  let cleaned = false;
  return {
    root,
    ownsRoot,
    childEnv,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (!ownsRoot) return;
      removeOwnedPath({ candidate: root, parent: tempDir, prefix: SUITE_ROOT_PREFIX });
    },
  };
}

export function allocateTestProcessHome({ env = process.env } = {}) {
  const rootValue = nonEmpty(env[TEST_HOME_ROOT_ENV]);
  if (rootValue === null) {
    throw new Error(`${TEST_HOME_ROOT_ENV} is required by the test-home preload`);
  }
  const root = ensureExplicitTestRoot(rootValue, nonEmpty(env.TEAMI_HOME));
  const home = fs.mkdtempSync(path.join(root, PROCESS_HOME_PREFIX));
  let cleaned = false;
  return {
    home,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      removeOwnedPath({ candidate: home, parent: root, prefix: PROCESS_HOME_PREFIX });
    },
  };
}

function ensureExplicitTestRoot(value, inheritedRealHome) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${TEST_HOME_ROOT_ENV} must be an absolute disposable directory`);
  }
  const root = path.resolve(value);
  if (inheritedRealHome !== null && samePath(root, inheritedRealHome)) {
    throw new Error(`${TEST_HOME_ROOT_ENV} must not equal TEAMI_HOME`);
  }
  if (path.parse(root).root === root) {
    throw new Error(`${TEST_HOME_ROOT_ENV} must not be a filesystem root`);
  }

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${TEST_HOME_ROOT_ENV} must be a real directory, not a link`);
  }
  return root;
}

function removeOwnedPath({ candidate, parent, prefix }) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    !path.basename(resolvedCandidate).startsWith(prefix)
  ) {
    throw new Error(`refusing unsafe test-home cleanup: ${resolvedCandidate}`);
  }
  fs.rmSync(resolvedCandidate, { recursive: true, force: true });
}

function nonEmpty(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
