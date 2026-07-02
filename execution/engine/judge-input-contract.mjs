export const JUDGE_INPUT_CONTRACT_SCHEMA_VERSION = "teami-judge-input-contract/v1";
export const JUDGE_GRADEABILITY_VALUES = Object.freeze(["full_input", "detection_only"]);

export function deriveJudgeInputContract({ exampleSchema = null, judgePrompt = null } = {}) {
  const inputSchema = exampleSchema?.properties?.input;
  if (!isRecord(inputSchema)) return null;

  const defs = exampleSchema?.$defs || {};
  const fixtureSchema = defs.judge_fixture_input
    || inputSchema.properties?.judge_fixture_input
    || null;
  const contextSchema = defs.maintainer_supplied_context
    || inputSchema.properties?.maintainer_supplied_context
    || null;

  let judgeFixtureFields = requiredFields(fixtureSchema);
  let maintainerContextFields = requiredFields(contextSchema);
  let inputSource = "example_schema_input_shape";

  if (judgeFixtureFields.length === 0 && maintainerContextFields.length === 0) {
    judgeFixtureFields = requiredFields(inputSchema);
    maintainerContextFields = [];
    inputSource = "legacy_example_schema_input_required";
  }

  const requiredFieldsAll = [...judgeFixtureFields, ...maintainerContextFields];
  if (requiredFieldsAll.length === 0) return null;

  return deepFreeze({
    schema_version: JUDGE_INPUT_CONTRACT_SCHEMA_VERSION,
    source: inputSource,
    prompt_role: judgePrompt?.role ?? null,
    prompt_target_key: judgePrompt?.target_key ?? null,
    gradeability_values: [...JUDGE_GRADEABILITY_VALUES],
    gradeability_path: "input.gradeability",
    judge_fixture_input_path: "input.judge_fixture_input",
    maintainer_supplied_context_path: "input.maintainer_supplied_context",
    judge_fixture_input_fields: judgeFixtureFields,
    maintainer_supplied_context_fields: maintainerContextFields,
    required_fields: requiredFieldsAll,
  });
}

export function normalizeJudgeInput(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function projectJudgeInputForFixture(judgeInputs, contract) {
  const failures = judgeInputCompletenessFailures(judgeInputs, contract);
  if (failures.length > 0) return { ok: false, reason: "judge_input_incomplete", failures };
  const normalized = normalizeJudgeInput(judgeInputs);
  return {
    ok: true,
    gradeability: "full_input",
    judge_fixture_input: pickFields(normalized, contract.judge_fixture_input_fields),
    maintainer_supplied_context: pickFields(normalized, contract.maintainer_supplied_context_fields),
  };
}

export function combineStoredJudgeFixtureInput({
  fixtureInput,
  contract,
  maintainerSuppliedContext = null,
} = {}) {
  if (!isRecord(fixtureInput)) {
    return {
      ok: false,
      reason: "stored_fixture_input_not_object",
      failures: ["input_not_object"],
    };
  }
  if (fixtureInput.gradeability !== "full_input") {
    return {
      ok: false,
      reason: "stored_fixture_not_full_input",
      gradeability: fixtureInput.gradeability ?? null,
      failures: [`gradeability_not_full_input:${String(fixtureInput.gradeability ?? "missing")}`],
    };
  }
  const evidence = fixtureInput.judge_fixture_input;
  if (!isRecord(evidence)) {
    return {
      ok: false,
      reason: "stored_judge_fixture_input_missing",
      failures: ["input.judge_fixture_input_missing"],
    };
  }
  const context = maintainerSuppliedContext
    || (isRecord(fixtureInput.maintainer_supplied_context)
      ? fixtureInput.maintainer_supplied_context
      : null);
  if (!isRecord(context) && contract.maintainer_supplied_context_fields.length > 0) {
    return {
      ok: false,
      reason: "stored_maintainer_context_missing",
      failures: ["input.maintainer_supplied_context_missing"],
    };
  }

  const inputs = {
    ...pickFields(evidence, contract.judge_fixture_input_fields),
    ...pickFields(context || {}, contract.maintainer_supplied_context_fields),
  };
  const failures = judgeInputCompletenessFailures(inputs, contract);
  if (failures.length > 0) return { ok: false, reason: "stored_judge_input_incomplete", failures };
  return { ok: true, inputs: normalizeJudgeInput(inputs) };
}

export function judgeInputCompletenessFailures(inputs, contract) {
  if (!contract) return ["judge_input_contract_missing"];
  if (!isRecord(inputs)) return ["judge_input_not_object"];
  const failures = [];
  for (const field of contract.required_fields || []) {
    if (!Object.hasOwn(inputs, field) || inputs[field] === undefined) {
      failures.push(`missing:${field}`);
    }
  }
  return failures;
}

function requiredFields(schema) {
  return Object.freeze(
    Array.isArray(schema?.required)
      ? schema.required.filter((field) => typeof field === "string" && field.trim() !== "")
      : [],
  );
}

function pickFields(source, fields) {
  const picked = {};
  for (const field of fields || []) {
    if (Object.hasOwn(source || {}, field)) picked[field] = normalizeJudgeInput(source[field]);
  }
  return picked;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
