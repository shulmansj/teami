# Meta-Change Classifier Contract

Status: current
Current product path: yes
Date: 2026-07-11

This contract defines the preflight shape for the Phase 1 meta-change
classifier. It records what must be protected before classifier implementation,
what classes the classifier returns, how report-only becomes fail-closed, and
which current assets are protected.

This is not classifier code, a CI workflow, an approval hierarchy, or a
production auto-apply system. It does not grant any new branch, PR, merge,
apply, repo, token, Linear, unattended-service, or activation authority.

Primary sources:
[`teami-product-trust-record.md`](teami-product-trust-record.md),
[`authority-custody-defaults.md`](authority-custody-defaults.md),
[`docs/promotion-acceptance-policy.md`](../../docs/promotion-acceptance-policy.md),
[`docs/self-improvement.md`](../../docs/self-improvement.md), and
[`execution/evals/decomposition/`](../../execution/evals/decomposition/README.md).

## Purpose

The adopter self-improvement loop may draft changes to agent behavior artifacts
that the manifest exposes as self-improvement targets. Factory behavior —
promotion policy, proposal machinery, credentials, write authority, protected
maps, and maintainer-owned gates — is not part of that candidate universe. That
boundary is useful only if a candidate cannot quietly change the rules used to
approve itself.

The classifier is a deterministic routing preflight. It decides whether a diff
is ordinary behavior, governance/meta behavior, authority/custody behavior, or
too sensitive to classify safely. It does not decide product goodness, does not
approve the change, and does not merge or apply anything. The owner remains the
sole authority for factory behavior changes.

## Classes

The classifier returns exactly one primary class plus supporting facts:

```json
{
  "class": "ordinary_semantic | meta_change | authority_change | unknown_sensitive",
  "reasons": [],
  "protected_paths": [],
  "affected_surfaces": [],
  "mixed_classes": []
}
```

The S11 write guard must derive the final write disposition from the whole
object, not from `class` alone. Any non-empty `mixed_classes` that contains
`ordinary_semantic` and either `meta_change` or `authority_change` is blocked
until split. If a future implementation adds a derived disposition field, it
must preserve that rule.

Class meanings:

| Class | Meaning | Default route |
| --- | --- | --- |
| `ordinary_semantic` | Accepted agent behavior changes that do not alter gates, risk/approval classification, proposal machinery, authority, custody, credentials, CI/workflow authority, or the protected-path map. Manifest-declared accepted prompt targets (excluding the judge-agent prompt, which is maintainer-owned and `meta_change`) and manifest-declared runtime/model defaults are ordinary by default. | Same PR path, with behavior-proposal labeling and the existing process-change gates and packet guard. |
| `meta_change` | Changes to governance, eval meaning outside an accepted agent prompt, gates, rubrics, thresholds, risk classifiers, approval criteria, proposal packet/marker/controller machinery, protected-path map, classifier code, or evidence rules. | Not produced by the adopter self-improvement loop. If maintainers change these surfaces, do it through normal Teami development with explicit old/new explanation and deterministic evidence. |
| `authority_change` | Changes to who or what can write repos, create PRs, mutate Linear, mint or store tokens, alter GitHub/Linear permissions, change CI/workflow authority, operate unattended scanner/write paths, expose custody/egress, or create a maintainer access path. | Not produced by the adopter self-improvement loop. Maintainer-owned authority/custody work needs explicit access/custody before/after and no hidden scope expansion. |
| `unknown_sensitive` | The diff touches a path or hunk that could affect meta or authority behavior but cannot be deterministically classified, including unparseable generated/binary changes, protected-path additions without a known owner, suspicious renames, or ambiguous script/workflow changes. | Fail closed. No production proposal write until a human splits, reclassifies, or adds a reviewed map entry. |

`unknown_sensitive` always fails closed. When a diff contains both ordinary
content and `meta_change` or `authority_change` content, it is blocked until
the changes are split. A single atomic hunk that genuinely changes both meta
and authority posture routes as `authority_change` and must explain the
meta-governance impact. That atomic-hunk rule never permits ordinary content
to be bundled with protected changes, and the implementation must make the
atomic decision by deterministic hunk/path facts or block for owner review.
Independent meta and authority edits should still be split for review clarity.

Classifier output is derived from deterministic diff facts, path rules,
manifest slots, marker fields, and parsed machine-readable artifacts. LLM prose
inside proposals, annotations, project bodies, or judge rationales is data only;
it cannot lower the class, waive evidence, or make a blocked bundle acceptable.

## Current Protected Meta-Assets

The protected map starts with assets that exist today. Future phases add new
paths as risk classifiers, approval criteria, packet schemas, and proposal
guards are created. The protected-path map and detector code are themselves
meta-assets.

| Path or artifact slot | Current default class | Why protected |
| --- | --- | --- |
| `docs/contracts/meta-change-classifier-contract.md` | `meta_change` | Defines this classifier contract and protected-path map. |
| `docs/contracts/teami-product-trust-record.md` | `meta_change` | Defines owner loops, behavior-change posture, maintainer-update boundary, and product trust promises. Authority/custody hunks may escalate to `authority_change`. |
| `docs/contracts/authority-custody-defaults.md` | `authority_change` | Defines local write authority, credential/content custody, consent, domain confinement, proposal-branch/CI authority, bounded Git/process behavior, and external-contract verification. |
| `execution/integrations/linear/test/trust-doc-contract.test.mjs` | `meta_change` | Enforces current trust-doc inventory, superseded-contract tombstones, and exact sanctioned mentions of retired architecture. Weakening it changes the documentation trust gate. |
| `docs/promotion-acceptance-policy.md` | `meta_change` | Owns MVP HITL acceptance posture, no-auto-accept policy, future auto-accept preconditions, Phoenix handoff, and no-merge promise. Authority or credential hunks escalate to `authority_change`. |
| `docs/self-improvement.md` sections `Core Principle`, `Evaluation Judgment Principle`, `Interaction Surface Principle`, `Storage Responsibilities`, `Offline Evaluators`, `Dataset And Experiment Shape`, `Failure Taxonomy`, and `Process Change Loop` | `meta_change` | Defines how process changes are detected, evidenced, proposed, and accepted. Authority/custody hunks escalate to `authority_change`. |
| `execution/evals/decomposition/README.md` | `meta_change` | Canonical eval and promotion-controller contract. |
| `execution/evals/decomposition/promotion-policy.json` | `meta_change` | Promotion controller policy: disable switch, budgets, eligible sources, scanner routing, required evidence ids, and risk defaults. The self-improvement loop cannot edit this policy. |
| `execution/evals/decomposition/workspace-eval-policy.json` | `meta_change` | Human-set eval policy, train/test assignment, and human-label regression thresholds consumed by gates. |
| `execution/evals/decomposition/variants.json` | `meta_change` | Eval-mode variant identity and overrides. Variants are evidence context, never accepted behavior; changing their semantics affects evaluation trust. |
| `execution/evals/decomposition/rubrics/**` | `meta_change` | Human/model judgment rubric, score bands, label meaning, and rubric versions. |
| `execution/evals/decomposition/failure-taxonomy.json` | `meta_change` | Shared failure-mode vocabulary and taxonomy version used by gates and evidence. |
| `execution/evals/decomposition/example.schema.json` | `meta_change` | Dataset example contract and workflow-state denylist for Phoenix-bound examples. |
| `execution/evals/decomposition/annotation.schema.json` | `meta_change` | Human/LLM/CODE annotation contract, promotion outcome shape, label set, and workflow-state denylist. |
| `execution/evals/decomposition/templates/process-change-proposal.md` | `meta_change` | PR body template, marker contract, candidate target grammar, evidence custody, and proposal review surface. |
| `execution/evals/decomposition/accepted-prompts/decomposition-quality-judge.md` | `meta_change` | Judge-agent prompt. The judge is the maintainer-owned evaluator; a judge prompt edit is `meta_change`, not an adopter self-improvement target. Changing judge evaluation behavior changes what the maintainer-owned verifier accepts or rejects, not ordinary adopter behavior. Maintainers change this through normal Teami development with explicit old/new explanation and deterministic evidence. |
| `execution/evals/decomposition/accepted-prompts/pm-product-sufficiency-pass.md` | `ordinary_semantic` by default | Agent behavior prompt. It is not governance solely because it is an accepted prompt. Escalate only if the hunk changes factory gates, risk classification, approval criteria, authority, or attempts to grant tool/write power. |
| `execution/evals/decomposition/accepted-prompts/pm-synthesis.md` | `ordinary_semantic` by default | Agent behavior prompt, with the same escalation rule as above. |
| `execution/evals/decomposition/accepted-prompts/sr-eng-grounding-pass.md` | `ordinary_semantic` by default | Agent behavior prompt, with the same escalation rule as above. |
| `execution/evals/decomposition/accepted-prompts/sr-eng-blocker-check.md` | `ordinary_semantic` by default | Agent behavior prompt, with the same escalation rule as above. |
| `execution/evals/decomposition/accepted-runtime-roles.json` | `ordinary_semantic` when materialized for the manifest runtime-defaults target | Runtime/model defaults affect agent behavior and are in the manifest-declared self-improvement catalog through `rule/decomposition/runtime_role_assignments`. Any added write/tool authority is `authority_change`. |
| `execution/evals/decomposition/phoenix-assets.json` | Field-sensitive | Manifest prompt pins for accepted prompt targets are ordinary behavior unless they alter governance or authority. Evaluator/rubric/schema/gate/policy metadata, candidate/accepted tag semantics, target catalog ownership, and materializer changes are `meta_change`. |
| `execution/integrations/linear/src/process-change-gate.mjs` | `meta_change` | Process-change gate logic and facts. |
| `execution/integrations/linear/src/decomposition-quality-judge.mjs` | `meta_change` | Judge prompt/runtime wrapper and validation. |
| `execution/integrations/linear/src/quality.mjs` | `meta_change` | Deterministic CODE evaluator behavior and structural failure modes. |
| `execution/integrations/linear/src/eval-content-gate.mjs` | `meta_change` | Evidence content gate. |
| `execution/integrations/linear/src/deterministic-check-emission.mjs` | `meta_change` | Emits deterministic check results consumed as CODE evidence. |
| `execution/integrations/linear/src/disagreement-report.mjs` | `meta_change` | Derived disagreement evidence between HUMAN, LLM, and CODE signals. |
| `execution/integrations/linear/src/eval-annotation-contract.mjs` | `meta_change` | Runtime/schema enforcement for eval annotations. |
| `execution/integrations/linear/src/eval-structural-validator.mjs` | `meta_change` | Structural validation used by eval evidence. |
| `execution/integrations/linear/src/eval-status.mjs` | `meta_change` | Eval status and evidence-state derivation. |
| `execution/integrations/linear/src/workspace-eval-policy.mjs` | `meta_change` | Loader/resolver for workspace eval policy. |
| `execution/integrations/linear/src/decomposition-eval-cli.mjs` | `meta_change` | Eval-mode entrypoint and evidence-generation command path. |
| `execution/integrations/linear/src/promote-candidate.mjs` | `meta_change` | Promotion controller, gate orchestration, and PR proposal route. Authority hunks escalate to `authority_change`. |
| `execution/integrations/linear/src/promotion-policy.mjs` | `meta_change` | Promotion policy loader and trusted reads. |
| `execution/integrations/linear/src/promotion-materializer.mjs` | `meta_change` | Materializes accepted behavior diffs from candidates. |
| `execution/integrations/linear/src/promotion-pr-body.mjs` | `meta_change` | Product-readable PR body and marker rendering. |
| `execution/integrations/linear/src/promotion-target-keys.mjs` | `meta_change` | Candidate target grammar and routing. |
| `execution/integrations/linear/src/promotion-workspace.mjs` | `meta_change` | Promotion workspace/ref behavior; authority hunks escalate. |
| `execution/integrations/linear/src/rich-promotion.mjs` | `meta_change` | Rich evidence packaging and promotion evidence rules. |
| `execution/integrations/linear/src/promotion/**` | `meta_change` | PR marker, trusted-artifact, registry, packet, and controller-support machinery. Authority hunks escalate. |
| `execution/integrations/linear/src/promotion-candidate-scanner.mjs` and `execution/integrations/linear/src/promotion-scanner/**` | `meta_change` | Deterministic candidate scanner, scanner health, worklist derivation, and unattended promotion entry. Write-path hunks escalate to `authority_change`. |
| `execution/integrations/linear/src/improvement-drafter.mjs` | `meta_change` | Candidate-byte authoring, drafter quotas, target resolution, and production promotion transport use. Write-path hunks escalate to `authority_change`. |
| `execution/integrations/linear/src/phoenix-self-improvement.mjs` and `execution/integrations/linear/src/phoenix-experiment.mjs` | `meta_change` | Phoenix experiment/candidate evidence creation and intent flow. Authority or custody hunks escalate. |
| `execution/integrations/linear/src/foreground-runner.mjs` and `execution/integrations/linear/src/cli/runner-command.mjs` | `authority_change` when changing Linear/repo write behavior; otherwise `meta_change` for workflow routing | Runner path controls live workflow execution and proposal-capable operations. |
| `execution/engine/workflow-registry.mjs`, `execution/engine/**`, `execution/integrations/linear/src/workflow-runtime-config.mjs`, `trigger-registry.mjs`, `trigger-runner.mjs`, and `execution/integrations/linear/src/workflows/**` | `authority_change` when changing live workflow/mutation authority; otherwise `meta_change` for workflow/eval gate behavior | These are the product's internal workflow and trigger authority surfaces. |
| `execution/integrations/linear/src/github-promotion-client.mjs`, `github-production-transport.mjs`, `github-setup.mjs`, `github-secret-hygiene.mjs`, `linear-credential-store.mjs`, and `cli/github-command-options.mjs` | `authority_change` | Ambient GitHub/Linear authority, credential hygiene, setup, and endpoint/write boundaries. |
| `execution/integrations/linear/src/linear-graphql-client.mjs`, `linear-service.mjs`, `linear-oauth.mjs`, `linear-setup-auth.mjs`, and `execution/integrations/linear/src/linear/setup-service.mjs` | `authority_change` | Linear read/write, OAuth, one-shot admin, setup, and live mutation surfaces. |
| `.github/workflows/**` | `authority_change` | Workflow/CI authority. Existing workflows are protected; additions and edits remain authority/workflow changes. |
| `package.json` script changes touching `test`, `promote-candidate`, `promotion:scan`, `draft-improvement`, `runner`, `github:init`, eval gates, or credential/setup commands | `unknown_sensitive` unless a narrower parsed rule classifies the hunk | Scripts can silently change which gates run or which write paths execute. Unknown-sensitive fails closed. |
| Any activation-state record, feature flag, or config field controlling report-only vs fail-closed classifier enforcement | `authority_change` | Only the owner can activate production write authority; candidate branches cannot flip their own guard mode. |

New files under `execution/**`, `supabase/functions/**`,
`supabase/migrations/**`, or `docs/contracts/**` with no reviewed map
entry are `unknown_sensitive` and fail closed until the owner adds or approves
a map entry. Existing ordinary code, docs, prompt, or fixture changes outside
this map are `ordinary_semantic` only when a deterministic rule proves they do
not introduce a hidden gate, evaluator, risk, approval, authority, credential,
workflow, custody, or proposal-routing change.

## Agent Behavior Manifest Rule

The implemented self-improvement surface is manifest-declared agent behavior
targets:

- A prompt target is in scope when `phoenix-assets.json` declares it with a
  `prompt/` target key, `artifact_kind: accepted_prompt`,
  `materializer: phoenix_prompt_version_to_accepted_prompt_snapshot`, and a
  concrete snapshot path.
- A runtime-default target is in scope when `phoenix-assets.json` declares it
  with a `rule/` target key, `artifact_kind: runtime_role_defaults`,
  `materializer: eval_variant_to_runtime_role_defaults`, and a concrete
  artifact path.
- The judge-agent prompt is excluded. The judge is the maintainer-owned
  evaluator (Q2); a judge prompt edit is `meta_change`, not an adopter
  self-improvement target. All other manifest-declared accepted prompt targets
  remain ordinary unless the diff attempts to alter factory gates.
- Do not classify a non-judge manifest-declared accepted prompt edit as
  governance merely because it changes output quality, judgment style, or
  decomposition style.
- Escalate a non-judge prompt edit only when the diff attempts to alter factory gates,
  risk classification, approval criteria, evidence requirements, classifier
  behavior, proposal machinery, credentials, permissions, tool/write authority,
  Linear mutation authority, GitHub authority, or the no-merge/no-auto-apply
  boundary.
- Other non-prompt judge behavior, rubrics, evaluator schemas, and
  agent-behavior surfaces can become self-improvement targets only after
  maintainers model them as first-class manifest agent-behavior artifacts with
  explicit materializers. They are not inferred from policy fields or ad hoc
  target strings.

## Current-Accepted-Base Rule

Candidate changes to gates, classifiers, proposal machinery, promotion policy,
protected-path map, rubrics, schemas, workflow/CI authority, or
credential/permission surfaces are evaluated by the currently accepted mainline
verifier and protected map, not by code, fixtures, reports, or PR body claims
produced by the candidate branch. Accepted prompt targets remain ordinary
agent behavior unless their diff attempts to change those factory surfaces.

The trusted read source for unattended evaluation must be default-branch
accepted behavior, or an explicitly identified trusted internal clone at
default-branch HEAD. The identity of that trusted clone, the activation-state
record, and any narrower parsed rules that can classify `package.json` or other
broad config hunks are read only from accepted default-branch behavior or
owner-held configuration. They are never read from the candidate working tree,
candidate branch, candidate PR body, candidate registry row, or candidate
Phoenix evidence.

The active candidate checkout is untrusted for its own protection-rule changes.

Candidate-produced evidence may be attached as context, but it cannot satisfy
or waive the current verifier, current classifier, current gate, current packet
guard, current protected map, or current authority/custody rule.

## Manual Freeze

Until deterministic fail-closed enforcement replaces it, a manual freeze is in
force for any self-improvement or promotion PR produced by `draft-improvement`,
`promote-candidate`, `promotion:scan`, or the scanner when the
diff touches the protected set above.

Freeze owner:

- For maintainer-owned maintainer sandbox work in this repository: The product owner is the freeze
  owner. Agents and maintainers may flag risks, but they do not own the
  acceptance decision.
- For an adopter behavior repo: the adopter/behavior-repo owner is the freeze
  owner. Maintainers have no special branch, PR, token, Linear, apply, merge,
  or activation path.

During the freeze:

- Protected diffs must be manually path-screened before merge.
- Governance/meta and authority/custody changes must be separated from
  ordinary behavior changes.
- Unknown-sensitive diffs stay blocked until split, mapped, or explicitly
  reclassified by the owner with a recorded reason.
- Unattended scanner invocations must remain report-only,
  read-only, disabled, or blocked for every class. They must not create
  production GitHub branches or PRs before fail-closed activation.

Sunset condition:

The manual freeze sunsets only after all of the following are true on accepted
mainline:

1. GOV-02 has implemented the deterministic classifier using this contract.
2. The full fixture matrix below passes with the exact local command named in
   this contract.
3. GOV-03 has wired the S11 write guard at scanner and direct
   `promote-candidate` PR-creation call sites.
4. All production proposal writes funnel through the allowlisted GitHub client
   and guarded choke point; tests prove no module can bypass it by importing
   production transport directly.
5. Before activation, unattended scanner paths are proven unable to
   call production GitHub proposal-writing paths for any class.
6. After activation, `meta_change`, `authority_change`, `unknown_sensitive`,
   and mixed ordinary+protected classes are blocked or routed separately before
   PR creation.
7. CON-01 and CON-02 owner-approval and current write-authority defaults remain
   accepted and not contradicted by the implementation.
8. The activation state is recorded in accepted repo state or owner-held config
   so future runs know whether the guard is report-only or fail-closed.

## Report-Only To Fail-Closed Guard

GOV-03 owns the S11 write guard:

```js
resolvePromotionWriteGuard({ invocation, classification, activationState })
// -> { allowed, mode, reason, owner_copy_key }
```

Modes:

| Mode | Meaning |
| --- | --- |
| `report_only` | The classifier may record a local/reporting result, but no production GitHub branch, PR, PR body update, marker, or Phoenix outcome write that implies a proposal was opened is allowed. |
| `blocked` | The invocation stops before any proposal write because the class, bundle, activation state, or authority condition is unsafe. |
| `write` | The invocation may proceed only through the existing allowlisted GitHub client, ref-bound proposal branch rules, packet guard, and no-merge/no-apply policy. |

Pre-activation:

- Unattended scanner invocations are `report_only` or `blocked`
  for every class, including `ordinary_semantic`.
- Foreground/manual commands may write ordinary proposals only through the
  allowlisted client and packet guard, with the manual freeze still applying to
  protected diffs.

Post-activation:

- `ordinary_semantic` may proceed to `write` only when all existing gates,
  packet prerequisites, selected-repo/ref boundaries, and no-merge guarantees
  pass.
- `meta_change` and `authority_change` are maintainer-owned factory behavior,
  not adopter self-improvement outputs. The self-improvement loop must not
  produce production PRs for them.
- `unknown_sensitive` is always `blocked`.
- Mixed ordinary+meta/authority diffs are `blocked` until split.
- Workflow/CI authority edits, credential-surface edits, and self-approval
  attempts fail closed.

## Fixture Matrix

The classifier implementation must carry fixtures that cover at least this
matrix. Fixture names are contractual; file names may vary as long as the test
reports the same ids.

| Fixture id | Example diff | Expected class | Required result |
| --- | --- | --- | --- |
| `ordinary_agent_prompt_edit` | Edits a manifest-declared accepted prompt target without changing factory gates, risk, approval, or authority. | `ordinary_semantic` | Not governance. Normal behavior-proposal PR path may continue. |
| `ordinary_judge_prompt_edit` | Edits `decomposition-quality-judge.md` to change judge-agent evaluation behavior without changing factory gates, approval, or authority. | `meta_change` | Judge-agent prompt is maintainer-owned (Q2); a judge prompt edit is `meta_change`, not an ordinary adopter proposal. Separate governance/meta proposal or normal Teami development required. |
| `ordinary_runtime_defaults_edit` | Updates `accepted-runtime-roles.json` through the manifest runtime-defaults materializer without adding write/tool authority. | `ordinary_semantic` | Agent runtime/model defaults are in scope as manifest-declared agent behavior. Normal behavior-proposal PR path may continue. |
| `rubric_score_band_edit` | Changes label meaning or score bands in `rubrics/decomposition-quality.md`. | `meta_change` | Separate governance/meta proposal. |
| `failure_taxonomy_edit` | Adds, removes, or renames failure modes in `failure-taxonomy.json`. | `meta_change` | Separate governance/meta proposal. |
| `schema_gate_edit` | Changes `annotation.schema.json` or `example.schema.json` label set, denylist, required fields, or promotion outcome shape. | `meta_change` | Separate governance/meta proposal. |
| `promotion_policy_risk_default_edit` | Changes `promotion-policy.json` risk defaults, scanner routing, eligible sources, budgets, or disable flag. | `meta_change` | Maintainer-owned factory behavior; not an adopter self-improvement candidate. |
| `protected_path_map_edit` | Edits this contract or future classifier protected-map artifact. | `meta_change` | Evaluated by current accepted map, never candidate map. |
| `proposal_marker_or_template_edit` | Changes `templates/process-change-proposal.md`, PR marker grammar, PR body marker rendering, or marker parser. | `meta_change` | Separate governance/meta proposal. |
| `candidate_self_approval_attempt` | Candidate changes gate/classifier/proposal machinery and includes candidate-generated evidence claiming the new gate passes. | `meta_change` | Candidate evidence ignored; current accepted verifier decides. |
| `authority_or_token_edit` | Changes GitHub authority, Linear credential, one-shot admin handling, selected-repo verification, endpoint allowlist, or token storage code. | `authority_change` | Separate authority/custody proposal. |
| `workflow_ci_authority_edit` | Adds or edits `.github/workflows/**` or privileged CI/check behavior. | `authority_change` | Fail closed or separate authority proposal. |
| `unattended_write_path_edit` | Lets a scanner or other unattended path create production proposal branches or PRs before fail-closed activation. | `authority_change` | Blocked. |
| `direct_production_transport_import` | Adds or preserves a production proposal-write import outside the guarded allowlisted choke point. | `authority_change` | Blocked unless current accepted tests prove it is guarded. |
| `activation_state_flip` | Candidate changes the report-only/fail-closed activation record, flag, or trusted-base pointer. | `authority_change` | Evaluated from accepted default branch or owner-held config only; candidate value ignored. |
| `mixed_ordinary_meta` | Same diff changes `pm-synthesis.md` and `rubrics/decomposition-quality.md`. | `meta_change` with `mixed_classes` including `ordinary_semantic` | Block until split. |
| `mixed_ordinary_authority` | Same diff changes an ordinary prompt and GitHub/Linear permission or credential code. | `authority_change` with `mixed_classes` including `ordinary_semantic` | Block until split. |
| `unknown_sensitive_generated_or_binary` | Binary/generated/unparseable change under protected directories or script/config change whose effect cannot be parsed. | `unknown_sensitive` | Fail closed. |
| `unknown_new_protected_surface` | New file under `execution/**`, `supabase/functions/**`, `supabase/migrations/**`, or `docs/contracts/**` with no map entry. | `unknown_sensitive` unless a reviewed map entry classifies it | Fail closed. |
| `agent_prompt_authority_attempt` | Accepted agent prompt edit asks the runtime to use tools, mutate Linear, bypass packet checks, approve, or apply. | `authority_change` or `unknown_sensitive` | Blocked; not ordinary. |
| `defective_verifier_exception_packet` | Signed replacement for a defective accepted verifier with old/new comparison, evidence, record, and rollback path. | `meta_change` | May be proposed only through the bounded exception below; no maintainer activation authority. |

## Exact Check Target

The future classifier implementation must expose this exact narrow local test
command:

```powershell
node --test execution/integrations/linear/test/meta-change-classifier-preflight.test.mjs
```

Before fail-closed activation, that narrow command must pass and the classifier
fixtures must also be included in the repo-wide command:

```powershell
npm test
```

The current `npm test` script uses a non-recursive `test/*.test.mjs` glob, so
GOV-02 must place the preflight test directly under
`execution/integrations/linear/test/` or update the repo-wide test script in a
separate reviewed change.

If GitHub CI is deliberately added later, the check name for this preflight
must be exactly:

```text
meta-change-classifier-preflight
```

As of this GOV-01 worktree on 2026-06-17, there is no `.github/workflows/**`
directory and no GitHub CI check exists for this classifier. No contract,
packet, or PR may claim GitHub CI enforcement for the classifier until a later
issue deliberately adds and tests it. Adding that workflow/check is itself a
workflow-authority change and must route through this contract.

## Defective-Verifier Exception

Genesis authority is bounded: the first accepted gate, evaluator,
risk-classifier, approval criteria, protected-path map, and classifier versions
are the trusted base. Later changes to them are meta-changes.

If the currently accepted verifier or classifier is defective, the exception is
limited to bypassing only the broken verifier's self-check. It does not bypass
owner consent, packet requirements, authority/custody rules, no-merge/no-apply
policy, or rollback requirements.

The exception may be used only when all conditions below are met:

1. The defect is recorded in product terms: what it blocks or misroutes, who is
   affected, and why normal verification cannot safely evaluate the fix.
2. The replacement is signed or otherwise provenance-recorded before the owner
   is asked to trust it.
3. The packet compares old and new verifier behavior on deterministic fixtures,
   including the failing case and non-regression cases.
4. At least one always-independent signal is required, such as deterministic
   fixtures run from the trusted base or owner inspection against the accepted
   baseline. Candidate-produced evidence is optional context and can never be
   the only proof.
5. The exception is owner- or foreground-initiated. An autonomous loop may
   draft a report-only warning, but it may not declare the verifier defective
   at scale or activate the replacement.
6. The owner explicitly consents to activate the replacement after seeing the
   old/new comparison, evidence, risk, and rollback path.
7. The decision is recorded in the behavior repo or accepted review record.
8. Rollback is bounded and described: what restores the old verifier, what
   cannot be undone, and whether any downstream runs consumed the replacement.
9. The exception creates no maintainer branch, PR, apply, repo, token, Linear,
   merge, mark-ready, review, or activation path.

Maintainers may publish or propose a signed replacement artifact or advisory
outside the adopter repo. They may not use the exception to create adopter
branches or PRs, mint or use adopter tokens, mutate Linear, operate the
adopter's factory, apply the replacement, or activate it. Any branch or PR in
an adopter behavior repo must be created through adopter-owned authority after
owner consent and the applicable guards.

## Non-Goals

- Do not implement classifier code in GOV-01.
- Do not add a GitHub workflow or CI check in GOV-01.
- Do not create production auto-apply, auto-merge, mark-ready, approving-review,
  status-override, or acceptance paths.
- Do not create another human approval hierarchy. Governance/meta and
  authority/custody changes are owner-approvable in v1 after clear separation,
  deterministic evidence, old/new comparison, and risk/custody copy.
- Do not make Phoenix, LLM prose, candidate tags, scanner records, or proposal
  markers a source of acceptance authority. They are evidence or routing
  context only.

## Structured Review Checklist

Use this checklist to verify GOV-02/GOV-03 against Phase 1 and CON-02:

- Unknown-sensitive fails closed.
- Mixed ordinary+meta/authority diffs are blocked or split.
- Manifest-declared accepted agent prompt edits (excluding the judge-agent
  prompt, which is `meta_change`) and manifest-declared runtime/model defaults
  remain ordinary unless they alter governance or authority.
- Rubrics, thresholds, schemas, gates, classifiers, proposal machinery,
  promotion policy, protected map, and evidence rules are meta-assets unless
  a later maintainer-owned manifest/materializer design explicitly makes a
  narrower agent-behavior artifact self-improvement eligible.
- Credential, GitHub/Linear permission, unattended write-path, and
  workflow/CI authority changes are authority changes.
- Candidate changes to gate/classifier/proposal machinery are evaluated by
  current accepted mainline, not candidate-produced evidence.
- Trusted-base pointers, activation state, and narrow parsed classification
  rules are not read from candidate-controlled state.
- New files under sensitive execution, Supabase, or maintainer-contract roots
  without a reviewed map entry fail closed as `unknown_sensitive`.
- Untrusted proposal branches run with no secrets, no privileged workflow
  triggers, no write-token CI, no status override, and no artifact/log
  exfiltration path.
- Unattended scanner paths are report-only/read-only/disabled before
  fail-closed activation and cannot call production GitHub write paths for any
  class.
- The defective-verifier exception is signed/proposed only, owner-consented,
  evidence-backed, old/new compared, recorded, rollbackable, and grants
  maintainers no operational authority.
- No contract or packet claims a GitHub classifier CI check exists in this
  worktree until a later issue adds one.
