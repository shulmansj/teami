export const RUN_ARTIFACT_SCHEMA_VERSION = "teami-run-artifact/v1";
export const LEGACY_RUN_ARTIFACT_SCHEMA_VERSION = "linear-decomposition-run-artifact/v3";

// Three version axes that happen to share "0.2.0" today but evolve independently
// once a second function ships — keep them named for what they version:
//   - ENGINE_VERSION: the provider-neutral engine. The engine stamps it on each
//     per-turn orchestrator output (the `workflow_version` wire field — see
//     orchestrator-output.mjs) and uses it as the neutral run-artifact fallback.
//   - a FUNCTION's version: function-owned, declared by the definition
//     (DECOMPOSITION_FUNCTION_VERSION in the decomposition provider) and persisted
//     as the artifact's `function_version`. NOT sourced from an engine constant.
//   - PROCESS_VERSION: the self-improvement PROCESS version (process-change-gate,
//     promotion/experiment receipts). A process-machinery concept, not the engine
//     or function version.
export const ENGINE_VERSION = "0.2.0";
export const PROCESS_VERSION = "0.2.0";
