const USER_ID = 'mju_01j0000000e008000000000001';
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, chmod, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliCommand, cliPrefix } from "./cli-helper.mjs";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { saveSession, loadSession, apiOrigin } from "../dist/session.js";
import { MidjoClient } from "../dist/http.js";
import { OperationCatalog, execute } from "../dist/operations.js";

const run = promisify(execFile);

const token = "access.fixture.token";
const refreshToken = "r".repeat(43);
const spec = {
  openapi: "3.1.0", paths: {
    "/api/admin/operators:search": {
      post: { operationId: "searchCompanies", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: {} },
    },
    "/api/admin/operators/{id}": {
      get: { operationId: "getCompany", parameters: [{ in: "path", name: "id", required: true }], responses: {} },
    },
    "/api/admin/projects": {
      get: { operationId: "listProjects", responses: { 200: { description: "Projects" } } },
      post: { operationId: "createProject", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProject" } } } } },
    },
    "/api/admin/projects/{projectId}": {
      get: { operationId: "getProject", parameters: [{ in: "path", name: "projectId", required: true }], responses: {} },
      patch: { operationId: "updateProject", parameters: [{ in: "path", name: "projectId", required: true }], responses: {} },
    },
    "/api/admin/environments/{environmentId}/profiles:search": {
      post: { operationId: "searchProfiles", parameters: [{ in: "path", name: "environmentId", required: true }, { in: "query", name: "page", required: true }, { in: "query", name: "tags" }], responses: {} },
    },
    "/api/passengers/uploads/{assetId}": { put: { operationId: "upload", parameters: [{ in: "path", name: "assetId", required: true }, { in: "header", name: "X-Midjo-Media-Upload-Token", required: true }], responses: {} } },
    "/api/admin/projects/current": { get: { operationId: "currentProject", responses: {} } },
    "/api/admin/projects/{projectId}:publish": { post: { operationId: "publishProject", parameters: [{ in: "path", name: "projectId", required: true }], responses: {} } },
    "/api/admin/upload": { post: { operationId: "multipartUpload", requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object" } } } }, responses: {} } },
    "/api/admin/sessions": { post: { operationId: "hostedSession", responses: {} } },
    "/api/admin/download": { get: { operationId: "download", responses: {} } },
    "/api/auth/native/exchange": { post: { operationId: "forbiddenExchange", responses: {} } },
    "/api/v1/send": { post: { operationId: "serverSend", responses: {} } },
  }, components: { schemas: { CreateProject: { type: "object", required: ["name"], properties: { name: { type: "string" }, status: { $ref: "#/components/schemas/Status" } } }, Status: { type: "string", enum: ["ACTIVE", "ARCHIVED"] } } },
};

async function fixture(t, { failProfile = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "midjoctl-test-"));
  await chmod(dir, 0o700);
  const path = join(dir, "session.json");
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/auth/native/config") {
      response.end(JSON.stringify({ issuer: origin, clientId: "midjoctl", scopes: ["openid", "email", "offline_access", "midjo.api"] })); return;
    }
    if (request.url === "/oauth2/token") {
      const form = new URLSearchParams(body.toString());
      assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), expectedChallenge);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("client_id"), "midjoctl");
      assert.equal(form.get("client_secret"), null);
      response.end(JSON.stringify({ access_token: token, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600,
        scope: "openid email offline_access midjo.api" })); return;
    }
    if (request.url === "/oauth2/revoke") {
      assert.equal(new URLSearchParams(body.toString()).get("token"), refreshToken);
      response.statusCode = 200; response.end(); return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) { response.statusCode = 401; response.end('{"code":"authentication_required"}'); return; }
    assert.equal(request.headers.cookie, undefined);
    if (request.url === "/api/passengers/me") {
      if (failProfile) { response.statusCode = 403; response.end('{"code":"account_not_ready"}'); return; }
      response.end(JSON.stringify({ midjoUserId: USER_ID, email: "user@example.com" })); return;
    }
    assert.equal(request.headers["x-midjo-workspace"], undefined);
    assert.equal(request.headers["x-midjo-application"], undefined);
    if (request.url === "/api/auth/native/openapi") { response.end(JSON.stringify(spec)); return; }
    if (request.url === "/api/passengers/me") { response.end('{"id":"user-a","email":"user@example.com"}'); return; }
    if (request.url === "/api/admin/auth/logout") {
      response.statusCode = 204; response.setHeader("Set-Cookie", "midjo_session=; Max-Age=0"); response.end(); return;
    }
    if (request.url === "/api/admin/download") { response.setHeader("Content-Type", "application/octet-stream"); response.end(Buffer.from([0, 1, 2, 255])); return; }
    if (request.url === "/api/admin/projects/denied") { response.statusCode = 403; response.end('{"code":"permission_denied","message":"Denied"}'); return; }
    if (request.url === "/api/admin/projects/redirect") { response.statusCode = 302; response.setHeader("Location", "/api/passengers/me"); response.end(); return; }
    if (request.url === "/api/admin/operators:search") {
      response.end(JSON.stringify({ content: [{ id: "opr_company_a", permissions: ["fleet:manage"] }, { id: "opr_company_b", permissions: ["fleet:read"] }], page: JSON.parse(body).page })); return;
    }
    if (request.url === "/api/admin/projects" && request.method === "POST") { response.statusCode = 201; response.end(body); return; }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  let expectedChallenge;
  let expectedNonce;
  const session = { schemaVersion: 1, issuer: origin, apiUrl: origin, resource: origin, clientId: "midjoctl", accessToken: token, refreshToken, accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600, scopes: "openid email offline_access midjo.api", userId: USER_ID, email: "user@example.com" };
  await saveSession(session, path);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, MIDJOCTL_SESSION_FILE: path, MIDJOCTL_API_URL: origin };
  return { dir, path, calls, origin, session, env, client: new MidjoClient(path), challenge: (value, nonce) => { expectedChallenge = value; expectedNonce = nonce; } };
}

test("discovers all operation families, resolves enum schemas, validates paths and sends exact scoped requests", async t => {
  const f = await fixture(t);
  const catalog = await OperationCatalog.load(f.client);
  assert.equal(catalog.search("", 0, 2).operations.length, 2);
  assert.equal(catalog.search("", 0, 2).total, 12);
  assert.throws(() => catalog.operation("serverSend"), /Unknown operation/);
  assert.throws(() => catalog.operation("forbiddenExchange"), /Unknown operation/);
  const schema = catalog.schema("createProject");
  assert.deepEqual(schema.components.schemas.Status.enum, ["ACTIVE", "ARCHIVED"]);
  assert.throws(() => catalog.prepare({ operationId: "getProject" }), /Missing path/);
  assert.throws(() => catalog.prepare({ operationId: "getProject", path: { projectId: ".." } }), /Invalid path/);
  assert.throws(() => catalog.prepare({ operationId: "searchProfiles", path: { environmentId: "env" } }), /Required query/);
  assert.throws(() => catalog.prepare({ operationId: "listProjects", headers: { Authorization: "evil" } }), /not an operation/);
  assert.throws(() => catalog.prepare({ operationId: "listProjects", query: { unknown: "value" } }), /Unknown query/);
  const result = await execute(f.client, catalog, { operationId: "createProject", body: { name: "Agent project" } });
  assert.equal(result.status, 201);
  assert.equal(result.body.name, "Agent project");
  assert.equal(f.calls.at(-1).headers["x-midjo-application"], undefined);
  await assert.rejects(execute(f.client, catalog, { operationId: "getProject", path: { projectId: "denied" } }), error => error.status === 403 && error.body.code === "permission_denied");
  await assert.rejects(execute(f.client, catalog, { operationId: "getProject", path: { projectId: "redirect" } }));
  assert.equal(f.calls.filter(call => call.url === "/api/passengers/me").length, 0);
  const binary = await execute(f.client, catalog, { operationId: "download" });
  assert.deepEqual(Buffer.from(binary.bodyBase64, "base64"), Buffer.from([0, 1, 2, 255]));
  await execute(f.client, catalog, { operationId: "upload", path: { assetId: "asset" },
    headers: { "X-Midjo-Media-Upload-Token": "capability" }, contentType: "image/png", rawBodyBase64: "AAEC/w==" });
  assert.equal(f.calls.at(-1).headers["content-type"], "image/png");
  assert.equal(f.calls.at(-1).headers["x-midjo-media-upload-token"], "capability");
  assert.deepEqual(f.calls.at(-1).body, Buffer.from([0, 1, 2, 255]));
});

test("CLI dry-run performs no write, downloads bytes, preserves API failures and revokes logout", async t => {
  const f = await fixture(t);
  const input = join(f.dir, "request.json");
  await import("node:fs/promises").then(fs => fs.writeFile(input, JSON.stringify({ body: { name: "Draft" } })));
  const dry = await run(cliCommand, [...cliPrefix, "execute", "createProject", "--input", input, "--dry-run"], { env: f.env });
  assert.equal(JSON.parse(dry.stdout).apiUrl, f.origin);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  const output = join(f.dir, "download.bin");
  await run(cliCommand, [...cliPrefix, "execute", "download", "--output", output], { env: f.env });
  assert.deepEqual(await readFile(output), Buffer.from([0, 1, 2, 255]));
  if (process.platform !== "win32") assert.equal((await lstat(output)).mode & 0o777, 0o600);
  await assert.rejects(run(cliCommand, [...cliPrefix, "execute", "download", "--output", output], { env: f.env }));
  await run(cliCommand, [...cliPrefix, "logout"], { env: f.env });
  await assert.rejects(readFile(f.path), /ENOENT/);
  assert.equal(f.calls.at(-1).url, "/oauth2/revoke");
});

test("session storage is private, refuses symlinks and rejects untrusted API origins", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  await assert.rejects(saveSession({ ...f.session, accessToken: "x".repeat(43) }, f.path), /EEXIST/);
  assert.equal((await loadSession(f.path)).accessToken, token);
  await chmod(f.path, 0o644);
  await assert.rejects(loadSession(f.path), /private/);
  await chmod(f.path, 0o600);
  const link = join(f.dir, "link.json");
  await symlink(f.path, link);
  await assert.rejects(loadSession(link));
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com/api", "https://example.com?token=x"]) assert.throws(() => apiOrigin(url));
});

test("a running client refuses a changed account or instance before sending a request", async t => {
  const f = await fixture(t);
  await f.client.session();
  await saveSession({ ...f.session, userId: "another-user" }, f.path, true);
  await assert.rejects(f.client.json("/api/admin/projects"), /issuer or instance changed/);
  assert.equal(f.calls.length, 0);
});

test("browser PKCE login validates callback state and stores only a private session", async t => {
  const f = await fixture(t);
  await rm(f.path);
  const child = spawn(cliCommand, [...cliPrefix, "login", "--api-url", f.origin, "--issuer", f.origin, "--no-browser"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const authorization = await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk;
      const url = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize\?[^\s]+/);
      if (url) resolve(new URL(url[0]));
    });
    child.on("exit", code => reject(new Error(`Login exited before authorization: ${code}: ${stderr}`)));
  });
  assert.equal(authorization.searchParams.get("client_id"), "midjoctl");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("max_age"), "0");
  assert.match(authorization.searchParams.get("nonce"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorization.searchParams.get("scope"), "openid email offline_access midjo.api");
  assert.equal(authorization.searchParams.get("resource"), f.origin);
  f.challenge(authorization.searchParams.get("code_challenge"), authorization.searchParams.get("nonce"));
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({ state: "wrong", code: "c".repeat(43) });
  assert.equal((await fetch(callback)).status, 400);
  callback.search = new URLSearchParams({ state: "é".repeat(43), code: "c".repeat(43) });
  assert.equal((await fetch(callback)).status, 400);
  callback.search = new URLSearchParams({ state: authorization.searchParams.get("state"), code: "c".repeat(43), iss: "https://wrong-issuer.example" });
  assert.equal((await fetch(callback)).status, 400);
  callback.search = new URLSearchParams({ state: authorization.searchParams.get("state"), code: "c".repeat(43), iss: f.origin });
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(await new Promise(resolve => child.on("exit", resolve)), 0);
  assert.equal((await loadSession(f.path)).userId, USER_ID);
  assert.equal(stdout.includes(token), false);
  assert.equal(JSON.parse(stdout).email, "user@example.com");
});

test("failed account admission preserves the rotating grant for logout without any company selection", async t => {
  const f = await fixture(t, { failProfile: true });
  await rm(f.path);
  const child = spawn(cliCommand, [...cliPrefix, "login", "--api-url", f.origin, "--no-browser"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const exited = new Promise(resolve => child.on("exit", resolve));
  const authorization = await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk;
      const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize\?[^\s]+/);
      if (match) resolve(new URL(match[0]));
    });
    child.on("exit", code => reject(new Error(`Login exited early: ${code}`)));
  });
  f.challenge(authorization.searchParams.get("code_challenge"), authorization.searchParams.get("nonce"));
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({ state: authorization.searchParams.get("state"), iss: f.origin, code: "c".repeat(43) });
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(await exited, 1);
  const pending = await loadSession(f.path);
  assert.equal(pending.userId, null);
  assert.equal(pending.refreshToken, refreshToken);
  assert.equal("workspaceId" in pending, false);
  await run(cliCommand, [...cliPrefix, "logout"], { env: f.env });
  await assert.rejects(readFile(f.path), /ENOENT/);
});

test("official MCP client discovers and invokes stdio tools with explicit permission errors", async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: cliCommand, args: [...cliPrefix, "mcp"], env: f.env, stderr: "pipe" });
  const client = new Client({ name: "midjo-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 4);
  const write = tools.tools.find(tool => tool.name === "midjo_execute");
  assert.equal(write.annotations.destructiveHint, true);
  const status = await client.callTool({ name: "midjo_status", arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).apiUrl, f.origin);
  assert.equal(JSON.stringify(status).includes(token), false);
  const denied = await client.callTool({ name: "midjo_execute", arguments: { operationId: "getProject", path: { projectId: "denied" } } });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).error.code, "permission_denied");
});


test("company commands use bounded discovery and explicit targets without saving business context", async t => {
  const f = await fixture(t);
  const listed = await run(cliCommand, [...cliPrefix, "companies", "list", "--query", "Company", "--page", "2", "--limit", "10"], { env: f.env });
  assert.equal(JSON.parse(listed.stdout).body.content.length, 2);
  assert.deepEqual(JSON.parse(f.calls.at(-1).body).page, { number: 2, size: 10 });
  assert.deepEqual(JSON.parse(f.calls.at(-1).body).filter, { query: "Company" });
  await run(cliCommand, [...cliPrefix, "companies", "get", "opr_company_b"], { env: f.env });
  assert.equal(f.calls.at(-1).url, "/api/admin/operators/opr_company_b");
  const state = await loadSession(f.path);
  for (const field of ["companyId", "operatorId", "context", "workspaceId", "permissions"]) assert.equal(field in state, false);
  await assert.rejects(run(cliCommand, [...cliPrefix, "companies", "list", "--limit", "101"], { env: f.env }));
});

test("direct API UX resolves literal routes and explicit company IDs through the same contract", async t => {
  const f = await fixture(t);
  const catalog = await OperationCatalog.load(f.client);
  assert.deepEqual(catalog.forRequest("GET", "/api/admin/operators/opr_company_a"), { operationId: "getCompany", path: { id: "opr_company_a" } });
  await run(cliCommand, [...cliPrefix, "api", "GET", "/api/admin/operators/opr_company_b"], { env: f.env });
  assert.equal(f.calls.at(-1).url, "/api/admin/operators/opr_company_b");
  const input = join(f.dir, "company-request.json");
  await writeFile(input, JSON.stringify({ body: { name: "Company" } }));
  const count = f.calls.filter(call => call.method === "POST").length;
  await run(cliCommand, [...cliPrefix, "api", "POST", "/api/admin/projects", "--input", input, "--dry-run"], { env: f.env });
  assert.equal(f.calls.filter(call => call.method === "POST").length, count);
  for (const path of ["//foreign.example/api/admin/operators/opr_a", "/api/admin/operators/opr_a?token=secret", "/api/admin/sessions", "/api/internal/private"]) {
    assert.throws(() => catalog.forRequest("GET", path));
  }
});


test("named connection profiles isolate local and preprod without retaining a company", async t => {
  const local = await fixture(t);
  const preprod = await fixture(t);
  const profileDirectory = join(local.dir, "lookandtry", "midjoctl");
  await saveSession(local.session, join(profileDirectory, "local.json"));
  await saveSession(preprod.session, join(profileDirectory, "preprod.json"));
  const env = { ...local.env, XDG_CONFIG_HOME: local.dir };
  delete env.MIDJOCTL_SESSION_FILE; delete env.MIDJOCTL_API_URL;
  for (const [profile, origin] of [["local", local.origin], ["preprod", preprod.origin]]) {
    const status = await run(cliCommand, [...cliPrefix, "status", "--profile", profile], { env });
    assert.equal(JSON.parse(status.stdout).apiUrl, origin);
  }
  await assert.rejects(run(cliCommand, [...cliPrefix, "status", "--profile", "../escape"], { env }), error => /Profile names/.test(error.stderr));
});


test("route resolution respects literals and action suffixes while multipart uses a generated boundary", async t => {
  const f = await fixture(t);
  const catalog = await OperationCatalog.load(f.client);
  assert.deepEqual(catalog.forRequest("GET", "/api/admin/projects/current"), { operationId: "currentProject", path: {} });
  assert.deepEqual(catalog.forRequest("POST", "/api/admin/projects/p1:publish"), { operationId: "publishProject", path: { projectId: "p1" } });
  assert.throws(() => catalog.operation("hostedSession"), /Unknown operation/);
  const input = { operationId: "multipartUpload", multipart: { fields: { label: "Evidence" }, files: [{ name: "image", filename: "sample.bin", contentType: "application/octet-stream", dataBase64: Buffer.from([0, 1, 2, 255]).toString("base64") }] } };
  await execute(f.client, catalog, input);
  assert.match(f.calls.at(-1).headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(f.calls.at(-1).body.toString(), /name="image"; filename="sample.bin"/);
  assert.throws(() => catalog.prepare({ ...input, body: {} }), /Choose body/);
  assert.throws(() => catalog.prepare({ ...input, contentType: "multipart/form-data" }), /generated automatically/);
});


test("missing and invalid command arguments explain the correction before authentication", async t => {
  const f = await fixture(t);
  await rm(f.path);
  for (const [args, message] of [
    [["api", "GET"], /Use api METHOD/], [["schema"], /Specify one operation/],
    [["companies", "list", "--limit", "101"], /Limit must be/],
    [["companies", "get"], /Use companies list/], [["status"], /No saved connection/],
  ]) {
    await assert.rejects(run(cliCommand, [...cliPrefix, ...args], { env: f.env }), error => message.test(error.stderr));
  }
  assert.equal(f.calls.length, 0);
});
