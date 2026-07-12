import fs from "node:fs";
import path from "node:path";

function noOp() {}

export function writeFileAndFsync(filePath, contents, { flag = "w", fsApi = fs } = {}) {
  let fd = null;
  let pendingError = null;
  try {
    fd = fsApi.openSync(filePath, flag);
    fsApi.writeFileSync(fd, contents, "utf8");
    fsApi.fsyncSync(fd);
  } catch (error) {
    pendingError = error;
  } finally {
    if (fd !== null) {
      try {
        fsApi.closeSync(fd);
      } catch (error) {
        if (!pendingError) pendingError = error;
      }
    }
  }
  if (pendingError) throw pendingError;
}

export function fsyncDirectoryAfterRename(
  dirPath,
  { fsApi = fs, platform = process.platform, committedFilePath = null } = {},
) {
  if (platform === "win32") {
    // Node cannot open an NTFS directory with FILE_FLAG_BACKUP_SEMANTICS. Flush the
    // committed file after rename instead; the rename remains atomic and recovery
    // always treats an absent directory entry as an interrupted write.
    if (!committedFilePath) return false;
    let fd = null;
    try {
      fd = fsApi.openSync(committedFilePath, "r+");
      fsApi.fsyncSync(fd);
      return false;
    } finally {
      if (fd !== null) fsApi.closeSync(fd);
    }
  }

  let fd = null;
  let pendingError = null;
  try {
    fd = fsApi.openSync(dirPath, "r");
    fsApi.fsyncSync(fd);
  } catch (error) {
    pendingError = error;
  } finally {
    if (fd !== null) {
      try {
        fsApi.closeSync(fd);
      } catch (error) {
        if (!pendingError) pendingError = error;
      }
    }
  }
  if (pendingError) throw pendingError;
  return true;
}

export function renameWithRetry(
  tempPath,
  filePath,
  { fsApi = fs, attempts = 5 } = {},
) {
  const retryable = new Set(["EPERM", "EACCES"]);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fsApi.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryable.has(error.code)) break;
    }
  }
  if (fsApi.existsSync(tempPath)) fsApi.rmSync(tempPath, { force: true });
  throw lastError;
}

export function writeAtomicFile({
  filePath,
  contents,
  validateTemp = null,
  validateCommitted = null,
  fsApi = fs,
  platform = process.platform,
  onBoundary = noOp,
} = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("atomic_file_path_required");
  }
  if (typeof contents !== "string") throw new Error("atomic_file_contents_must_be_string");

  const dirPath = path.dirname(filePath);
  fsApi.mkdirSync(dirPath, { recursive: true });
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let renamed = false;
  try {
    onBoundary("before_temp_write", { filePath, tempPath });
    writeFileAndFsync(tempPath, contents, { fsApi });
    onBoundary("after_temp_fsync", { filePath, tempPath });
    validateTemp?.(tempPath);
    onBoundary("after_temp_validation", { filePath, tempPath });
    renameWithRetry(tempPath, filePath, { fsApi });
    renamed = true;
    onBoundary("after_rename", { filePath, tempPath });
    const directoryFsynced = fsyncDirectoryAfterRename(dirPath, {
      fsApi,
      platform,
      committedFilePath: filePath,
    });
    onBoundary("after_directory_fsync", { filePath, tempPath, directoryFsynced });
    validateCommitted?.(filePath);
    onBoundary("after_committed_validation", { filePath, tempPath, directoryFsynced });
    return { written: true, filePath, directoryFsynced };
  } catch (error) {
    if (!renamed && fsApi.existsSync(tempPath)) fsApi.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function writeAtomicJson({
  filePath,
  value,
  validate = null,
  fsApi = fs,
  platform = process.platform,
  onBoundary = noOp,
} = {}) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const parseAndValidate = (candidatePath) => {
    const parsed = JSON.parse(fsApi.readFileSync(candidatePath, "utf8"));
    validate?.(parsed);
  };
  return writeAtomicFile({
    filePath,
    contents,
    validateTemp: parseAndValidate,
    validateCommitted: parseAndValidate,
    fsApi,
    platform,
    onBoundary,
  });
}
