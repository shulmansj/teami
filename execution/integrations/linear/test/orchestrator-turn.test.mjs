import assert from "node:assert/strict";
import test from "node:test";

import {
  ORCHESTRATOR_RUNTIME_ROLE,
  buildOrchestratorPrompt,
  executeOrchestratorTurn,
  handleInvokeLibrary,
} from "../src/orchestrator-turn.mjs";
import { createOrchestratorRoster } from "../src/orchestrator-roster.mjs";
import { createRunRecorder } from "../../../engine/run-accepted-refs.mjs";

const PM_SUFFICIENCY_KEY = "prompt/decomposition/pm_product_sufficiency_pass";

test("the orchestrator runs on a NORMAL runtime role (scaffolded, added in I-2b)", () => {
  // The orchestrator's own runtime is the 'orchestrator' role — a normal tunable
  // decomposition role resolved the same way pm/sr_eng are. I-2a only names the
  // resolution path; the role itself is added in I-2b.
  assert.equal(ORCHESTRATOR_RUNTIME_ROLE, "orchestrator");
});

test("executeOrchestratorTurn returns { controlAction, evidence, producedContent?, sessionHandle } with a STUBBED runtime", async () => {
  const roster = createOrchestratorRoster();
  const seen = {};
  const turn = await executeOrchestratorTurn({
    runId: "run-1",
    project: { id: "proj-1" },
    roster,
    priorTurns: [],
    bounds: { rounds_used: 0, max_rounds: 100 },
    sessionHandle: null,
    config: null,
    repoRoot: undefined,
    // STUB the runtime: a scripted control action + a producedContent sibling.
    orchestratorRuntime: async (input) => {
      Object.assign(seen, input);
      return {
        controlAction: { action: "invoke_library", target_key: input.selectableTargets[0] },
        evidence: { perspectives_run: [] },
        producedContent: { draft_final_issues: [{ decomposition_key: "k1" }] },
        sessionHandle: "handle-1",
      };
    },
  });

  // The turn-result shape (Seam 1).
  assert.deepEqual(Object.keys(turn).sort(), [
    "controlAction",
    "evidence",
    "producedContent",
    "sessionHandle",
  ]);
  // controlAction is the VALIDATED, normalized control action.
  assert.equal(turn.controlAction.action, "invoke_library");
  assert.equal(turn.controlAction.target_key, PM_SUFFICIENCY_KEY);
  // producedContent is a SIBLING of evidence, carrying authored output.
  assert.ok("producedContent" in turn);
  assert.deepEqual(turn.producedContent.draft_final_issues, [{ decomposition_key: "k1" }]);
  assert.notEqual(turn.evidence, turn.producedContent);
  assert.equal(turn.sessionHandle, "handle-1");

  // The roster's selectableTargets are passed to the runtime so the orchestrator
  // knows which library subagents exist.
  assert.deepEqual(seen.selectableTargets, roster.selectableTargets);
  assert.equal(seen.runId, "run-1");
});

test("executeOrchestratorTurn omits producedContent when the turn authored nothing", async () => {
  const turn = await executeOrchestratorTurn({
    runId: "run-1",
    project: {},
    roster: createOrchestratorRoster(),
    bounds: {},
    orchestratorRuntime: async () => ({
      controlAction: { action: "terminate", outcome: "pause", reason: "product_questions" },
      evidence: { perspectives_run: [] },
      // no producedContent
    }),
  });
  assert.ok(!("producedContent" in turn));
  assert.equal(turn.controlAction.action, "terminate");
  assert.equal(turn.controlAction.outcome, "pause");
});

test("executeOrchestratorTurn rejects an invalid control action from the runtime", async () => {
  await assert.rejects(
    () =>
      executeOrchestratorTurn({
        runId: "run-1",
        project: {},
        roster: createOrchestratorRoster(),
        bounds: {},
        orchestratorRuntime: async () => ({
          controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete", sneaky: 1 },
        }),
      }),
    /orchestrator_turn_invalid_control_action/,
  );
});

test("executeOrchestratorTurn passes the governing body + roster to the injected runtime and returns the parsed control action (I-2b wired path)", async () => {
  // I-2b wires the real runtime; the unit path is exercised by injecting an
  // orchestratorRuntime, which receives the governing body + selectableTargets
  // and returns a raw control action that the harness validates.
  let received = null;
  const result = await executeOrchestratorTurn({
    runId: "run-1",
    project: { id: "p1" },
    roster: createOrchestratorRoster(),
    bounds: { rounds_used: 1, max_rounds: 10 },
    governingBody: "GOVERNING PERSONA BODY",
    orchestratorRuntime: async (input) => {
      received = input;
      return {
        controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
        producedContent: { final_issues: [] },
      };
    },
  });

  assert.equal(received.governingBody, "GOVERNING PERSONA BODY");
  assert.ok(Array.isArray(received.selectableTargets));
  assert.equal(result.controlAction.action, "terminate");
  assert.equal(result.controlAction.outcome, "commit");
  assert.deepEqual(result.producedContent, { final_issues: [] });
});

test("buildOrchestratorPrompt keeps the factory contract code-owned outside the governing body", () => {
  const promptInput = {
    runId: "run-factory-contract",
    project: { id: "p1", name: "Factory split" },
    selectableTargets: ["prompt/decomposition/custom"],
    priorTurns: [
      {
        controlAction: { action: "invoke_library", target_key: "prompt/decomposition/custom" },
        outcome: "continue",
      },
    ],
    bounds: { rounds_used: 1, max_rounds: 3 },
    invocableRuntimeRoles: ["pm", "sr_eng"],
  };
  const tunedPrompt = buildOrchestratorPrompt({
    ...promptInput,
    governingBody: "ADOPTER TUNED GOVERNING BODY",
  });
  const emptyGovernancePrompt = buildOrchestratorPrompt({
    ...promptInput,
    governingBody: "",
  });

  const factoryContractSnippets = [
    "Reply with EXACTLY ONE JSON object that satisfies the provided schema.",
    "control_action is REQUIRED and is exactly ONE of:",
    "- invoke_library({ action: \"invoke_library\", target_key }) to run a named library subagent;",
    "- invoke_one_off({ action: \"invoke_one_off\", role_label, task, prompt, runtime_role }) to run an improvised subagent (runtime_role is one of pm|sr_eng);",
    "- terminate({ action: \"terminate\", outcome, reason }) to end the run (outcome commit -> reason synthesis_complete; outcome pause -> reason product_questions|discovery_needed|needs_pm_review).",
    "produced_content is a SIBLING of control_action (NOT a field inside it).",
    "When you terminate with outcome commit, produced_content MUST include:",
    "- final_issues: an array of agent-ready issues, each { decomposition_key, title, issue_body_markdown, depends_on, assignment, output, acceptance_criteria };",
    "- project_update_markdown: a project update that includes the line `run_id: <run_id>`",
  ];

  for (const prompt of [tunedPrompt, emptyGovernancePrompt]) {
    for (const snippet of factoryContractSnippets) {
      assert.ok(prompt.includes(snippet), snippet);
    }
  }
  assert.match(tunedPrompt, /^ADOPTER TUNED GOVERNING BODY\n\nrun_id: run-factory-contract\n/);
  assert.match(
    emptyGovernancePrompt,
    /^You are the Agentic Factory decomposition orchestrator\. Decide which subagents to run and when to terminate\.\n\nrun_id: run-factory-contract\n/,
  );
});

test("handleInvokeLibrary resolves once, records the library load, and returns the body", () => {
  const roster = createOrchestratorRoster();
  const recorder = createRunRecorder({});
  const controlAction = { action: "invoke_library", target_key: PM_SUFFICIENCY_KEY };

  const result = handleInvokeLibrary({ controlAction, roster, recorder });
  assert.equal(result.ok, true);
  assert.equal(result.runtime_role, "pm");
  assert.equal(typeof result.body, "string");
  assert.ok(result.body.length > 0);
  assert.equal(typeof result.snapshot, "object");

  // The library load is captured on the recorder (capture-at-load), and the
  // resolved runtime_role is recorded as executed.
  const refs = recorder.collectRefs();
  assert.deepEqual(refs.map((r) => r.target_key), [PM_SUFFICIENCY_KEY]);
});

test("handleInvokeLibrary rejects an unknown/non-selectable target and records nothing", () => {
  const roster = createOrchestratorRoster();
  const recorder = createRunRecorder({});
  const result = handleInvokeLibrary({
    controlAction: { action: "invoke_library", target_key: "prompt/decomposition/does_not_exist" },
    roster,
    recorder,
  });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
  assert.deepEqual(recorder.collectRefs(), []);
});

test("handleInvokeLibrary rejects a wrong-action control action", () => {
  const result = handleInvokeLibrary({
    controlAction: { action: "terminate", outcome: "commit", reason: "synthesis_complete" },
    roster: createOrchestratorRoster(),
    recorder: createRunRecorder({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invoke_library_handler_wrong_action");
});

// NOTE on deliverable C (the injectable orchestratorTurnExecutor param): the
// decomposition phase-loop function is a retirement-surface router token
// (RET-CHECK set-a), so it is intentionally NOT referenced from this NEW file —
// doing so would proliferate a router token into the very surface being retired.
// The additive param is verified instead via a source-pinned assertion in
// orchestrator-turn-injection.test.mjs (the param is destructured) PLUS the
// EXISTING phase-loop tests (linear-workflow / runtime-role-defaults), which stay
// green and prove the live router behavior is unchanged.
