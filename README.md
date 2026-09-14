# dsh-zgit

English | [中文](./README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-zgit.svg)](https://www.npmjs.com/package/dsh-zgit)
[![license](https://img.shields.io/npm/l/dsh-zgit.svg)](./LICENSE)

> [!TIP]
> **第一个《世界计划》本地化知识库，为同人作者和考据党而生：[SekaiSync](https://github.com/omoinoki/sekaisync)**  
> **The first *Project SEKAI* localization knowledge base, built for fan creators and lore enthusiasts: [SekaiSync](https://github.com/omoinoki/sekaisync)**
>
> 即将面向 DeepSeek Harness 插件生态针对性适配，欢迎各位豆腐人 Star 和共建。  
> Targeted adaptation for the DeepSeek Harness plugin ecosystem is coming soon. Fellow Tofus are welcome to star and contribute!

**dsh-zgit** (the `/zgit` plugin) is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin for when the first thought about fetching source code or binary releases from a git host should *not* be `git clone`.

It fetches over plain HTTPS, with **no git binary** and **zero runtime dependencies**:

**Docs:** https://zukunftsholz.github.io/dsh-zgit/

- **Source code** → downloaded as a forge archive (codeload-style tar.gz/zip), extracted into a **simulated checkout** with `.zerogit` metadata — a git-like directory you can inspect, `status`-check, and refresh.
- **Binary releases** → release assets listed or downloaded straight from GitHub/GitLab/Gitee releases, with sha256 verification against shipped checksum files.
- **git, simulated** → `zgit_ls_remote`, `zgit_show`, `zgit_ls_tree`, `zgit_log`, `zgit_diff`, `zgit_status` reimplement the read side of git over the forge APIs.
- **Anything else** → `zgit_download` fetches any direct URL (mirrors, toolchains) into the workspace with a byte cap and optional sha256.

```
dsh plugin --profile web add dsh-zgit
# …or from Git (no npm account needed):
# dsh plugin --profile web add github:zukunftsholz/dsh-zgit
# …or from a local checkout:
# dsh plugin --profile web add ./dsh-zgit
```

## Tools

| Tool | git analog | What it does |
| --- | --- | --- |
| `zgit_ls_remote` | `git ls-remote` | Branches, tags, ref→sha resolution, default branch, latest release tag. |
| `zgit_clone` | `git clone` / `git archive` | Downloads the source archive at a ref, extracts it into the workspace as a simulated checkout (`.zerogit/meta.json`), supports `subdir` sparse extraction and explicit archive URLs (mirrors). |
| `zgit_fetch_release` | `gh release download` | Lists or downloads release assets (latest or a tag) with glob patterns and sha256 verification. |
| `zgit_show` | `git show` | Fetches one raw file at a ref (optionally saved into the workspace). |
| `zgit_ls_tree` | `git ls-tree` | Lists files/dirs at a ref via the forge API. |
| `zgit_log` | `git log` | Recent commits at a ref. |
| `zgit_diff` | `git diff` | Compare two refs: changed-files summary or a single-file unified diff. |
| `zgit_status` | `git status` + `git fetch` | Checks a simulated checkout against the remote: moved ref, commits behind. |
| `zgit_download` | `curl` | Any direct HTTPS download into the workspace, capped, with optional sha256. |

Plus the human-plane command **`/zgit`** (Web UI slash menu / TUI): `clone`, `get`, `show`, `ls`, `log`, `diff`, `resolve`, `status`, `download` — the same operations without the model in the loop.

## Forge support

- **GitHub** (`github.com` + `api.github.com` + `codeload.github.com` + `raw.githubusercontent.com`)
- **GitLab** (`gitlab.com` + API v4), including nested groups
- **Gitee** (`gitee.com` + API v5)
- **Generic** GitHub-style hosts: archive/raw URL guessing works (self-hosted Gitea/GitHub Enterprise); API-backed operations report a clear error — use `archiveUrl` or `zgit_download`.

Repo references accept `owner/repo`, `owner/repo@ref`, full `https://` URLs (with `@ref` or `/tree/ref`), `git@host:owner/repo.git`, and `ssh://` URLs.

## Configuration

All config lives in the plugin row (`$DSH_HOME/cordis.patch.yml`, the profile patch, or an overlay):

```yaml
- id: zgit
  config:
    clone: true          # per-tool toggles: lsRemote, clone, release, show,
    command: true        #   lsTree, log, diff, status, download, command
    timeoutMs: 120000
    maxArchiveBytes: 536870912      # 512 MiB clone cap
    maxDownloadBytes: 1073741824    # 1 GiB download cap
    maxFileBytes: 262144            # 256 KiB zgit_show cap
    maxTreeEntries: 5000
    maxLogCommits: 30
    maxDiffChars: 100000
    maxExtractedEntries: 100000
    workspaceRoot: ''               # fallback root (defaults to process.cwd()); tool calls prefer the calling session workspace
    userAgent: dsh-zgit/0.2.2
    tokenEnv: { github: GITHUB_TOKEN, gitlab: '', gitee: '' }   # env var names
    tokens:   { github: '', gitlab: '', gitee: '' }             # or direct values
```

Tokens raise API rate limits and enable private repos; the env-var name wins over a direct value.

## The simulated checkout

`zgit_clone` produces a normal directory plus:

```
<dir>/
├── .zerogit/
│   ├── meta.json   # origin, ref, sha, archive URL, fetched-at, file counts
│   └── HEAD        # the pinned commit sha
└── ...             # the extracted source (root folder stripped)
```

`zgit_status <dir>` re-resolves the pinned ref remotely and reports how far the checkout fell behind. Refresh with `zgit_clone (replace: true)`.

## Safety properties

- **Workspace confinement** — every write is resolved inside the calling session's workspace (`exec.agent.session.header.cwd`), falling back to `workspaceRoot` for agentless callers; paths escaping the root are rejected.
- **Archive hardening** — path traversal (`..`, absolute paths, Windows reserved names) is rejected; case-insensitive collisions error; entries are capped by count and total bytes; zip entries are CRC32-verified; gzip is decompressed under a hard cap (bomb guard); symlinks are recorded and skipped (not materialized), hardlinks are copied.
- **Byte caps** everywhere — downloads stream with early abort when a cap is exceeded.
- **No execution** — archives are never executed, only extracted.

## Development

The package has **zero runtime dependencies** (pure Node builtins: `node:zlib`, `node:crypto`, `node:fs`, `node:http`). It targets DSH **0.1.5-rc.2** (cordis 4.0.2, schemastery 3.18.2) and tests run against the installed DSH profile packages:

```sh
npm run build      # scripts/build.sh (DSH checkout + junctions + tsc) via node wrapper
npm run typecheck
npm test           # vitest: parser/glob units, tar.gz+zip extractors, forge fixtures, real-HTTP e2e, Cordis mount
```

## FAQ

**What is dsh-zgit?**
dsh-zgit (zgit) is a DeepSeek Harness plugin that fetches source archives and release assets from git hosts over plain HTTPS. It needs no git binary and adds no runtime dependencies.

**Do I need git installed?**
No. Everything runs over HTTPS against the forge's archive, raw-file, and release endpoints.

**Which git hosts are supported?**
GitHub, GitLab (API v4, nested groups), and Gitee (API v5). Generic GitHub-style self-hosted hosts (Gitea, GitHub Enterprise) work for archive/raw URL guessing; API-backed operations return a clear error and fall back to `archiveUrl` or `zgit_download`.

**How do I install it?**
`dsh plugin --profile web add dsh-zgit` — the package is on npm. The Git form (`github:zukunftsholz/dsh-zgit`) and a local checkout (`./dsh-zgit`) work too.

**Is it a git replacement?**
It reimplements the read side of git (`ls-remote`, `show`, `ls-tree`, `log`, `diff`, `status`) over the forge APIs, plus release-asset download. It does not do writes or pushes.

**Are downloads verified?**
Release assets and `zgit_download` support sha256 verification against shipped checksum files. Zip entries are CRC32-verified; gzip is decompressed under a hard cap (bomb guard).

**Which DSH version does it target?**
DSH 0.1.5-rc.2 (cordis 4.0.2, schemastery 3.18.2).

**What license?**
MIT.

## License

MIT
