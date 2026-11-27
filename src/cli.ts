#!/usr/bin/env node
import { integer, sessionPath } from "./config.js";
import { VERSION } from "./version.js";
import { parseArgs } from "node:util";
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MidjoClient, errorDetails, jsonResponse } from "./http.js";
import { login } from "./login.js";
import { logout } from "./session.js";
import { OperationCatalog, executionSchema, execute } from "./operations.js";

async function readInput(path: string): Promise<string> {
  if (path !== "-") {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("JSON input must be a regular file up to 2 MiB");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("JSON input exceeds 2 MiB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

enum Command { LOGIN = "login", STATUS = "status", LOGOUT = "logout", OPERATIONS = "operations", SCHEMA = "schema", EXECUTE = "execute", API = "api", COMPANIES = "companies", MCP = "mcp", HELP = "help" }
enum CompanyCommand { LIST = "list", GET = "get" }
const help = `Midjo CLI — authenticate once, supply company targets per command.

Connection:
  midjoctl login --api-url HTTPS_ORIGIN [--profile local|preprod] [--no-browser]
  midjoctl status [--profile NAME]
  midjoctl logout [--profile NAME]

Companies:
  midjoctl companies list [--query TEXT] [--page 0] [--limit 20]
  midjoctl companies get opr_COMPANY_ID

Business API:
  midjoctl operations [keywords] [--offset 0] [--limit 25]
  midjoctl schema OPERATION_ID
  midjoctl api METHOD /api/RESOURCE_PATH [--input request.json|-] [--dry-run]
  midjoctl execute OPERATION_ID [--input request.json|-] [--dry-run]
  midjoctl api METHOD /api/RESOURCE_PATH --input request.json --output download.bin
  midjoctl execute OPERATION_ID --body-file upload.bin --content-type TYPE
  midjoctl mcp [--profile NAME]
  midjoctl --version

Examples:
  midjoctl login --profile preprod --api-url https://preprod.api.midjo.lookandtry.com
  midjoctl companies list --profile preprod --query Cotonou
  midjoctl api GET /api/admin/operators/opr_COMPANY_ID --profile preprod

All authenticated commands accept --profile NAME. Profiles save connection/account
credentials only; company and business context are never memorized.
Input JSON: {"path":{},"query":{},"headers":{},"body":{}}. With api, path values
come from the URL. Use schema to inspect required parameters and enum values.
--dry-run prepares without submitting the business request. Writes are never retried.
--output creates a new private file; existing files are never overwritten.
MIDJOCTL_API_URL supplies the login API origin; MIDJOCTL_PROFILE selects a connection.
MIDJOCTL_SESSION_FILE selects an explicit private session file instead of a profile.
JSON goes to stdout; diagnostics and browser login URLs go to stderr.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { profile: { type: "string" }, query: { type: "string" }, page: { type: "string" }, "api-url": { type: "string" }, issuer: { type: "string" }, "no-browser": { type: "boolean" }, input: { type: "string" },
      "dry-run": { type: "boolean" }, output: { type: "string" }, "body-file": { type: "string" },
      "content-type": { type: "string" }, offset: { type: "string" }, limit: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
  });
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  const [command, ...args] = positionals;
  if (values.profile !== undefined) {
    if (process.env.MIDJOCTL_SESSION_FILE) throw new Error("Use --profile or MIDJOCTL_SESSION_FILE, not both");
    process.env.MIDJOCTL_PROFILE = values.profile;
  }
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const client = new MidjoClient();
  if (values.help || !command || command === Command.HELP) { process.stdout.write(help); return; }
  if (!Object.values(Command).includes(command as Command)) throw new Error(`Unknown command ${command}; use midjoctl --help`);
  if (![Command.OPERATIONS, Command.SCHEMA, Command.EXECUTE, Command.API, Command.COMPANIES].includes(command as Command) && args.length) throw new Error("Unexpected positional arguments");
  const allowedOptions: Record<Command, string[]> = {
    [Command.LOGIN]: ["api-url", "issuer", "no-browser"], [Command.STATUS]: [], [Command.LOGOUT]: [],
    [Command.OPERATIONS]: ["offset", "limit"], [Command.SCHEMA]: [],
    [Command.EXECUTE]: ["input", "dry-run", "output", "body-file", "content-type"],
    [Command.API]: ["input", "dry-run", "output", "body-file", "content-type"],
    [Command.COMPANIES]: ["query", "page", "limit"], [Command.MCP]: [], [Command.HELP]: [],
  };
  for (const option of Object.keys(values)) {
    if (option !== "profile" && !allowedOptions[command as Command].includes(option)) throw new Error(`--${option} is not valid for ${command}`);
  }
  sessionPath(); // Validate connection selection before any network request.
  if (command === Command.SCHEMA || command === Command.EXECUTE) {
    if (args.length !== 1) throw new Error("Specify one operation ID; use midjoctl operations");
  }
  if (command === Command.API && args.length !== 2) throw new Error("Use api METHOD /api/RESOURCE_PATH");
  if (command === Command.COMPANIES) {
    if (args[0] === CompanyCommand.LIST && args.length === 1) {
      integer(values.page ?? "0", "Page", 0, 2_147_483_647);
      integer(values.limit ?? "20", "Limit", 1, 100);
    } else if (args[0] === CompanyCommand.GET && args.length === 2) {
      if (values.query !== undefined || values.page !== undefined || values.limit !== undefined) throw new Error("companies get accepts only a company ID and --profile");
    } else throw new Error("Use companies list or companies get opr_COMPANY_ID");
  }
  switch (command) {
    case Command.LOGIN: {
      const origin = values["api-url"] ?? process.env.MIDJOCTL_API_URL;
      if (!origin) throw new Error("Specify --api-url or MIDJOCTL_API_URL");
      const issuer = values.issuer ?? process.env.MIDJOCTL_ISSUER;
      print(await login({ apiUrl: origin, ...(issuer ? { issuer } : {}), ...(values["no-browser"] ? { noBrowser: true } : {}) })); return;
    }
    case Command.MCP: {
      const { startMcp } = await import("./mcp.js"); startMcp(); return;
    }
    case Command.STATUS: {
      const session = await client.session();
      print({ apiUrl: session.apiUrl, issuer: session.issuer, accessTokenExpiresAt: session.accessTokenExpiresAt, account: await client.json("/api/passengers/me") }); return;
    }
    case Command.LOGOUT: {
      await logout(); print({ loggedOut: true }); return;
    }
  }
  const catalog = await OperationCatalog.load(client);
  if (command === Command.OPERATIONS) { print(catalog.search(args.join(" "), Number(values.offset ?? 0), Number(values.limit ?? 25))); return; }
  if (command === Command.COMPANIES) {
    const [action, id] = args;
    if (action === CompanyCommand.LIST && args.length === 1) {
      const operation = catalog.forRoute("POST", "/api/admin/operators:search");
      print(await execute(client, catalog, { operationId: operation.operationId, body: {
        filter: { query: values.query ?? "" }, sort: [], page: {
          number: integer(values.page ?? "0", "Page", 0, 2_147_483_647),
          size: integer(values.limit ?? "20", "Limit", 1, 100),
        },
      } })); return;
    }
    if (action === CompanyCommand.GET && id && args.length === 2) {
      if (values.query || values.page || values.limit) throw new Error("companies get accepts only a company ID and --profile");
      print(await execute(client, catalog, catalog.forRequest("GET", `/api/admin/operators/${encodeURIComponent(id)}`))); return;
    }
    throw new Error("Use companies list or companies get opr_COMPANY_ID");
  }
  if (command === Command.SCHEMA) {
    if (args.length !== 1) throw new Error("Specify one operation ID; use midjoctl operations");
    print(catalog.schema(args[0]!)); return;
  }
  const target = command === Command.API ? (() => {
    if (args.length !== 2) throw new Error("Use api METHOD /api/RESOURCE_PATH");
    return catalog.forRequest(args[0]!, args[1]!);
  })() : (() => {
    if (args.length !== 1) throw new Error("Specify one operation ID; use midjoctl operations");
    return { operationId: args[0]! };
  })();
  let raw: unknown = {};
  if (values.input) {
    const text = await readInput(values.input);
    try { raw = JSON.parse(text); }
    catch { throw new Error("Input must be valid JSON; use schema to inspect the operation contract"); }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || "operationId" in raw) throw new Error("Input must be an object without operationId");
  if (command === Command.API && "path" in raw) throw new Error("api path values come from its URL; remove input.path or use execute");
  const input = executionSchema.parse({ ...raw, ...target });
  if (values["body-file"]) {
    if (input.body !== undefined || input.rawBodyBase64 !== undefined || input.multipart !== undefined) throw new Error("--body-file cannot be combined with an input body");
    const handle = await open(values["body-file"], "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Body file must be a regular file up to 64 MiB");
      input.rawBodyBase64 = (await handle.readFile()).toString("base64");
    } finally { await handle.close(); }
  }
  if (values["content-type"]) input.contentType = values["content-type"];
  const prepared = catalog.prepare(input);
  if (values["dry-run"]) {
    const session = await client.session();
    print({ apiUrl: session.apiUrl, ...prepared,
      ...(prepared.body instanceof FormData ? { body: { multipart: true, fields: [...prepared.body.keys()] } } : prepared.body instanceof Uint8Array ? { body: { bytes: prepared.body.byteLength } } : {}) }); return;
  }
  if (!values.output) { print(await execute(client, catalog, input)); return; }
  const file = await open(values.output, "wx", 0o600);
  let status: number;
  let contentType: string | null;
  try {
    const response = await client.request(prepared.path, { method: prepared.method, headers: prepared.headers,
      ...(prepared.body === undefined ? {} : { body: prepared.body as BodyInit }) });
    if (!response.ok) await jsonResponse(response);
    status = response.status;
    contentType = response.headers.get("content-type");
    if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), file.createWriteStream({ autoClose: false }));
    await file.sync();
  } catch (error) { await rm(values.output, { force: true }); throw error; }
  finally { await file.close(); }
  print({ status, output: values.output, contentType });
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify(errorDetails(error))}\n`);
  process.exitCode = 1;
});
