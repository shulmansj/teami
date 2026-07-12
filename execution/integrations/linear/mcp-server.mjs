import { runTeamiProjectMcpStdioServer } from "./src/project-mcp-server.mjs";
import { sanitizeProjectMcpError } from "./src/project-mcp-tools.mjs";

try {
  await runTeamiProjectMcpStdioServer();
} catch (error) {
  const sanitized = sanitizeProjectMcpError(error);
  process.stderr.write(`${JSON.stringify(sanitized)}\n`);
  process.exitCode = 1;
}
