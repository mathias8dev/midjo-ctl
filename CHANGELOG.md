# Changelog

## [Unreleased]

## [0.1.3] - 2026-11-27

### Fixed

- Allow 120 seconds for cold OpenAPI generation while retaining current server contracts, 60-second ordinary API deadlines and explicit cancellation.

## [0.1.2] - 2026-11-27

### Fixed

- Allow explicit manual publication of an existing stable tag when its push event does not start a workflow, retaining all native verification and immutable-artifact checks.

## [0.1.1] - 2026-11-27

### Fixed

- Initialize the native release workflow on the default branch while retaining verification on all six targets before publication.

## [0.1.0] - 2026-11-27

### Added

- Native Midjo CLI and stdio MCP with hosted Identity PKCE login and private named connections.
- Existing API discovery/execution, company search, explicit company inputs and structured failures.
- Rotating-grant recovery, TLS trust, bounded uploads/downloads and native release verification.
