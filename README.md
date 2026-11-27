# Midjo CLI

`midjoctl` connects to Midjo through Identity and calls the existing passenger,
company, Agent and platform APIs. The backend checks current permissions for each
action and target company. The CLI never saves a selected company or business context.

## Install

```sh
mise use -g github:mathias8dev/midjo-ctl@0.1.0
midjoctl --version
```

Native releases include Node and the stdio MCP server on Linux, macOS and Windows,
for x64 and arm64. A Node installation or source checkout is unnecessary.
Release archives include their runtime/dependency notices and build provenance.
The POSIX and PowerShell installers verify published checksums before installing.

## Connect

Keep local and preproduction connections separate with named profiles:

```sh
midjoctl login --profile local --api-url https://api.midjo.lookandtry.local
midjoctl login --profile preprod --api-url https://preprod.api.midjo.lookandtry.com
midjoctl status --profile preprod
midjoctl logout --profile preprod
```

Login opens the existing Identity sign-in page with Authorization Code and S256
PKCE. Enter credentials only on that page. `--no-browser` prints the URL instead.
The dedicated public `midjoctl` client and Midjo resource must first be registered
in that environment; the API must have its own Identity introspection credentials.

A profile stores the instance, exact issuer, resource, account and rotating OAuth
grant in a private file under `~/.config/lookandtry/midjoctl/NAME.json` (or
`$XDG_CONFIG_HOME`). It stores no company, application selection, roles or grants.
Without `--profile`, commands use the default connection. `MIDJOCTL_PROFILE` can
select a profile; `MIDJOCTL_SESSION_FILE` selects a private file explicitly.

## Find a company and act

```sh
midjoctl companies list --profile preprod --query Cotonou --page 0 --limit 20
midjoctl companies get opr_COMPANY_ID --profile preprod
midjoctl api GET /api/admin/operators/opr_COMPANY_ID --profile preprod
```

Replace `opr_COMPANY_ID` with a public ID returned by the API. Discovery uses
Midjo's existing paginated company search. A user can have different permissions
in different companies and also have platform access. Each operation supplies
its target explicitly; there is no implicit first company or context switching.
The company list may show memberships whose current permissions differ or are
restricted by company status. Listing never grants permission to perform an action.

## Discover and call any business operation

```sh
midjoctl operations departures --profile preprod
midjoctl schema OPERATION_ID --profile preprod
midjoctl execute OPERATION_ID --input request.json --dry-run --profile preprod
midjoctl execute OPERATION_ID --input request.json --profile preprod
midjoctl api POST /api/RESOURCE_PATH --input request.json --profile preprod
```

`schema` reads the running server's operation, parameters, enums and referenced
schemas. Input JSON contains `path`, `query`, `headers` and/or `body`. With `api`,
path parameters come from the supplied URL; put query parameters in `query`.
Metadata is discovery, not authorization. The server remains authoritative.
`--dry-run` prepares the request without submitting the business operation.

Use `--body-file FILE --content-type TYPE` for raw uploads. Multipart input uses
`multipart.fields` and `multipart.files` (`name`, `filename`, `contentType`,
`dataBase64`). Use `--output FILE` for binary downloads; existing files are never
overwritten. Normal responses emit JSON with HTTP status and body to stdout;
diagnostics and login URLs go to stderr. Structured API errors produce exit code 1.

Writes and refreshes are never retried automatically after an uncertain outcome.
Reuse an operation's documented idempotency key when reconciling a write. Public
TypeIDs, payment references and signed ticket/departure claim IDs have distinct
meanings. Booking confirmation, late-payment recovery, planning revisions,
inventory and offline validation remain backend workflows.

## MCP

Run `midjoctl mcp --profile preprod` from an MCP host after signing in in a terminal.
The stdio tools share the same connection, operation catalog and executor as the
CLI. Inspect status and the operation schema before acting. A running client
refuses account/instance drift. MCP never accepts credentials or chooses a company.

## Development and delivery

```sh
mise trust
mise run setup
mise run check
mise run package
mise run test:packaged
```

Tests use HTTP/Identity fixtures and the official MCP client, including the native
packaged executable. Live Identity registration and local/preprod login require
separate verification. GitHub Actions builds each OS/architecture on a matching
runner before publishing an immutable versioned release. See [RELEASING.md](RELEASING.md).
