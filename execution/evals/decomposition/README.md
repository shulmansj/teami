# Decomposition Eval Contracts

This directory is the canonical, repo-owned home of the decomposition eval
contracts: what a dataset example looks like, what an annotation means, which
failure modes exist, which Phoenix assets are accepted, and how accepted
behavior changes.

## Ownership boundary

The repo is the system of record for **accepted behavior**: rubric intent, the
failure taxonomy, schemas, gates, runtime rules, accepted prompt pins and
snapshots, promoted regression fixtures, and accepted process-change PRs.

Phoenix is the system of record for **eval observations and assets only**:
traces, annotations, harvested datasets, experiment runs, candidate prompt
versions, and prompt-version tags.

The wipe test, applied before any Phoenix write: if losing Phoenix would lose
"which behavior is accepted, what queue is pending, or what runtime config to
use", that state must not live in Phoenix. Phoenix annotations are judgments,
never task flags; no workflow/queue state (pending promotion, needs relabel,
worklist status, scanner status) is ever written to Phoenix. Phoenix outcome
annotations record only actual controller outcomes and are observability,
never authority.

There is no third eval UI. Phoenix, the agent session, Linear, and GitHub are
the only surfaces.

Local Phoenix is local custody: if its state is lost, human annotations,
calibration examples, and test-split exposure history may be lost with it.
That is why every new-style promotion PR body carries a standalone evidence
summary, why old-style committed proposal files remain readable during
migration, and why the manifest below pins exact asset ids instead of mirroring
Phoenix state.

## File inventory

| File | Owns |
| --- | --- |
| [`example.schema.json`](example.schema.json) | The dataset example contract: `input` carries the complete captured Judge input (`judge_fixture_input`) plus separated maintainer context and `gradeability`; legacy project/run-envelope fields remain for eval reruns. |
| [`annotation.schema.json`](annotation.schema.json) | The annotation contract in both its logical shape and the Phoenix wire shape, including the fixed label set and documented score bands. |
| [`failure-taxonomy.json`](failure-taxonomy.json) | The versioned failure taxonomy shared by human, model, and code signals. |
| [`phoenix-assets.json`](phoenix-assets.json) | The accepted Phoenix asset manifest: exact accepted prompt/evaluator/dataset version pins and experiment evidence ids. |
| [`workspace-eval-policy.json`](workspace-eval-policy.json) | The repo-owned workspace eval policy: human-set `workspace_maturity`, default/override rules for `project_category` and `project_impact_level`, and the deterministic train/test split assignment rule applied at promotion time. |
| [`variants.json`](variants.json) | Repo-owned candidate variants for non-mutating eval-mode decomposition runs (`npm run eval:decomposition -- --variant <id>`): variant id to role runtime/model overrides and/or a candidate judge prompt version reference. |
| [`promotion-policy.json`](promotion-policy.json) | The repo-owned promotion policy behind `npm run promote-candidate`: disable flag, lookback window, max-open/per-period proposal budgets, eligible experiment launch sources, required evidence id kinds, and risk defaults (prior test-split exposure defaults `high_risk`). The controller records this file's `policy_version` + sha256 in every handoff, registry row, and PR marker; unattended reads must come from the internal clone at default-branch HEAD. |
| `proposals/` | Legacy/migration proposal documents: the controller no longer commits proposal documents for new promotion PRs; old-style branches remain readable during migration. |
| [`rubrics/decomposition-quality.md`](rubrics/decomposition-quality.md) | The shared human/model quality rubric: dimensions, label semantics, score bands. |
| [`accepted-prompts/decomposition-quality-judge.md`](accepted-prompts/decomposition-quality-judge.md) | The accepted judge prompt snapshot (repo-owned pin of judge behavior). |
| [`templates/process-change-proposal.md`](templates/process-change-proposal.md) | The PR body template for behavior-diff promotion PRs, including the machine-readable PR marker. |

All machine-readable artifacts here are JSON, not YAML, because this repo is
zero-dependency and has no YAML parser. JSON has no comments, so manifest
entries use sparing `_note` fields for inline documentation; `_note` fields are
documentation only and carry no contract meaning.

## Contract invariants

These are load-bearing and verified by tests
(`execution/integrations/linear/test/eval-contracts.test.mjs`):

- The annotation label set is exactly `pass | needs_revision | blocking_failure`
  and the roll-up annotation name stays `quality`. Neither may
  drift.
- Every canonical annotation requires a non-empty `identifier` (human/user id,
  judge id, or code evaluator id). Phoenix upserts by
  `(name, target, identifier)` and defaults the identifier to the empty
  string, so an omitted or empty identifier can silently overwrite or merge
  human, model, and code judgments that share a name and target — collapsing
  evidence.
- `annotator_kind` is `HUMAN | LLM | CODE`. `CODE` is storage for deterministic
  checks, not a third peer judge, and deterministic checks are never spoofed as
  `HUMAN` or `LLM`.
- Phoenix wire quality annotations require `result.label`, `result.score`, and
  `result.explanation`. `CODE` deterministic checks may use binary scores
  (0 or 1) but still report a score and an explanation. Controller promotion
  outcome annotations are a separate, minimal, label-only contract
  (`$defs/promotion_outcome_annotation` in `annotation.schema.json`:
  `route_to_hitl | blocked | superseded` plus required provenance metadata);
  the quality shape is never loosened to accommodate them.
- Phoenix-bound metadata (example metadata and annotation metadata) carries a
  schema-level denylist of known workflow-state keys: `needs_relabel`,
  `pending_promotion`, `accepted_by_factory`, `propose_repo_change`,
  `proposal_state`, `queue_state`, `workflow_status`, `assigned`, `resolved`.
  `accepted_by_factory` is a workflow-state key and must keep being rejected by
  the schemas.
  Rationale is the wipe test: if losing Phoenix would lose "which behavior is
  accepted or what queue is pending", that state must never be written to
  Phoenix. The denylist rejects the known banned keys at validation time while
  keeping other extensibility (benign metrics, counts) open.
- The failure taxonomy has two kinds of sections: `workflows.*` holds
  judgment failure modes (docs-seeded, used by human and model judges), and
  `structural` holds exactly the modes the deterministic `CODE` evaluators in
  `execution/integrations/linear/src/quality.mjs` emit (exported as
  `STRUCTURAL_FAILURE_MODES`). Parameterized CODE diagnostics such as
  `missing_context_digest:<phase>` normalize to their base id
  (`normalizeFailureMode`) in `metadata.failure_modes`; the raw parameterized
  detail is preserved in `metadata.failure_mode_details`. Tests fail if
  quality.mjs can emit a mode the taxonomy does not list.
- Default score bands: pass 0.80–1.00, needs_revision 0.40–0.79,
  blocking_failure 0.00–0.39 (or any critical failure mode that invalidates the
  output). Bands are documented defaults: a label/score band mismatch is a
  low-confidence worklist flag, not a schema rejection, and `CODE` checks may
  use binary scores for structural invariants.
- Human-label authenticity is reported as `asserted` in MVP because local
  Phoenix does not authenticate annotators. Never claim `authenticated`.
- Exactly one promotion-candidate tag exists per Phoenix prompt:
  `teami_promotion_candidate`. The tag is an intent signal only —
  never accepted behavior, never queue authority. Moving the tag supersedes the
  prior candidate for that prompt target. Accepted behavior is marked only by
  the pins in `phoenix-assets.json`.
- Native Phoenix split membership wins over `metadata.dataset_split`. The
  metadata field is a mirror for filtering/fallback reporting; a mismatch is a
  reconciliation/evidence-quality problem, never silently merged.

## Workspace eval policy

`workspace-eval-policy.json` is the repo-owned policy artifact behind example
metadata and split membership. Everything in it is **human-set** and changes
only by editing the file in a reviewed commit — there is no automatic
maturity/category/impact transition logic anywhere in MVP.

- `workspace_maturity` (`new | calibrating | stable`) stamps every promoted
  example and annotation default.
- `project_category` and `project_impact_level` each carry a `default` plus
  `overrides` keyed by Linear project id (preferred, stable) or exact project
  name. Rich promotion resolves the run's project against the overrides and
  falls back to the default.
- `split_assignment` is the deterministic train/test rule applied **at
  promotion time** (Track B owns assignment): bucket = first 8 bytes of
  sha256(example id) as an unsigned integer, modulo `total_buckets`;
  bucket < `test_buckets` means `test`, otherwise `train`. The default is
  1 test bucket of 5 (4:1 train:test). The same example id always lands in
  the same split on any machine, with no stored counter. `calibration` and
  `regression` are never hash-assigned: they exist only via the explicit
  `--split` flag at promotion time (`flag_only_splits`).
- `human_label_regression` records the D5 default thresholds the
  process-change gate consumes; it is policy data here so the workspace owner
  can change it without touching gate code.

Split membership is written as a native Phoenix split at upload whenever the
pinned Phoenix accepts per-example `splits`; `metadata.dataset_split` mirrors
it. When the native write path fails or is unavailable, promotion records
`split_assignment: metadata_fallback` in the local promotion receipt and
command output — the metadata mirror is then pending native assignment and is
never claimed as native split evidence.

## Eval-mode variants

`variants.json` is the repo-owned variants config for the non-mutating
eval-mode CLI task (`npm run eval:decomposition`). A variant is an
**experiment identity only**: selecting one labels eval outputs and resolves
runtime overrides for that run, and never changes accepted behavior. Accepting
a variant as the new baseline is a process change like any other (proposal
template + `phoenix-assets.json` pins).

Shape (`decomposition-eval-variants/v1`):

- `default_variant` names the entry used when `--variant` is omitted and must
  stay the no-override accepted baseline (`accepted_baseline`).
- `variants.<id>.role_overrides` maps a role (`pm | sr_eng | judge`) to
  `{ "runtime"?: ..., "model"?: ... }`; overrides are merged over
  `workflows.decomposition.roles.<role>` into a derived config at eval time.
  The committed config is never mutated.
- `variants.<id>.judge_candidate_prompt_version_id` optionally pins a Phoenix
  candidate prompt version that the `--judge` chain executes instead of the
  repo-accepted snapshot, labeled `phoenix_candidate_version` in all judge
  output metadata (a Phoenix prompt version is intent/experiment material,
  never accepted behavior).
- Unknown variant ids, unknown entry keys, unknown roles, and malformed
  override values fail closed before any execution. Process-level variants
  (changed prompts, rules, gates, policies) are repo diffs evaluated through the
  experiment wrapper, not runtime flags here.

Eval runs that use a variant record the variant id, its overrides, and the
inputs hash in the local eval-run record under
`.teami/eval-runs/<eval_run_id>.json` (gitignored local custody) so
later experiment receipts can attribute results to the exact candidate.

## Phoenix experiments and managed receipts

`npm run phoenix:experiment-decomposition -- <dataset_name> [--variant <id>]
[--intent promotion_candidate|exploratory] [--split train|test]
[--example-ids id,id]` runs the non-mutating eval task over a curated Phoenix
dataset and records the results as a **Phoenix-native experiment** (Phoenix is
the experiment store; there is no custom experiment store). Native Phoenix
split selection is used when the split exists; otherwise examples are filtered
client-side on the `metadata.dataset_split` mirror and the fallback is
disclosed in the summary and the receipt — never claimed as native split
evidence.

Every launch writes a managed-experiment receipt to
`.teami/experiments/<receipt_id>.json` (gitignored local custody):
source `managed_manual`, intent, candidate target key, launch baseline
(derived from `phoenix-assets.json`, never from caller input), candidate
version, dataset + dataset version, split, evaluator versions, workspace eval
policy version/hash (`promotion_policy` is a null placeholder until the
promotion policy artifact exists), asserted actor, timestamps, Phoenix scope,
Teami run ID, and the Phoenix experiment ID written back as soon as
it is known — the experiment ID is the primary join for the candidate-intent
scanner, because the pinned Phoenix cannot enumerate experiments by prompt
version. Receipt/run IDs are also stamped into the experiment's create-time
metadata as best-effort provenance (experiment metadata is create-time-only).

**Intent default rule (MVP):** `--intent` defaults to `exploratory`. The plan
allows defaulting to `promotion_candidate` only when a repo-owned automation
policy explicitly marks the dataset/variant path as a self-improvement
candidate; **no automation policy artifact exists yet**, so the default is
always `exploratory` and `promotion_candidate` requires the explicit flag.
Experiments are evidence, never intent by themselves.

### Live baseline re-pin

Baseline experiment pins are live-Phoenix evidence and are not updated by
`npm test`. Re-pin them only in a maintainer PR after a local Phoenix run:

```bash
npm run phoenix:experiment-decomposition -- teami-decomposition-examples --variant accepted_baseline --intent exploratory
```

Then update only the relevant `experiments[]` baseline row in
`phoenix-assets.json` with the new `experiment_id`, dataset id/version if
Phoenix returned a newer dataset version, and the advisory mean in `_note`.
The exact decomposition baseline rows currently owned by this manifest are:

- `purpose: "baseline"`,
  `candidate_target_key: "prompt/decomposition/sr_eng_grounding_pass"`,
  `dataset_id: "RGF0YXNldDox"`,
  `dataset_version_id: "RGF0YXNldFZlcnNpb246Mg=="`,
  `accepted_artifact_hash_vector.snapshot_sha256:
  "d9657e0ac66ea9612d9fee02ba417c3b14a386c9f6499ed9b35fac3d590bc843"`.
- `purpose: "baseline"`, no `candidate_target_key`,
  `dataset_id: "RGF0YXNldDox"`,
  `dataset_version_id: "RGF0YXNldFZlcnNpb246Mg=="`,
  `project_name: "Experiment-7cf2a684e812e741c360e605"`.

The WS-C score migration uses one live re-baseline to cover both the uniform
`quality` annotation rename and the band-derived score change. The online eval
self-run shape is: query the pinned dataset, run the accepted behavior
variant, let the Judge write `quality` annotations whose scores are derived
from the namespace label bands, compare against the manifest-pinned baseline,
and review the manifest pin update in git. After re-pinning, run
`npm run eval:gate -- --experiment <fresh_receipt_id>` for the fresh evidence
receipt; stale candidate receipts must fail with `baseline_identity_current`
and be rerun rather than compared across score semantics.

Receipts are append-only: `npm run phoenix:experiment-amend -- <receipt_id>
--action register|reclassify|withdraw --reason <text> [--experiment-id <id>]
[--intent <new>]` verifies identity through the local Phoenix resolver and
appends an amendment event (actor, timestamp, reason, action). Prior receipt
facts are never rewritten; withdrawal is visible as derived receipt state.

## Disagreement report and process-change gate

`npm run eval:disagreements -- (<run_id> | --experiment
<receipt_id_or_experiment_id>)` compares HUMAN annotations, LLM judge results,
and deterministic CODE check results for one run or one experiment while
preserving the raw records (labels, scores, rationales, failure modes, and
Phoenix links). Human-vs-model comparison is on the taste labels/scores;
CODE results are compared primarily on **failure modes** and are never forced
onto the taste-score scale. `judge_invalid` / `judge_missing` surface as
derived worklist items. The report is a derived, read-time view (GET-only,
transient stdout): nothing is persisted, no disagreement-resolution primitive
exists, and the detection logic is literally the same function the `npm run
worklist` derivation uses — the two surfaces cannot drift apart.

`npm run eval:gate -- --experiment <receipt_id> [--accept-cross-version]`
evaluates whether the candidate behind a managed experiment receipt clears the
process-change gate. Every condition is named and **fails closed**: tied to an
annotation/failure mode, a reusable failure captured as a dataset example, a
human-labeled subset, held-out test-split evidence, improvement against the
manifest-pinned baseline experiment, no human-labeled regression (D5
thresholds read from `workspace-eval-policy.json` `human_label_regression`),
disagreements actually checked and surfaced, exact resolvable Phoenix pins,
current baseline identity (from `phoenix-assets.json`, never the receipt), and
a standalone evidence summary. Examples are compared only across compatible
workflow/rubric/taxonomy versions (`--accept-cross-version` to include
mismatches explicitly); `deprecated` examples never enter default gates;
relabel-needed state is derived at read time and never persisted. Before any
HUMAN/LLM annotation is consumed, the explicit label/score band-mismatch check
runs: band-mismatched annotations remain valid evidence but are flagged and
counted as `annotations_low_confidence` in the evidence counts. The gate
reports deterministic FACTS in product terms (what improved, what risk
remains, what human decision load changed, which categories were tested, which
Phoenix assets were evidence vs which repo artifacts own accepted behavior)
plus machine-local best-effort test-split exposure history; the advisory
`evidence_quality` / `promotion_risk` labels are assigned by the promotion
controller, never by the gate. The report goes to stdout and a local record
under `.teami/gate-reports/<id>.json` — never to Phoenix.

## Promotion controller (`teami.promote_candidate`)

`npm run promote-candidate -- --input <request.json>` is the one promotion
controller every surface calls. The request envelope supplies context only —
schema version, source, claimed actor, expected project, explicit Phoenix IDs
and/or a Phoenix deep link, and `requested_action: "propose_repo_change"` (the
ONLY caller-requestable action; `route_to_hitl` and `blocked` are controller
outcomes). The controller derives `trigger_authenticity` from the invocation
transport (caller claims are ignored; MVP says `asserted`), derives the
Phoenix origin from local config, validates deep links against a strict
path-only allowlist before extracting IDs, preflights resolver capability per
object type, re-resolves all evidence through the verified local REST path,
joins the managed receipt by experiment id (discovered/withdrawn/exploratory
evidence blocks), runs the process-change gate, and assigns the labels as
RUBRIC-DERIVED ADVISORIES — a deterministic rubric over gate facts (no model
call; adversarial prose is data; advisory only, never able to waive a
mechanical gate).

Repo-visible PR markers remain the dedupe, human-rejection-memory, budget, and
max-open truth. Materialization runs only after those repo-marker
dedupe/rejection/budget/max-open checks. If the materialized file set is empty,
does not include a mapped repo-owned behavior artifact for the target, or
touches `execution/evals/decomposition/proposals/**` anywhere in the diff, no
promotion PR is opened. Diffs touching `.github/workflows/**` still block
before push.

New-style promotion PRs are behavior-diff PRs. For prompt promotions, the PR
contains the accepted snapshot edit and the `phoenix-assets.json` manifest pin
edit together; merging that PR is the human acceptance act. The PR body, not a
committed proposal file, carries the human review surface: proposed change,
what changes, why now, risk, a standalone evidence summary that survives
Phoenix loss, and exactly one sentinel-bounded `teami_promotion`
marker. The evidence summary passes through the same content gate as rich
promotion plus GitHub Markdown escaping.

New-style promotion commits also carry the immutable envelope trailers
`Teami-Promotion-Envelope`,
`Teami-Promotion-Instance`, and
`Teami-Promotion-Target`. Resume and orphan-branch recovery verify
those trailers against the current normalized envelope, while old-style
branches with committed `proposals/<proposal_instance_id>.md` files remain
readable through the proposal-file fallback during migration. If PR creation
succeeds and the Phoenix outcome write fails, `phoenix_audit_retry_needed`
repair custody is the PR-body marker plus the local registry; repair state is
never committed into behavior files.

Valid evidence without a drafted behavior change is an improvement opportunity,
not a GitHub PR. The internal controller outcome is `blocked` with reason
`improvement_opportunity_no_proposed_change`; the local registry/scanner record
is the operator-facing structured status. No branch, PR, marker, or Phoenix
outcome annotation is written for this path, and the string
`improvement_opportunity` must never appear in a Phoenix request payload.

## Drafting (writer)

`draft-improvement` is operator-invoked only. There is no auto-draft toggle:
unattended auto-drafting is not built, and adding it would be a separate product
decision, not flipping a config flag. Before any model call, the writer
preflights the repo-owned eligible target list, repo-visible marker memory,
per-target quota, duplicate same-source drafts, GitHub identity, the target's
repo-owned prompt artifact, taxonomy ids, and Phoenix deep links. Unknown
taxonomy ids and foreign or disallowed Phoenix links are dropped before the
prompt is built.

The writer is an author of candidate bytes, not an acceptor. A valid draft is
stored as content in a sibling file and as a size-bounded local receipt before
any tag is applied. The chain is receipt -> Phoenix prompt registration ->
managed derived-variant experiment receipt with `intent: promotion_candidate`
and `drafted_by` provenance -> candidate-tag occupancy check -> candidate tag.
Crashes resume from the typed receipt state. If the candidate tag is occupied,
the chain fails closed unless the operator explicitly asks to supersede it;
the same version is idempotent. Quotas and content-hash dedupe keep repeated
draft attempts from turning into Phoenix prompt-version or experiment floods.

Drafted candidates then flow through the same scanner -> gate -> controller
path as any other promotion candidate. The controller still runs the
mechanical gate, materializes only mapped behavior diffs, opens only the HITL
PR path when the gate passes, and discloses machine authorship in the PR body
(`Machine-drafted candidate (...)`). The writer cannot edit trust machinery,
change policy/gate behavior, open GitHub PRs, merge, mark ready, review,
comment, or accept anything. Acceptance remains the human PR merge.

The terminal MVP success is still `route_to_hitl`: a HITL PR carrying the
marker — never an auto-merge. The GitHub client stays endpoint-allowlisted and
has no merge, mark-ready, review, comment, webhook, workflow, or admin
codepath. Every controller stage lands in the durable registry
`.teami/promotion-candidates/<envelope-hash>.json` so recovery
resumes instead of duplicating, and the Phoenix `promotion_outcome` annotation
is written only after the PR is created or the controller terminally blocks.

The acceptance posture behind this controller — why HITL PRs are the terminal
MVP outcome, the structural no-merge guarantee, the full v2 auto-acceptance
invariant list, and the Phoenix handoff entry points (validated deep links,
the no-adapter decision for the pinned Phoenix, the future adapter contract)
— is documented in
[`docs/promotion-acceptance-policy.md`](../../../docs/promotion-acceptance-policy.md).

## Versioning rules

- **Schemas** are JSON Schema draft 2020-12 and carry a versioned `$id`
  (`.../v1`). Breaking a schema means publishing a new `$id` version, not
  silently editing field meanings.
- **`rubric_version`** bumps whenever the meaning of a dimension, label, or
  band changes. **`failure_taxonomy_version`** bumps whenever failure modes are
  added or changed — and modes are added only when real traces reveal recurring
  gaps, never speculatively.
- Annotations and dataset examples record the rubric, taxonomy, and workflow
  versions they were judged against. Process-change gates compare examples only
  across compatible versions, or with an explicitly accepted cross-version
  comparison.
- **Accepted prompt snapshots** under `accepted-prompts/` are the repo-owned
  pin of judge behavior, content-addressed now: `snapshot_sha256` in
  `phoenix-assets.json` is the sha256 of the exact bytes of the snapshot file.
  Until a Phoenix prompt version pin exists (`accepted_prompt_version_id` is
  null), the accepted baseline identity (`accepted_baseline_id`) for that
  prompt is `sha256:<snapshot_sha256>` — never the bare label
  `unpinned-initial`. A test asserts the stored hash matches the file content,
  so editing the prompt without updating the hash fails CI; prompt edits are
  process changes and ship through the PR body template like any other
  accepted-behavior change.
- **`candidate_target_key` grammar** is canonical and load-bearing:
  `<candidate_kind>/<scope>/<artifact_slot>`, where `candidate_kind` is one of
  `prompt | evaluator_prompt | rule | schema | code_evaluator | policy`,
  `scope` is the stable workflow area (for example `decomposition`),
  and `artifact_slot` is the repo manifest key or repo-relative artifact path.
  Dedupe, supersede handling, rejection memory, and proposal budgets all key
  on this grammar; free-form keys are invalid. See
  [`templates/process-change-proposal.md`](templates/process-change-proposal.md).
- **`phoenix-assets.json` pins** change only through accepted process-change
  PRs (HITL PRs built from the template here). Null pins mean "not yet
  registered/accepted in Phoenix"; until then the repo snapshot or code
  referenced by the manifest is the accepted behavior. Baseline identity for
  any promotion derives from this manifest, not from receipts.
- Every change to accepted behavior — judge prompts, rubric, taxonomy, schemas,
  code evaluators, phase rules, policy — is a process change: it ships as a
  reviewable behavior-diff PR using the PR body template, with exact Phoenix
  pins and a standalone evidence summary in the PR body. In MVP a human always
  owns the merge.
