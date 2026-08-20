# Contributing

Issues and pull requests are welcome. Before opening a change:

1. Use Node.js 20.15 or newer. Bash is preferred for the full build
   (`scripts/build.sh`, which locates a DSH checkout via `DSH_CHECKOUT` or
   common paths and creates the dev junctions the project resolves peers
   from); `npm run build` auto-finds Git Bash on Windows and falls back to a
   plain local tsc build when no bash exists.
2. Run `npm run check` (typecheck + build) and `npm test`.
3. Tests resolve `@deepseek-ai/*` against the installed DSH profile
   (`$DSH_HOME/profiles/node_modules`) when present, falling back to the
   project's own `node_modules`.

Please keep changes focused and describe the DSH version used for testing.
