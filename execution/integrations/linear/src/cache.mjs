import fs from "node:fs";
import path from "node:path";

export function readLinearCache(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  return JSON.parse(fs.readFileSync(cachePath, "utf8"));
}

export function writeLinearCache(cachePath, cache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}
