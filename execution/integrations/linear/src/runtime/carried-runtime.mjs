import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import zlib from "node:zlib";

export const CARRIED_RUNTIME_CURRENT_DIRNAME = "current";
const DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TAR_METADATA_BYTES = 1024 * 1024;

export async function ensureCarriedRuntime({
  runtimeDir,
  manifestPath,
  platformKey = `${process.platform}-${process.arch}`,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  downloadTimeoutMs = DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS,
} = {}) {
  let extractDir = null;
  let failureReason = "runtime_fetch_failed";
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

    failureReason = "runtime_extract_failed";
    removeStaleExtractionDirs(downloadDir, `${assetName}.extract-`);
    extractDir = path.join(downloadDir, `${assetName}.extract-${process.pid}-${Date.now()}`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    onProgress("Extracting carried runtime...");
    await extractTarGz(partPath, extractDir);

    failureReason = "runtime_install_failed";
    installExtractedRuntime({ runtimeDir, extractDir });
    cacheRuntimeManifest({ runtimeDir, manifestPath });
    fs.rmSync(partPath, { force: true });
    return { ok: true, manifestEntry };
  } catch (error) {
    const partialExtractionCleared = removeExtractionDirBestEffort(extractDir);
    return {
      ok: false,
      reason: failureReason,
      repairHint: runtimeRepairHint(error, failureReason, { partialExtractionCleared }),
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
  let globalPax = {};
  let nextEntryPax = {};

  try {
    for await (const chunk of gunzip) {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (!current) {
          if (buffer.length < 512) break;
          const header = buffer.subarray(0, 512);
          buffer = buffer.subarray(512);
          if (isZeroBlock(header)) return;
          current = openTarEntry(header, destDir, {
            path: effectivePaxValue(globalPax, nextEntryPax, "path"),
            linkpath: effectivePaxValue(globalPax, nextEntryPax, "linkpath"),
            size: effectivePaxValue(globalPax, nextEntryPax, "size"),
          });
          if (!current.metadataType) nextEntryPax = {};
        }

        const done = writeTarEntryChunk(current, buffer);
        buffer = buffer.subarray(done.consumed);
        if (!done.entryComplete) break;
        const metadata = closeTarEntry(current);
        if (current.metadataType === "pax_global") {
          globalPax = applyPaxRecords(globalPax, parsePaxRecords(metadata));
        } else if (current.metadataType === "pax_local") {
          nextEntryPax = applyPaxRecords(nextEntryPax, parsePaxRecords(metadata));
        } else if (current.metadataType === "gnu_long_path") {
          nextEntryPax.path = tarMetadataString(metadata);
        } else if (current.metadataType === "gnu_long_link") {
          nextEntryPax.linkpath = tarMetadataString(metadata);
        }
        current = null;
      }
    }
    if (current && (current.remaining > 0 || current.padding > 0)) {
      throw new Error("runtime archive ended mid-entry");
    }
  } catch (error) {
    closeTarEntryBestEffort(current);
    throw error;
  }
}

function openTarEntry(header, destDir, overrides = {}) {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  const entryName = overrides.path || (prefix ? `${prefix}/${name}` : name);
  const headerSize = parseTarOctal(header, 124, 12, "size");
  const mode = parseTarOctal(header, 100, 8, "mode");
  const type = tarString(header, 156, 1) || "0";
  const linkName = overrides.linkpath || tarString(header, 157, 100);

  const metadataType = {
    x: "pax_local",
    g: "pax_global",
    L: "gnu_long_path",
    K: "gnu_long_link",
  }[type];
  if (metadataType) {
    if (headerSize > MAX_TAR_METADATA_BYTES) {
      throw new Error("runtime archive metadata entry is too large");
    }
    return {
      remaining: headerSize,
      padding: paddingForTarSize(headerSize),
      fd: null,
      skip: false,
      metadataType,
      metadataChunks: [],
    };
  }

  const size = overrides.size === undefined ? headerSize : parsePaxDecimal(overrides.size, "size");
  if (!["0", "\0", "1", "2", "5", "7"].includes(type)) {
    throw new Error(`runtime archive entry type is unsupported:${type}`);
  }

  const targetPath = safeExtractPath(destDir, entryName);
  const safeMode = mode & 0o777;

  if (type === "5") {
    if (size !== 0) throw new Error("runtime archive directory entry has content");
    assertNoSymlinkPathComponents(destDir, targetPath);
    fs.mkdirSync(targetPath, { recursive: true, mode: safeMode });
    return { remaining: 0, padding: paddingForTarSize(size), fd: null, skip: true };
  }

  if (type === "2") {
    if (size !== 0) throw new Error("runtime archive symlink entry has content");
    assertNoSymlinkPathComponents(destDir, targetPath, { includeTarget: false });
    safeSymlinkTarget(destDir, targetPath, linkName);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      fs.symlinkSync(linkName, targetPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = fs.lstatSync(targetPath);
      if (!existing.isSymbolicLink() || fs.readlinkSync(targetPath) !== linkName) throw error;
    }
    return { remaining: 0, padding: paddingForTarSize(size), fd: null, skip: true };
  }

  if (type === "1") {
    if (size !== 0) throw new Error("runtime archive hardlink entry has content");
    assertNoSymlinkPathComponents(destDir, targetPath);
    const sourcePath = safeExtractPath(destDir, linkName);
    assertNoSymlinkPathComponents(destDir, sourcePath);
    const source = lstatIfPresent(sourcePath);
    if (!source?.isFile()) throw new Error("runtime archive hardlink source is unavailable");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.linkSync(sourcePath, targetPath);
    return { remaining: 0, padding: 0, fd: null, skip: true };
  }

  assertNoSymlinkPathComponents(destDir, targetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const fd = fs.openSync(targetPath, "w", safeMode);
  return { remaining: size, padding: paddingForTarSize(size), fd, skip: false };
}

function writeTarEntryChunk(entry, buffer) {
  let consumed = 0;
  if (entry.remaining > 0) {
    const bytesToWrite = Math.min(entry.remaining, buffer.length);
    if (bytesToWrite > 0 && !entry.skip) {
      if (entry.metadataType) {
        entry.metadataChunks.push(Buffer.from(buffer.subarray(0, bytesToWrite)));
      } else {
        fs.writeSync(entry.fd, buffer, 0, bytesToWrite);
      }
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
  if (entry.fd !== null) {
    const fd = entry.fd;
    entry.fd = null;
    fs.closeSync(fd);
  }
  return entry.metadataType ? Buffer.concat(entry.metadataChunks) : null;
}

function closeTarEntryBestEffort(entry) {
  if (entry?.fd === null || entry?.fd === undefined) return;
  const fd = entry.fd;
  entry.fd = null;
  try {
    fs.closeSync(fd);
  } catch {
    // Preserve the original archive failure; cleanup remains best effort.
  }
}

function parsePaxRecords(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error("runtime archive has an invalid PAX record length");
    const lengthText = buffer.subarray(offset, space).toString("ascii");
    if (!/^\d+$/.test(lengthText)) throw new Error("runtime archive has an invalid PAX record length");
    const recordLength = Number.parseInt(lengthText, 10);
    const recordEnd = offset + recordLength;
    if (!Number.isSafeInteger(recordLength) || recordLength <= space - offset + 1 || recordEnd > buffer.length) {
      throw new Error("runtime archive has a truncated PAX record");
    }
    const payloadEnd = buffer[recordEnd - 1] === 0x0a ? recordEnd - 1 : recordEnd;
    const payload = buffer.subarray(space + 1, payloadEnd).toString("utf8");
    const separator = payload.indexOf("=");
    if (separator <= 0) throw new Error("runtime archive has an invalid PAX record");
    records[payload.slice(0, separator)] = payload.slice(separator + 1);
    offset = recordEnd;
  }
  return records;
}

function applyPaxRecords(current, records) {
  const next = { ...current };
  for (const [key, value] of Object.entries(records)) {
    next[key] = value === "" ? null : value;
  }
  return next;
}

function effectivePaxValue(globalPax, localPax, key) {
  if (Object.prototype.hasOwnProperty.call(localPax, key)) return localPax[key] ?? undefined;
  return globalPax[key] ?? undefined;
}

function tarMetadataString(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8").replace(/\n$/, "");
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

function removeStaleExtractionDirs(downloadDir, prefix) {
  for (const entry of fs.readdirSync(downloadDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const identity = entry.name.slice(prefix.length).match(/^(\d+)-(\d+)$/);
    if (!identity || processIsAlive(Number(identity[1]))) continue;
    removeExtractionDirBestEffort(safeExtractPath(downloadDir, entry.name));
  }
}

function removeExtractionDirBestEffort(extractDir) {
  if (!extractDir) return true;
  try {
    fs.rmSync(extractDir, { recursive: true, force: true });
    return !fs.existsSync(extractDir);
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  if (!entryName || path.isAbsolute(entryName) || path.posix.isAbsolute(entryName) || path.win32.isAbsolute(entryName) || entryName.split(/[\\/]+/).includes("..")) {
    throw new Error(`unsafe runtime archive path:${entryName}`);
  }
  const targetPath = path.join(destDir, entryName);
  const relative = path.relative(destDir, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`unsafe runtime archive path:${entryName}`);
  }
  return targetPath;
}

function safeSymlinkTarget(destDir, targetPath, linkName) {
  if (!linkName || path.isAbsolute(linkName) || path.posix.isAbsolute(linkName) || path.win32.isAbsolute(linkName)) {
    throw new Error("unsafe runtime archive symlink target");
  }
  const resolvedTarget = path.resolve(path.dirname(targetPath), linkName);
  const relative = path.relative(path.resolve(destDir), resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("unsafe runtime archive symlink target");
  }
}

function assertNoSymlinkPathComponents(destDir, targetPath, { includeTarget = true } = {}) {
  const root = path.resolve(destDir);
  const relative = path.relative(root, path.resolve(targetPath));
  const segments = relative.split(path.sep).filter(Boolean);
  const count = includeTarget ? segments.length : Math.max(0, segments.length - 1);
  let cursor = root;
  for (let index = 0; index < count; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const entry = lstatIfPresent(cursor);
    if (entry?.isSymbolicLink()) {
      throw new Error("runtime archive path crosses a symlink");
    }
  }
}

function lstatIfPresent(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function tarString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8").trim();
}

function parseTarOctal(buffer, offset, length, field) {
  const value = tarString(buffer, offset, length).trim() || "0";
  if (!/^[0-7]+$/.test(value)) throw new Error(`runtime archive has an invalid ${field}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`runtime archive has an invalid ${field}`);
  return parsed;
}

function parsePaxDecimal(value, field) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`runtime archive has an invalid PAX ${field}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`runtime archive has an invalid PAX ${field}`);
  }
  return parsed;
}

function paddingForTarSize(size) {
  return (512 - (size % 512)) % 512;
}

function isZeroBlock(buffer) {
  return buffer.every((byte) => byte === 0);
}

function runtimeRepairHint(error, reason, { partialExtractionCleared = true } = {}) {
  if (reason === "runtime_extract_failed") {
    return partialExtractionCleared
      ? "Teami could not unpack the verified local trace runtime. It cleared the partial extraction; rerun Teami setup. If this repeats, check free disk space and local security software before reporting a Teami packaging problem."
      : "Teami could not unpack the verified local trace runtime or clear the partial extraction. Close programs using the Teami runtime, then rerun Teami setup.";
  }
  if (reason === "runtime_install_failed") {
    return "Teami unpacked the local trace runtime but could not activate it. Rerun Teami setup; if this repeats, close programs using the Teami runtime and retry.";
  }
  if (/checksum mismatch/i.test(error?.message || "")) {
    return "The local trace runtime download did not match its pinned manifest, so Teami discarded it. Rerun Teami setup to download a clean copy.";
  }
  if (/timed out after \d+ms/i.test(error?.message || "")) {
    const duration = String(error.message).match(/timed out after \d+ms/i)?.[0] || "timed out";
    return `The local trace runtime download ${duration}. Check access to GitHub Releases, then rerun Teami setup; the download will resume safely.`;
  }
  return "Retry the Teami runtime download by rerunning Teami setup. If it still fails, check access to GitHub Releases; partial downloads resume safely.";
}
