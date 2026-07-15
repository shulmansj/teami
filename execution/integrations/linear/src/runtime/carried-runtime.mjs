import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import zlib from "node:zlib";

export const CARRIED_RUNTIME_CURRENT_DIRNAME = "current";
const DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export async function ensureCarriedRuntime({
  runtimeDir,
  manifestPath,
  platformKey = `${process.platform}-${process.arch}`,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  downloadTimeoutMs = DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS,
} = {}) {
  try {
    if (typeof runtimeDir !== "string" || runtimeDir.trim() === "") {
      throw new Error("runtimeDir is required");
    }
    if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
      throw new Error("manifestPath is required");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl is required");
    }

    const manifest = readRuntimeManifest(manifestPath);
    const manifestEntry = manifest.platforms?.[platformKey];
    if (!manifestEntry) {
      throw new Error(`unsupported runtime platform:${platformKey}`);
    }
    validateManifestEntry(manifestEntry);

    fs.mkdirSync(runtimeDir, { recursive: true });
    if (isRuntimeCurrent({ runtimeDir, manifestEntry })) {
      return { ok: true, manifestEntry };
    }

    const assetName = assetNameFromUrl(manifestEntry.asset_url);
    const downloadDir = path.join(runtimeDir, ".download");
    const partPath = path.join(downloadDir, `${assetName}.part`);
    fs.mkdirSync(downloadDir, { recursive: true });

    await downloadRuntimeAsset({
      manifestEntry,
      partPath,
      assetName,
      fetchImpl,
      onProgress,
      timeoutMs: downloadTimeoutMs,
    });

    const actualSize = fs.statSync(partPath).size;
    if (actualSize !== manifestEntry.size_bytes) {
      if (actualSize > manifestEntry.size_bytes) {
        fs.rmSync(partPath, { force: true });
      }
      throw new Error(`runtime size mismatch: expected ${manifestEntry.size_bytes}, received ${actualSize}`);
    }

    const actualSha256 = await sha256File(partPath);
    if (actualSha256 !== manifestEntry.sha256) {
      fs.rmSync(partPath, { force: true });
      throw new Error("runtime checksum mismatch");
    }

    const extractDir = path.join(downloadDir, `${assetName}.extract-${process.pid}-${Date.now()}`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    onProgress("Extracting carried runtime...");
    await extractTarGz(partPath, extractDir);

    installExtractedRuntime({ runtimeDir, extractDir });
    cacheRuntimeManifest({ runtimeDir, manifestPath });
    fs.rmSync(partPath, { force: true });
    return { ok: true, manifestEntry };
  } catch (error) {
    return {
      ok: false,
      reason: "runtime_fetch_failed",
      repairHint: runtimeRepairHint(error),
    };
  }
}

function readRuntimeManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest?.schema_version !== 1) throw new Error("unsupported runtime manifest schema");
  if (manifest.phoenix_package !== "arize-phoenix==14.13.0") {
    throw new Error("unexpected Phoenix package in runtime manifest");
  }
  if (manifest.python_tag !== "cpython-3.12.13+20260623") {
    throw new Error("unexpected Python tag in runtime manifest");
  }
  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    throw new Error("runtime manifest missing platforms");
  }
  return manifest;
}

function validateManifestEntry(entry) {
  if (typeof entry.asset_url !== "string" || !entry.asset_url.startsWith("https://github.com/shulmansj/teami/releases/download/")) {
    throw new Error("runtime manifest entry has invalid asset_url");
  }
  if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes <= 0) {
    throw new Error("runtime manifest entry has invalid size_bytes");
  }
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error("runtime manifest entry has invalid sha256");
  }
  if (typeof entry.source_commit !== "string" || entry.source_commit.trim() === "") {
    throw new Error("runtime manifest entry has invalid source_commit");
  }
}

function isRuntimeCurrent({ runtimeDir, manifestEntry }) {
  const currentDir = path.join(runtimeDir, CARRIED_RUNTIME_CURRENT_DIRNAME);
  const cachedManifestPath = path.join(runtimeDir, "runtime-manifest.json");
  if (!fs.existsSync(currentDir) || !fs.existsSync(cachedManifestPath)) return false;
  try {
    const cached = JSON.parse(fs.readFileSync(cachedManifestPath, "utf8"));
    const cachedEntry = Object.values(cached.platforms || {}).find((entry) => entry.sha256 === manifestEntry.sha256);
    return Boolean(cachedEntry && cachedEntry.size_bytes === manifestEntry.size_bytes);
  } catch {
    return false;
  }
}

async function downloadRuntimeAsset({ manifestEntry, partPath, assetName, fetchImpl, onProgress, timeoutMs }) {
  let resumeFrom = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
  if (resumeFrom >= manifestEntry.size_bytes) {
    if (resumeFrom === manifestEntry.size_bytes && (await sha256File(partPath)) === manifestEntry.sha256) return;
    fs.rmSync(partPath, { force: true });
    resumeFrom = 0;
  }

  const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
  onProgress(resumeFrom > 0 ? `Resuming carried runtime download at byte ${resumeFrom}...` : "Downloading carried runtime...");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("runtime download timeout must be positive");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(manifestEntry.asset_url, { headers, signal: controller.signal });
    if (!response || !response.ok) {
      throw new Error(`runtime download failed:${response?.status || "no_response"}`);
    }

    const append = resumeFrom > 0 && response.status === 206;
    if (resumeFrom > 0 && response.status !== 206) {
      resumeFrom = 0;
    }
    await writeResponseBody(response, partPath, { append, initialBytes: resumeFrom });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`runtime download timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const size = fs.statSync(partPath).size;
  if (size < manifestEntry.size_bytes) {
    throw new Error(`runtime download incomplete:${assetName}`);
  }
}

async function writeResponseBody(response, partPath, { append, initialBytes }) {
  const output = fs.createWriteStream(partPath, { flags: append ? "a" : "w" });
  if (response.body && typeof Readable.fromWeb === "function") {
    await pipeline(Readable.fromWeb(response.body), output);
    return;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await new Promise((resolve, reject) => {
    output.on("error", reject);
    output.end(bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (initialBytes + bytes.length !== fs.statSync(partPath).size) {
    throw new Error("runtime download write failed");
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function extractTarGz(archivePath, destDir) {
  const gunzip = fs.createReadStream(archivePath).pipe(zlib.createGunzip());
  let buffer = Buffer.alloc(0);
  let current = null;

  for await (const chunk of gunzip) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (!current) {
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (isZeroBlock(header)) return;
        current = openTarEntry(header, destDir);
      }

      const done = writeTarEntryChunk(current, buffer);
      buffer = buffer.subarray(done.consumed);
      if (!done.entryComplete) break;
      closeTarEntry(current);
      current = null;
    }
  }

  if (current && current.remaining > 0) throw new Error("runtime archive ended mid-entry");
}

function openTarEntry(header, destDir) {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  const entryName = prefix ? `${prefix}/${name}` : name;
  const size = parseInt(tarString(header, 124, 12).trim() || "0", 8);
  const type = tarString(header, 156, 1) || "0";
  const linkName = tarString(header, 157, 100);
  const targetPath = safeExtractPath(destDir, entryName);

  if (type === "5") {
    fs.mkdirSync(targetPath, { recursive: true });
    return { remaining: 0, padding: paddingForTarSize(size), fd: null, skip: true };
  }

  if (type === "2") {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      fs.symlinkSync(linkName, targetPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return { remaining: 0, padding: paddingForTarSize(size), fd: null, skip: true };
  }

  if (type !== "0" && type !== "\0") {
    return { remaining: size, padding: paddingForTarSize(size), fd: null, skip: true };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const fd = fs.openSync(targetPath, "w");
  return { remaining: size, padding: paddingForTarSize(size), fd, skip: false };
}

function writeTarEntryChunk(entry, buffer) {
  let consumed = 0;
  if (entry.remaining > 0) {
    const bytesToWrite = Math.min(entry.remaining, buffer.length);
    if (bytesToWrite > 0 && !entry.skip) {
      fs.writeSync(entry.fd, buffer, 0, bytesToWrite);
    }
    consumed += bytesToWrite;
    entry.remaining -= bytesToWrite;
  }

  if (entry.remaining > 0) return { consumed, entryComplete: false };

  const paddingToConsume = Math.min(entry.padding, buffer.length - consumed);
  consumed += paddingToConsume;
  entry.padding -= paddingToConsume;
  return { consumed, entryComplete: entry.padding === 0 };
}

function closeTarEntry(entry) {
  if (entry.fd !== null) fs.closeSync(entry.fd);
}

function installExtractedRuntime({ runtimeDir, extractDir }) {
  const targetDir = path.join(runtimeDir, CARRIED_RUNTIME_CURRENT_DIRNAME);
  const backupDir = path.join(runtimeDir, `.previous-${process.pid}-${Date.now()}`);
  if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backupDir);
  try {
    fs.renameSync(extractDir, targetDir);
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
      fs.renameSync(backupDir, targetDir);
    }
    throw error;
  }
}

function cacheRuntimeManifest({ runtimeDir, manifestPath }) {
  const target = path.join(runtimeDir, "runtime-manifest.json");
  const tmp = `${target}.${process.pid}.tmp`;
  fs.copyFileSync(manifestPath, tmp);
  fs.renameSync(tmp, target);
}

function assetNameFromUrl(assetUrl) {
  const url = new URL(assetUrl);
  const assetName = path.posix.basename(url.pathname);
  if (!assetName || assetName === "." || assetName === "/") {
    throw new Error("runtime manifest asset_url has no asset name");
  }
  return decodeURIComponent(assetName);
}

function safeExtractPath(destDir, entryName) {
  if (!entryName || path.isAbsolute(entryName) || entryName.split(/[\\/]+/).includes("..")) {
    throw new Error(`unsafe runtime archive path:${entryName}`);
  }
  const targetPath = path.join(destDir, entryName);
  const relative = path.relative(destDir, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`unsafe runtime archive path:${entryName}`);
  }
  return targetPath;
}

function tarString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8").trim();
}

function paddingForTarSize(size) {
  return (512 - (size % 512)) % 512;
}

function isZeroBlock(buffer) {
  return buffer.every((byte) => byte === 0);
}

function runtimeRepairHint(error) {
  const detail = error?.message ? ` (${error.message})` : "";
  return `Retry the Teami runtime download; if it keeps failing, check network access to GitHub Releases and remove the partial runtime download.${detail}`;
}
