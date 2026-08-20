# Changelog

All notable changes to this project are documented in this file.

## [0.1.1] - 2026-08-19

### Fixed

- zgit_* tools and the `/zgit` command now write into the **calling session's
  workspace** (`exec.agent.session.header.cwd`) instead of the DSH host
  process's `process.cwd()` (the server launch dir). Downloads, clones, raw
  saves, and release assets land in the agent's project folder; agentless
  callers still fall back to the configured `workspaceRoot`.
- `zgit_status` resolves checkouts against the same per-call workspace, so a
  clone made by one session is found by that session's own status checks.

### Changed

- `CallOptions` gains a `workspaceRoot` override; `/zgit` threads the calling
  agent's session cwd through the same path.
- Default User-Agent bumped to `dsh-zgit/0.1.1`.

## [0.1.0] - 2026-08-15

### Added

- Simulated git over plain HTTPS: `zgit_clone` (source archives with
  `.zerogit` metadata, sparse `subdir` extraction, explicit archive URLs),
  `zgit_fetch_release` (release assets with sha256 verification),
  `zgit_show`, `zgit_ls_tree`, `zgit_log`, `zgit_diff`, `zgit_status`,
  `zgit_ls_remote`, `zgit_download`.
- `/zgit` human command for the command plane.
- Archive hardening: path-traversal rejection, entry/byte caps, gzip bomb
  guard, CRC32 for zip, symlink skip + hardlink copy.
- Zero runtime dependencies (Node built-ins only).
