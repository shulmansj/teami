import { withFactoryChangeDisposition } from "./promotion/factory-change-disposition.mjs";
import {
  DECOMPOSITION_EVAL_NAMESPACE,
  DECOMPOSITION_EVAL_PATHS,
  decompositionEvalNamespacePath,
} from "./workflows/decomposition/eval-paths.mjs";

export const META_CHANGE_CLASSIFIER_SCHEMA_VERSION = "agentic-factory-meta-change-classifier/v1";

export const META_CHANGE_CLASSES = Object.freeze([
  "ordinary_semantic",
  "meta_change",
  "authority_change",
  "unknown_sensitive",
]);

const CLASS_PRIORITY = Object.freeze({
  ordinary_semantic: 0,
  meta_change: 1,
  authority_change: 2,
  unknown_sensitive: 3,
});

// ---------------------------------------------------------------------------
// Factory-protection path maps: single source of record + drift gate
// ---------------------------------------------------------------------------
//
// The classifier's FACTORY-PROTECTION path maps (EXACT_PROTECTED_PATHS minus the
// ORDINARY_PROMPT_PATHS exception below, PREFIX_PROTECTED_PATHS, and
// NEW_FILE_SENSITIVE_ROOTS) have a single machine-readable source of record:
// `maintainers/contracts/protected-slots.json`.
//
// PROTECTED_SLOTS below is the in-code PROJECTION of that JSON. The engine reads
// only this embedded projection at runtime — it never reads the JSON file at
// load time, so the classifier has no runtime filesystem dependency. The JSON is
// the human-edited source of record; this projection must stay byte-for-byte
// equivalent to it.
//
// Drift gate: `protected-slots-currency.test.mjs` reads the JSON file and the
// exported PROTECTED_SLOTS projection and asserts they are deeply equal. Editing
// the JSON alone, OR editing this projection alone, makes the two diverge and
// fails `npm test`. Neither can silently drift from the other.
//
// To change a factory-protection slot: edit BOTH the JSON and this projection in
// the same change (the currency test enforces that they move together).
export const PROTECTED_SLOTS = Object.freeze({
  schema_version: "agentic-factory-protected-slots/v1",
  exact_paths: Object.freeze([
    { path: "maintainers/contracts/meta-change-classifier-contract.md", class: "meta_change", surface: "protected_path_map" },
    { path: "maintainers/contracts/agentic-factory-product-trust-record.md", class: "meta_change", surface: "product_trust_contract" },
    { path: "maintainers/contracts/authority-custody-defaults.md", class: "authority_change", surface: "authority_custody_contract" },
    { path: "docs/promotion-acceptance-policy.md", class: "meta_change", surface: "promotion_acceptance_policy" },
    { path: "docs/self-improvement.md", class: "meta_change", surface: "self_improvement_contract" },
    { path: decompositionEvalNamespacePath("readme.md"), class: "meta_change", surface: "eval_contract" },
    { path: DECOMPOSITION_EVAL_PATHS.policy, class: "meta_change", surface: "promotion_policy" },
    { path: decompositionEvalNamespacePath("workspace-eval-policy.json"), class: "meta_change", surface: "workspace_eval_policy" },
    { path: DECOMPOSITION_EVAL_PATHS.variants, class: "meta_change", surface: "eval_variant_identity" },
    { path: DECOMPOSITION_EVAL_PATHS.taxonomy, class: "meta_change", surface: "failure_taxonomy" },
    { path: decompositionEvalNamespacePath("example.schema.json"), class: "meta_change", surface: "eval_schema" },
    { path: decompositionEvalNamespacePath("annotation.schema.json"), class: "meta_change", surface: "eval_schema" },
    { path: decompositionEvalNamespacePath("templates/process-change-proposal.md"), class: "meta_change", surface: "proposal_template" },
    { path: decompositionEvalNamespacePath("accepted-prompts/decomposition-quality-judge.md"), class: "meta_change", surface: "judge_prompt" },
    { path: DECOMPOSITION_EVAL_PATHS.accepted_runtime, class: "field_sensitive", surface: "runtime_roles" },
    { path: DECOMPOSITION_EVAL_PATHS.manifest, class: "field_sensitive", surface: "phoenix_assets_manifest" },
    { path: "execution/integrations/linear/src/process-change-gate.mjs", class: "meta_change", surface: "process_change_gate" },
    { path: "execution/integrations/linear/src/decomposition-quality-judge.mjs", class: "meta_change", surface: "judge_runtime" },
    { path: "execution/integrations/linear/src/quality.mjs", class: "meta_change", surface: "code_evaluator" },
    { path: "execution/integrations/linear/src/eval-content-gate.mjs", class: "meta_change", surface: "eval_content_gate" },
    { path: "execution/integrations/linear/src/deterministic-check-emission.mjs", class: "meta_change", surface: "deterministic_check_emission" },
    { path: "execution/integrations/linear/src/disagreement-report.mjs", class: "meta_change", surface: "disagreement_evidence" },
    { path: "execution/integrations/linear/src/eval-annotation-contract.mjs", class: "meta_change", surface: "eval_annotation_contract" },
    { path: "execution/integrations/linear/src/eval-structural-validator.mjs", class: "meta_change", surface: "eval_structural_validator" },
    { path: "execution/integrations/linear/src/eval-status.mjs", class: "meta_change", surface: "eval_status" },
    { path: "execution/integrations/linear/src/workspace-eval-policy.mjs", class: "meta_change", surface: "workspace_eval_policy_loader" },
    { path: "execution/integrations/linear/src/decomposition-eval-cli.mjs", class: "meta_change", surface: "eval_entrypoint" },
    { path: "execution/integrations/linear/src/promote-candidate.mjs", class: "meta_change", surface: "promotion_controller" },
    { path: "execution/integrations/linear/src/promotion-policy.mjs", class: "meta_change", surface: "promotion_policy_loader" },
    { path: "execution/integrations/linear/src/promotion-materializer.mjs", class: "meta_change", surface: "promotion_materializer" },
    { path: "execution/integrations/linear/src/promotion-pr-body.mjs", class: "meta_change", surface: "proposal_pr_body" },
    { path: "execution/integrations/linear/src/promotion-target-keys.mjs", class: "meta_change", surface: "promotion_target_grammar" },
    { path: "execution/integrations/linear/src/promotion-workspace.mjs", class: "meta_change", surface: "promotion_workspace" },
    { path: "execution/integrations/linear/src/rich-promotion.mjs", class: "meta_change", surface: "rich_promotion_evidence" },
    { path: "execution/integrations/linear/src/promotion-candidate-scanner.mjs", class: "meta_change", surface: "promotion_scanner" },
    { path: "execution/integrations/linear/src/improvement-drafter.mjs", class: "meta_change", surface: "improvement_drafter" },
    { path: "execution/integrations/linear/src/phoenix-self-improvement.mjs", class: "meta_change", surface: "phoenix_self_improvement" },
    { path: "execution/integrations/linear/src/phoenix-experiment.mjs", class: "meta_change", surface: "phoenix_experiment" },
    { path: "execution/integrations/linear/src/local-supervisor.mjs", class: "meta_change", surface: "supervisor" },
    { path: "execution/integrations/linear/src/cli/supervisor-command.mjs", class: "meta_change", surface: "supervisor" },
    { path: "execution/integrations/linear/src/foreground-runner.mjs", class: "meta_change", surface: "foreground_runner" },
    { path: "execution/integrations/linear/src/cli/runner-command.mjs", class: "meta_change", surface: "foreground_runner" },
    { path: "execution/engine/workflow-registry.mjs", class: "meta_change", surface: "workflow_registry" },
    { path: "execution/integrations/linear/src/workflow-runtime-config.mjs", class: "meta_change", surface: "workflow_runtime_config" },
    { path: "execution/integrations/linear/src/trigger-registry.mjs", class: "meta_change", surface: "trigger_registry" },
    { path: "execution/integrations/linear/src/trigger-runner.mjs", class: "meta_change", surface: "trigger_runner" },
    { path: "execution/integrations/linear/src/runtime-adapters.mjs", class: "authority_change", surface: "runtime_adapter_authority" },
    { path: "execution/integrations/linear/src/github-promotion-client.mjs", class: "authority_change", surface: "github_proposal_authority" },
    { path: "execution/integrations/linear/src/github-production-transport.mjs", class: "authority_change", surface: "github_production_transport" },
    { path: "execution/integrations/linear/src/github-setup.mjs", class: "authority_change", surface: "github_setup_authority" },
    { path: "execution/integrations/linear/src/github-token-broker-client.mjs", class: "authority_change", surface: "github_token_broker" },
    { path: "execution/integrations/linear/src/broker-credential.mjs", class: "authority_change", surface: "broker_credential" },
    { path: "execution/integrations/linear/src/github-askpass.mjs", class: "authority_change", surface: "github_askpass" },
    { path: "execution/integrations/linear/src/linear-setup-auth.mjs", class: "authority_change", surface: "linear_setup_auth" },
    { path: "execution/integrations/linear/src/linear-credential-store.mjs", class: "authority_change", surface: "linear_credential_store" },
    { path: "execution/integrations/linear/src/runner-inbox-credential.mjs", class: "authority_change", surface: "runner_inbox_credential" },
    { path: "execution/integrations/linear/src/cli/github-command-options.mjs", class: "authority_change", surface: "github_command_options" },
    { path: "execution/integrations/linear/src/linear-graphql-client.mjs", class: "authority_change", surface: "linear_graphql_authority" },
    { path: "execution/integrations/linear/src/linear-service.mjs", class: "authority_change", surface: "linear_service_authority" },
    { path: "execution/integrations/linear/src/linear-oauth.mjs", class: "authority_change", surface: "linear_oauth" },
    { path: "execution/integrations/linear/src/linear-webhook-registration.mjs", class: "authority_change", surface: "linear_webhook_registration" },
    { path: "execution/integrations/linear/src/linear-webhook-inbox.mjs", class: "authority_change", surface: "linear_webhook_inbox" },
    { path: "execution/integrations/linear/src/linear/setup-service.mjs", class: "authority_change", surface: "linear_setup_service" },
    { path: "execution/integrations/linear/src/hosted-inbox-client.mjs", class: "authority_change", surface: "hosted_inbox_authority" },
    { path: "execution/integrations/linear/src/hosted-wake-queue-store.mjs", class: "authority_change", surface: "hosted_wake_queue_authority" },
    { path: "execution/integrations/linear/src/domain-resolver.mjs", class: "authority_change", surface: "domain_credential_routing" },
    { path: "execution/integrations/linear/src/domain-command-context.mjs", class: "authority_change", surface: "domain_credential_routing" },
    { path: "execution/integrations/linear/src/inbox-store.mjs", class: "authority_change", surface: "inbox_custody" },
    { path: "execution/integrations/linear/src/runtime-command.mjs", class: "authority_change", surface: "runtime_command_credential_boundary" },
    { path: "execution/integrations/linear/src/meta-change-classifier.mjs", class: "meta_change", surface: "meta_change_classifier" },
  ].map((entry) => Object.freeze({ ...entry }))),
  prefix_paths: Object.freeze([
    { prefix: "maintainers/contracts/", class: "meta_change", surface: "maintainer_contract", broad_default: true },
    { prefix: `${DECOMPOSITION_EVAL_NAMESPACE}/rubrics/`, class: "meta_change", surface: "rubric" },
    { prefix: "execution/integrations/linear/src/promotion/", class: "meta_change", surface: "promotion_machinery" },
    { prefix: "execution/integrations/linear/src/promotion-scanner/", class: "meta_change", surface: "promotion_scanner" },
    { prefix: "execution/integrations/linear/src/supervisor/", class: "meta_change", surface: "supervisor" },
    { prefix: "execution/integrations/linear/src/workflows/", class: "meta_change", surface: "workflow" },
    { prefix: "execution/engine/", class: "meta_change", surface: "integration_source_default", broad_default: true },
    { prefix: "execution/integrations/linear/src/", class: "meta_change", surface: "integration_source_default", broad_default: true },
    { prefix: ".github/workflows/", class: "authority_change", surface: "workflow_ci_authority" },
    { prefix: "supabase/functions/agentic-factory-github-broker/", class: "authority_change", surface: "github_broker_authority" },
    { prefix: "supabase/functions/agentic-factory-inbox/", class: "authority_change", surface: "hosted_inbox_authority" },
    { prefix: "supabase/migrations/", class: "authority_change", surface: "supabase_migration_authority", broad_default: true },
  ].map((entry) => Object.freeze({ ...entry }))),
  sensitive_roots: Object.freeze([
    "execution/",
    "supabase/functions/",
    "supabase/migrations/",
    "maintainers/contracts/",
  ]),
});

// ORDINARY_PROMPT_PATHS is a DEFERRED-PERSONA exception and is intentionally NOT
// part of protected-slots.json. It is the adopter per-phase-prompt classification
// from the retired per-role model; it will be re-derived against the persona shape
// later. The "single source of record / no second hand-maintained map" rule above
// applies ONLY to the factory-protection maps the JSON owns. This stays here as an
// explicit, code-commented deferred exception (a documented second map, never a
// silent one) — see `protected-slots-currency.test.mjs`, which asserts the JSON
// covers the factory-protection set AND that this is the known deferred surface.
const ORDINARY_PROMPT_PATHS = new Map([
  [decompositionEvalNamespacePath("accepted-prompts/pm-product-sufficiency-pass.md"), "agent_behavior_prompt"],
  [decompositionEvalNamespacePath("accepted-prompts/pm-synthesis.md"), "agent_behavior_prompt"],
  [decompositionEvalNamespacePath("accepted-prompts/sr-eng-grounding-pass.md"), "agent_behavior_prompt"],
  [decompositionEvalNamespacePath("accepted-prompts/sr-eng-blocker-check.md"), "agent_behavior_prompt"],
]);

// Project the JSON-shaped source of record into the runtime lookup structures.
// `class` in the source maps to `className` in the runtime rule shape; the rest of
// the classifier reads only these projected structures (unchanged shapes).
const EXACT_PROTECTED_PATHS = new Map(
  PROTECTED_SLOTS.exact_paths.map((entry) => [
    entry.path,
    { className: entry.class, surface: entry.surface },
  ]),
);

// The factory-protection JSON owns every exact entry above. ORDINARY_PROMPT_PATHS
// (the deferred exception) is injected here, exactly as before, so the adopter
// per-phase prompts classify ordinary_semantic by default.
for (const [promptPath, surface] of ORDINARY_PROMPT_PATHS) {
  EXACT_PROTECTED_PATHS.set(promptPath, { className: "ordinary_semantic", surface });
}

const PREFIX_PROTECTED_PATHS = Object.freeze(
  PROTECTED_SLOTS.prefix_paths.map((entry) => Object.freeze({
    prefix: entry.prefix,
    className: entry.class,
    surface: entry.surface,
    ...(entry.broad_default ? { broadDefault: true } : {}),
  })),
);

const NEW_FILE_SENSITIVE_ROOTS = Object.freeze([...PROTECTED_SLOTS.sensitive_roots]);

const SENSITIVE_PACKAGE_SCRIPT_PATTERNS = Object.freeze([
  /^test$/,
  /^promote-candidate$/,
  /^promotion:scan$/,
  /^draft-improvement$/,
  /^runner$/,
  /^runtime-smoke$/,
  /^trigger-status$/,
  /^supervisor(?::|$)/,
  /^github:init$/,
  /^init(?::linear)?$/,
  /^reset(?::linear)?$/,
  /^uninstall(?::linear)?$/,
  /^eval:/,
  /^phoenix:(annotate-trace|promote-run|promote-decomposition|experiment-decomposition|experiment-amend)$/,
]);

const AUTHORITY_HUNK_PATTERNS = Object.freeze([
  {
    id: "authority_merge_apply_or_review",
    surface: "write_acceptance_authority",
    pattern: /\b(auto[-_ ]?merge|auto[-_ ]?apply|merge without|apply without|submit approving review|approv(?:e|ing) (?:its own|the )?(?:change|proposal|pull request|pr)|mark[-_ ]?ready|status override|bypass branch protection)\b/i,
  },
  {
    id: "authority_repo_write_path",
    surface: "repo_write_authority",
    pattern: /\b(createPullRequest|create pull request|open (?:a )?(?:github )?(?:pull request|pr)|updatePullRequestBody|pushPromotionBranch|git push|write proposal branch|production proposal branch|refs\/heads|default branch|protected branch)\b/i,
  },
  {
    id: "authority_credential_or_broker",
    surface: "credential_or_broker_authority",
    pattern: /\b(token|credential|oauth|secret|private key|installation token|broker|setup grant|renewal grant|askpass|bearer)\b/i,
  },
  {
    id: "authority_prompt_tool_attempt",
    surface: "prompt_authority_attempt",
    pattern: /\b(use tools|tool access|mutate linear|create github pr|open github pr|bypass packet|bypass checks|approve your own|approve its own|write to github|write to linear)\b/i,
  },
  {
    id: "authority_linear_or_github_mutation",
    surface: "linear_github_authority",
    pattern: /\b(mutate linear|linear mutation|linear graphql mutation|linear_write|project_mutation|issue_mutation|tool_policy|github app|repository permission|selected[-_ ]?repo|endpoint allowlist|tool\/write authority|write access)\b/i,
  },
  {
    id: "authority_unattended_write_path",
    surface: "unattended_write_path",
    pattern: /\b(?:scanner|supervisor|unattended|foreground runner|workflow trigger)[\s\S]{0,120}\b(?:write|create(?:s)? (?:production )?(?:proposal|pull request|pr)|open(?:s)? (?:production )?(?:proposal|pull request|pr)|push|promoteCandidate|githubTransport|production transport)\b/i,
  },
  {
    id: "authority_unattended_write_path_reversed",
    surface: "unattended_write_path",
    pattern: /\b(?:write|create(?:s)? (?:production )?(?:proposal|pull request|pr)|open(?:s)? (?:production )?(?:proposal|pull request|pr)|push|promoteCandidate|githubTransport|production transport)[\s\S]{0,120}\b(?:scanner|supervisor|unattended|foreground runner|workflow trigger)\b/i,
  },
  {
    id: "authority_ci_or_workflow",
    surface: "workflow_ci_authority",
    pattern: /\b(github actions|\.github\/workflows|privileged workflow|write-token ci|workflow authority|workflow\/ci authority)\b/i,
  },
  {
    id: "authority_activation_state",
    surface: "activation_state",
    pattern: /\b(report[-_ ]?only|fail[-_ ]?closed|activation[-_ ]?state|activationState|guard[-_ ]?mode|classifier[-_ ]?enforcement|write[-_ ]?guard)\b/i,
  },
]);

const META_HUNK_PATTERNS = Object.freeze([
  {
    id: "meta_gate_or_classifier",
    surface: "gate_classifier_or_guard",
    pattern: /\b(gate|guard|classifier|protected path|risk classification|risk label|promotion risk|evidence quality)\b/i,
  },
  {
    id: "meta_approval_or_evidence_rules",
    surface: "approval_or_evidence_rules",
    pattern: /\b(approval criteria|approval rule|auto[-_ ]?accept|required evidence|evidence requirement|self[-_ ]?approval|no[-_ ]?merge|no[-_ ]?auto[-_ ]?apply)\b/i,
  },
  {
    id: "meta_eval_meaning",
    surface: "eval_meaning",
    pattern: /\b(rubric|taxonomy|schema|score band|threshold|judge prompt|evaluator prompt|evaluator|judge\/evaluator)\b/i,
  },
  {
    id: "meta_proposal_machinery",
    surface: "proposal_machinery",
    pattern: /\b(proposal marker|proposal packet|pr marker|process-change proposal|promotion policy|packet guard|marker parser)\b/i,
  },
]);

const FIELD_SENSITIVE_META_PATTERNS = Object.freeze([
  /\b(judge|evaluator|rubric|schema|gate|policy|classifier|candidate_tag|accepted_tag|materializer|approval|risk|threshold)\b/i,
  /\b(decomposition_quality_judge|failure_taxonomy|annotation\.schema|example\.schema|promotion-policy)\b/i,
]);

const ORDINARY_PHASE_PROMPT_PATTERNS = Object.freeze([
  /\b(pm_product_sufficiency_pass|pm_synthesis|sr_eng_grounding_pass|sr_eng_blocker_check)\b/i,
  /\b(prompt\/decomposition\/(?:pm_product_sufficiency_pass|pm_synthesis|sr_eng_grounding_pass|sr_eng_blocker_check))\b/i,
]);

const RUNTIME_DEFAULTS_FACTORY_PATTERNS = Object.freeze([
  /\b(rubric|schema|gate|policy|classifier|candidate_tag|accepted_tag|materializer|approval|risk|threshold)\b/i,
  /\b(failure_taxonomy|annotation\.schema|example\.schema|promotion-policy)\b/i,
]);

// The decomposition quality judge is the maintainer-owned evaluator: a runtime
// or model edit to its role in accepted-runtime-roles.json is a meta change,
// not an ordinary adopter runtime-default. Matches the JSON role key
// ("judge":) and the roles.judge.* / roles/judge field path forms.
const RUNTIME_DEFAULTS_JUDGE_ROLE_PATTERN =
  /(?:"judge"\s*:|\broles\.judge\b|\broles\/judge\b|\bjudge\.(?:runtime|model)\b)/i;

export function normalizeClassifierPath(filePath) {
  if (typeof filePath !== "string") return "";
  return filePath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^[ab]\//, "")
    .replace(/\/+/g, "/");
}

function normalizedLookupPath(filePath) {
  return normalizeClassifierPath(filePath).toLowerCase();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function classSort(left, right) {
  return CLASS_PRIORITY[left] - CLASS_PRIORITY[right];
}

function primaryClassFor(classes) {
  const sorted = [...classes].sort(classSort);
  return sorted.at(-1) || "ordinary_semantic";
}

function protectedPathRuleFor(filePath) {
  const lookupPath = normalizedLookupPath(filePath);
  const exact = EXACT_PROTECTED_PATHS.get(lookupPath);
  if (exact) return { ...exact, rule_id: `exact:${lookupPath}` };
  const prefixRule = PREFIX_PROTECTED_PATHS.find((rule) => lookupPath.startsWith(rule.prefix));
  if (prefixRule) return { ...prefixRule, rule_id: `prefix:${prefixRule.prefix}` };
  return null;
}

function isSensitiveRoot(filePath) {
  const lookupPath = normalizedLookupPath(filePath);
  return NEW_FILE_SENSITIVE_ROOTS.some((prefix) => lookupPath.startsWith(prefix));
}

function hunkLines(change) {
  const hunks = Array.isArray(change.hunks) ? change.hunks : [];
  const lines = [];
  for (const hunk of hunks) {
    if (typeof hunk === "string") {
      lines.push(...hunk.split(/\r?\n/));
    } else if (Array.isArray(hunk?.lines)) {
      lines.push(...hunk.lines.map((line) => String(line)));
    } else if (typeof hunk?.text === "string") {
      lines.push(...hunk.text.split(/\r?\n/));
    }
  }
  if (typeof change.diff === "string") lines.push(...change.diff.split(/\r?\n/));
  if (typeof change.patch === "string") lines.push(...change.patch.split(/\r?\n/));
  return lines;
}

function hunkText(change) {
  return hunkLines(change).join("\n");
}

function changedLineText(change) {
  return hunkLines(change)
    .filter((line) => /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
    .join("\n");
}

function matchingPatterns(patterns, text) {
  return patterns.filter((entry) => entry.pattern.test(text));
}

function packageJsonSensitiveScriptTouched(change) {
  if (normalizedLookupPath(change.path) !== "package.json") return false;
  const text = changedLineText(change);
  const touchedScripts = [...text.matchAll(/^[+-]\s*"([^"]+)"\s*:/gm)]
    .map((match) => match[1]);
  return touchedScripts.some((scriptName) =>
    SENSITIVE_PACKAGE_SCRIPT_PATTERNS.some((pattern) => pattern.test(scriptName)));
}

function statusOf(change) {
  return typeof change.status === "string" ? change.status.toLowerCase() : "modified";
}

function classifyFieldSensitiveChange({ change, rule, text }) {
  const authorityMatches = matchingPatterns(AUTHORITY_HUNK_PATTERNS, text);
  if (authorityMatches.length > 0) {
    return {
      className: "authority_change",
      additionalClasses: ["meta_change"],
      surface: authorityMatches[0].surface || rule.surface,
      reasonId: authorityMatches[0].id,
      detail: `field-sensitive artifact changes authority/custody behavior by hunk facts`,
    };
  }
  if (ORDINARY_PHASE_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    && !FIELD_SENSITIVE_META_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      className: "ordinary_semantic",
      additionalClasses: [],
      surface: "ordinary_prompt_pin",
      reasonId: "field_sensitive_phase_prompt_only",
      detail: "field-sensitive artifact changes only accepted agent prompt identity by hunk facts",
    };
  }
  if (rule.surface === "runtime_roles" && RUNTIME_DEFAULTS_JUDGE_ROLE_PATTERN.test(text)) {
    return {
      className: "meta_change",
      additionalClasses: [],
      surface: "judge_runtime_defaults",
      reasonId: "field_sensitive_runtime_defaults_judge_excluded",
      detail: "field-sensitive artifact changes the maintainer-owned judge runtime/model defaults",
    };
  }
  if (rule.surface === "runtime_roles"
    && /\b(runtime|model)\b/i.test(text)
    && !RUNTIME_DEFAULTS_FACTORY_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      className: "ordinary_semantic",
      additionalClasses: [],
      surface: "agent_behavior_runtime_defaults",
      reasonId: "field_sensitive_runtime_defaults_only",
      detail: "field-sensitive artifact changes only agent runtime/model defaults by hunk facts",
    };
  }
  if (FIELD_SENSITIVE_META_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      className: "meta_change",
      additionalClasses: [],
      surface: rule.surface,
      reasonId: "field_sensitive_meta_slot",
      detail: "field-sensitive artifact changes evaluator, gate, policy, tag, or schema meaning",
    };
  }
  return {
    className: "unknown_sensitive",
    additionalClasses: [],
    surface: rule.surface,
    reasonId: "field_sensitive_hunk_ambiguous",
    detail: "field-sensitive artifact changed without a deterministic ordinary/meta/authority slot match",
  };
}

function addReason(reasons, { id, className, filePath, detail, surface, patternId = null }) {
  reasons.push({
    id,
    class: className,
    path: filePath,
    detail,
    ...(surface ? { surface } : {}),
    ...(patternId ? { pattern_id: patternId } : {}),
  });
}

function classifyOneChange(change) {
  const filePath = normalizeClassifierPath(change.path || change.newPath || change.filePath);
  const oldPath = normalizeClassifierPath(change.oldPath || change.previousPath || "");
  const status = statusOf(change);
  const text = hunkText(change);
  const rule = protectedPathRuleFor(filePath);
  const oldRule = oldPath ? protectedPathRuleFor(oldPath) : null;
  const authorityMatches = matchingPatterns(AUTHORITY_HUNK_PATTERNS, text);
  const metaMatches = matchingPatterns(META_HUNK_PATTERNS, text);
  const classes = new Set();
  const reasons = [];
  const surfaces = new Set();
  const protectedPaths = new Set();

  if (rule || oldRule) {
    protectedPaths.add(filePath || oldPath);
    if (oldPath) protectedPaths.add(oldPath);
    surfaces.add((rule || oldRule).surface);
  }

  if ((change.binary || change.generated || change.unparseable)
    && (rule || oldRule || isSensitiveRoot(filePath) || isSensitiveRoot(oldPath) || normalizedLookupPath(filePath) === "package.json")) {
    classes.add("unknown_sensitive");
    surfaces.add(rule?.surface || oldRule?.surface || "generated_or_binary_sensitive");
    protectedPaths.add(filePath || oldPath);
    addReason(reasons, {
      id: "unknown_sensitive_generated_or_binary",
      className: "unknown_sensitive",
      filePath: filePath || oldPath,
      detail: "generated, binary, or unparseable change touched a sensitive surface",
      surface: rule?.surface || oldRule?.surface || "generated_or_binary_sensitive",
    });
    return { classes, reasons, surfaces, protectedPaths };
  }

  if (status === "renamed" && (rule || oldRule || isSensitiveRoot(filePath) || isSensitiveRoot(oldPath))) {
    classes.add("unknown_sensitive");
    surfaces.add(rule?.surface || oldRule?.surface || "sensitive_rename");
    protectedPaths.add(filePath || oldPath);
    addReason(reasons, {
      id: "unknown_sensitive_suspicious_rename",
      className: "unknown_sensitive",
      filePath: filePath || oldPath,
      detail: "rename touched a sensitive surface and must be reclassified by owner-reviewed map facts",
      surface: rule?.surface || oldRule?.surface || "sensitive_rename",
    });
    return { classes, reasons, surfaces, protectedPaths };
  }

  if (packageJsonSensitiveScriptTouched({ ...change, path: filePath })) {
    classes.add("unknown_sensitive");
    surfaces.add("package_script_authority");
    protectedPaths.add(filePath);
    addReason(reasons, {
      id: "unknown_sensitive_package_script",
      className: "unknown_sensitive",
      filePath,
      detail: "package.json script hunk touches promotion, scanner, runner, supervisor, GitHub setup, eval gate, or test authority",
      surface: "package_script_authority",
    });
    return { classes, reasons, surfaces, protectedPaths };
  }

  if (status === "added" && (!rule || rule.broadDefault) && isSensitiveRoot(filePath)) {
    classes.add("unknown_sensitive");
    surfaces.add("new_sensitive_surface");
    protectedPaths.add(filePath);
    addReason(reasons, {
      id: "unknown_new_sensitive_surface",
      className: "unknown_sensitive",
      filePath,
      detail: "new file under a sensitive root has no reviewed protected-path map entry",
      surface: "new_sensitive_surface",
    });
    return { classes, reasons, surfaces, protectedPaths };
  }

  if (!rule) {
    if (authorityMatches.length > 0) {
      const match = authorityMatches[0];
      classes.add("authority_change");
      surfaces.add(match.surface);
      protectedPaths.add(filePath);
      addReason(reasons, {
        id: "authority_hunk_unmapped_path",
        className: "authority_change",
        filePath,
        detail: "unmapped path contains deterministic authority, custody, credential, CI, activation, or write-path hunk facts",
        surface: match.surface,
        patternId: match.id,
      });
      return { classes, reasons, surfaces, protectedPaths };
    }
    if (metaMatches.length > 0) {
      const match = metaMatches[0];
      classes.add("meta_change");
      surfaces.add(match.surface);
      protectedPaths.add(filePath);
      addReason(reasons, {
        id: "meta_hunk_unmapped_path",
        className: "meta_change",
        filePath,
        detail: "unmapped path contains deterministic gate, classifier, evidence, proposal, evaluator, policy, or approval hunk facts",
        surface: match.surface,
        patternId: match.id,
      });
      return { classes, reasons, surfaces, protectedPaths };
    }
    classes.add("ordinary_semantic");
    addReason(reasons, {
      id: "ordinary_unprotected_path",
      className: "ordinary_semantic",
      filePath,
      detail: "path is outside the current protected meta/authority map and no sensitive new-file/script/binary fact was present",
      surface: "ordinary_content",
    });
    surfaces.add("ordinary_content");
    return { classes, reasons, surfaces, protectedPaths };
  }

  if (rule.className === "field_sensitive") {
    const resolved = classifyFieldSensitiveChange({ change: { ...change, path: filePath }, rule, text });
    classes.add(resolved.className);
    for (const className of resolved.additionalClasses) classes.add(className);
    surfaces.add(resolved.surface);
    addReason(reasons, {
      id: resolved.reasonId,
      className: resolved.className,
      filePath,
      detail: resolved.detail,
      surface: resolved.surface,
    });
    return { classes, reasons, surfaces, protectedPaths };
  }

  const ordinaryPromptEscalates = rule.className === "ordinary_semantic"
    && (authorityMatches.length > 0 || metaMatches.length > 0);
  if (!ordinaryPromptEscalates) classes.add(rule.className);
  addReason(reasons, {
    id: `protected_path_${rule.className}`,
    className: rule.className,
    filePath,
    detail: `path is protected by ${rule.rule_id}`,
    surface: rule.surface,
  });

  if (rule.className !== "authority_change" && authorityMatches.length > 0) {
    classes.add("authority_change");
    const match = authorityMatches[0];
    surfaces.add(match.surface);
    addReason(reasons, {
      id: "authority_hunk_escalation",
      className: "authority_change",
      filePath,
      detail: "hunk facts alter authority, custody, credential, activation, CI, or write-path posture",
      surface: match.surface,
      patternId: match.id,
    });
  }

  if (rule.className === "ordinary_semantic") {
    if (metaMatches.length > 0) {
      classes.add("meta_change");
      const match = metaMatches[0];
      surfaces.add(match.surface);
      addReason(reasons, {
        id: "ordinary_prompt_meta_escalation",
        className: "meta_change",
        filePath,
        detail: "ordinary agent prompt hunk attempts to alter governance, gates, evidence, proposal, or approval rules",
        surface: match.surface,
        patternId: match.id,
      });
    }
  }

  return { classes, reasons, surfaces, protectedPaths };
}

function normalizeChange(change) {
  if (!change || typeof change !== "object") {
    throw new TypeError("classifier changes must be objects");
  }
  const filePath = normalizeClassifierPath(change.path || change.newPath || change.filePath);
  if (!filePath) throw new TypeError("classifier change is missing a path");
  return { ...change, path: filePath };
}

export function parseUnifiedDiff(diffText) {
  if (typeof diffText !== "string" || diffText.trim() === "") return [];
  const changes = [];
  let current = null;
  let currentHunk = null;

  function finishCurrent() {
    if (current) changes.push(current);
    current = null;
    currentHunk = null;
  }

  for (const line of diffText.split(/\r?\n/)) {
    const diffMatch = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
    if (diffMatch) {
      finishCurrent();
      current = {
        oldPath: normalizeClassifierPath(diffMatch[1]),
        path: normalizeClassifierPath(diffMatch[2]),
        status: "modified",
        hunks: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = normalizeClassifierPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = normalizeClassifierPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("Binary files ")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const oldPath = line.slice(4).trim();
      if (oldPath !== "/dev/null") current.oldPath = normalizeClassifierPath(oldPath);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = line.slice(4).trim();
      if (newPath !== "/dev/null") current.path = normalizeClassifierPath(newPath);
      continue;
    }
    if (line.startsWith("@@")) {
      currentHunk = { header: line, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk) currentHunk.lines.push(line);
  }
  finishCurrent();
  return changes;
}

export function classifyMetaAuthorityChange(input = {}) {
  const hasStructuredChanges = Array.isArray(input.changes);
  const diffInput = input.diff || input.diffText || "";
  const rawChanges = hasStructuredChanges
    ? input.changes
    : parseUnifiedDiff(diffInput);
  if (!hasStructuredChanges && typeof diffInput === "string" && diffInput.trim() !== "" && rawChanges.length === 0) {
    // Annotate the assembled result with the demoted view (advisory_reasons /
    // advisories). This is a downstream read over reasons[]; it does not change
    // classify logic, the parseability invariant, or the fail-closed class.
    return withFactoryChangeDisposition({
      schema_version: META_CHANGE_CLASSIFIER_SCHEMA_VERSION,
      class: "unknown_sensitive",
      reasons: [{
        id: "unknown_sensitive_unparseable_diff",
        class: "unknown_sensitive",
        path: "<unparsed-diff>",
        detail: "non-empty diff text could not be parsed into deterministic file/hunk facts",
        surface: "unparseable_diff",
      }],
      protected_paths: ["<unparsed-diff>"],
      affected_surfaces: ["unparseable_diff"],
      mixed_classes: [],
      deterministic: true,
      fail_closed: true,
      ignored_evidence_sources: [],
    });
  }
  const changes = rawChanges.map(normalizeChange);
  const classSet = new Set();
  const reasons = [];
  const protectedPaths = new Set();
  const surfaces = new Set();

  for (const change of changes) {
    const result = classifyOneChange(change);
    for (const className of result.classes) classSet.add(className);
    reasons.push(...result.reasons);
    for (const protectedPath of result.protectedPaths) protectedPaths.add(protectedPath);
    for (const surface of result.surfaces) surfaces.add(surface);
  }

  const candidateEvidence = Array.isArray(input.candidateEvidence) ? input.candidateEvidence : [];
  const ignoredEvidenceSources = candidateEvidence
    .map((entry) => normalizeClassifierPath(entry?.path || entry?.source || "candidate_evidence"))
    .filter(Boolean);
  if (ignoredEvidenceSources.length > 0) {
    reasons.push({
      id: "candidate_evidence_ignored",
      class: "ordinary_semantic",
      path: null,
      detail: "candidate-produced evidence is context only and cannot lower or waive deterministic path/hunk classification",
      ignored_sources: ignoredEvidenceSources,
    });
  }

  if (classSet.size === 0) classSet.add("ordinary_semantic");
  const sortedClasses = [...classSet].sort(classSort);
  const primaryClass = primaryClassFor(classSet);

  // Annotate the assembled result with the demoted view (advisory_reasons /
  // advisories) so every classification result records which factory labels are
  // PATH-map/PROMPT-PROSE advisory vs gating. This reads reasons[] downstream;
  // it does not touch classify logic, the fast-paths, or the parseability rule.
  return withFactoryChangeDisposition({
    schema_version: META_CHANGE_CLASSIFIER_SCHEMA_VERSION,
    class: primaryClass,
    reasons,
    protected_paths: uniqueSorted([...protectedPaths]),
    affected_surfaces: uniqueSorted([...surfaces]),
    mixed_classes: sortedClasses.length > 1 ? sortedClasses : [],
    deterministic: true,
    fail_closed: primaryClass !== "ordinary_semantic" || classSet.has("unknown_sensitive"),
    ignored_evidence_sources: uniqueSorted(ignoredEvidenceSources),
  });
}

export function classifyUnifiedDiff(diffText, options = {}) {
  return classifyMetaAuthorityChange({ ...options, diff: diffText });
}
