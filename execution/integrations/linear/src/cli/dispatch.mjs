import fs from "node:fs";

import { cachePathForConfig, loadLinearConfig } from "../config.mjs";
import {
  emitDeterministicCheckResults,
} from "../deterministic-check-emission.mjs";
import {
  runDecompositionEvalTask,
} from "../decomposition-eval-cli.mjs";
import {
  registerJudgePromptInPhoenix,
  registerPromptInPhoenix,
  runDecompositionQualityJudge,
} from "../decomposition-quality-judge.mjs";
import {
  collectDisagreementReport,
} from "../disagreement-report.mjs";
import { resolveForegroundDomainCache } from "../domain-command-context.mjs";
import {
  collectEvalStatuses,
  rankEvalWorklist,
} from "../eval-status.mjs";
import {
  runImprovementDrafter,
} from "../improvement-drafter.mjs";
import { redactOAuthSecrets } from "../linear-oauth.mjs";
import { setupStatePathForCache } from "../local-state.mjs";
import {
  ensurePhoenixReady,
  phoenixStatus,
  stopPhoenix,
} from "../local-phoenix-manager.mjs";
import {
  runLocalPhoenixTracePreflight,
} from "../local-phoenix-trace-sink.mjs";
import {
  amendExperimentReceipt,
  runDecompositionExperiment,
} from "../phoenix-experiment.mjs";
import {
  createPhoenixTraceAnnotation,
  promoteTraceReceiptToPhoenixDataset,
  resolveAnnotationIdentifier,
} from "../phoenix-self-improvement.mjs";
import {
  evaluateProcessChangeGate,
} from "../process-change-gate.mjs";
import {
  PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
  promoteCandidate,
} from "../promote-candidate.mjs";
import {
  collectPhase2ProposalWorklist,
  PHASE_2_PROPOSAL_STATE_NAME_LIST,
  PHASE_2_PROPOSAL_WORKLIST_SCHEMA_VERSION,
} from "../promotion/proposal-worklist-read-model.mjs";
import {
  scanPromotionCandidates,
} from "../promotion-candidate-scanner.mjs";
import {
  DEFAULT_RICH_DATASET_NAME,
  promoteRichDecompositionExample,
} from "../rich-promotion.mjs";
import { readTraceHealth, readTraceReceipt } from "../trace-status-store.mjs";
import { runGitHubInitPhase } from "../github-setup.mjs";
import {
  defaultRunGit,
  registerGitRepoResourceKind,
} from "../../../git/git-repo-materializer.mjs";
import {
  runDomainBindRepoCommand,
} from "./domain-bind-repo-command.mjs";
import {
  runDoctorCommand,
  runDoctorLinearCommand,
} from "./doctor-command.mjs";
import { createCliOutput } from "./cli-output.mjs";
import { flagValue, parseCliFlags } from "./flags.mjs";
import {
  configWithGithubFlags,
  githubFailureTitle,
} from "./github-command-options.mjs";
import {
  githubInitTransportFromFlags,
  runLinearSetupCommand,
} from "./linear-setup-command.mjs";
import {
  createBootstrapLinearCredentialStore,
  runLocalSetupCleanupCommand,
} from "./local-setup-cleanup.mjs";
import {
  runGatewayCommand,
  runRunnerCommand,
  runRuntimeSmokeCommand,
  runTriggerStatusCommand,
} from "./runner-command.mjs";
import {
  runSupervisorDisableCommand,
  runSupervisorEnableCommand,
  runSupervisorReconcileCommand,
  runSupervisorRegisterCommand,
  runSupervisorRunCommand,
  runSupervisorStatusCommand,
  runSupervisorUnregisterCommand,
} from "./supervisor-command.mjs";
import {
  agenticFactoryHeading,
  compactPairs,
  humanizeToken,
  printVerboseHint,
  yesNo,
} from "./operator-output.mjs";

const CLI_USAGE = "Usage: node execution/integrations/linear/cli.mjs <init|domain:add|domain:bind-repo|github:init|doctor|doctor:linear|phoenix:start|phoenix:doctor|phoenix:status|phoenix:preflight|phoenix:annotate-trace|phoenix:promote-run|phoenix:promote-decomposition|phoenix:experiment-decomposition|phoenix:experiment-amend|eval:decomposition|eval:disagreements|eval:emit-checks|eval:gate|eval:judge|eval:register-prompt|eval:register-judge-prompt|promote-candidate|draft-improvement|promotion:scan|supervisor:register|supervisor:run|supervisor:status|supervisor:reconcile|supervisor:disable|supervisor:enable|supervisor:unregister|phoenix:stop|gateway|runner|runtime-smoke|trigger-status|worklist|uninstall|reset>";

const COMMAND_TABLE = new Map([
  ["uninstall", runLocalSetupCleanupCommand],
  ["reset", runLocalSetupCleanupCommand],
  ["init", runLinearSetupCommand],
  ["domain:add", runLinearSetupCommand],
  ["domain:bind-repo", runDomainBindRepoCommand],
  ["github:init", runGithubInitCommand],
  ["doctor", runDoctorCommand],
  ["doctor:linear", runDoctorLinearCommand],
  ["phoenix:start", runPhoenixStartCommand],
  ["phoenix:doctor", runPhoenixDoctorCommand],
  ["phoenix:status", runPhoenixStatusCommand],
  ["phoenix:preflight", runPhoenixPreflightCommand],
  ["phoenix:annotate-trace", runPhoenixAnnotateTraceCommand],
  ["worklist", runWorklistCommand],
  ["phoenix:promote-run", runPhoenixPromoteRunCommand],
  ["phoenix:promote-decomposition", runPhoenixPromoteDecompositionCommand],
  ["eval:emit-checks", runEvalEmitChecksCommand],
  ["eval:judge", runEvalJudgeCommand],
  ["eval:decomposition", runEvalDecompositionCommand],
  ["phoenix:experiment-decomposition", runPhoenixExperimentDecompositionCommand],
  ["phoenix:experiment-amend", runPhoenixExperimentAmendCommand],
  ["eval:disagreements", runEvalDisagreementsCommand],
  ["eval:gate", runEvalGateCommand],
  ["draft-improvement", runDraftImprovementCommand],
  ["promote-candidate", runPromoteCandidateCommand],
  ["promotion:scan", runPromotionScanCommand],
  ["supervisor:register", runSupervisorRegisterCommand],
  ["supervisor:run", runSupervisorRunCommand],
  ["supervisor", runSupervisorRunCommand],
  ["supervisor:status", runSupervisorStatusCommand],
  ["supervisor:reconcile", runSupervisorReconcileCommand],
  ["supervisor:disable", runSupervisorDisableCommand],
  ["supervisor:enable", runSupervisorEnableCommand],
  ["supervisor:unregister", runSupervisorUnregisterCommand],
  ["eval:register-prompt", runEvalRegisterPromptCommand],
  ["eval:register-judge-prompt", runEvalRegisterPromptCommand],
  ["phoenix:stop", runPhoenixStopCommand],
  ["gateway", runGatewayCommand],
  ["runner", runRunnerCommand],
  ["runtime-smoke", runRuntimeSmokeCommand],
  ["trigger-status", runTriggerStatusCommand],
]);

const NOUN_VERB_COMMANDS = new Map([
  ["gateway", new Map([
    ["start", { command: "gateway", consumeVerb: true }],
    ["status", { command: "gateway", consumeVerb: false }],
  ])],
  ["domain", new Map([
    ["add", { command: "domain:add", consumeVerb: true }],
    ["bind-repo", { command: "domain:bind-repo", consumeVerb: true }],
  ])],
]);

// Normalize `<noun> <verb>` invocations to the real command token. Single-token and colon commands
// pass through unchanged. A leading global flag (or no verb) means a bare noun - pass through. An
// unknown verb passes through unchanged so the existing unknown-command/usage path (exit 2) still fires.
export function normalizeCommandInvocation({ command, args = [] } = {}) {
  const verbs = NOUN_VERB_COMMANDS.get(command);
  if (!verbs) return { command, args };
  const verb = args[0];
  if (!verb || verb.startsWith("--")) return { command, args };
  const mapping = verbs.get(verb);
  if (!mapping) return { command, args };
  return { command: mapping.command, args: mapping.consumeVerb ? args.slice(1) : args };
}

const COMMAND_HELP = new Map([
  ["init", "Usage: npm run init -- --domain <name> [--workspace <name-or-id>] [--github-dry-run] [--verbose]"],
  ["domain:add", "Usage: npm run domain:add -- --domain <name> [--workspace <name-or-id>] [--verbose]"],
  ["domain:bind-repo", "Usage: npm run domain:bind-repo -- --domain <id> --path <existing checkout>"],
  ["github:init", "Usage: npm run github:init -- [--github-dry-run] [--github-owner <owner>] [--github-repo <repo>]"],
  ["doctor", "Usage: npm run doctor -- [--domain <id>] [--verbose]"],
  ["doctor:linear", "Usage: npm run doctor:linear -- [--domain <id>] [--verbose]"],
  ["gateway", "Usage: npm run gateway -- [status] [--domain <id>] [--verbose]"],
  ["runtime-smoke", "Usage: npm run runtime-smoke -- [--domain <id>] [--verbose]"],
  ["reset", "Usage: npm run reset -- [--domain <id>] [--verbose]"],
  ["uninstall", "Usage: npm run uninstall -- --domain <id> [--verbose]"],
]);

const EVAL_REGISTER_PROMPT_COMMAND_OPTIONS = Object.freeze({
  "eval:register-judge-prompt": {
    defaultTargetKey: "prompt/decomposition/decomposition_quality_judge",
    registerPrompt: registerJudgePromptInPhoenix,
  },
  "eval:register-prompt": {
    defaultTargetKey: null,
    registerPrompt: registerPromptInPhoenix,
  },
});

function createCliContext({ repoRoot, output = createCliOutput() }) {
  const config = loadLinearConfig({ repoRoot });
  const cachePath = cachePathForConfig(config, repoRoot);
  const setupStatePath = setupStatePathForCache(cachePath);
  const credentialStore = createBootstrapLinearCredentialStore({ config, repoRoot });
  return {
    cachePath,
    config,
    credentialStore,
    output,
    repoRoot,
    runGit: defaultRunGit,
    setupStatePath,
  };
}

export async function runCliCommand({ repoRoot = process.cwd(), command, args = [] } = {}) {
  registerGitRepoResourceKind();
  const normalized = normalizeCommandInvocation({ command, args });
  command = normalized.command;
  args = normalized.args;
  const outputFlags = extractCliOutputFlags(args);
  const output = createCliOutput({
    verbose: outputFlags.verbose,
    color: outputFlags.noColor ? false : undefined,
    unicode: outputFlags.ascii ? false : undefined,
  });
  const handler = COMMAND_TABLE.get(command);
  if (isHelpRequest(command, outputFlags.args)) {
    printCliHelp(output, command);
    process.exitCode = 0;
    return;
  }
  if (!handler) {
    printCliUsage(output);
    return;
  }
  const context = createCliContext({ repoRoot, output });
  await handler({ context, command, args: outputFlags.args });
}

// Global output flags (`--verbose`, `--no-color`, `--ascii`) are recognized only as a
// contiguous LEADING or TRAILING run of the argument list — never interleaved between
// command arguments. The primitive parseCliFlags binds the next non-"--" token as a flag's
// value, so peeling only from the ends guarantees we can never retokenize a command's flags
// or swallow one of its positionals/values. (No `-v` short form: a single-dash token is
// indistinguishable from a positional in this grammar.)
export function extractCliOutputFlags(args = []) {
  const GLOBAL_FLAGS = new Set(["--verbose", "--no-color", "--ascii"]);
  let verbose = false;
  let noColor = false;
  let ascii = false;
  const apply = (token) => {
    if (token === "--verbose") verbose = true;
    else if (token === "--no-color") noColor = true;
    else if (token === "--ascii") ascii = true;
  };
  let start = 0;
  let end = args.length;
  while (start < end && GLOBAL_FLAGS.has(args[start])) {
    apply(args[start]);
    start += 1;
  }
  while (end > start && GLOBAL_FLAGS.has(args[end - 1])) {
    apply(args[end - 1]);
    end -= 1;
  }
  return { args: args.slice(start, end), verbose, noColor, ascii };
}

function printCliUsage(output = createCliOutput()) {
  output.error({
    what: CLI_USAGE,
  });
  process.exitCode = 2;
}

function isHelpRequest(command, args = []) {
  return command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h");
}

function printCliHelp(output = createCliOutput(), command = null) {
  if (COMMAND_TABLE.has(command)) {
    output.raw(`${COMMAND_HELP.get(command) || `Usage: npm run ${command} -- [options]`}\n`);
    return;
  }
  output.raw(`${CLI_USAGE}\n`);
}

export async function runGithubInitCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    const { flags } = parseCliFlags(args);
    const githubConfig = configWithGithubFlags(config, flags);
    const githubProgress = (line) => {
      const text = String(line || "");
      if (/^(FAIL GitHub setup:|Repair:)/i.test(text)) return;
      const visibleProgress = text.match(/^GitHub progress:\s*(.+)$/);
      if (visibleProgress) {
        output.info(visibleProgress[1]);
        return;
      }
      if (/^GitHub repo target:/i.test(text)) {
        output.info(text);
        return;
      }
      output.detail(text);
    };
    const result = await runGitHubInitPhase({
      repoRoot,
      config: githubConfig,
      transport: await githubInitTransportFromFlags({
        config: githubConfig,
        flags,
        repoRoot,
        onProgress: githubProgress,
      }),
      requestedOwner: flags["github-owner"] || null,
      requestedRepoName: flags["github-repo"] || null,
      requestedVisibility: flags["github-visibility"] || null,
      onProgress: githubProgress,
    });
    if (!result.ok) {
      output.detail(`reason: ${result.reason}`);
      if (result.detail) output.detail(result.detail);
      output.error({
        what: githubFailureTitle(result.reason),
        why: result.detail,
        fix: result.repair || "re-run after repair",
      });
      process.exitCode = 1;
      return;
    }
    output.success(`Repo connected: ${result.connection.repo.full_name}`);
    if (result.connection.connection_mode === "dry_run") {
      output.warn("Dry-run recorded; adoption is not complete. Re-run without --github-dry-run.");
    }
    output.detail(`connection_mode=${result.connection.connection_mode}`);
    process.exitCode = 0;
}
export async function runPhoenixStartCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix start");
    let phoenix;
    try {
      phoenix = await ensurePhoenixReady({
        repoRoot,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Local Phoenix could not start",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "check .agent-shell/logs/phoenix-server.err.log and retry.",
      });
      process.exitCode = 1;
      return;
    }
    if (!phoenix.ok) {
      output.error({
        what: "Local Phoenix could not start",
        why: phoenix.reason,
        fix: phoenix.repairHint,
      });
      process.exitCode = 1;
      return;
    }
    output.success(`Local Phoenix running: ${phoenix.appUrl}`);
    output.detail(`collector=${phoenix.collectorUrl}`);
    output.detail(`managed=${phoenix.managed}`);
    output.detail(`started=${phoenix.started}`);
    output.nextSteps([
      { text: "Open Phoenix", hint: phoenix.appUrl },
    ]);
    printVerboseHint(output);
    process.exitCode = 0;
}
export async function runPhoenixDoctorCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix doctor");
    let status;
    try {
      status = await phoenixStatus({ repoRoot });
    } catch (error) {
      output.error({
        what: "Local Phoenix doctor could not run",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "run npm run phoenix:start after repairing the local Phoenix URL.",
      });
      process.exitCode = 1;
      return;
    }
    renderPhoenixHealthStatus(status, output, { includeOpenPhoenix: true });
    process.exitCode = status.ok ? 0 : 1;
}
export async function runPhoenixStatusCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix status");
    let status;
    try {
      status = await phoenixStatus({ repoRoot });
    } catch (error) {
      output.error({
        what: "Local Phoenix status could not be read",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "run npm run phoenix:doctor for local Phoenix repair guidance.",
      });
      process.exitCode = 1;
      return;
    }
    renderPhoenixHealthStatus(status, output);
    const health = readTraceHealth({ repoRoot });
    renderTraceHealth(health, output);
    const evalReport = await collectEvalStatuses({ repoRoot });
    renderEvalStatusReport(evalReport, output);
    const worklistItems = rankEvalWorklist(evalReport);
    output.nextSteps(status.ok
      ? [
        { text: "Open Phoenix", hint: status.appUrl },
        { text: "npm run worklist", hint: "rank what needs judgment" },
      ]
      : [
        { text: "npm run phoenix:start", hint: "start local traces and eval UI" },
        { text: "npm run phoenix:doctor", hint: "inspect local Phoenix health" },
      ]);
    if (worklistItems.length > 0) {
      output.detail(`${worklistItems.length} worklist item(s) need judgment.`);
    }
    printVerboseHint(output);
    process.exitCode = status.ok ? 0 : 1;
}
export async function runPhoenixPreflightCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix preflight");
    let preflight;
    try {
      const foreground = resolveForegroundDomainCache({
        config,
        repoRoot,
        domainId: flagValue(args, "--domain"),
      });
      preflight = await runLocalPhoenixTracePreflight({
        repoRoot,
        onProgress: (line) => output.detail(line),
        domainContext: foreground.context,
      });
    } catch (error) {
      output.error({
        what: "Local Phoenix preflight could not run",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "run npm run init or pass --domain after setup, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    if (!preflight.ok) {
      output.error({
        what: "Local Phoenix preflight failed",
        why: preflight.reason || preflight.status,
        fix: preflight.repairHint,
      });
      output.detail(`run_id=${preflight.runId}`);
      output.detail(`trace_id=${preflight.traceId || "none"}`);
      process.exitCode = 1;
      return;
    }
    output.success(`Local Phoenix preflight: ${preflight.status}`);
    output.keyValues([
      ["Open Phoenix", preflight.appUrl],
    ]);
    output.detail(`run_id=${preflight.runId}`);
    output.detail(`trace_id=${preflight.traceId || "none"}`);
    output.detail(`collector=${preflight.collectorUrl || "unknown"}`);
    output.detail(`project=${preflight.projectName || "unknown"}`);
    printVerboseHint(output);
    process.exitCode = 0;
}
export async function runPhoenixAnnotateTraceCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix annotate trace");
    const { positionals, flags } = parseCliFlags(args);
    const [traceId, label, maybeScore, ...explanationParts] = positionals;
    const usage = "Usage: npm run phoenix:annotate-trace -- <trace_id> <label> <score> <explanation> [--name <dimension>] [--kind HUMAN|LLM|CODE] [--identifier <id>] [--maturity new|calibrating|stable]";
    if (!traceId || !label || maybeScore === undefined || !/^-?\d+(\.\d+)?$/.test(maybeScore)) {
      output.error({ what: usage });
      process.exitCode = 2;
      return;
    }
    const explanation = explanationParts.join(" ");
    if (!explanation.trim()) {
      output.error({
        what: usage,
        why: "An explanation is required: record why this judgment was made.",
      });
      process.exitCode = 2;
      return;
    }
    const annotatorKind = String(flags.kind || "HUMAN").toUpperCase();
    let annotation;
    let resolvedIdentifier;
    try {
      resolvedIdentifier = resolveAnnotationIdentifier({
        annotatorKind,
        identifier: flags.identifier,
        config,
      });
      annotation = await createPhoenixTraceAnnotation({
        repoRoot,
        traceId,
        name: flags.name,
        label,
        score: Number(maybeScore),
        explanation,
        annotatorKind,
        identifier: resolvedIdentifier.identifier,
        workspaceMaturity: flags.maturity || config?.evals?.workspace_maturity || "new",
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Local Phoenix annotation failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "check the trace id, annotation fields, and local Phoenix health, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    output.success("Local Phoenix annotation accepted");
    output.keyValues([
      ["Open Phoenix", annotation.appUrl],
    ]);
    output.detail(`annotation_ids=${annotation.annotationIds.join(",") || "accepted"}`);
    output.detail(`trace_id=${traceId}`);
    output.detail(`annotator=${annotatorKind} identifier=${resolvedIdentifier.identifier} (${resolvedIdentifier.source}; asserted, not authenticated)`);
    printVerboseHint(output);
    process.exitCode = 0;
}
export async function runWorklistCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "worklist");
    // Agent-session judgment worklist: a derived, read-only view recomputed on
    // every invocation. It never mutates Linear, never writes to Phoenix, and
    // persists nothing (transient stdout report only).
    let report;
    try {
      report = await collectEvalStatuses({ repoRoot });
    } catch (error) {
      report = fallbackEvalWorklistReport({ error });
    }
    let proposalReport;
    try {
      proposalReport = await collectPhase2ProposalWorklist({ repoRoot });
    } catch (error) {
      proposalReport = fallbackProposalWorklistReport({ error });
    }
    const items = rankEvalWorklist(report);
    renderWorklistReport({ report, items, proposalReport }, output);
    printVerboseHint(output);
    process.exitCode = 0;
}
export async function runPhoenixPromoteRunCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix promote run");
    const [runId, datasetName = "agentic-factory-decomposition-runs"] = args;
    if (!runId) {
      output.error({ what: "Usage: npm run phoenix:promote-run -- <run_id> [dataset_name]" });
      process.exitCode = 2;
      return;
    }
    let promotion;
    try {
      const receipt = readTraceReceipt({ repoRoot, runId });
      if (!receipt) throw new Error(`No local trace receipt found for run ${runId}.`);
      promotion = await promoteTraceReceiptToPhoenixDataset({
        repoRoot,
        receipt,
        datasetName,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Local Phoenix dataset promotion failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "confirm the run has a local trace receipt and Phoenix is healthy, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    output.success(`Local Phoenix dataset promotion: ${promotion.datasetName} (${promotion.action})`);
    output.detail(`dataset_id=${promotion.dataset?.dataset_id || "unknown"}`);
    output.detail(`dataset_version_id=${promotion.dataset?.version_id || "unknown"}`);
    output.nextSteps([
      { text: "Open Phoenix", hint: promotion.appUrl },
    ]);
    printVerboseHint(output);
    process.exitCode = 0;
}
export async function runPhoenixPromoteDecompositionCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix promote decomposition");
    // Rich decomposition example promotion (explicit command; bounded
    // phoenix:promote-run stays the safe default). Fails closed on missing
    // receipt/artifact/snapshot, token-shaped content, and unclassifiable
    // content; idempotency is client-side via the local promotion receipt.
    const rawArgs = args;
    const forceNewVersion = rawArgs.includes("--force-new-version");
    const { positionals, flags } = parseCliFlags(rawArgs.filter((arg) => arg !== "--force-new-version"));
    const [runId, datasetName = DEFAULT_RICH_DATASET_NAME] = positionals;
    if (!runId) {
      output.error({
        what: "Usage: npm run phoenix:promote-decomposition -- <run_id> [dataset_name] [--annotation-ids <id,id>] [--split calibration|regression] [--force-new-version]",
      });
      process.exitCode = 2;
      return;
    }
    const annotationIds = String(flags["annotation-ids"] || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    let result;
    try {
      result = await promoteRichDecompositionExample({
        repoRoot,
        runId,
        datasetName,
        annotationIds,
        explicitSplit: flags.split || null,
        forceNewVersion,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Rich decomposition promotion failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "repair local Phoenix or the promotion inputs, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      output.error({
        what: `Rich decomposition promotion failed: ${result.state || "cannot_promote"}`,
        why: richPromotionFailureWhy(result),
        fix: richPromotionFix(result),
      });
      process.exitCode = 1;
      return;
    }
    if (result.idempotent) {
      output.success(`Rich promotion reused: ${datasetName}`);
      output.detail(result.detail);
      output.detail(`run_id=${runId}`);
      output.detail(`dataset_id=${result.dataset_id || "unknown"}`);
      output.detail(`dataset_version_id=${result.dataset_version_id || "unknown"}`);
      output.detail(`example_content_hash=${result.example_content_hash}`);
      output.detail(`receipt=${result.receipt_path}`);
      printVerboseHint(output);
      process.exitCode = 0;
      return;
    }
    output.success(`Rich promotion: ${result.datasetName} (${result.action})`);
    output.keyValues([
      ["Dataset", result.datasetName],
      ["Split", `${result.split} (${result.split_assignment}${result.split_assignment === "metadata_fallback" ? "; pending native assignment" : ""})`],
    ], { heading: "Promotion" });
    if (result.split_assignment === "metadata_fallback") {
      output.warn("Native split assignment is pending in Phoenix; metadata.dataset_split was recorded and is not native split evidence.");
    }
    output.detail(`run_id=${runId}`);
    output.detail(`dataset_id=${result.dataset_id || "unknown"}`);
    output.detail(`dataset_version_id=${result.dataset_version_id || "unknown"}`);
    output.detail(`example_id=${result.example_id}`);
    output.detail(`example_content_hash=${result.example_content_hash}`);
    if (result.annotation_ids.length > 0) output.detail(`annotation_ids=${result.annotation_ids.join(",")}`);
    output.detail(`sanitizer_report: ${JSON.stringify(result.sanitizer_report)}`);
    output.detail(`receipt=${result.receipt_path}`);
    output.nextSteps([
      { text: "Open Phoenix", hint: result.appUrl },
    ]);
    printVerboseHint(output);
    process.exitCode = 0;
}
export async function runEvalEmitChecksCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "eval emit-checks");
    // Track D2: post-run deterministic check emission, strictly outside the
    // live mutation path (re-runnable on demand). Runs the existing offline
    // quality.mjs evaluators over the local run artifact and stores the
    // results as Phoenix trace annotations with annotator_kind CODE on the
    // run's actual trace id from the trace receipt. When the pinned Phoenix
    // cannot store CODE results, the results are printed as report output
    // below and the command FAILS CLOSED — never spoofed as HUMAN/LLM.
    const [runId] = args;
    if (!runId) {
      output.error({ what: "Usage: npm run eval:emit-checks -- <run_id>" });
      process.exitCode = 2;
      return;
    }
    let result;
    try {
      result = await emitDeterministicCheckResults({
        repoRoot,
        runId,
        requirePhoenixNative: true,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Deterministic check emission failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || `repair the run evidence or Phoenix CODE annotation storage, then rerun npm run eval:emit-checks -- ${runId}.`,
      });
      process.exitCode = 1;
      return;
    }
    renderDeterministicCheckReport(result, output);
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
}
export async function runEvalJudgeCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "eval judge");
    // Track D: the decomposition_quality model judge — code-first wrapper
    // around a Phoenix-managed prompt, strictly outside the live mutation
    // path (the judge never receives a Linear client and never decides live
    // mutation; CONSTRAINTS #27). Executes the repo-ACCEPTED prompt snapshot
    // unless --candidate-prompt-version pins a Phoenix candidate for an
    // experiment (labeled as such in all output metadata). Timeouts record
    // judge_missing and malformed output records judge_invalid in the report
    // and the local judge receipt — never a Phoenix annotation pretending a
    // judgment happened.
    const { positionals, flags } = parseCliFlags(args);
    const [runId] = positionals;
    if (!runId) {
      output.error({ what: "Usage: npm run eval:judge -- <run_id> [--candidate-prompt-version <phoenix_version_id>]" });
      process.exitCode = 2;
      return;
    }
    let result;
    try {
      result = await runDecompositionQualityJudge({
        repoRoot,
        runId,
        config,
        candidatePromptVersionId: flags["candidate-prompt-version"] || null,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Decomposition quality judge failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || `repair the run evidence, judge prompt, or Phoenix health, then rerun npm run eval:judge -- ${runId}.`,
      });
      process.exitCode = 1;
      return;
    }
    renderJudgeReport(result, output);
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
}
export async function runEvalDecompositionCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "eval decomposition");
    // Track E: first-class non-mutating decomposition eval-mode task. Wraps
    // the existing runDecompositionEvalMode over one captured example —
    // structurally incapable of Linear mutation (snapshot-backed read-only
    // client + eval-mode guard) and of local gateway wake claims (no wake store
    // exists on this path; CONSTRAINTS #27). Phoenix stays lazy: traces and
    // the optional --emit-checks/--judge chains reuse Phoenix only when it is
    // already running and degrade to report-only/local receipts otherwise.
    const rawArgs = args;
    const emitChecks = rawArgs.includes("--emit-checks");
    const judgeRequested = rawArgs.includes("--judge");
    const { flags } = parseCliFlags(
      rawArgs.filter((arg) => arg !== "--emit-checks" && arg !== "--judge"),
    );
    const usage =
      "Usage: npm run eval:decomposition -- (--run <run_id> | --example <path-to-example.json> | --dataset <name> --example-id <id>) [--domain <domain_id>] [--variant <variant_id>] [--emit-checks] [--judge]";
    let result;
    try {
      const foreground = resolveForegroundDomainCache({
        config,
        repoRoot,
        domainId: flags.domain || null,
      });
      result = await runDecompositionEvalTask({
        repoRoot,
        config: foreground.config,
        domainContext: foreground.context,
        runId: flags.run || null,
        examplePath: flags.example || null,
        datasetName: flags.dataset || null,
        datasetExampleId: flags["example-id"] || null,
        variantId: flags.variant || null,
        emitChecks,
        judge: judgeRequested,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Eval decomposition could not run",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "run npm run init or pass --domain after setup, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    if (result.status === "not_run" && result.reason === "invalid_input_selection") {
      output.error({ what: usage });
      process.exitCode = 2;
      return;
    }
    renderEvalRunReport(result, output);
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
}
export async function runPhoenixExperimentDecompositionCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix experiment decomposition");
    // Track F: thin, agent-callable Phoenix experiment wrapper over a curated
    // dataset. Phoenix IS the experiment store (no custom store): the wrapper
    // creates the experiment via REST, runs the non-mutating eval task per
    // example with the requested variant, records task outputs + explicit
    // evaluator results as experiment runs/evaluations, and writes the local
    // managed-experiment receipt under .agentic-factory/experiments/.
    // Intent defaults to exploratory in MVP: no repo-owned automation policy
    // exists yet, so promotion_candidate requires the explicit --intent flag.
    const { positionals, flags } = parseCliFlags(args);
    const [datasetName] = positionals;
    if (!datasetName) {
      output.error({
        what: "Usage: npm run phoenix:experiment-decomposition -- <dataset_name> [--variant <variant_id>] [--intent promotion_candidate|exploratory] [--split train|test] [--example-ids <id,id>]",
      });
      process.exitCode = 2;
      return;
    }
    const exampleIds = String(flags["example-ids"] || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    let result;
    try {
      result = await runDecompositionExperiment({
        repoRoot,
        config,
        datasetName,
        variantId: flags.variant || null,
        intentFlag: flags.intent ?? null,
        split: flags.split || null,
        exampleIds: exampleIds.length > 0 ? exampleIds : null,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Phoenix experiment failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "repair Phoenix or the experiment inputs, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderPhoenixExperimentResult(result, output);
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
}
export async function runPhoenixExperimentAmendCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix experiment amend");
    // Managed-experiment receipt amendments: retroactive registration,
    // reclassification, and withdrawal. Identity is verified through the
    // local resolver (REST GET); amendments are APPEND-ONLY events — prior
    // receipt facts are never rewritten.
    const { positionals, flags } = parseCliFlags(args);
    const [receiptId] = positionals;
    if (!receiptId || !flags.action || !flags.reason) {
      output.error({
        what: "Usage: npm run phoenix:experiment-amend -- <receipt_id> --action register|reclassify|withdraw --reason <text> [--experiment-id <id>] [--intent promotion_candidate|exploratory]",
      });
      process.exitCode = 2;
      return;
    }
    let result;
    try {
      result = await amendExperimentReceipt({
        repoRoot,
        receiptId,
        action: flags.action,
        reason: flags.reason,
        experimentId: flags["experiment-id"] || null,
        newIntent: flags.intent || null,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Experiment receipt amendment failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "check the receipt id, amendment flags, and local Phoenix health, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderPhoenixExperimentAmendmentResult(result, output);
    process.exitCode = result.ok ? 0 : 1;
}
export async function runEvalDisagreementsCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "eval disagreements");
    // Step 9 (Track G): disagreement report. Compares HUMAN, LLM, and CODE
    // results for one run or one experiment while preserving the raw records
    // (scores, rationales, failure modes, Phoenix links). Derived states only
    // (CONSTRAINTS #3/#33): GET-only against Phoenix, nothing persisted
    // anywhere — rerun to recompute. The same detection logic backs the
    // step 3 worklist, so the two surfaces can never disagree.
    const { positionals, flags } = parseCliFlags(args);
    const [runId] = positionals;
    const experimentRef = flags.experiment || null;
    if ((!runId && !experimentRef) || (runId && experimentRef)) {
      output.error({
        what: "Usage: npm run eval:disagreements -- (<run_id> | --experiment <receipt_id_or_experiment_id>)",
      });
      process.exitCode = 2;
      return;
    }
    let report;
    try {
      report = await collectDisagreementReport({
        repoRoot,
        runId: runId || null,
        experimentRef,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Disagreement report failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "check the run, experiment reference, and local Phoenix health, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderDisagreementReport(report, output);
    process.exitCode = report.ok ? 0 : 1;
}
export async function runEvalGateCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "eval gate");
    // Step 9 (Track G): process-change gate. Pure evaluation logic: reads the
    // managed receipt + Phoenix evidence (REST GETs) + repo-owned policy and
    // manifest, evaluates every named gate condition fail-closed
    // (CONSTRAINTS #34), and reports in product terms. No repo mutation, no
    // PR creation, no Phoenix writes — the step 10 controller consumes this
    // result. The report is stdout + a local record under
    // .agentic-factory/gate-reports/ only.
    const rawArgs = args;
    const acceptCrossVersion = rawArgs.includes("--accept-cross-version");
    const { flags } = parseCliFlags(rawArgs.filter((arg) => arg !== "--accept-cross-version"));
    if (!flags.experiment) {
      output.error({
        what: "Usage: npm run eval:gate -- --experiment <receipt_id> [--accept-cross-version]",
      });
      process.exitCode = 2;
      return;
    }
    let result;
    try {
      result = await evaluateProcessChangeGate({
        repoRoot,
        receiptId: flags.experiment,
        acceptCrossVersion,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Process-change gate failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "check the managed experiment receipt and local Phoenix health, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderProcessChangeGateReport(result, output);
    process.exitCode = result.ok && result.verdict === "pass" ? 0 : 1;
}
export async function runDraftImprovementCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "draft improvement");
    const rawArgs = args;
    const supersedeExistingCandidate = rawArgs.includes("--supersede-existing-candidate");
    const { flags } = parseCliFlags(rawArgs.filter((arg) => arg !== "--supersede-existing-candidate"));
    const failureModeIds = String(flags["failure-modes"] || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const usage =
      "Usage: npm run draft-improvement -- (--opportunity <registry_envelope_hash> | --target <candidate_target_key>) [--failure-modes <id,id>] [--dataset <name>] [--supersede-existing-candidate]";
    if ((flags.opportunity ? 1 : 0) + (flags.target ? 1 : 0) !== 1) {
      output.error({
        what: usage,
        why: "Pass exactly one source for the draft: either --opportunity or --target.",
        fix: "choose the promotion opportunity hash or the candidate target key, then rerun.",
      });
      process.exitCode = 2;
      return;
    }
    let result;
    try {
      result = await runImprovementDrafter({
        repoRoot,
        opportunityHash: flags.opportunity || null,
        targetKey: flags.target || null,
        failureModeIds,
        datasetName: flags.dataset || null,
        supersedeExistingCandidate,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Improvement draft could not run",
        why: redactOAuthSecrets(error.message),
        fix: "check the opportunity or target id, local Phoenix health, and runtime adapter configuration, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderImprovementDraftResult(result, output);
    if (result.ok) printVerboseHint(output);
    process.exitCode = result.ok ? 0 : 1;
}
export async function runPromoteCandidateCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "promote candidate");
    // Step 10 (Track G): the agentic_factory.promote_candidate MVP promotion
    // controller. CLI JSON transport (D3): the request envelope comes from
    // --input <request.json>, with inline flags for debugging. The controller
    // owns the outcome (route_to_hitl | blocked); the only caller-requestable
    // action is propose_repo_change (CONSTRAINTS #7). Real GitHub work is
    // selected only from a verified real local-ambient connection state.
    const promoteRawArgs = args;
    // Boolean flag: explicit human acceptance of cross-version comparison is
    // REQUEST-VISIBLE (accept_cross_version_comparison in the envelope), never
    // an invisible controller option (outside-review FIX 4).
    const acceptCrossVersionComparison = promoteRawArgs.includes("--accept-cross-version");
    const { flags } = parseCliFlags(promoteRawArgs.filter((arg) => arg !== "--accept-cross-version"));
    const usage =
      "Usage: npm run promote-candidate -- --input <request.json> | [--source <s> --actor-id <id> --expected-project <name> --experiment-id <id> --requested-action propose_repo_change [--prompt-version-id <id>] [--evaluator-id <id>] [--dataset-version-id <id>] [--annotation-ids <id,id>] [--deep-link <phoenix url>] [--accept-cross-version]]";
    let request;
    if (flags.input) {
      try {
        request = JSON.parse(fs.readFileSync(flags.input, "utf8"));
      } catch (error) {
        output.error({
          what: `Could not read the request envelope from ${flags.input}`,
          why: redactOAuthSecrets(error.message),
          fix: "check the --input path and JSON syntax, then rerun promote-candidate.",
        });
        process.exitCode = 2;
        return;
      }
    } else if (flags["experiment-id"] || flags["deep-link"]) {
      request = {
        schema_version: PROMOTE_CANDIDATE_REQUEST_SCHEMA_VERSION,
        source: flags.source,
        actor_id: flags["actor-id"],
        expected_project: flags["expected-project"],
        requested_action: flags["requested-action"],
        ...(flags["experiment-id"] ? { experiment_id: flags["experiment-id"] } : {}),
        ...(flags["deep-link"] ? { phoenix_deep_link: flags["deep-link"] } : {}),
        ...(flags["prompt-version-id"] ? { prompt_version_id: flags["prompt-version-id"] } : {}),
        ...(flags["evaluator-id"] ? { evaluator_id: flags["evaluator-id"] } : {}),
        ...(flags["dataset-version-id"] ? { dataset_version_id: flags["dataset-version-id"] } : {}),
        ...(flags["annotation-ids"]
          ? { annotation_ids: String(flags["annotation-ids"]).split(",").map((id) => id.trim()).filter(Boolean) }
          : {}),
        ...(acceptCrossVersionComparison ? { accept_cross_version_comparison: true } : {}),
      };
    } else {
      output.error({
        what: usage,
        why: "A request envelope or inline promotion evidence is required.",
        fix: "pass --input <request.json>, or provide the source, actor, project, action, and evidence identifiers.",
      });
      process.exitCode = 2;
      return;
    }
    let result;
    try {
      result = await promoteCandidate({
        repoRoot,
        request,
        invocation: { transport: "cli_local_session" },
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Promotion candidate could not run",
        why: redactOAuthSecrets(error.message),
        fix: "repair the request envelope, local Phoenix evidence, or GitHub connection, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderPromotionOutcomeResult(result, output);
    if (result.ok && result.outcome === "route_to_hitl") printVerboseHint(output);
    process.exitCode = result.ok && result.outcome === "route_to_hitl" ? 0 : 1;
}
export async function runPromotionScanCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, "promotion scan");
    // Step 12: deterministic candidate-intent scanner. It records local
    // ledger/health under .agentic-factory/promotion-candidates/, derives
    // budget/caps from repo-visible PR markers, and calls the committed
    // promotion controller only after explicit intent and deterministic
    // evidence packaging. GitHub marker reads share the same production
    // local-ambient/dry-run selection as the controller.
    let result;
    try {
      result = await scanPromotionCandidates({
        repoRoot,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Promotion scan could not run",
        why: redactOAuthSecrets(error.message),
        fix: "repair local promotion scanner state or Phoenix/GitHub access, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderPromotionScanResult(result, output);
    if (result.ok) printVerboseHint(output);
    process.exitCode = result.ok ? 0 : 1;
}

function renderImprovementDraftResult(result, output) {
  const target = result.human_name || result.target_key || "unknown target";
  if (result.ok) {
    const tagged = result.chain_state === "tagged";
    output.success(tagged
      ? `Drafted candidate change: ${target}`
      : `Draft recorded: ${target}`);
    output.keyValues(compactPairs([
      ["Draft", result.draft_id],
      ["Target", result.target_key],
      ["State", humanizeToken(result.chain_state)],
      ["Receipt", result.receipt_path],
      ["Content", result.content_path],
      ["Prompt version", result.phoenix_prompt_version_id],
      ["Experiment receipt", result.experiment_receipt_id],
      ["Phoenix experiment", result.phoenix_experiment_id],
      ["Branch", result.branch || result.pr?.head || result.pr?.branch],
      ["PR", result.pr?.url || result.pr_url],
    ]), { heading: "Draft" });
    if (result.idempotent) output.success("Candidate tag was already applied; no new draft was needed.");
    if (result.receipt?.supersede_existing_candidate) {
      output.warn("Supersede request recorded; promotion will use it when proposing the change.");
    }
    if (result.dropped_failure_mode_ids?.length > 0) {
      output.warn(`Dropped unknown failure modes: ${result.dropped_failure_mode_ids.join(", ")}`);
    }
    output.detail(`chain_state=${result.chain_state || "unknown"}`);
    output.detail(`drafted_by=${result.drafted_by || "unknown"}`);
    output.detail(`content_sha256=${result.content_sha256 || "unknown"}`);
    output.detail(`content_byte_size=${result.content_byte_size ?? "unknown"}`);
    return;
  }

  output.error({
    what: improvementDraftFailureTitle(result, target),
    why: improvementDraftFailureWhy(result),
    fix: improvementDraftFailureFix(result),
  });
  output.keyValues(compactPairs([
    ["Draft", result.draft_id || result.existing_draft_id],
    ["Target", result.target_key],
    ["Receipt", result.receipt_path],
    ["Existing draft", result.existing_draft_id],
  ]), { heading: "Draft" });
  output.detail(`outcome=${result.outcome || "unknown"}`);
  output.detail(`chain_state=${result.chain_state || "unknown"}`);
  if (result.lock_path) output.detail(`lock=${result.lock_path}`);
}

function improvementDraftFailureTitle(result, target) {
  if (result.outcome === "draft_chain_failed") return `Improvement draft chain could not complete: ${target}`;
  if (result.outcome === "draft_rejected") return `Draft was not accepted for ${target}`;
  return "Improvement draft was not created";
}

function improvementDraftFailureWhy(result) {
  return [result.reason, result.detail]
    .filter(Boolean)
    .map((line) => redactOAuthSecrets(line))
    .join("\n") || "The draft request did not produce an accepted candidate change.";
}

function improvementDraftFailureFix(result) {
  if (result.existing_draft_id) return "review the existing draft or rerun with --supersede-existing-candidate if a replacement is intentional.";
  if (result.outcome === "draft_rejected") return "adjust the target or failure modes so the change is composable, then retry.";
  if (result.outcome === "draft_chain_failed") return "repair the failed chain stage, then rerun draft-improvement to resume from the durable receipt.";
  return "check the target, opportunity id, and local Phoenix/runtime setup, then retry.";
}

function renderPromotionOutcomeResult(result, output) {
  if (result.outcome === "route_to_hitl") {
    output.success("Proposal ready for review");
    output.keyValues(compactPairs([
      ["Title", result.pr?.title || result.pr_title || result.candidate_target_key],
      ["PR", result.pr?.url],
      ["PR number", result.pr?.number],
      ["Branch", result.branch || result.pr?.head || result.pr?.branch],
      ["Proposal", result.proposal_instance_id],
      ["Target", result.candidate_target_key],
      ["Candidate version", result.candidate_version_id],
      ["Registry", result.registry_path],
    ]), { heading: "Proposal" });
    if (result.pr?.url) output.nextSteps([{ text: "Review PR", hint: result.pr.url }]);
    output.detail(`outcome=${result.outcome}`);
    output.detail(`normalized_envelope_hash=${result.normalized_envelope_hash || "unknown"}`);
    output.detail(`phoenix_outcome=${JSON.stringify(result.phoenix_outcome || null)}`);
    return;
  }

  if (result.outcome === "rejected") {
    output.error({
      what: "Promotion request was not accepted",
      why: promotionOutcomeWhy(result),
      fix: "fix the request envelope and re-invoke promote-candidate.",
    });
  } else if (result.reason === "improvement_opportunity_no_proposed_change") {
    const opportunity = result.improvement_opportunity || {};
    const humanName = opportunity.human_name || result.candidate_target_key || "Unknown target";
    const failureLabels = Array.isArray(opportunity.failure_mode_labels)
      ? opportunity.failure_mode_labels.filter((label) => typeof label === "string" && label.trim() !== "")
      : [];
    output.error({
      what: `Improvement opportunity found: ${humanName}`,
      why: `Evidence suggests ${humanName} could improve${failureLabels.length > 0 ? ` on ${failureLabels.join(", ")}` : ""}, but no concrete prompt or policy change has been drafted yet.`,
      fix: result.candidate_target_key
        ? `run npm run draft-improvement -- --target ${result.candidate_target_key}`
        : "draft the proposed agent, prompt, or policy change, then rerun promotion.",
    });
  } else if (result.evidence_repair) {
    output.error({
      what: "Promotion evidence needs repair",
      why: promotionOutcomeWhy(result),
      fix: "repair the missing or stale evidence, then rerun promote-candidate.",
    });
  } else {
    output.error({
      what: "Promotion did not open a proposal",
      why: promotionOutcomeWhy(result),
      fix: result.terminal === false
        ? "rerun promote-candidate after repair; recovery resumes from the last durable stage for this envelope."
        : "repair the reported promotion input or evidence issue, then retry.",
    });
  }

  output.keyValues(compactPairs([
    ["Target", result.candidate_target_key],
    ["Envelope", result.normalized_envelope_hash],
    ["Registry", result.registry_path],
    ["Proposal", result.proposal_instance_id],
    ["PR", result.pr?.url],
  ]), { heading: "Promotion" });
  output.detail(`outcome=${result.outcome || "unknown"}`);
  output.detail(`terminal=${result.terminal ?? "unknown"}`);
  output.detail(`phoenix_outcome=${JSON.stringify(result.phoenix_outcome || null)}`);
}

function promotionOutcomeWhy(result) {
  const lines = [];
  if (result.reason) lines.push(result.reason);
  if (result.detail) lines.push(result.detail);
  return lines.map((line) => redactOAuthSecrets(line)).join("\n")
    || "The promotion controller did not produce a review proposal.";
}

function renderPromotionScanResult(result, output) {
  if (!result.ok) {
    output.error({
      what: "Promotion scan could not complete",
      why: [result.reason, result.detail].filter(Boolean).map((line) => redactOAuthSecrets(line)).join("\n")
        || result.status || "scan_failed",
      fix: result.lock_path
        ? "wait for the active scan to finish, remove a stale lock only after verifying no scanner is running, then retry."
        : "repair scanner state, local Phoenix, or GitHub marker access, then retry.",
    });
    if (result.lock_path) {
      output.keyValues([["Lock", result.lock_path]], { heading: "Scan" });
    }
    output.detail(`status=${result.status || "unknown"}`);
    return;
  }

  output.success(`Promotion scan completed: ${result.candidates.length} candidate signal(s)`);
  output.keyValues(compactPairs([
    ["Ledger", result.ledger_path],
    ["Health", result.health_path],
    ["Policy", result.policy ? `v${result.policy.policy_version}` : null],
    ["Repo markers", result.repo_marker_state
      ? (result.repo_marker_state.controller_calls_allowed ? "proposal checks allowed" : "proposal checks paused")
      : null],
  ]), { heading: "Scan" });
  if (result.phoenix_scan?.ok === false) {
    output.warn(`Phoenix scan needs attention: ${result.phoenix_scan.reason}${result.phoenix_scan.detail ? ` - ${redactOAuthSecrets(result.phoenix_scan.detail)}` : ""}`);
  }
  if (result.repo_marker_state && !result.repo_marker_state.controller_calls_allowed) {
    output.warn(redactOAuthSecrets(result.repo_marker_state.detail || result.repo_marker_state.reason || "Repo marker state requires operator attention."));
  }
  output.detail(`status=${result.status || "unknown"}`);
  output.detail(`status_counts=${JSON.stringify(promotionCandidateStatusCounts(result.candidates))}`);
  if (result.policy) {
    output.detail(`policy_hash=${result.policy.policy_hash || "unknown"}`);
    output.detail(`policy_read_path=${result.policy.read_path || "unknown"}`);
  }
  output.detail(`repo_marker_state=${JSON.stringify(result.repo_marker_state || null)}`);

  output.section("Candidate signals");
  if (result.candidates.length === 0) {
    output.success("No candidate signals found.");
    return;
  }
  for (const candidate of result.candidates) {
    const headline = promotionCandidateHeadline(candidate, result);
    if (promotionCandidateIsReady(candidate)) output.success(headline);
    else output.warn(headline);
    output.keyValues(compactPairs([
      ["Candidate", candidate.candidate_key],
      ["Target", candidateDisplayTarget(candidate)],
      ["PR", candidate.pr?.url],
      ["Proposal", candidate.proposal_instance_id],
      ["Receipt", candidate.receipt_id],
      ["Experiment", candidate.experiment_id],
      ["Next", promotionCandidateNextAction(candidate)],
    ]));
    output.detail(`candidate_status=${candidate.status || "unknown"}`);
    output.detail(`candidate_display_class=${candidate.display_class || "none"}`);
    output.detail(`candidate_reason=${candidate.controller_reason || candidate.reason || "none"}`);
    if (candidate.controller_detail || candidate.detail) {
      output.detail(`candidate_detail=${redactOAuthSecrets(candidate.controller_detail || candidate.detail)}`);
    }
  }
}

function promotionCandidateIsReady(candidate) {
  return [
    "controller_called_pr_opened",
    "discovered_evidence_without_intent",
    "withdrawn_no_action",
  ].includes(candidate.status);
}

function promotionCandidateHeadline(candidate, result) {
  if (candidate.status === "improvement_opportunity") {
    const opportunity = candidate.improvement_opportunity || {};
    return `Improvement opportunity found: ${opportunity.human_name || candidateDisplayTarget(candidate)}`;
  }
  if (candidate.status === "discovered_evidence_without_intent") return "Evidence found, with no requested change.";
  if (candidate.status === "ignored_unmanaged_target") return "Signal ignored because its target is not in the agent-behavior catalog.";
  if (candidate.display_class === "evidence_needs_repair") return "Evidence needs repair before a proposal can be considered.";
  if (candidate.status === "controller_called_pr_opened") {
    return `Proposal ready for review: ${candidate.pr?.title || candidate.pr_title || candidateDisplayTarget(candidate)}`;
  }
  if (candidate.status === "blocked_by_policy_budget") {
    return `Proposal limit reached; no new proposals until ${promotionBudgetWindowFact(candidate, result.repo_marker_state)}.`;
  }
  if (candidate.status === "blocked_by_verified_repo_state") return "GitHub connection needs attention before proposals can be checked.";
  if (candidate.status === "withdrawn_no_action") return "Candidate was withdrawn; no proposal was opened.";
  if (candidate.status === "suppressed_by_policy") return "Promotion policy paused this candidate.";
  if (candidate.status === "controller_called") return "Controller checked the candidate; no proposal was opened.";
  if (candidate.status === "candidate_intent_ready") return "Candidate is ready for promotion review.";
  return "Candidate scan recorded a status.";
}

function promotionCandidateNextAction(candidate) {
  if (candidate.status === "improvement_opportunity") {
    const target = candidate.candidate_target_key || candidate.target_key;
    return target ? `npm run draft-improvement -- --target ${target}` : "draft the proposed change, then rerun promotion";
  }
  if (candidate.display_class === "evidence_needs_repair") return "repair evidence, then rerun promotion:scan";
  if (candidate.status === "controller_called_pr_opened") return candidate.pr?.url ? "review the PR" : "review the proposal";
  if (candidate.status === "blocked_by_policy_budget") return "wait for the proposal limit window to clear";
  if (candidate.status === "blocked_by_verified_repo_state") return "repair GitHub connection or repo marker access";
  if (candidate.status === "ignored_unmanaged_target") return "no action; the target is outside the scanner candidate catalog";
  if (candidate.status === "candidate_intent_ready") return "run promote-candidate with the candidate evidence";
  return null;
}

function promotionBudgetWindowFact(candidate, repoMarkerState) {
  const counts = repoMarkerState?.counts ?? {};
  if (candidate.reason === "max_open_proposals_reached") {
    const activeOpen = counts.active_open_proposals ?? counts.max_open_proposals ?? null;
    const maxOpen = counts.max_open_proposals ?? activeOpen;
    if (activeOpen !== null && maxOpen !== null) return `an open proposal closes (${activeOpen}/${maxOpen} open)`;
    return "an open proposal closes";
  }
  if (candidate.reason === "proposal_budget_exhausted") {
    return counts.proposal_budget_period_days
      ? `the ${counts.proposal_budget_period_days}-day budget window clears`
      : "the budget window clears";
  }
  return "the proposal limit clears";
}

function candidateDisplayTarget(candidate) {
  return candidate.candidate_target_key || candidate.candidate_key || "unknown target";
}

function promotionCandidateStatusCounts(candidates = []) {
  const counts = {};
  for (const candidate of candidates) {
    const status = candidate.display_class === "evidence_needs_repair"
      ? "evidence_needs_repair"
      : candidate.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

export async function runEvalRegisterPromptCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    agenticFactoryHeading(output, command === "eval:register-judge-prompt"
      ? "eval register judge prompt"
      : "eval register prompt");
    // Registers a repo-accepted prompt snapshot as a Phoenix-managed prompt
    // version (the authoring/candidate surface) and PRINTS/STAGES the manifest
    // pin. phoenix-assets.json is never modified here: accepting a pin is a
    // repo process change (CONSTRAINTS #19/#20 — Phoenix prompt versions/tags
    // signal intent, never accepted behavior). The judge command remains a
    // compatibility alias for the judge target.
    const { positionals, flags } = parseCliFlags(args);
    const commandOptions =
      EVAL_REGISTER_PROMPT_COMMAND_OPTIONS[command] || EVAL_REGISTER_PROMPT_COMMAND_OPTIONS["eval:register-prompt"];
    const targetKey = commandOptions.defaultTargetKey || positionals[0];
    if (!targetKey) {
      output.error({ what: "Usage: npm run eval:register-prompt -- <target_key> [--name <phoenix_prompt_name>]" });
      process.exitCode = 2;
      return;
    }
    let result;
    try {
      result = await commandOptions.registerPrompt({
        repoRoot,
        targetKey,
        config,
        promptName: flags.name || null,
        onProgress: (line) => output.detail(line),
      });
    } catch (error) {
      output.error({
        what: "Prompt registration failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "repair the prompt target, runtime assignment, or Phoenix health, then retry.",
      });
      process.exitCode = 1;
      return;
    }
    renderPromptRegistrationReport(result, output);
    process.exitCode = result.ok ? 0 : 1;
}
export async function runPhoenixStopCommand({ context, command, args }) {
  const { config, repoRoot, cachePath, setupStatePath, credentialStore, output } = context;
    phoenixHeading(output, "phoenix stop");
    let stopped;
    try {
      stopped = await stopPhoenix({ repoRoot });
    } catch (error) {
      output.error({
        what: "Local Phoenix stop failed",
        why: redactOAuthSecrets(error.message),
        fix: phoenixRepairHintForError(error) || "run npm run phoenix:doctor for local Phoenix repair guidance.",
      });
      process.exitCode = 1;
      return;
    }
    const status = stopped.reason || (stopped.stopped ? "stopped" : "no managed service stopped");
    if (stopped.ok) {
      output.success(`Local Phoenix stop: ${status}`);
    } else {
      output.error({
        what: "Local Phoenix stop failed",
        why: status,
        fix: "run npm run phoenix:doctor for local Phoenix repair guidance.",
      });
    }
    process.exitCode = stopped.ok ? 0 : 1;
}

function phoenixHeading(output, readableCommand) {
  agenticFactoryHeading(output, readableCommand);
}

function phoenixRepairHintForError(error) {
  const message = String(error?.message || error || "");
  if (/must bind to loopback/i.test(message)) {
    return "unset AGENTIC_FACTORY_PHOENIX_URL or point it at a loopback address, then retry.";
  }
  return null;
}

function fallbackEvalWorklistReport({ error }) {
  const reason = redactOAuthSecrets(error?.message || String(error || "unknown"));
  return {
    phoenix: {
      ok: false,
      appUrl: "unavailable",
      projectName: "unknown",
      projectGlobalId: null,
      notice:
        `Local evidence status could not be read (${reason}). `
        + "Proposal states are still shown from behavior proposal facts when available.",
    },
    runs: [],
    receiptsDir: "unknown",
    artifactsDir: "unknown",
  };
}

function fallbackProposalWorklistReport({ error }) {
  const reason = redactOAuthSecrets(error?.message || String(error || "unknown"));
  return {
    schema_version: PHASE_2_PROPOSAL_WORKLIST_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    state_names: PHASE_2_PROPOSAL_STATE_NAME_LIST,
    sources: {
      registry_dir: "unavailable",
      scanner_ledger_dir: "unavailable",
      github_pr_markers: "unavailable",
    },
    owner_judgments: [],
    repair_items: [],
    fyi_receipts: [],
    internal_items: [],
    items: [],
    deferred_writer_dependencies: [],
    diagnostics: [
      {
        copy_class: "blocked_for_repair",
        headline: "Behavior proposal status could not be read.",
        why_it_matters: "Proposal decisions may be incomplete until the proposal status view can be rebuilt.",
        source_facts: [{
          surface: "proposal_worklist_read",
          fact: "read failed",
          durable: false,
          detail: reason,
        }],
      },
    ],
  };
}

function renderWorklistReport({ report, items, proposalReport }, output) {
  renderProposalWorklistReport(proposalReport, output);

  output.section("Local evidence");
  if (report.phoenix.ok) {
    output.success("Phoenix evidence is reachable");
  } else {
    output.warn("Phoenix evidence is unavailable; showing local receipt/artifact state only");
  }
  if (report.phoenix.notice) output.warn(ownerSafeWorklistNotice(report.phoenix.notice));
  output.keyValues([
    ["Project", report.phoenix.projectName || "unknown"],
    ["Local runs", report.runs.length],
    ["Need judgment", items.length + (proposalReport?.owner_judgments?.length || 0)],
    ["Proposal repairs", proposalReport?.repair_items?.length || 0],
    ["Proposal receipts", proposalReport?.fyi_receipts?.length || 0],
  ]);
  output.detail(`phoenix_app_url=${report.phoenix.appUrl}`);
  output.detail(`phoenix_project_global_id=${report.phoenix.projectGlobalId || "unknown"}`);
  output.detail(`receipts_dir=${report.receiptsDir}`);
  output.detail(`artifacts_dir=${report.artifactsDir}`);

  output.section("Judgment worklist");
  if (items.length === 0) {
    output.success("No local evidence judgment needs attention right now.");
  } else {
    items.forEach((run, index) => {
      const kind = run.artifact_kind ? ` (${run.artifact_kind})` : "";
      output.warn(`${index + 1}. P${run.priority_class} ${humanizeToken(run.priority_id)}${kind}`);
      const reasons = worklistReasons(run);
      output.keyValues([
        ["Run", run.run_id],
        ["Trace", run.trace_id || "none"],
        ["Signals", `human ${yesNo(run.has_human)}, model ${yesNo(run.has_llm)}, code ${yesNo(run.has_code)}`],
        ["Why", reasons.join("; ") || run.derived_status],
      ]);
      output.detail(`project_id=${run.project_id || "unknown"}`);
      output.detail(`status=${run.derived_status} disagreement=${yesNo(run.disagreements.length > 0)} promoted=${yesNo(run.promoted_to_dataset)} trace=${run.trace_status || "none"}`);
      if (run.phoenix_url) output.detail(`phoenix=${run.phoenix_url}`);
    });
  }
  renderWorklistNextSteps({ proposalReport, evalItems: items }, output);
}

function renderProposalWorklistReport(report, output) {
  output.section("Behavior proposal decisions");
  if (!report || report.owner_judgments.length === 0) {
    output.success("No behavior proposal needs approval right now.");
  } else {
    report.owner_judgments.forEach((item, index) => {
      const prefix = item.copy_class === "review_carefully" ? "High risk" : "Ready";
      output.warn(`${index + 1}. ${prefix}: ${item.headline}`);
      output.keyValues([
        ["Why", item.why_it_matters],
        ["Decide", item.where_to_decide || "Open the proposal review."],
      ]);
      output.detail(`states=${item.states.join(", ")}`);
      output.detail(`source_facts=${JSON.stringify(item.source_facts)}`);
    });
  }

  output.section("Repair and setup blockers");
  if (!report || report.repair_items.length === 0) {
    output.success("No proposal repair blocker is visible right now.");
  } else {
    report.repair_items.forEach((item, index) => {
      output.warn(`${index + 1}. ${item.headline}`);
      const pairs = [
        ["Why", item.why_it_matters],
        ["Blocked", item.blocked_by],
        ["Decision", item.where_to_decide],
      ];
      if (item.deferred) {
        pairs.splice(1, 0, ["Status", "Waiting on proposal readiness; no owner action yet."]);
      }
      output.keyValues(compactPairs(pairs));
      if (item.deferred) {
        output.detail(`deferred=${JSON.stringify(item.deferred)}`);
      }
      output.detail(`states=${item.states.join(", ")}`);
      output.detail(`source_facts=${JSON.stringify(item.source_facts)}`);
    });
  }

  output.section("Receipts");
  if (!report || report.fyi_receipts.length === 0) {
    output.info("No proposal receipts to show.");
  } else {
    report.fyi_receipts.forEach((item, index) => {
      output.info(`${index + 1}. ${item.headline}`);
      output.keyValues([
        ["Why", item.why_it_matters],
        ["Decision", item.where_to_decide || "No decision needed."],
      ]);
      output.detail(`states=${item.states.join(", ")}`);
    });
  }

  if (report?.diagnostics?.length > 0) {
    output.section("Diagnostics");
    for (const diagnostic of report.diagnostics) {
      output.warn(diagnostic.headline);
      output.detail(JSON.stringify(diagnostic.source_facts || []));
    }
  }
  if (report) {
    output.detail(`internal_candidate_items=${report.internal_items.length}`);
    output.detail(`derived_state_names=${report.state_names.join(", ")}`);
  }
}

function renderWorklistNextSteps({ proposalReport, evalItems }, output) {
  const steps = [];
  const firstDecision = proposalReport?.owner_judgments?.[0];
  if (firstDecision?.where_to_decide) {
    steps.push({ text: "Review behavior proposal", hint: firstDecision.where_to_decide });
  }
  const repairItems = proposalReport?.repair_items || [];
  const actionableRepairItems = repairItems.filter((item) => !item.deferred);
  if (actionableRepairItems.length > 0) {
    steps.push({ text: "Repair listed proposal blocker", hint: "then check this list again" });
  } else if (repairItems.length > 0) {
    steps.push({ text: "Wait for proposal readiness", hint: "no owner approve/decline decision yet" });
  }
  if (evalItems.length > 0) {
    steps.push({ text: "Add human judgment", hint: "use the selected evidence link or local annotation flow" });
  }
  if (steps.length > 0) output.nextSteps(steps);
}

function ownerSafeWorklistNotice(notice) {
  return String(notice || "")
    .replace(/Start it with npm run phoenix:start and rerun\./g, "Start local evidence capture and check this list again.");
}

function renderDeterministicCheckReport(result, output) {
  if (result.ok) {
    output.success(`Deterministic checks: ${result.emitted_count || 0} CODE annotation(s) emitted`);
  } else {
    output.error({
      what: `Deterministic check emission failed (closed): ${result.reason || "phoenix_native_code_storage_unavailable"}`,
      why: deterministicCheckFailureWhy(result),
      fix: "repair Phoenix-native CODE annotation storage or the run evidence, then rerun npm run eval:emit-checks.",
    });
  }
  renderDeterministicCheckDetails(result, output);
  printVerboseHint(output);
}

function renderDeterministicCheckDetails(result, output, { heading = "Deterministic checks" } = {}) {
  output.keyValues([
    ["Trace status", result.trace_status || "unknown"],
    ["Storage", result.storage || "unknown"],
    ["Emitted", result.emitted_count ?? 0],
    ["Skipped", result.skipped_count ?? 0],
  ], { heading });
  if (result.storage === "report_only") {
    output.warn(`Report-only storage: ${result.reason || "Phoenix-native CODE storage unavailable"}`);
  }
  const checks = result.checks || [];
  if (checks.length === 0) {
    output.warn("No deterministic checks were available.");
  }
  for (const check of checks) {
    if (check.status === "skipped") {
      const missing = check.missing_inputs?.length > 0 ? ` — missing: ${check.missing_inputs.join(", ")}` : "";
      output.warn(`${check.name}: skipped (${check.skip_reason || "not available"})${missing}`);
      continue;
    }
    const annotation = check.annotation || {};
    const modes = annotation.metadata?.failure_modes || [];
    const label = annotation.label || "unknown";
    const score = formatScore(annotation.score);
    const line = `${check.name}: ${label}${score ? ` (score ${score})` : ""}${modes.length > 0 ? ` - ${modes.join(", ")}` : ""}`;
    if (check.error) output.warn(line);
    else output.success(line);
    output.detail(`identifier.${check.name}=${annotation.identifier || "unknown"}`);
    if (check.annotation_ids?.length > 0) output.detail(`annotation_ids.${check.name}=${check.annotation_ids.join(",")}`);
    if (check.error) output.detail(`write_error.${check.name}=${check.error}`);
  }
  output.detail(`run_id=${result.run_id || "unknown"}`);
  output.detail(`trace_id=${result.trace_id || "none"}`);
}

function deterministicCheckFailureWhy(result) {
  const lines = [];
  if (result.reason) lines.push(result.reason);
  if (result.storage) lines.push(`storage=${result.storage}`);
  const failedChecks = (result.checks || []).filter((check) => check.error);
  if (failedChecks.length > 0) {
    lines.push(`write errors: ${failedChecks.map((check) => `${check.name}: ${check.error}`).join("; ")}`);
  }
  return lines.join("\n") || "Deterministic checks are recorded in report output only; no HUMAN or LLM fallback annotation was written.";
}

function renderJudgeReport(result, output) {
  if (result.ok) {
    const score = formatScore(result.judge?.score);
    output.success(`Decomposition-quality judge: ${result.judge?.label || result.judge_state}${score ? ` (score ${score})` : ""}`);
  } else {
    output.error({
      what: `Decomposition-quality judge failed: ${result.reason || result.judge_state || "not_run"}`,
      why: judgeFailureWhy(result),
      fix: judgeFailureFix(result),
    });
  }
  renderJudgeDetails(result, output);
  printVerboseHint(output);
}

function renderJudgeDetails(result, output, { heading = "Judge" } = {}) {
  const judgmentScore = formatScore(result.judge?.score);
  const judgment = result.judge
    ? `${result.judge.label}${judgmentScore ? ` (score ${judgmentScore})` : ""}`
    : "unavailable";
  output.keyValues([
    ["State", result.judge_state || "unknown"],
    ["Judgment", judgment],
    ["Storage", result.storage || "unknown"],
    result.prompt_source ? ["Prompt", `${result.prompt_source} ${result.prompt_version || ""}`.trim()] : null,
    ["Versions", `rubric ${result.rubric_version || "?"}, taxonomy ${result.failure_taxonomy_version || "?"}`],
  ], { heading });
  if (result.judge?.failure_modes?.length > 0) {
    output.warn(`Failure modes: ${result.judge.failure_modes.join(", ")}`);
  }
  for (const reason of result.low_confidence_reasons || []) {
    output.warn(`Low-confidence judge signal: ${reason}`);
  }
  if (result.storage === "report_only") {
    output.warn("No Phoenix LLM annotation was written; the run remains evaluable by humans and deterministic checks.");
  }
  output.detail(`run_id=${result.run_id || "unknown"}`);
  output.detail(`trace_id=${result.trace_id || "none"}`);
  output.detail(`identifier=${result.identifier || "unknown"}`);
  output.detail(`runtime=${result.runtime || "unknown"}`);
  if (result.judge?.explanation) output.detail(`explanation=${result.judge.explanation}`);
  if (result.annotation_ids?.length > 0) output.detail(`annotation_ids=${result.annotation_ids.join(",")}`);
  if (result.receipt_path) output.detail(`receipt=${result.receipt_path}`);
}

function judgeFailureWhy(result) {
  const lines = [];
  if (result.judge_state) lines.push(`state=${result.judge_state}`);
  if (result.reason) lines.push(result.reason);
  if (result.storage === "report_only") lines.push("No Phoenix LLM annotation was written.");
  return lines.join("\n") || "The judge did not produce a usable stored judgment.";
}

function judgeFailureFix(result) {
  if (result.judge_state === "judge_missing" || result.judge_state === "judge_invalid") {
    return "the run remains evaluable by humans and deterministic checks; repair the judge runtime or prompt and rerun npm run eval:judge.";
  }
  return "repair the run artifact, judge prompt, or Phoenix health, then rerun npm run eval:judge.";
}

function renderEvalRunReport(result, output) {
  if (result.status === "not_run") {
    output.error({
      what: `Eval decomposition failed: ${result.reason || "not_run"}`,
      why: evalRunFailureWhy(result),
      fix: result.repairHint || "repair the reported eval input issue and rerun npm run eval:decomposition.",
    });
    return;
  }
  output.success(`Eval decomposition: ${result.status} (no Linear mutations, no local gateway wake claims)`);
  output.keyValues([
    ["Eval run id", result.eval_run_id || "unknown"],
    ["Source", describeEvalSource(result.source)],
    ["Variant", result.variant_id || "unknown"],
    ["Accepted packets", describeAcceptedPackets(result.accepted_packets)],
    ["Evaluator inputs", describeEvaluatorInputs(result.evaluator_inputs)],
    result.record_path ? ["Record", result.record_path] : null,
  ], { heading: "Eval run" });
  if (result.terminal) {
    output.keyValues([
      ["Terminal", `${result.terminal.status} (${result.terminal.reason})`],
      ["Issues", `final ${result.terminal.final_issues?.length || 0}, discovery ${result.terminal.discovery_issues?.length || 0}`],
      ["Relations", result.terminal.dependency_relations?.length || 0],
      ["Authored", `project update ${presentAbsent(result.terminal.project_update_markdown)}, open questions ${presentAbsent(result.terminal.open_questions_markdown)}`],
    ], { heading: "Terminal artifact" });
  } else if (result.artifact) {
    output.warn(`Non-terminal artifact: ${result.artifact.kind}`);
  }
  for (const [targetKey, override] of Object.entries(result.prompt_overrides || {})) {
    output.detail(`prompt_override.${targetKey}=version:${override.candidate_prompt_version_id} sha256:${override.candidate_prompt_sha256}`);
  }
  if (result.checks) renderDeterministicCheckDetails(result.checks, output, { heading: "--emit-checks" });
  if (result.judge) {
    if (result.judge.reason === "missing_terminal_artifact") {
      output.warn("--judge skipped: no terminal artifact to judge");
    } else {
      renderJudgeDetails(result.judge, output, { heading: `--judge (variant ${result.judge.variant_id || result.variant_id || "unknown"})` });
    }
  }
  output.detail(`source=${JSON.stringify(result.source || null)}`);
  output.detail(`inputs_hash=${result.inputs_hash || "unknown"}`);
  output.detail(`trace_id=${result.trace?.trace_id || "none"}`);
  output.detail(`trace_status=${result.trace?.trace_status || "unknown"}`);
  if (result.trace?.phoenix_app_url) output.detail(`phoenix=${result.trace.phoenix_app_url}`);
  if (result.artifact_path) output.detail(`artifact_path=${result.artifact_path}`);
  if (result.trace?.phoenix_app_url) {
    output.nextSteps([{ text: "Open Phoenix", hint: result.trace.phoenix_app_url }]);
  }
  printVerboseHint(output);
}

function evalRunFailureWhy(result) {
  const lines = [];
  if (result.detail) lines.push(result.detail);
  if (result.schema_errors?.length > 0) lines.push(`schema: ${result.schema_errors.join(" | ")}`);
  if (result.failures?.length > 0) lines.push(`failures: ${result.failures.join(", ")}`);
  if (result.available?.length > 0) lines.push(`available variants: ${result.available.join(", ")}`);
  return lines.join("\n") || result.reason || result.status || "not_run";
}

function renderDisagreementReport(report, output) {
  if (!report.ok) {
    output.error({
      what: `Disagreement report failed: ${report.reason || report.status || "not_run"}`,
      why: report.detail || report.path || null,
      fix: "check the run or experiment reference, repair local Phoenix health if needed, then rerun npm run eval:disagreements.",
    });
    if (report.run_id) output.detail(`run_id=${report.run_id}`);
    if (report.experiment_id) output.detail(`experiment_id=${report.experiment_id}`);
    return;
  }

  const disagreements = report.disagreements || [];
  if (disagreements.length === 0) output.success("No signal disagreements detected");
  else output.warn(`${disagreements.length} signal disagreement(s) need judgment`);

  if (report.mode === "run") renderRunDisagreementSummary(report, output);
  else renderExperimentDisagreementSummary(report, output);

  output.section("Disagreements");
  if (disagreements.length === 0) {
    output.success(report.pr_disclosure?.none_observed_statement || "None detected among available signals");
  } else {
    for (const disagreement of disagreements) output.warn(disagreementSummary(disagreement, report));
  }

  for (const mismatch of report.band_mismatches || []) {
    output.warn(`Band mismatch ${mismatch.example_id || report.run_id || ""} ${mismatch.annotator_kind} ${mismatch.identifier}: ${mismatch.label} at score ${formatScore(mismatch.score)}`);
  }
  for (const item of (report.worklist_items || []).filter((entry) => entry.priority_id === "judge_attention")) {
    output.warn(`Judge attention ${item.ref}: ${item.kind}${item.reason ? ` (${item.reason})` : ""}`);
  }
  output.keyValues([
    ["Worklist items", report.worklist_items?.length || 0],
    ["Rationale required", yesNo(report.pr_disclosure?.proceeds_despite_disagreement_requires_rationale)],
  ], { heading: "Promotion disclosure" });
  const nextSteps = disagreementNextSteps(report);
  if (nextSteps.length > 0) output.nextSteps(nextSteps);
  printVerboseHint(output);
}

function renderRunDisagreementSummary(report, output) {
  output.keyValues([
    ["Mode", "run"],
    ["Status", report.derived_status],
    ["Checked", "1 run"],
    ["Annotations", report.annotations?.length || 0],
  ], { heading: "Evidence" });
  for (const annotation of report.annotations || []) {
    output.detail(`raw_annotation=${describeAnnotationForDetail(annotation)}`);
  }
  if (report.judge_attempt) {
    output.detail(`judge_attempt=${report.judge_attempt.judge_state}${report.judge_attempt.reason ? ` (${report.judge_attempt.reason})` : ""}`);
  }
  output.detail(`run_id=${report.run_id}`);
  output.detail(`trace_id=${report.trace_id}`);
  output.detail(`phoenix=${report.phoenix?.deep_link || "unknown"}`);
}

function renderExperimentDisagreementSummary(report, output) {
  const examples = report.per_example || [];
  output.keyValues([
    ["Mode", "experiment"],
    ["Examples checked", examples.length],
    ["Receipt state", report.receipt_state || "unknown"],
    ["Human read failures", report.human_annotation_failures?.length || 0],
  ], { heading: "Evidence" });
  if (report.human_annotation_failures?.length > 0) {
    output.warn(`Human annotations unreadable for ${report.human_annotation_failures.length} example(s); disagreements were not fully checked.`);
  }
  output.section("Examples");
  for (const entry of examples) {
    const line = `${entry.example_id} -> ${entry.derived_status}${entry.split ? ` (${entry.split})` : ""}`;
    if (entry.disagreements?.length > 0 || entry.judge_errors?.length > 0 || entry.band_mismatches?.length > 0) {
      output.warn(line);
    } else {
      output.success(line);
    }
    for (const annotation of [...(entry.humans || []), ...(entry.llms || []), ...(entry.codes || [])]) {
      output.detail(`raw_annotation.${entry.example_id}=${describeAnnotationForDetail(annotation)}`);
    }
    for (const error of entry.judge_errors || []) {
      output.detail(`judge_error.${entry.example_id}=${error.state} (${error.detail})`);
    }
    if (entry.deep_links?.source_trace) output.detail(`source_trace.${entry.example_id}=${entry.deep_links.source_trace}`);
    if (entry.deep_links?.eval_trace) output.detail(`eval_trace.${entry.example_id}=${entry.deep_links.eval_trace}`);
  }
  output.detail(`receipt_id=${report.receipt_id || "none"}`);
  output.detail(`phoenix_experiment_id=${report.phoenix_experiment_id}`);
  output.detail(`dataset_id=${report.dataset?.dataset_id || "unknown"}`);
  output.detail(`dataset_version_id=${report.dataset?.dataset_version_id || "unknown"}`);
  output.detail(`phoenix=${report.phoenix?.deep_links?.experiment || "unknown"}`);
}

function renderProcessChangeGateReport(result, output) {
  if (!result.ok) {
    output.error({
      what: `Process-change gate failed (closed): ${result.reason || "not_run"}`,
      why: gateFailureWhy(result),
      fix: "repair the missing or unverified evidence before proposing accepted behavior; the gate treats missing evidence as no.",
    });
    if (result.record_path) output.detail(`record=${result.record_path}`);
    return;
  }
  if (result.verdict === "pass") {
    output.success(`Process-change gate passed: ${result.candidate_target_key}`);
  } else {
    const failedCount = (result.failed_condition_ids || []).length;
    output.error({
      what: `Process-change gate failed: ${result.candidate_target_key}`,
      why: `${failedCount || "one or more"} gate condition(s) failed — see Conditions below.`,
      fix: "resolve failed conditions or collect stronger evidence before proposing a repo process change.",
    });
  }
  output.keyValues([
    ["Verdict", result.verdict],
    ["Intent", `${result.intent} (${result.intent_source})`],
    ["Candidate", result.candidate_target_key],
  ], { heading: "Gate" });
  output.section("Conditions");
  for (const conditionEntry of result.conditions || []) {
    if (conditionEntry.status === "pass") output.success(`${conditionEntry.id}: ${conditionEntry.detail}`);
    else output.warn(`${conditionEntry.id}: ${conditionEntry.detail}`);
  }
  const counts = result.evidence_counts || {};
  output.keyValues([
    ["Train examples", `${counts.train_examples ?? 0} (${counts.train_human_labeled_examples ?? 0} human-labeled)`],
    ["Test examples", `${counts.test_examples ?? 0} (${counts.test_human_labeled_examples ?? 0} human-labeled)`],
    ["Human labels", counts.human_label_authenticity || "unknown"],
    ["Low confidence", counts.annotations_low_confidence ?? 0],
  ], { heading: "Evidence" });
  const product = result.product_report || {};
  for (const improved of product.behavior_improved || []) output.success(`Behavior improved: ${improved}`);
  const risks = product.product_risk_remaining || [];
  if (risks.length === 0) output.success("No remaining product risk surfaced by deterministic checks");
  else for (const risk of risks) output.warn(`Product risk remaining: ${risk}`);
  if (product.human_decision_load) {
    output.keyValues([
      ["Needs human judgment", product.human_decision_load.items_requiring_human_judgment],
      ["Open disagreements", product.human_decision_load.open_disagreements],
      ["Judge attention", product.human_decision_load.judge_attention_items],
      ["Band mismatch", product.human_decision_load.band_mismatch_flags],
    ], { heading: "Human decision load" });
  }
  if (product.categories_tested?.length > 0) {
    output.keyValues([["Categories tested", product.categories_tested.join(", ")]]);
  }
  for (const mismatch of result.band_mismatches || []) {
    output.warn(`Band mismatch ${mismatch.example_id} ${mismatch.annotator_kind} ${mismatch.identifier}: ${mismatch.label} at score ${formatScore(mismatch.score)}`);
  }
  if (result.test_split_exposure?.records?.length > 0 || result.defaults_high_risk) {
    output.warn(`Test-split exposure: ${result.test_split_exposure?.disclosure || "history incomplete"}${result.defaults_high_risk ? " (defaults high risk downstream)" : ""}`);
  }
  output.detail(`gate_report_id=${result.gate_report_id}`);
  output.detail(`receipt_id=${result.receipt_id}`);
  output.detail(`phoenix_experiment_id=${result.phoenix_experiment_id}`);
  output.detail(`candidate_version_id=${result.candidate_version_id || "unknown"}`);
  output.detail(`record=${result.record_path || "not_written"}`);
  if (result.record_write_error) output.detail(`record_write_error=${result.record_write_error}`);
  output.detail(`failed_condition_ids=${(result.failed_condition_ids || []).join(",") || "none"}`);
  if (product.phoenix_assets_evidence) {
    output.detail(`phoenix_assets_evidence=${JSON.stringify(product.phoenix_assets_evidence)}`);
  }
  if (product.repo_artifacts_owning_accepted_behavior) {
    output.detail(`repo_artifacts=${JSON.stringify(product.repo_artifacts_owning_accepted_behavior)}`);
  }
  if (result.phoenix?.deep_links?.experiment) {
    output.nextSteps([{ text: "Open Phoenix", hint: result.phoenix.deep_links.experiment }]);
  }
  if (result.verdict === "pass") printVerboseHint(output);
}

function gateFailureWhy(result) {
  const lines = [];
  if (result.detail) lines.push(result.detail);
  lines.push("The process-change gate fails closed: no evidence is treated as no, never as yes.");
  return lines.join("\n");
}

function renderPromptRegistrationReport(result, output) {
  if (!result.ok) {
    output.error({
      what: `Prompt registration failed${result.target_key ? ` for ${result.target_key}` : ""}: ${result.reason || "not_registered"}`,
      why: result.detail || null,
      fix: "repair the prompt target, runtime assignment, or local Phoenix health, then rerun registration.",
    });
    return;
  }
  output.success(`Prompt registration: ${result.target_key}`);
  output.keyValues([
    ["Prompt", result.prompt_name],
    ["Content source", result.content_source || "repo_accepted_snapshot"],
    ["Manifest mutated", yesNo(result.manifest_mutated)],
  ], { heading: "Registration" });
  output.warn("The staged manifest pin is not applied; accepting it remains a repo process change.");
  output.detail(`prompt_id=${result.prompt_id || "unresolved"}`);
  output.detail(`prompt_version_id=${result.prompt_version_id}`);
  output.detail(`snapshot_path=${result.snapshot_path || "unknown"}`);
  output.detail(`snapshot_sha256=${result.snapshot_sha256}`);
  if (result.accepted_snapshot_sha256) output.detail(`accepted_snapshot_sha256=${result.accepted_snapshot_sha256}`);
  output.detail(`staged_pin=${JSON.stringify(result.staged_pin)}`);
  output.detail(`receipt=${result.receipt_path}`);
  output.nextSteps([
    { text: "Open Phoenix", hint: result.appUrl },
  ]);
  printVerboseHint(output);
}

function renderPhoenixHealthStatus(status, output, { includeOpenPhoenix = false } = {}) {
  if (status.ok) {
    output.success("Local Phoenix running");
    if (includeOpenPhoenix) {
      output.keyValues([
        ["Open Phoenix", status.appUrl],
      ]);
    }
  } else {
    output.error({
      what: "Local Phoenix is unavailable",
      why: status.status,
      fix: status.repairHint,
    });
  }
  output.detail(`app_url=${status.appUrl}`);
  output.detail(`collector=${status.collectorUrl}`);
  if (status.metadata?.managed !== undefined) output.detail(`managed=${status.metadata.managed}`);
  if (status.metadata?.status) output.detail(`service_status=${status.metadata.status}`);
}

function renderTraceHealth(health, output) {
  const status = health.latest_status || "trace_unknown";
  if (status === "trace_exported") {
    output.success("Trace delivery healthy");
  } else if (status === "trace_unknown" && health.consecutive_failure_count === 0) {
    output.info("Trace delivery has no local runs yet.");
  } else {
    output.warn(`Trace delivery needs attention: ${status}`);
  }
  output.detail(`latest_status=${status}`);
  output.detail(`consecutive_failures=${health.consecutive_failure_count}`);
  output.detail(`recent_failures=${health.recent_failure_count}`);
  output.detail(`audit_records=${health.outbox_record_count}`);
  output.detail(`audit_bytes=${health.outbox_byte_size}`);
}

function renderEvalStatusReport(report, output) {
  output.section("Evaluation status");
  if (report.phoenix.notice) output.warn(report.phoenix.notice);
  if (report.runs.length === 0) {
    output.info("No local runs found.");
    return;
  }
  const labelWidth = String(report.runs.length).length;
  report.runs.forEach((run, index) => {
    const label = `Run ${String(index + 1).padStart(labelWidth, " ")}`;
    const summary = evalRunSummary(run);
    if (summary.level === "success") output.success(`${label}  ${summary.text}`);
    else output.warn(`${label}  ${summary.text}`);
    output.detail(`run_id=${run.run_id}`);
    output.detail(`trace_id=${run.trace_id || "none"}`);
    output.detail(`project_id=${run.project_id || "unknown"}`);
    output.detail(`status=${run.derived_status} human=${yesNo(run.has_human)} model=${yesNo(run.has_llm)} code=${yesNo(run.has_code)} disagreement=${yesNo(run.disagreements.length > 0)} promoted=${yesNo(run.promoted_to_dataset)} trace=${run.trace_status || "none"}`);
    if (run.promoted_datasets?.length > 0) output.detail(`promoted_datasets=${run.promoted_datasets.join(",")}`);
    if (run.phoenix_url) output.detail(`phoenix=${run.phoenix_url}`);
  });
}

function evalRunSummary(run) {
  if (run.disagreements.length > 0) {
    return { level: "warn", text: `${run.derived_status} - disagreement needs judgment` };
  }
  if (run.judge_flags.length > 0 || run.judge_missing || run.judge_attempt?.judge_state) {
    return { level: "warn", text: `${run.derived_status} - judge needs attention` };
  }
  if (run.derived_status === "needs_human") {
    return { level: "warn", text: "needs human judgment" };
  }
  if (run.derived_status === "has_human") {
    return { level: "success", text: "human judgment recorded" };
  }
  return { level: "warn", text: run.derived_status };
}

function formatScore(value) {
  return Number.isFinite(value) ? String(value) : "";
}

function presentAbsent(value) {
  return value ? "present" : "absent";
}

function describeEvalSource(source) {
  if (!source) return "unknown";
  if (source.mode === "run") return "captured run snapshot";
  if (source.mode === "example") return `local example ${source.example_path}`;
  if (source.mode === "dataset") return `Phoenix dataset ${source.dataset_name}`;
  return JSON.stringify(source);
}

function describeAcceptedPackets(packets = []) {
  if (packets.length === 0) return "0";
  return `${packets.length} (${packets.map((packet) => packet.phase).join(" -> ")})`;
}

function describeEvaluatorInputs(evaluatorInputs = {}) {
  const checkInputs = Object.keys(evaluatorInputs.check_inputs || {});
  return `checks ${checkInputs.join(",") || "none"}, judge ${evaluatorInputs.judge_inputs ? "ready" : "unavailable"}`;
}

function worklistReasons(run) {
  const reasons = [];
  if (run.high_risk) reasons.push("paused with open product/scope questions");
  for (const disagreement of run.disagreements || []) {
    reasons.push(disagreement.kind === "human_llm_label_conflict"
      ? `${disagreement.name}: human=${disagreement.human_label} vs model=${disagreement.llm_label}`
      : `${disagreement.name}: code flagged ${disagreement.code_failure_modes.join(",")} but human passed`);
  }
  for (const flag of run.judge_flags || []) reasons.push(`judge ${flag.identifier || "?"}: ${flag.reason}`);
  if (run.judge_missing) reasons.push("no model-judge annotation yet");
  if (run.judge_attempt?.judge_state === "judge_invalid") {
    reasons.push(`judge output invalid${run.judge_attempt.reason ? ` (${run.judge_attempt.reason})` : ""}`);
  }
  if (run.judge_attempt?.judge_state === "judge_missing") {
    reasons.push(`judge run produced no judgment${run.judge_attempt.reason ? ` (${run.judge_attempt.reason})` : ""}`);
  }
  if (run.derived_status === "needs_human" && reasons.length === 0) {
    reasons.push(run.all_signals_pass
      ? "passing example; human label would calibrate the judge"
      : "no human annotation yet");
  }
  return reasons;
}

function describeAnnotationForDetail(annotation = {}) {
  const modes = Array.isArray(annotation.metadata?.failure_modes)
    ? annotation.metadata.failure_modes
    : [];
  return [
    annotation.annotator_kind || "unknown",
    annotation.identifier || "?",
    annotation.name || "unnamed",
    annotation.label || "unlabeled",
    Number.isFinite(annotation.score) ? `score=${annotation.score}` : null,
    modes.length > 0 ? `failure_modes=${modes.join(",")}` : null,
    annotation.annotation_id ? `id=${annotation.annotation_id}` : null,
    annotation.explanation ? `explanation=${annotation.explanation}` : null,
  ].filter(Boolean).join(" ");
}

function disagreementSummary(disagreement, report) {
  const ref = disagreement.example_id || report.run_id || "evidence";
  if (disagreement.kind === "human_llm_label_conflict") {
    return `${ref} ${disagreement.name}: human(${disagreement.human_identifier})=${disagreement.human_label} vs model(${disagreement.llm_identifier})=${disagreement.llm_label}`;
  }
  return `${ref} ${disagreement.name}: code(${disagreement.code_identifier}) flagged ${(disagreement.code_failure_modes || []).join(",")} but human(${disagreement.human_identifier}) passed`;
}

function disagreementNextSteps(report) {
  const steps = [];
  if (report.mode === "run" && report.phoenix?.deep_link) {
    steps.push({ text: "Open Phoenix", hint: report.phoenix.deep_link });
  }
  if (report.mode === "experiment" && report.phoenix?.deep_links?.experiment) {
    steps.push({ text: "Open Phoenix", hint: report.phoenix.deep_links.experiment });
  }
  if ((report.worklist_items || []).length > 0) {
    steps.push({ text: "npm run worklist", hint: "rank what needs judgment" });
  }
  return steps;
}

function richPromotionFailureWhy(result) {
  const lines = [result.reason || "cannot_promote"];
  if (result.detail) lines.push(result.detail);
  if (result.secret_paths) lines.push(`token-shaped content at: ${result.secret_paths.join(", ")}`);
  if (result.unclassified_paths) {
    lines.push(`unclassified fields: ${result.unclassified_paths.join(", ")}`);
  }
  if (result.schema_errors) lines.push(`schema errors: ${result.schema_errors.join(" | ")}`);
  if (result.state === "duplicate_changed_content") {
    lines.push(`previous content hash: ${result.previous_content_hash}`);
    lines.push(`new content hash: ${result.new_content_hash}`);
  }
  if (result.report) lines.push(`sanitizer_report: ${JSON.stringify(result.report)}`);
  return lines.join("\n");
}

function richPromotionFix(result) {
  if (result.state === "duplicate_changed_content") {
    return "pass --force-new-version only if appending a new Phoenix example for changed content is intentional.";
  }
  if (result.unclassified_paths?.length > 0) {
    return "extend the content-gate field policy or remove the unclassified fields, then retry.";
  }
  if (result.secret_paths?.length > 0) {
    return "remove token-shaped content from the source artifact before promoting.";
  }
  if (result.repairable) return "re-run the source workflow to write current trace/run evidence, then retry.";
  return "repair the reported input issue and rerun the promotion.";
}

function renderPhoenixExperimentResult(result, output) {
  if (!result.ok) {
    output.error({
      what: "Phoenix experiment failed",
      why: experimentFailureWhy(result),
      fix: result.repair_hint || "repair the reported experiment input or Phoenix health issue, then retry.",
    });
    // receipt path is already surfaced in the error `why` (experimentFailureWhy) with
    // launch-facts context; no verbose-only duplicate.
    printVerboseHint(output);
    return;
  }

  const summary = result.summary;
  output.success(`Phoenix experiment: ${summary.status}`);
  output.keyValues([
    ["Intent", `${result.intent} (${result.intent_source === "explicit_flag" ? "explicit flag" : "default exploratory"})`],
    ["Variant", result.variant_id],
    ["Dataset", result.dataset.name],
    ["Split", `${result.split.requested || "all"} via ${result.split.selection}`],
    ["Examples", `${summary.example_count} run, ${summary.failed_example_count} with failures`],
  ], { heading: "Experiment" });
  if (result.split.selection === "metadata_fallback") {
    output.warn("Split selection used the disclosed metadata fallback; it is not native Phoenix split evidence.");
  }
  if (result.split.disclosure) output.detail(result.split.disclosure);
  for (const failed of summary.failed_examples || []) {
    output.warn(`Example needs attention: ${failed.example_id} (${failed.failures.join("; ") || failed.status})`);
  }
  renderExperimentEvidence(summary, output);
  renderExperimentComparisons(summary, output);
  output.detail(`phoenix_experiment_id=${result.phoenix_experiment_id}`);
  output.detail(`receipt_id=${result.receipt_id}`);
  output.detail(`receipt=${result.receipt_path}`);
  output.detail(`dataset_id=${result.dataset.dataset_id}`);
  output.detail(`dataset_version_id=${result.dataset.dataset_version_id}`);
  output.detail(`candidate_target=${result.candidate_target_key}`);
  output.detail(`baseline=${result.launch_baseline.accepted_baseline_id}`);
  output.nextSteps([
    { text: "Open Phoenix", hint: result.deep_links.experiment },
  ]);
  printVerboseHint(output);
}

function experimentFailureWhy(result) {
  const lines = [result.reason || result.status || "not_run"];
  if (result.detail) lines.push(result.detail);
  if (result.missing) lines.push(`missing examples: ${result.missing.join(", ")}`);
  if (result.failures) lines.push(`failures: ${result.failures.join(", ")}`);
  if (result.available) lines.push(`available variants: ${result.available.join(", ")}`);
  if (result.receipt_path) lines.push(`receipt: ${result.receipt_path} (launch facts recorded; experiment not created)`);
  return lines.join("\n");
}

function renderExperimentEvidence(summary, output) {
  const counts = summary.evidence_counts;
  if (!counts) return;
  output.keyValues([
    ["Train examples", `${counts.train_examples} (${counts.train_human_labeled_examples} human-labeled)`],
    ["Test examples", `${counts.test_examples} (${counts.test_human_labeled_examples} human-labeled)`],
    ["Human labels", counts.human_label_authenticity],
  ], { heading: "Evidence" });
  if (summary.human_annotation_note) output.warn(summary.human_annotation_note);
}

function renderExperimentComparisons(summary, output) {
  const meanNames = Object.keys(summary.score_means || {}).sort();
  for (const name of meanNames) {
    output.detail(`score_mean.${name}=${summary.score_means[name].toFixed(3)}`);
  }
  const baseline = summary.baseline_comparison || {};
  if (baseline.computable) {
    for (const [name, entry] of Object.entries(baseline.deltas || {})) {
      output.detail(`baseline_delta.${name}=${entry.delta >= 0 ? "+" : ""}${entry.delta.toFixed(3)} (${entry.baseline.toFixed(3)} -> ${entry.current.toFixed(3)})`);
    }
    if (baseline.regressions?.length > 0) {
      output.warn(`Regressions vs baseline: ${baseline.regressions.join(", ")}`);
    }
  } else if (baseline.reason) {
    output.warn(`Baseline score comparison is not computable: ${baseline.reason}`);
  }
  for (const regression of summary.judge_vs_human_regressions || []) {
    output.warn(`Judge-vs-human regression on ${regression.example_id}: human ${regression.human_label} -> judge ${regression.judge_label}`);
  }
  if ((summary.disagreements || []).length > 0) {
    for (const disagreement of summary.disagreements) {
      const parts = Object.entries(disagreement.signals || {})
        .map(([signal, label]) => `${signal}=${label}`)
        .join(" ");
      output.warn(`Signal disagreement on ${disagreement.example_id}: ${parts}`);
    }
  } else {
    output.success("No signal disagreements detected");
  }
  if (summary.metadata_stamp !== "stamped") {
    output.warn(`Metadata stamp: ${summary.metadata_stamp} (receipt remains the primary join)`);
  }
}

function renderPhoenixExperimentAmendmentResult(result, output) {
  if (!result.ok) {
    output.error({
      what: "Experiment receipt amendment failed",
      why: `${result.reason}${result.detail ? `\n${result.detail}` : ""}`,
      fix: "check the receipt id, amendment flags, and local Phoenix health, then retry.",
    });
    return;
  }
  output.success(`Experiment receipt amendment: ${result.action}`);
  output.keyValues([
    ["Reason", result.amendment.reason],
    ["State", result.state.state],
    ["Intent", result.state.intent],
  ], { heading: "Receipt" });
  if (result.action === "register") {
    output.detail(`registered_experiment_id=${result.amendment.experiment_id}`);
  }
  if (result.action === "reclassify") {
    output.info(`Intent changed: ${result.amendment.from_intent} -> ${result.amendment.to_intent}`);
  }
  output.detail(`receipt_id=${result.receipt_id}`);
  output.detail(`receipt=${result.receipt_path}`);
  output.detail(`phoenix_experiment_id=${result.state.phoenix_experiment_id || "none"}`);
  output.detail(`actor=${result.amendment.actor.os_username} (${result.amendment.actor.authenticity})`);
  printVerboseHint(output);
}
export {
  CLI_USAGE,
  COMMAND_TABLE,
  createCliContext,
  printCliUsage,
  redactOAuthSecrets,
};
