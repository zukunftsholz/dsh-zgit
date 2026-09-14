# dsh-zgit

[English](./README.md) | 中文

**零 git（zgit）** —— 一个 DeepSeek Harness 插件：当需要从 git 仓库拉取源代码或二进制发行版时，第一想法不再是 `git clone`，而是更敏捷的纯 HTTPS 方案（甚至直接"模拟 git"）。

`dsh-zgit` 无需 git 二进制、零运行时依赖：

- **源代码** → 直接下载代码托管平台的源码归档（codeload 风格的 tar.gz/zip），解压成带 `.zerogit` 元数据的**模拟检出目录**（simulated checkout），可以查看、`status` 检查、随时刷新。
- **二进制发行版** → 从 GitHub / GitLab / Gitee 的 Releases 直接列出或下载产物，支持 sha256 校验（自动识别随包发布的校验文件）。
- **模拟 git** → `zgit_ls_remote`、`zgit_show`、`zgit_ls_tree`、`zgit_log`、`zgit_diff`、`zgit_status` 用托管平台 API 重新实现了 git 的"读"侧。
- **其他一切** → `zgit_download` 把任意直链（镜像、工具链）下载进工作区，带字节上限与可选 sha256。

```sh
dsh plugin --profile web add github:zukunftsholz/dsh-zgit
# ……或本地检出目录：
# dsh plugin --profile web add ./dsh-zgit
```

## 工具一览

| 工具 | 对应 git | 功能 |
| --- | --- | --- |
| `zgit_ls_remote` | `git ls-remote` | 分支、标签、ref→sha 解析、默认分支、最新 release 标签。 |
| `zgit_clone` | `git clone` / `git archive` | 按 ref 下载源码归档并解压为模拟检出（`.zerogit/meta.json`），支持 `subdir` 稀疏检出与显式归档 URL（镜像）。 |
| `zgit_fetch_release` | `gh release download` | 列出或下载发行版产物（最新或指定 tag），支持 glob 匹配与 sha256 校验。 |
| `zgit_show` | `git show` | 按 ref 拉取单个原始文件（可选保存到工作区）。 |
| `zgit_ls_tree` | `git ls-tree` | 通过平台 API 列出某 ref 下的文件/目录。 |
| `zgit_log` | `git log` | 某 ref 的最近提交。 |
| `zgit_diff` | `git diff` | 比较两个 ref：变更文件汇总，或单个文件的 unified diff。 |
| `zgit_status` | `git status` + `git fetch` | 检查模拟检出与远端是否同步：ref 是否移动、落后多少提交。 |
| `zgit_download` | `curl` | 任意 HTTPS 直链下载进工作区，带上限与可选 sha256。 |

另有面向人机交互的斜杠命令 **`/zgit`**（Web 输入栏 / TUI）：`clone`、`get`、`show`、`ls`、`log`、`diff`、`resolve`、`status`、`download` —— 不经过模型，直接执行同样的操作。

## 平台支持

- **GitHub**（`github.com` + `api.github.com` + `codeload.github.com` + `raw.githubusercontent.com`）
- **GitLab**（`gitlab.com` + API v4），支持嵌套分组
- **Gitee**（`gitee.com` + API v5）
- **通用** GitHub 风格自建主机（Gitea / GHE 等）：归档/原始文件 URL 可用；依赖 API 的操作会给出明确报错——改用 `archiveUrl` 或 `zgit_download`。

仓库引用支持 `owner/repo`、`owner/repo@ref`、完整 `https://` URL（可带 `@ref` 或 `/tree/ref`）、`git@host:owner/repo.git` 与 `ssh://` URL。

## 配置

配置写在插件行上（`$DSH_HOME/cordis.patch.yml`、profile patch 或 overlay）：

```yaml
- id: zgit
  config:
    clone: true          # 各工具开关：lsRemote, clone, release, show,
    command: true        #   lsTree, log, diff, status, download, command
    timeoutMs: 120000
    maxArchiveBytes: 536870912      # clone 归档上限 512 MiB
    maxDownloadBytes: 1073741824    # 下载上限 1 GiB
    maxFileBytes: 262144            # zgit_show 上限 256 KiB
    maxTreeEntries: 5000
    maxLogCommits: 30
    maxDiffChars: 100000
    maxExtractedEntries: 100000
    workspaceRoot: ''               # 兜底根（默认 process.cwd()）；工具调用优先使用调用方会话工作区
    userAgent: dsh-zgit/0.2.0
    tokenEnv: { github: GITHUB_TOKEN, gitlab: '', gitee: '' }   # 环境变量名
    tokens:   { github: '', gitlab: '', gitee: '' }             # 或直接填 token
```

Token 可提高 API 限流配额并支持私有仓库；环境变量名优先于直接配置值。

## 模拟检出（simulated checkout）

`zgit_clone` 生成一个普通目录，外加：

```
<dir>/
├── .zerogit/
│   ├── meta.json   # 源地址、ref、sha、归档 URL、抓取时间、文件统计
│   └── HEAD        # 固定的提交 sha
└── ...             # 解压出的源码（已去掉单一顶层目录）
```

`zgit_status <dir>` 会重新解析固定的 ref，报告检出落后了多少提交；用 `zgit_clone (replace: true)` 刷新。

## 安全特性

- **工作区约束** —— 所有写入都解析在调用方会话工作区（`exec.agent.session.header.cwd`）之内，无会话调用回退到 `workspaceRoot`；越界路径直接拒绝。
- **归档加固** —— 拒绝路径穿越（`..`、绝对路径、Windows 保留名）；大小写不敏感冲突报错；条目数与总字节数双重上限；zip 条目做 CRC32 校验；gzip 解压设有硬上限（防解压炸弹）；符号链接只记录不落地，硬链接复制内容。
- **处处有字节上限** —— 下载采用流式读取，超限立即中止。
- **绝不执行** —— 归档只解压，从不运行。

## 开发

本包**零运行时依赖**（只用 Node 内置模块：`node:zlib`、`node:crypto`、`node:fs` 等），面向 DSH **0.1.5-rc.2**（cordis 4.0.2、schemastery 3.18.2）。测试直接针对已安装的 DSH profile 包运行：

```sh
npm run build      # scripts/build.sh（DSH checkout + junction + tsc），由 node 包装器调用
npm run typecheck
npm test           # vitest：解析/glob 单测、tar.gz+zip 解压、平台 fixture、真实 HTTP 端到端、Cordis 挂载
```

## License

MIT
