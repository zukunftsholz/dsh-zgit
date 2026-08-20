#!/bin/bash
# dsh-zgit build entry (dsh-super-injector pipeline shape):
#   1. locate the DSH checkout (DSH_CHECKOUT env or common paths),
#   2. recreate the peer/dev junctions the project resolves against
#      (profile-installed @deepseek-ai packages, checkout @types/vitest/typescript),
#   3. compile host code with the checkout's tsc.
# Usage: bash scripts/build.sh        (auto-probe)
#        DSH_CHECKOUT=<checkout> bash scripts/build.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- 1. locate the DSH checkout ---------------------------------------------
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  for candidate in \
    "C:/GreenApps/DeepSeekHarness-Desktop/harness" \
    "$HOME/GreenApps/DeepSeekHarness-Desktop/harness" \
    "$HOME/dsh/harness" \
    "$HOME/.dsh/harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/packages" ]; then
  echo "build.sh: checkout = $CHECKOUT"

  # --- 2. peer/dev junctions (idempotent; existing junctions are kept) ----------
  # Prefer the installed profile's @deepseek-ai packages (the exact runtime the
  # desktop app resolves peers from), falling back to the CLI app's node_modules.
  PROFILE_MODULES="${DSH_HOME:-$HOME/.dsh}/profiles/node_modules"
  link_dir() {
    node -e '
      const fs = require("fs");
      const path = require("path");
      const link = path.resolve(process.argv[1]);
      const target = path.resolve(process.argv[2]);
      if (fs.existsSync(link)) {
        const st = fs.lstatSync(link);
        if (!st.isSymbolicLink() && !st.isDirectory()) {
          throw new Error("refusing to replace non-directory " + link);
        }
      } else {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      }
    ' "node_modules/$1" "$2"
  }
  if [ -d "$PROFILE_MODULES/@deepseek-ai" ]; then
    link_dir "@deepseek-ai" "$PROFILE_MODULES/@deepseek-ai"
  else
    link_dir "@deepseek-ai" "$CHECKOUT/apps/cli/node_modules/@deepseek-ai"
  fi
  link_dir "@types" "$CHECKOUT/node_modules/@types"
  link_dir "vitest" "$CHECKOUT/node_modules/vitest"
  link_dir "typescript" "$CHECKOUT/node_modules/typescript"

  # --- 3. compile host code ------------------------------------------------------
  node "$CHECKOUT/node_modules/typescript/bin/tsc" -p tsconfig.build.json
else
  # No DSH checkout: fall back to a plain npm install (CI, fresh clone), where
  # typescript lives in node_modules via devDependencies.
  if [ ! -f "node_modules/typescript/bin/tsc" ]; then
    echo "build.sh: no DSH checkout found — set DSH_CHECKOUT=<checkout> or run 'npm ci' first" >&2
    exit 1
  fi
  echo "build.sh: no DSH checkout — using node_modules typescript"
  node "node_modules/typescript/bin/tsc" -p tsconfig.build.json
fi
echo "build.sh: lib/ written"
