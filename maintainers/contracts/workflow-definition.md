# Workflow Definition Contract

Authored 2026-06-12 (Milestone A); **refreshed 2026-06-22 for the function-engine
generalization** (`../plans/2026-06-21-function-engine-generalization-plan.md`). Decomposition is
the FIRST and ONLY registered workflow; this contract describes the provider-neutral **engine** it
flows through, so the **execution** function (the committed next build) plugs in as `definition +
assets` without a rewrite. "Concepts generic, code narrow."

## The engine / provider boundary

The provider-neutral engine lives at `execution/engine/`. An automated test
(`test/engine-import-direction.test.mjs`) enforces the dependency arrow **provider → engine ONLY**:
no `execution/engine/**` module imports from `integrations/**`, a git provider, or
`node:child_process`. Generic machinery (the orchestrator loop, the contracts, run-store, the
registry, the run recorder, the commit-effect applier, the manifest-path + markdown + version
helpers) is engine-owned; Linear-specifics (the trigger-inbox, GraphQL, the decomposition
write-target) stay under `integrations/linear/`.

## The registry (provider self-registers — registry imports no provider)

`execution/engine/workflow-registry.mjs`:
- `registerWorkflow(definition)` — the provider self-registers as a load side-effect; the registry
  imports NO provider module (the engine→provider back-edge is inverted).
- `getWorkflowDefinition(workflowType)` → the definition, or **throws** `unknown_workflow_type:<type>`
  (fail closed, no default fallback).
- `registeredWorkflowTypes()`; `resetRegistry()` (test-only).

`integrations/linear/src/workflows/decomposition/definition.mjs` is the single place decomposition
describes itself; it WIRES existing modules (`run` is a lazy wrapper so loading the definition does
not pull the whole runner before registration).

## The definition shape (owned fields)

| field | decomposition value (wired, not duplicated) |
| --- | --- |
| `workflow_type` | `"decomposition"` |
| `triggers` | the `linear.project.planned` row (provider event type, object type, wake-key builder, `runner_required`) |
| `required_capabilities` | `["linear.project.planned", "decomposition.trigger_runner.v1"]` |
| `roles` | `["pm","sr_eng","judge","drafter","orchestrator"]` (source list) |
| **role facets** (runtime-role axis) | `driver:"orchestrator"`, `driver_governing_target_key`, `invocable_runtime_roles` (= roles − driver → `ONE_OFF_RUNTIME_ROLES`), `runtime_assignment_roles` (= all → `RESOLVABLE_RUNTIME_ROLES`), `engine_owned_evaluator_roles` (sourced from `JUDGE_ROLE_NAMES`) |
| `eligibility` | `evaluateDecompositionEligibility` |
| `commitPayload` | injected `{ assembleCommitPayload, validateCommitPayload, qualityGateInput }` (Seam 3) |
| `commit_effects` | the ordered effect list (Seam 5) — decomposition declares ONE coarse `linear_issues` effect at N=1 |
| `role_capabilities` | a PLACED attach point (write-credentials-absent invariant); body deferred to the execution build |
| `run` | the decomposition run entry (lazy wrapper over `runTriggeredDecomposition`) |
| `artifact_schema` | neutral envelope id `agentic-factory-run-artifact/v1` + `engine_version`/`function_version` |
| `eval_namespace` | `execution/evals/decomposition` (the manifest/accepted-runtime/proposals/policy/variants/taxonomy paths derive from here via `engine/eval-namespace.mjs`) |

The library **roster** is a SEPARATE axis — Phoenix-asset `target_key`s, not role names —
manifest-derived (`orchestrator-roster.isSelectableTarget`), excluding the driver + judge by
identity. It is NOT re-derived from role membership.

## The generic seams (provider-neutral)

- **Orchestrator loop** (`engine/orchestrator-loop.mjs`, `runOrchestratorLoop`): the free agent-driven
  loop; runtime/turn executors, the roster, the definition, the commit-payload module, and the span
  sink are CALLER-SUPPLIED (honest injection — only `spanSink` defaults null).
- **Generic-core vocabulary**: outcome set `{commit,pause,failed_closed}`, status `{continue,blocked}`,
  the single-sourced `(outcome→reasons)` map with a derived agent-choosable subset, neutral schema ids
  (`agentic-factory-orchestrator-*`).
- **Run-artifact envelope/payload split** (run-store): a generic envelope (engine-validated) carrying a
  function payload (`commitPayload.validateCommitPayload`); validates a NON-decomposition payload
  without `final_issues`. Legacy `linear-decomposition-run-artifact/v3` is migrated in-memory on read.
- **Ordered commit-effects applier** (`engine/commit-effects.mjs`): `probe → skip → apply → verify`;
  idempotent probes are the replay guard (`pending_effect_id` on partial failure, replay re-derives from
  the durable artifact). "The single commit" = one gated durable commit intent, not a cross-provider
  transaction.
- **Knob classification**: every behavioral knob is a Phoenix accepted asset OR factory-owned (see
  `behavioral-knob-ownership.md`). The config runtime/model bypass is closed: accepted defaults win;
  the judge (+ `engine_owned_evaluator_roles`) is NOT adopter-overridable; tunable-role overrides require
  the `AGENTIC_FACTORY_ALLOW_UNPINNED_RUNTIME` dev flag and emit `unpinned_runtime` + a Phoenix attribute
  (tunable ⟹ observable). `config.example.json` ships with per-role `{runtime,model}` removed.
- **Observability**: a span per orchestrator turn + per subagent turn (best-effort, never throws); the
  first orchestrator-turn span carries the run-config projection (persona accepted-version, per-role
  resolved `{runtime,model}` + provenance, `accepted_runtime_defaults_ref`, `max_rounds`).

## Dispatch rule

Every seam that names decomposition resolves through the registry: webhook-inbox routing +
`trigger-registry.mjs` (a thin adapter deriving its table from the registry), `trigger-runner` dispatch
(`getWorkflowDefinition(...).run`, fail closed), foreground-runner, capability derivation, `config.mjs`
role-name validation (`getWorkflowDefinition(type).roles`/`.runtime_assignment_roles`). The hosted
inbox function (`supabase/functions/agentic-factory-inbox/index.ts`) stays mirror-pinned; a parity test
asserts its hardcoded capabilities/workflow_type/wake-key equal the definition.

## `checkpoint` is legacy-READ (removal deferred)

`checkpoint` is a recognized run-artifact kind for READ + rejected-at-replay (pinned by tests). It is NOT
written by the current engine (the loop goes straight to a terminal `commit`/`pause`). Removal is
**deferred** until the version-skew migration proves no persisted artifact needs it.

## Out of scope (anti-speculation; place the seam, defer the machinery)

The execution function, its git write-target/effects + idempotency state table + cross-provider
ordering, its per-function run-artifact PAYLOAD shape, the PHYSICAL persona consolidation, the heavier
Phoenix projections, and the role **capability/tool-policy** BODY are NOT built — each has a placed
attach point only. No knob-ownership registry, no effect-transaction primitive, no manifest-path
registry, no engine-owned-target marker, no physical persona manifest entry.

## Acceptance

A synthetic second `workflow_type` (`definition + assets + a fake idempotent effect`) registers behind a
test-only seam and flows UNCHANGED through: registry dispatch, its OWN role-facet derivation (not
pm/sr_eng), generic-core contract validation, `eval_namespace` resolution, the run-store generic envelope
carrying a NON-decomposition payload, per-turn span emission, and the commit gate + effect applier —
**without importing Linear or git** (asserted by the import-direction test). Decomposition behavior is
unchanged per-wave; full `npm test` green; live validation N≥2 real commits.

## History

Milestone A (2026-06-12) made decomposition a registered workflow (registry + dispatch + config reshape
+ the linear-service split). The function-engine generalization (2026-06-22) extracted the
provider-neutral engine, inverted the registry edge, generalized the contracts (commit-payload, run-
artifact envelope, ordered effect-list), replaced fixed roles with definition facets, closed the
config bypass, added the per-turn observability floor, and bound the orchestrator persona by driver
identity — superseding Milestone A's deferred role-runtime carve-out (now generalized via the facets;
the next design point is the execution function's capability/tool policy).
