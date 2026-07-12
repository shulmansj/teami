import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  prepareTestHomeEnvironment,
  TEST_HOME_ROOT_ENV,
} from "./test-home-isolation.mjs";

const preloadUrl = pathToFileURL(path.join(import.meta.dirname, "_teami-home-isolation.mjs")).href;

test("runner environment drops inherited TEAMI_HOME and safely cleans its owned root", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-test-isolation-proof-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const prepared = prepareTestHomeEnvironment({
    env: { TEAMI_HOME: path.join(tempDir, "would-be-real-home"), SAMPLE: "kept" },
    tempDir,
  });

  assert.equal(prepared.childEnv.TEAMI_HOME, undefined);
  assert.equal(prepared.childEnv.SAMPLE, "kept");
  assert.equal(prepared.childEnv[TEST_HOME_ROOT_ENV], prepared.root);
  assert.equal(fs.existsSync(prepared.root), true);

  prepared.cleanup();
  assert.equal(fs.existsSync(prepared.root), false);
  assert.doesNotThrow(() => prepared.cleanup());
});

test("explicit disposable test root is respected but never deleted by the runner", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-explicit-test-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prepared = prepareTestHomeEnvironment({
    env: { [TEST_HOME_ROOT_ENV]: root },
  });
  assert.equal(prepared.root, path.resolve(root));
  assert.equal(prepared.ownsRoot, false);

  prepared.cleanup();
  assert.equal(fs.existsSync(root), true);
});

test("preload replaces an inherited user home, writes only below the disposable root, and cleans its child", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "teami-preload-proof-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const fakeRealHome = path.join(sandbox, "fake-real-home");
  const testRoot = path.join(sandbox, "explicit-test-root");
  fs.mkdirSync(fakeRealHome, { recursive: true });
  fs.writeFileSync(path.join(fakeRealHome, "sentinel.txt"), "must remain untouched\n", "utf8");

  const program = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const home = process.env.TEAMI_HOME;',
    'fs.writeFileSync(path.join(home, "test-write.txt"), "isolated\\n", "utf8");',
    'console.log(JSON.stringify({ home, sawSentinel: fs.existsSync(path.join(home, "sentinel.txt")) }));',
  ].join("");
  const result = spawnSync(
    process.execPath,
    ["--import", preloadUrl, "--input-type=module", "--eval", program],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEAMI_HOME: fakeRealHome,
        [TEST_HOME_ROOT_ENV]: testRoot,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.sawSentinel, false);
  assert.equal(isWithin(testRoot, proof.home), true);
  assert.notEqual(path.resolve(proof.home), path.resolve(fakeRealHome));
  assert.equal(fs.readFileSync(path.join(fakeRealHome, "sentinel.txt"), "utf8"), "must remain untouched\n");
  assert.equal(fs.existsSync(path.join(fakeRealHome, "test-write.txt")), false);
  assert.equal(fs.existsSync(proof.home), false, "preload-owned child home must be cleaned on exit");
  assert.equal(fs.existsSync(testRoot), true, "caller-owned test root must remain");
});

test("explicit test root rejects the inherited TEAMI_HOME and unsafe roots", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teami-test-root-rejection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => prepareTestHomeEnvironment({ env: { TEAMI_HOME: root, [TEST_HOME_ROOT_ENV]: root } }),
    /must not equal TEAMI_HOME/,
  );
  assert.throws(
    () => prepareTestHomeEnvironment({ env: { [TEST_HOME_ROOT_ENV]: "relative-test-home" } }),
    /must be an absolute disposable directory/,
  );
});

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
