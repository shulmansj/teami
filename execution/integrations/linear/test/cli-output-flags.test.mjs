import assert from "node:assert/strict";
import test from "node:test";

import { extractCliOutputFlags } from "../src/cli/dispatch.mjs";

test("peels global output flags from a leading run", () => {
  const result = extractCliOutputFlags(["--verbose", "--no-color", "--workspace", "Acme"]);
  assert.deepEqual(result.args, ["--workspace", "Acme"]);
  assert.equal(result.verbose, true);
  assert.equal(result.noColor, true);
  assert.equal(result.ascii, false);
});

test("peels global output flags from a trailing run, preserving a command flag's value", () => {
  const result = extractCliOutputFlags(["--workspace", "Acme", "--verbose", "--ascii"]);
  assert.deepEqual(result.args, ["--workspace", "Acme"]);
  assert.equal(result.verbose, true);
  assert.equal(result.ascii, true);
  assert.equal(result.noColor, false);
});

test("never retokenizes the middle: an interleaved global-flag token passes through verbatim", () => {
  // `--workspace --verbose Acme` must reach the command parser unchanged; consuming the
  // middle `--verbose` would silently turn `Acme` into `--workspace`'s value.
  const result = extractCliOutputFlags(["--workspace", "--verbose", "Acme"]);
  assert.deepEqual(result.args, ["--workspace", "--verbose", "Acme"]);
  assert.equal(result.verbose, false);
});

test("returns args unchanged when there are no global output flags", () => {
  const result = extractCliOutputFlags(["--domain", "d1"]);
  assert.deepEqual(result.args, ["--domain", "d1"]);
  assert.equal(result.verbose, false);
  assert.equal(result.noColor, false);
  assert.equal(result.ascii, false);
});
