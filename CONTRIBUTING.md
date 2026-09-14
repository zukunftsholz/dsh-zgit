# Contributing

Issues and pull requests are welcome. Before opening a change:

1. Use Node.js 20.15 or newer. Bash is preferred for the full build
   (`scripts/build.sh`, which locates a DSH checkout via `DSH_CHECKOUT` or
   common paths and creates the dev junctions the project resolves peers
   from); `npm run build` auto-finds Git Bash on Windows and falls back to a
   plain local tsc build when no bash exists.
2. Run `npm run check` (typecheck + build) and `npm test`.
3. `lib/` is committed. Consumers install from a Git tag or a tarball without
   running a build step, so the compiled output travels with `src/`. Run
   `npm run build` and include the regenerated `lib/` in the same commit as any
   change under `src/`, or the two drift apart.
4. Tests resolve `@deepseek-ai/*` against the installed DSH profile
   (`$DSH_HOME/profiles/node_modules`) when it carries the full peer set the
   suite imports, falling back to the project's own `node_modules` otherwise.

Please keep changes focused and describe the DSH version used for testing.
