import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import { teamiHomePaths } from "../src/app-home.mjs";
import { ensureCarriedRuntime } from "../src/runtime/carried-runtime.mjs";
import {
  phoenixExecutablePath,
  phoenixPythonPath,
  resolvePhoenixConfig,
} from "../src/local-phoenix-manager.mjs";

const packagedManifestPath = path.resolve(
  import.meta.dirname,
  "../src/runtime/runtime-manifest.json",
);

test("runtime manifest matches Contract 3 and resolves by platform-arch key", () => {
  const manifest = JSON.parse(fs.readFileSync(packagedManifestPath, "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.phoenix_package, "arize-phoenix==14.13.0");
  assert.equal(manifest.python_tag, "cpython-3.12.13+20260623");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"]);

  const expected = {
    "darwin-arm64": {
      asset: "teami-phoenix-runtime-cpython-3.12.13+20260623-darwin-arm64.tar.gz",
      size_bytes: 224776165,
      sha256: "92a400cfae52b7409be368bcbe81281ac9d410dbc43440a898182639e02f503c",
    },
    "darwin-x64": {
      asset: "teami-phoenix-runtime-cpython-3.12.13+20260623-darwin-x64.tar.gz",
      size_bytes: 238648023,
      sha256: "751d3d92982f79dd8471158b24bf8cbc8d99be009f774e4a315d597a2016ee2f",
    },
    "win32-x64": {
      asset: "teami-phoenix-runtime-cpython-3.12.13+20260623-win32-x64.tar.gz",
      size_bytes: 245367107,
      sha256: "8f2d0d193a412a86fdc3fe052fdea7e971621e6f996752a698d6e43e0a1c0853",
    },
  };

  for (const [platformKey, entry] of Object.entries(manifest.platforms)) {
    assert.equal(entry.source_commit, "01e476d78f3c0472c95a91cbb947be890bcd6570");
    assert.equal(entry.size_bytes, expected[platformKey].size_bytes);
    assert.equal(entry.sha256, expected[platformKey].sha256);
    assert.equal(entry.asset_url.includes("/releases/expanded_assets/"), false);
    assert.match(
      entry.asset_url,
      new RegExp(`^https://github\\.com/shulmansj/teami/releases/download/[^/]+/${escapeRegExp(expected[platformKey].asset)}$`),
    );
  }

  const hostPlatformKey = `${process.platform}-${process.arch}`;
  if (["darwin-arm64", "darwin-x64", "win32-x64"].includes(hostPlatformKey)) {
    assert.ok(manifest.platforms[hostPlatformKey]);
  } else {
    assert.equal(manifest.platforms[hostPlatformKey], undefined);
  }
});

test("carried runtime fetch resumes a .part download, verifies checksum, and installs atomically", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-carried-runtime-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const archive = buildFixtureArchive({
    "bin/python": "fixture python",
    "bin/phoenix": "fixture phoenix",
  });
  const { manifestPath, manifestEntry } = writeFixtureManifest({ tempDir, archive });
  const downloadDir = path.join(runtimeDir, ".download");
  fs.mkdirSync(downloadDir, { recursive: true });
  const partialBytes = Math.floor(archive.length / 3);
  const partPath = path.join(downloadDir, "fixture-runtime.tar.gz.part");
  fs.writeFileSync(partPath, archive.subarray(0, partialBytes));

  const calls = [];
  const result = await ensureCarriedRuntime({
    runtimeDir,
    manifestPath,
    platformKey: "darwin-arm64",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      return new Response(archive.subarray(partialBytes), { status: 206 });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.manifestEntry, manifestEntry);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, manifestEntry.asset_url);
  assert.equal(calls[0].headers.Range, `bytes=${partialBytes}-`);
  assert.equal(fs.existsSync(partPath), false);
  assert.equal(fs.readFileSync(path.join(runtimeDir, "current", "bin", "python"), "utf8"), "fixture python");
  assert.equal(fs.readFileSync(path.join(runtimeDir, "current", "bin", "phoenix"), "utf8"), "fixture phoenix");
  assert.equal(fs.existsSync(path.join(runtimeDir, "runtime-manifest.json")), true);
});

test("carried runtime rejects a completed download whose checksum does not match", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-carried-runtime-bad-sha-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const archive = buildFixtureArchive({ "bin/python": "fixture python" });
  const { manifestPath } = writeFixtureManifest({
    tempDir,
    archive,
    sha256: "0".repeat(64),
  });

  const result = await ensureCarriedRuntime({
    runtimeDir,
    manifestPath,
    platformKey: "darwin-arm64",
    fetchImpl: async () => new Response(archive, { status: 200 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "runtime_fetch_failed");
  assert.match(result.repairHint, /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(runtimeDir, "current")), false);
});

test("carried runtime aborts a stalled download within its configured bound", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-carried-runtime-timeout-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const archive = buildFixtureArchive({ "bin/python": "fixture python" });
  const { manifestPath } = writeFixtureManifest({ tempDir, archive });
  let receivedSignal = null;

  const result = await ensureCarriedRuntime({
    runtimeDir,
    manifestPath,
    platformKey: "darwin-arm64",
    downloadTimeoutMs: 20,
    fetchImpl: async (_url, { signal }) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "runtime_fetch_failed");
  assert.equal(receivedSignal.aborted, true);
  assert.match(result.repairHint, /timed out after 20ms/);
});

test("Windows carried runtime fixture preserves side-by-side VC++ runtime DLLs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teami-carried-runtime-win-"));
  const runtimeDir = path.join(tempDir, "runtime");
  const archive = buildFixtureArchive({
    "Scripts/python.exe": "fixture python exe",
    "Scripts/phoenix.exe": "fixture phoenix exe",
    "vcruntime140.dll": "fixture vc runtime",
    "vcruntime140_1.dll": "fixture vc runtime 1",
  });
  const { manifestPath } = writeFixtureManifest({
    tempDir,
    archive,
    platformKey: "win32-x64",
  });

  const result = await ensureCarriedRuntime({
    runtimeDir,
    manifestPath,
    platformKey: "win32-x64",
    fetchImpl: async () => new Response(archive, { status: 200 }),
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(runtimeDir, "current", "Scripts", "python.exe")), true);
  assert.equal(fs.existsSync(path.join(runtimeDir, "current", "Scripts", "phoenix.exe")), true);
  assert.equal(fs.existsSync(path.join(runtimeDir, "current", "vcruntime140.dll")), true);
  assert.equal(fs.existsSync(path.join(runtimeDir, "current", "vcruntime140_1.dll")), true);
});

test("Phoenix config points python and phoenix at the carried runtime, not the old venv", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teami-phoenix-runtime-home-"));
  const config = resolvePhoenixConfig({ home, env: {} });
  const runtimeDir = teamiHomePaths({ home }).runtimeDir;
  assert.equal(config.runtimeDir, runtimeDir);

  const expectedPython = process.platform === "win32"
    ? path.join(runtimeDir, "current", "Scripts", "python.exe")
    : path.join(runtimeDir, "current", "bin", "python");
  const expectedPhoenix = process.platform === "win32"
    ? path.join(runtimeDir, "current", "Scripts", "phoenix.exe")
    : path.join(runtimeDir, "current", "bin", "phoenix");

  assert.equal(phoenixPythonPath(config), expectedPython);
  assert.equal(phoenixExecutablePath(config), expectedPhoenix);
  assert.equal(phoenixPythonPath(config).startsWith(config.venvDir), false);
  assert.equal(phoenixExecutablePath(config).startsWith(config.venvDir), false);
});

function writeFixtureManifest({ tempDir, archive, sha256 = sha256Buffer(archive), platformKey = "darwin-arm64" }) {
  const manifestEntry = {
    asset_url: "https://github.com/shulmansj/teami/releases/download/test-runtime/fixture-runtime.tar.gz",
    size_bytes: archive.length,
    sha256,
    source_commit: "fixture",
  };
  const manifest = {
    schema_version: 1,
    phoenix_package: "arize-phoenix==14.13.0",
    python_tag: "cpython-3.12.13+20260623",
    platforms: {
      [platformKey]: manifestEntry,
    },
  };
  const manifestPath = path.join(tempDir, "runtime-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifestEntry };
}

function buildFixtureArchive(entries) {
  const chunks = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content, "utf8");
    chunks.push(tarHeader({ name, size: body.length }));
    chunks.push(body);
    chunks.push(Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function tarHeader({ name, size }) {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, name, 0, 100);
  writeTarString(header, "0000777", 100, 8);
  writeTarString(header, "0000000", 108, 8);
  writeTarString(header, "0000000", 116, 8);
  writeTarString(header, size.toString(8).padStart(11, "0"), 124, 12);
  writeTarString(header, "00000000000", 136, 12);
  header.fill(0x20, 148, 156);
  writeTarString(header, "0", 156, 1);
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, checksum.toString(8).padStart(6, "0"), 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTarString(header, value, offset, length) {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(header, offset, 0, Math.min(bytes.length, length));
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
