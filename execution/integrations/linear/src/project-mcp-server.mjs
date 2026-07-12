import {
  TEAMI_PROJECT_MCP_TOOL_NAMES,
  createProjectMcpToolActions,
  sanitizeProjectMcpError,
} from "./project-mcp-tools.mjs";
import { createLocalPhoenixTraceSink } from "./local-phoenix-trace-sink.mjs";
import { loadLinearConfigAsync } from "./config.mjs";
import { PROJECT_PLANNING_SLOTS } from "./project-planning-body.mjs";

const SERVER_INFO = Object.freeze({
  name: "teami-project",
  version: "0.1.0",
});

export async function createTeamiProjectMcpServer({
  actions = null,
  serverInfo = SERVER_INFO,
  ...toolOptions
} = {}) {
  const [{ McpServer }, z] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("zod/v3"),
  ]);
  const server = new McpServer(serverInfo);
  const resolvedToolOptions = actions || toolOptions.config
    ? toolOptions
    : {
        ...toolOptions,
        config: await (toolOptions.loadConfig || loadLinearConfigAsync)({
          repoRoot: toolOptions.repoRoot || process.cwd(),
          home: toolOptions.home,
        }),
      };
  registerTeamiProjectTools(
    server,
    actions || createProjectMcpToolActions({
      createPlanningTraceSink: createLocalPhoenixTraceSink,
      ...resolvedToolOptions,
    }),
    z,
  );
  return server;
}

export async function runTeamiProjectMcpStdioServer(options = {}) {
  const [{ StdioServerTransport }, server] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    createTeamiProjectMcpServer(options),
  ]);
  await server.connect(new StdioServerTransport());
  return server;
}

export function registerTeamiProjectTools(server, actions, z) {
  const domainField = z.string().min(1).optional();
  const projectIdField = z.string().min(1);
  const planningSlotValueField = z.union([z.string(), z.array(z.string())]);
  const planningSlotsField = z.object(
    Object.fromEntries(PROJECT_PLANNING_SLOTS.map((slot) => [slot.key, planningSlotValueField])),
  );
  const planningTelemetryField = z.object({
    elicitation_rounds: z.number().optional(),
    human_only_decisions_surfaced: z.number().optional(),
    pressure_test_verdict: z.string().optional(),
    advisor_used: z.boolean().optional(),
  });

  // init_onboarding is intentionally part of the standing tool set (not gated to a separate
  // setup-only surface): it is the conversational setup AND repair entry. A bare call teaches
  // the agent what to ask; a call with a domain runs the real setup pipeline end to end.
  server.registerTool(
    "init_onboarding",
    {
      title: "Set up Teami",
      description: "Run full Teami setup through MCP after the agent gathers the domain, repo allowlist, and optional workspace.",
      inputSchema: {
        setup_id: z.string().uuid().optional().describe("Resume or poll an in-process setup authorization session."),
        domain: z.string().min(1).optional().describe("Required to run setup; omit only to get guidance for what to ask."),
        workspace: z.string().min(1).optional().describe("Expected Linear workspace name or id."),
        repo_intent: z.union([
          z.object({ mode: z.literal("non_code") }),
          z.object({ mode: z.literal("allowlist"), repos: z.array(z.string().min(1)).min(1) }),
        ]).optional().describe("Required on setup start: explicitly choose a non-code team or an owner/repo allowlist."),
        confirm: z.boolean().optional().describe("Must be true only after the adopter explicitly accepts the current setup disclosure."),
        disclosure_version: z.string().min(1).optional().describe("Exact disclosure version returned by the bare call."),
        disclosure_hash: z.string().length(64).optional().describe("Exact disclosure hash returned by the bare call."),
        admin_confirm: z.boolean().optional().describe("Separate just-in-time confirmation for a conditional one-shot Linear admin grant."),
        repair_admin_revocation: z.boolean().optional().describe("Returns fail-closed recovery guidance for an interrupted one-shot admin flow. Teami cannot clear a lost-token marker by revoking a fresh token."),
        github_repo: z.string().min(1).optional().describe("Behavior repo name override."),
        github_owner: z.string().min(1).optional().describe("Behavior repo owner/org override."),
        github_dry_run: z.boolean().optional().describe("Record the GitHub setup intent without real GitHub writes."),
      },
    },
    initOnboardingToolCallback(server, actions.init_onboarding),
  );
  server.registerTool(
    "resolve_domain",
    {
      title: "Resolve Teami domain",
      description: "Resolve the active local Teami domain without exposing credentials.",
      inputSchema: {
        domain: domainField.describe("Optional domain id when multiple active domains exist."),
      },
    },
    toolCallback(actions.resolve_domain),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create Linear planning project",
      description: "Create a bare Linear project in Backlog for the resolved Teami domain team.",
      inputSchema: {
        domain: domainField.describe("Optional domain id when multiple active domains exist."),
        name: z.string().min(1).describe("Project name."),
        description: z.string().min(1).optional().describe("One-line project summary."),
      },
    },
    toolCallback(actions.project_create),
  );

  server.registerTool(
    "project_write_body",
    {
      title: "Write Linear project body",
      description: "Write the planning body to a Linear project content field.",
      inputSchema: {
        domain: domainField.describe("Optional domain id when multiple active domains exist."),
        project_id: projectIdField.describe("Linear project id."),
        content: z.string().min(1).optional().describe("Legacy complete markdown body to store as project content."),
        slots: planningSlotsField
          .optional()
          .describe("Canonical planning slots. If content is also supplied, slots are rendered and take precedence."),
      },
    },
    toolCallback(actions.project_write_body),
  );

  server.registerTool(
    "project_move_status",
    {
      title: "Move Linear project to Planned",
      description: "Move a project to the configured Planned status. Requires confirm: true.",
      inputSchema: {
        domain: domainField.describe("Optional domain id when multiple active domains exist."),
        project_id: projectIdField.describe("Linear project id."),
        confirm: z.literal(true).describe("Must be true only after explicit human approval."),
        planning_telemetry: planningTelemetryField
          .optional()
          .describe("Optional additive planning-session telemetry recorded only on the committed trace."),
      },
    },
    toolCallback(actions.project_move_status),
  );

  return TEAMI_PROJECT_MCP_TOOL_NAMES;
}

function toolCallback(action) {
  return async (args) => {
    try {
      return toolResult(await action(args || {}));
    } catch (error) {
      return toolErrorResult(sanitizeProjectMcpError(error));
    }
  };
}

function initOnboardingToolCallback(server, action) {
  return async (args) => {
    try {
      return initOnboardingToolResult(await action(args || {}, {
        elicitInput: server?.server?.elicitInput?.bind(server.server),
      }));
    } catch (error) {
      return toolErrorResult(sanitizeProjectMcpError(error));
    }
  };
}

function toolResult(structuredContent) {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function initOnboardingToolResult(structuredContent) {
  return {
    content: [{
      type: "text",
      text: structuredContent?.fallback && structuredContent?.authorization_url
        ? structuredContent.authorization_url
        : JSON.stringify(structuredContent),
    }],
    structuredContent,
  };
}

function toolErrorResult(structuredContent) {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}
