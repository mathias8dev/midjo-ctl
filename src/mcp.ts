import { VERSION } from "./version.js";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { MidjoClient, errorDetails } from "./http.js";
import { OperationCatalog, execute, executionSchema } from "./operations.js";

export function createMcpServer(client = new MidjoClient()): McpServer {
  const server = new McpServer({ name: "midjo", version: VERSION }, {
    instructions: "Act as the signed-in Midjo user. Company targets are explicit operation inputs; discover current companies through the existing APIs. First inspect midjo_status, discover operations with midjo_search_operations and inspect their exact contracts with midjo_operation_schema. Use bounded search/pagination. Booking, ticketing, payment, planning and company changes have real effects. Do not retry a write automatically after an uncertain result. Authentication is interactive outside MCP: run midjoctl login in a terminal.",
  });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const guarded = async (work: () => Promise<unknown>) => {
    try { return result(await work()); }
    catch (error) {
      return { ...result(errorDetails(error)), isError: true };
    }
  };
  server.registerTool("midjo_status", {
    description: "Read current Midjo account and instance. Never returns session tokens.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => guarded(async () => {
    const session = await client.session();
    return { apiUrl: session.apiUrl, issuer: session.issuer, accessTokenExpiresAt: session.accessTokenExpiresAt, account: await client.json("/api/passengers/me") };
  }));
  server.registerTool("midjo_search_operations", {
    description: "Discover current business operations by keywords in their names, routes and descriptions. Returns a bounded page; use offset to continue.",
    inputSchema: z.object({ query: z.string().default(""), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) }).strict(),
    annotations: { readOnlyHint: true },
  }, async ({ query, offset, limit }) => guarded(async () => (await OperationCatalog.load(client)).search(query, offset, limit)));
  server.registerTool("midjo_operation_schema", {
    description: "Read an operation's method, path/query/header parameters, request/response schemas and referenced enum/component definitions. Inspect before execute.",
    inputSchema: z.object({ operationId: z.string() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ operationId }) => guarded(async () => (await OperationCatalog.load(client)).schema(operationId)));
  server.registerTool("midjo_execute", {
    description: "Execute a discovered business operation as the user. Supply path/query/headers plus JSON body or rawBodyBase64. Enforces current backend permissions and policies. May change bookings, payments, departures or memberships. Returns structured errors as isError; never retries writes. Binary responses are bounded base64; use CLI --output for larger downloads.",
    inputSchema: executionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input, context) => guarded(async () => execute(client, await OperationCatalog.load(client), input, context.mcpReq.signal)));
  return server;
}

export function startMcp(): void {
  serveStdio(() => createMcpServer(), { onerror: error => process.stderr.write(`${error.message}\n`) });
}
