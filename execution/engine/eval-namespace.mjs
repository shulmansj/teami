export function evalNamespacePaths(definition) {
  const namespace = normalizeEvalNamespace(definition?.eval_namespace);
  return Object.freeze({
    manifest: `${namespace}/phoenix-assets.json`,
    annotation_schema: `${namespace}/annotation.schema.json`,
    example_schema: `${namespace}/example.schema.json`,
    accepted_runtime: `${namespace}/accepted-runtime-roles.json`,
    proposals: `${namespace}/proposals`,
    policy: `${namespace}/promotion-policy.json`,
    variants: `${namespace}/variants.json`,
    taxonomy: `${namespace}/failure-taxonomy.json`,
  });
}

function normalizeEvalNamespace(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("eval_namespace_required");
  }
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/g, "");
  if (
    normalized === "."
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.startsWith("./")
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized.endsWith("/..")
    || normalized.includes("/./")
    || normalized.endsWith("/.")
  ) {
    throw new Error(`eval_namespace_must_be_repo_relative:${value}`);
  }
  return normalized;
}
