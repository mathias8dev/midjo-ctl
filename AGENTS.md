# Midjo CLI

Use the mathias-engineering skill. This maintained public repository contains only
the Midjo operator client and its stdio MCP transport. Never copy backend sources,
Git history, real environment files, credentials or sessions here.

- Follow existing lookctl, identityctl and engagectl conventions where semantics
  match. One API client and OpenAPI executor serve human commands and MCP.
- Use hosted Identity Authorization Code with S256 PKCE and the public midjoctl
  registration. Never collect passwords or reuse a web client's secret/session.
- Save only connection/OAuth/account facts. Do not persist a company, application
  context, role or permission cache. Company targets are explicit command inputs.
  Reuse the backend's company discovery and current authorization checks.
- Pin private sessions to instance, issuer, resource, public client and account.
  Serialize rotation/logout, persist each rotating grant before API use, retain
  failed-revocation recovery, preserve system/extra CAs and reject redirects.
- Do not retry uncertain writes or refreshes. Propagate structured API failures.
  Model finite vocabularies as enums and keep bounded discovery/input/output.
- Ship native Linux/macOS/Windows x64/arm64 binaries with the pinned Node runtime,
  bundled MCP and required third-party notices. Do not publish to npm.
- Run pnpm check, pnpm package and pnpm test:packaged. Fixture tests do not prove
  deployed Identity registration/login; qualify local/preprod independently.
- Use develop for integration and master for stable delivery. Version comes from
  package.json. Publish immutable matching vX.Y.Z tags only after all native
  artifacts pass. Never overwrite a published version.
- Commit, push, publish and deployment require user authorization. Inspect the
  full public inventory and staged diff; use descriptive Conventional Commits.
