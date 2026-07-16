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
  const teamField = z.string().min(1).optional();
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
  // setup-only surface): it is the conversational setup AND repair entry. A bare call returns
  // the disclosure and safe defaults; a confirmed call runs the real setup pipeline end to end.
  server.registerTool(
    "init_onboarding",
    {
      title: "Set up Teami",
      description: "Run full Teami setup; onboarding leaves every product repository disconnected.",
      inputSchema: {
        setup_id: z.string().uuid().optional().describe("Resume or poll an in-process setup authorization session."),
        team: z.string().min(1).optional().describe("Advanced override. Fresh setup uses the single default Teami team."),
        workspace: z.string().min(1).optional().describe("Expected Linear workspace name or id."),
        repo_intent: z.object({ mode: z.literal("non_code") }).optional()
          .describe("Compatibility field. Omit it; onboarding leaves every product repository disconnected."),
        confirm: z.boolean().optional().describe("Must be true only after the adopter explicitly accepts the current setup disclosure."),
        disclosure_version: z.string().min(1).optional().describe("Exact disclosure version returned by the bare call."),
        disclosure_hash: z.string().length(64).optional().describe("Exact disclosure hash returned by the bare call."),
        admin_confirm: z.boolean().optional().describe("Separate just-in-time confirmation for a conditional one-shot Linear admin grant."),
        linear_team_id: z.string().min(1).optional()
          .describe("Resume-only protocol field: exact existing Linear team offered after a workspace team-limit block."),
        linear_team_confirm: z.boolean().optional()
          .describe("Resume-only explicit confirmation that Teami may configure the selected existing Linear team."),
        repair_admin_revocation: z.boolean().optional().describe("Returns fail-closed recovery guidance for an interrupted one-shot admin flow. Teami cannot clear a lost-token marker by revoking a fresh token."),
        github_repo: z.string().min(1).optional().describe("Private Teami workspace-repository name override."),
        github_owner: z.string().min(1).optional().describe("Private Teami workspace-repository owner/org override."),
        github_dry_run: z.boolean().optional().describe("Record the GitHub setup intent without real GitHub writes."),
      },
    },
    initOnboardingToolCallback(server, actions.init_onboarding),
  );
  server.registerTool(
    "check_team_context",
    {
      title: "Check Team and approved planning context",
      description: "Read-only. Identify which Teami Team applies and return its Linear workspace, Team, and approved repositories. Does not create, edit, or grant access.",
      inputSchema: {
        team: teamField.describe("Optional local Team reference (team_ref) when multiple active Teams exist."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    toolCallback(actions.check_team_context),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create Linear planning project",
      description: "Create a bare Linear project in Backlog for the resolved Teami Team.",
      inputSchema: {
        team: teamField.describe("Optional local Team reference (team_ref) when multiple active Teams exist."),
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
        team: teamField.describe("Optional local Team reference (team_ref) when multiple active Teams exist."),
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
        team: teamField.describe("Optional local Team reference (team_ref) when multiple active Teams exist."),
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
