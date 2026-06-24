import path from "node:path";

import { evalNamespacePaths } from "../../../../../engine/eval-namespace.mjs";
import { decompositionDefinition } from "./definition.mjs";

export const DECOMPOSITION_EVAL_PATHS = evalNamespacePaths(decompositionDefinition);
export const DECOMPOSITION_EVAL_NAMESPACE = path.posix.dirname(DECOMPOSITION_EVAL_PATHS.manifest);

export function decompositionEvalNamespacePath(fileName) {
  return `${DECOMPOSITION_EVAL_NAMESPACE}/${fileName}`;
}

export function resolveDecompositionEvalPath(repoRoot, repoRelativePath) {
  return path.resolve(repoRoot, repoRelativePath);
}
