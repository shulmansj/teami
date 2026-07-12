// Test preload (NOT a *.test.mjs — never discovered as a test).
//
// F2b relocated all engine state from repoRoot-relative `.teami/` to a per-user home
// resolved by resolveTeamiHome() (default: the OS app-data dir). node --test runs every
// test FILE in its own child process, concurrently. Without isolation, every test that
// touches state would read/write the developer's REAL home — polluting it and racing with
// the ~190 other concurrent files on one shared directory.
//
// This preload (wired via `node --test --import`) runs once per test-file process and
// points it at a fresh unique child of the runner's disposable test-home root.
// Result: each file gets its own isolated home (like the old per-test repoRoot isolation),
// the real home is never touched, and per-test `process.env.TEAMI_HOME = ...` overrides
// still win. The temp dir is left for the OS tmp reaper (cheap; avoids teardown races).
import { isMainThread } from "node:worker_threads";

import { allocateTestProcessHome } from "./test-home-isolation.mjs";

// Set UNCONDITIONALLY in the main test-file process: node --test forks a child process per
// file that inherits the runner's env, so an "if unset" guard would make every child reuse the
// runner's single home (shared → concurrent contention). Setting it per process gives each file
// its own home. Per-test `process.env.TEAMI_HOME = ...` in a test body still overrides this.
//
// SKIP in Worker threads: a test that spawns a Worker (e.g. the packaged-MCP launch test) passes
// the Worker its OWN TEAMI_HOME via the Worker `env` option; workers inherit execArgv (this
// --import), so setting TEAMI_HOME here would clobber that intentional value. Respect it.
if (isMainThread) {
  const allocated = allocateTestProcessHome();
  process.env.TEAMI_HOME = allocated.home;
  process.once("exit", allocated.cleanup);
}
