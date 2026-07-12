# Teami Home Path Contract

Authored 2026-07-08 for the power-not-place delivery work.

`execution/integrations/linear/src/app-home.mjs` is the source of truth for where Teami keeps engine state.
It separates Teami-owned state from the product checkout:

- Teami state resolves through `resolveTeamiHome()` and `teamiHomePaths()`.
- Product code and git operations continue to use an explicit checkout/cwd seam.
- Read-only packaged defaults resolve through `resolvePackagedDefault()` from the package root, not from the
  Teami home and not from `process.cwd()`.

The home precedence is:

1. Absolute `TEAMI_HOME` after `~` expansion.
2. macOS: `~/Library/Application Support/teami`.
3. Windows: `%LOCALAPPDATA%\teami`, then `%APPDATA%\teami`, then `~\.teami`.
4. Linux and other POSIX platforms: `$XDG_STATE_HOME/teami`, then `~/.local/state/teami`, then `~/.teami`.

Cross-domain state lives at the home root: `domains.json`, `gateway.lock`, `github-connection.json`,
`behavior-mirror/`, `runtime/`, and `phoenix-data/`. Only per-domain state nests under
`domains/<domainId>/`, and `domainId` must match the registry's `DOMAIN_ID_PATTERN`.
