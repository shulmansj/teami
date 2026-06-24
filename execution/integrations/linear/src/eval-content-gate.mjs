import { findSecretContentKeys } from "../../../engine/trace-contract.mjs";

// Field-level content gate for rich eval content leaving local custody
// (CONSTRAINTS #28). Built as a reusable module on purpose: PR evidence
// summaries reuse the SAME allowlist semantics, denylist, secret rejection,
// and sanitizer reporting (CONSTRAINTS #29) by supplying their own field
// policy tree to the same engine.
//
// Gate semantics (fail closed, in order of severity):
// 1. Token/secret-shaped content (keys or values) anywhere -> the whole
//    payload is rejected (`token_or_secret_like`). Secrets are NEVER
//    "sanitized through"; mandatory but not sufficient.
// 2. Every field is classified against an explicit field policy tree:
//    - allowed fields are kept (string content is still scanned and private
//      URLs are redacted with a reported transform),
//    - explicitly excluded fields and denylisted content keys (prompts, tool
//      transcripts, shell output, repo snippets, customer data) are REMOVED
//      and each removal is reported,
//    - unknown/unclassifiable fields REJECT the payload into
//      `needs_sanitization` — never silently passed, never silently dropped.
// 3. The sanitizer returns a machine-readable report of every removal and
//    transformation. The report belongs in command output and the LOCAL
//    promotion receipt only — never in Phoenix payloads.

export const CONTENT_GATE_VERSION = "1.0.0";

// Keys whose presence alone is credential material (in addition to the
// trace-contract key scan): the gate fails closed rather than removing them,
// because their presence in promotion input means something upstream leaked.
export const SECRET_KEY_PATTERN =
  /(^|[_\-.])(token|secret|api[_\-.]?key|authorization|password|passwd|credential|private[_\-.]?key|oauth|client[_\-.]?secret|cookie|session[_\-.]?key)($|[_\-.])/i;

// Token-shaped value patterns. Superset of the trace-contract patterns:
// rich project/issue prose can carry secrets pasted by humans, so the rich
// gate scans harder than the bounded trace path.
export const SECRET_VALUE_PATTERNS = Object.freeze([
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/,
  new RegExp("\\b" + "sk-" + "[A-Za-z0-9_-]{16,}"),
  new RegExp("\\b" + "gh[pousr]_" + "[A-Za-z0-9_]{16,}"),
  new RegExp("\\b" + "github_" + "pat_" + "[A-Za-z0-9_]{20,}"),
  new RegExp("\\b" + "xox[baprs]-" + "[A-Za-z0-9-]{16,}"),
  new RegExp("\\b" + "ri_" + "[A-Fa-f0-9]{16,}"),
  /\blin_(?:api|oauth)_[A-Za-z0-9]{12,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  new RegExp("-----BEGIN " + "[A-Z ]*" + "PRIVATE KEY-----"),
  // URL userinfo credentials.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i,
]);

// Content-denylist key rules: fields whose CONTENT classes are banned from
// promoted examples and PR evidence summaries (CONSTRAINTS #28/#29). Matching
// fields are REMOVED and reported (unlike secrets, which fail the gate).
export const DENIED_CONTENT_KEY_RULES = Object.freeze([
  { rule: "prompt_content", pattern: /(^|[_\-.])(prompt|prompts)($|[_\-.])/i },
  {
    rule: "tool_transcript",
    pattern: /(^|[_\-.])(transcript|tool[_\-.]?calls?|tool[_\-.]?output|conversation|messages)($|[_\-.])/i,
  },
  {
    rule: "shell_output",
    pattern: /(^|[_\-.])(shell[_\-.]?output|stdout|stderr|console[_\-.]?output|command[_\-.]?output)($|[_\-.])/i,
  },
  {
    rule: "repo_snippet",
    pattern: /(^|[_\-.])(repo[_\-.]?snippet|code[_\-.]?snippet|source[_\-.]?context|diff|patch|file[_\-.]?contents?)($|[_\-.])/i,
  },
  {
    rule: "customer_data",
    pattern: /(^|[_\-.])(customer|email[_\-.]?address|phone[_\-.]?number|mailing[_\-.]?address|ssn)($|[_\-.])/i,
  },
]);

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]}"'<>]+/gi;
const PRIVATE_HOST_PATTERN =
  /^(localhost$|127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|.*\.(local|internal|lan|corp|intranet)$)/i;

// Token-shaped content scan: trace-contract key/value scan PLUS the extended
// rich-content value patterns. Returns the offending paths (deduped).
export function findTokenShapedContent(value, path = []) {
  const matches = new Set(findSecretContentKeys(value));
  scanValuesForSecrets(value, path, matches);
  return [...matches];
}

function scanValuesForSecrets(value, path, matches) {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      matches.add(path.join(".") || "$");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) matches.add([...path, key].join("."));
    scanValuesForSecrets(nested, [...path, key], matches);
  }
}

export function classifyDeniedContentKey(key) {
  const matched = DENIED_CONTENT_KEY_RULES.find(({ pattern }) => pattern.test(key));
  return matched ? matched.rule : null;
}

// Redacts private/internal URLs and non-http(s) link schemes from a string,
// reporting every transformation. Public http(s) URLs pass through.
export function sanitizeStringContent(text, path = "$") {
  const transformed = [];
  const value = text.replace(URL_PATTERN, (url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      transformed.push({ path, rule: "unparseable_url_redacted", detail: url.slice(0, 64) });
      return "[redacted-url]";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      transformed.push({ path, rule: "non_http_url_redacted", detail: `${parsed.protocol}//…` });
      return "[redacted-url]";
    }
    if (PRIVATE_HOST_PATTERN.test(parsed.hostname)) {
      transformed.push({ path, rule: "private_url_redacted", detail: parsed.hostname });
      return "[redacted-private-url]";
    }
    return url;
  });
  return { value, transformed };
}

// ---------------------------------------------------------------------------
// Field policy engine.
//
// Policy node forms:
//   { allow: "string" }            keep string|null; scan + URL-sanitize
//   { allow: "scalar" }            keep string|number|boolean|null; strings scanned
//   { object: { key: node, ... } } walk known keys; unknown keys are classified
//                                  (secret -> fail, denylist -> removed, else unknown)
//   { array: node }                apply node to each element
//   { exclude: "<rule>" }          remove the field and report the removal
// ---------------------------------------------------------------------------

export function applyContentFieldPolicy({ value, policy, path = "$" }) {
  const report = { removed: [], transformed: [], unknown: [], secrets: [] };
  const sanitized = walkPolicy(value, policy, path, report);
  return { value: sanitized, ...report };
}

function walkPolicy(value, policy, path, report) {
  if (!policy || typeof policy !== "object") {
    report.unknown.push(path);
    return undefined;
  }
  if (policy.exclude) {
    if (value !== undefined) report.removed.push({ path, rule: policy.exclude });
    return undefined;
  }
  if (policy.allow === "string") {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value !== "string") {
      report.unknown.push(`${path} (expected string, got ${describeType(value)})`);
      return undefined;
    }
    return sanitizeAllowedString(value, path, report);
  }
  if (policy.allow === "scalar") {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "string") return sanitizeAllowedString(value, path, report);
    if (typeof value === "number" || typeof value === "boolean") return value;
    report.unknown.push(`${path} (expected scalar, got ${describeType(value)})`);
    return undefined;
  }
  if (policy.array) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      report.unknown.push(`${path} (expected array, got ${describeType(value)})`);
      return undefined;
    }
    const items = [];
    value.forEach((item, index) => {
      const walked = walkPolicy(item, policy.array, `${path}[${index}]`, report);
      if (walked !== undefined) items.push(walked);
    });
    return items;
  }
  if (policy.object) {
    if (value === undefined || value === null) return value ?? null;
    if (typeof value !== "object" || Array.isArray(value)) {
      report.unknown.push(`${path} (expected object, got ${describeType(value)})`);
      return undefined;
    }
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      const childPolicy = policy.object[key];
      if (childPolicy !== undefined) {
        const walked = walkPolicy(nested, childPolicy, childPath, report);
        if (walked !== undefined) result[key] = walked;
        continue;
      }
      // Unlisted key: classify before rejecting. Secrets fail the gate;
      // denylisted content classes are removed and reported; anything else
      // is unclassifiable and rejects the payload into needs_sanitization.
      if (SECRET_KEY_PATTERN.test(key)) {
        report.secrets.push({ path: childPath, rule: "secret_shaped_key" });
        continue;
      }
      const deniedRule = classifyDeniedContentKey(key);
      if (deniedRule) {
        report.removed.push({ path: childPath, rule: deniedRule });
        continue;
      }
      report.unknown.push(childPath);
    }
    return result;
  }
  report.unknown.push(`${path} (unsupported policy node)`);
  return undefined;
}

function sanitizeAllowedString(text, path, report) {
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(text))) {
    report.secrets.push({ path, rule: "token_shaped_value" });
    return undefined;
  }
  const { value, transformed } = sanitizeStringContent(text, path);
  report.transformed.push(...transformed);
  return value;
}

function describeType(value) {
  if (Array.isArray(value)) return "array";
  return value === null ? "null" : typeof value;
}

// Main gate entry: classify + sanitize a payload against a field policy.
// Fail-closed result states mirror the plan's Rich Promotion State diagram:
//   token_or_secret_like -> cannot_promote
//   needs_sanitization   -> rejected_unsanitized (unknown/unclassifiable)
export function sanitizeAndClassifyContent({ value, policy, label = "content" } = {}) {
  // Mandatory token-shaped rejection runs over the RAW input first, so a
  // secret inside an otherwise-removed field still fails the gate.
  const rawSecretPaths = findTokenShapedContent(value);
  const { value: sanitized, removed, transformed, unknown, secrets } = applyContentFieldPolicy({
    value,
    policy,
  });
  const secretPaths = [
    ...new Set([...rawSecretPaths, ...secrets.map((entry) => entry.path)]),
  ];
  if (secretPaths.length > 0) {
    return {
      ok: false,
      state: "cannot_promote",
      reason: "token_or_secret_like",
      label,
      secret_paths: secretPaths,
      report: buildSanitizerReport({ removed, transformed }),
    };
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      state: "needs_sanitization",
      reason: "unclassified_content",
      label,
      unclassified_paths: [...new Set(unknown)],
      report: buildSanitizerReport({ removed, transformed }),
    };
  }
  return {
    ok: true,
    value: sanitized,
    report: buildSanitizerReport({ removed, transformed }),
  };
}

function buildSanitizerReport({ removed, transformed }) {
  return {
    content_gate_version: CONTENT_GATE_VERSION,
    removed,
    transformed,
    removed_count: removed.length,
    transformed_count: transformed.length,
  };
}

// ---------------------------------------------------------------------------
// Rich decomposition example field policy (the CONSTRAINTS #28 allowlist).
//
// ALLOWED content classes: project fields (captured snapshot projection),
// phase-packet summaries, final issue bodies, dependency summaries, authored
// project update text, and open-questions prose.
// EXCLUDED-but-known fields are removed with a named rule (reported).
// Everything else is unknown and rejects into needs_sanitization.
// ---------------------------------------------------------------------------

const labelPolicy = {
  object: {
    id: { allow: "string" },
    name: { allow: "string" },
  },
};

const phasePacketSummaryPolicy = {
  object: {
    schema_version: { allow: "string" },
    run_id: { allow: "string" },
    phase: { allow: "string" },
    status: { allow: "string" },
    reason: { allow: "string" },
    context_digest: { allow: "string" },
    assumptions: { array: { allow: "string" } },
    constraints: { array: { allow: "string" } },
    risks: { array: { allow: "string" } },
    open_questions_markdown: { allow: "string" },
    project_update_markdown: { allow: "string" },
    technical_explanation_markdown: { allow: "string" },
    // References into adopter sources are not part of the promoted summary:
    // they can name private repositories/URLs without being secrets.
    source_refs: { exclude: "source_refs_not_promoted" },
    // Issue payloads inside packets duplicate the terminal output artifact;
    // the output section is the single promoted copy.
    final_issues: { exclude: "duplicated_in_output_final_issues" },
    discovery_issues: { exclude: "duplicated_in_output_discovery_issues" },
  },
};

const finalIssuePolicy = {
  object: {
    decomposition_key: { allow: "string" },
    decompositionKey: { allow: "string" },
    title: { allow: "string" },
    issue_body_markdown: { allow: "string" },
    issueBodyMarkdown: { allow: "string" },
    assignment: { allow: "string" },
    output: { allow: "string" },
    acceptanceCriteria: { array: { allow: "string" } },
    acceptance_criteria: { array: { allow: "string" } },
    depends_on: { array: { allow: "string" } },
    dependsOn: { array: { allow: "string" } },
    // Workspace-internal routing identifiers add no judgment signal.
    assignee_id: { exclude: "workspace_internal_routing_id" },
    label_ids: { exclude: "workspace_internal_routing_id" },
  },
};

const discoveryIssuePolicy = {
  object: {
    decomposition_key: { allow: "string" },
    decompositionKey: { allow: "string" },
    title: { allow: "string" },
    body_markdown: { allow: "string" },
    in_session_research: { allow: "scalar" },
    evidence_gap: { allow: "scalar" },
    depends_on: { array: { allow: "string" } },
    assignee_id: { exclude: "workspace_internal_routing_id" },
    label_ids: { exclude: "workspace_internal_routing_id" },
  },
};

export const RICH_EXAMPLE_CONTENT_POLICY = Object.freeze({
  object: {
    schema_version: { allow: "string" },
    input: {
      object: {
        source_type: { allow: "string" },
        project: {
          object: {
            id: { allow: "string" },
            name: { allow: "string" },
            description: { allow: "string" },
            content: { allow: "string" },
            status: { allow: "string" },
            labels: { array: labelPolicy },
            existing_issues: {
              array: {
                object: {
                  id: { allow: "string" },
                  identifier: { allow: "string" },
                  title: { allow: "string" },
                  state: {
                    object: {
                      id: { allow: "string" },
                      name: { allow: "string" },
                      type: { allow: "string" },
                    },
                  },
                  labels: { array: labelPolicy },
                },
              },
            },
          },
        },
        run_envelope: {
          object: {
            workflow_version: { allow: "string" },
            allowed_source_boundaries: { array: { allow: "string" } },
            runtime_assignments: {
              object: {
                pm: { allow: "string" },
                sr_eng: { allow: "string" },
              },
            },
          },
        },
        source_refs: { array: { allow: "string" } },
      },
    },
    output: {
      object: {
        terminal_status: { allow: "string" },
        terminal_reason: { allow: "string" },
        phase_packets: { array: phasePacketSummaryPolicy },
        final_issues: { array: finalIssuePolicy },
        discovery_issues: { array: discoveryIssuePolicy },
        dependency_relations: {
          array: {
            object: {
              blocking: { allow: "string" },
              blocked: { allow: "string" },
            },
          },
        },
        project_update_markdown: { allow: "string" },
        open_questions_markdown: { allow: "string" },
      },
    },
    reference: {
      object: {
        human_annotations: {
          array: {
            object: {
              name: { allow: "string" },
              label: { allow: "string" },
              score: { allow: "scalar" },
              failure_modes: { array: { allow: "string" } },
              explanation: { allow: "string" },
            },
          },
        },
        human_annotation_ids: { array: { allow: "string" } },
      },
    },
    metadata: {
      object: {
        workspace_maturity: { allow: "string" },
        project_category: { allow: "string" },
        project_impact_level: { allow: "string" },
        lifecycle_state: { allow: "string" },
        dataset_split: { allow: "string" },
        process_version: { allow: "string" },
        rubric_version: { allow: "string" },
        failure_taxonomy_version: { allow: "string" },
        source_trace_id: { allow: "string" },
        source_run_id: { allow: "string" },
        content_retention: { allow: "string" },
      },
    },
  },
});
