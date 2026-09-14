/**
 * The `/zgit` human command: a git-flavored CLI over the same core operations
 * as the zgit_* tools, for the command plane (Web UI slash menu, TUI). The
 * command runs in the human-only plane — its output never reaches the model.
 * @module dsh-zgit/command
 */
import { errorMessage } from "./core.js";
import { cloneSource, diff, download, fetchReleaseAssets, log, lsRemote, lsTree, showFile, status, } from "./core.js";
const USAGE = `zgit — fetch source and release binaries without git
usage: /zgit <subcommand> [args]

  clone   <repo>[@ref] [dir] [--subdir P] [--replace]   simulated git clone (archive download + extract)
  get     <repo> [tag] [pattern...]                     list or download release assets (latest by default)
  show    <repo> <path> [ref] [--save-to P]             fetch one raw file (git show)
  ls      <repo> [path] [ref]                           list files at a ref (git ls-tree)
  log     <repo> [ref] [count]                          recent commits (git log)
  diff    <repo> <base> <head> [path]                   compare refs (git diff)
  resolve <repo> [ref]                                  branches/tags + ref resolution (git ls-remote)
  status  <dir> [repo]                                  check a simulated checkout against the remote
  download <url> [path] [--sha256 HEX]                  download any direct URL into the workspace
  help                                                   this help`;
/** Split a command line into tokens, honoring double quotes. */
export function tokenize(input) {
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match;
    while ((match = re.exec(input)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
    return tokens;
}
/** Parse `--key value` / `--flag` pairs out of a token list. */
export function parseFlags(tokens) {
    const flags = {};
    const positionals = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.startsWith('--')) {
            const name = token.slice(2);
            const next = tokens[index + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[name] = next;
                index += 1;
            }
            else {
                flags[name] = true;
            }
        }
        else {
            positionals.push(token);
        }
    }
    return { flags, positionals };
}
/**
 * Run one /zgit invocation; always settles as a CommandResult.
 * @param workspaceRoot - the calling agent's session workspace (session header cwd),
 *   so command writes land in the same project folder as tool calls; undefined keeps
 *   the runtime root (agentless callers).
 */
export async function runZgitCommand(runtime, rawInput, signal, workspaceRoot) {
    try {
        const { flags, positionals } = parseFlags(tokenize(rawInput));
        const sub = positionals.shift()?.toLowerCase() ?? 'help';
        const call = workspaceRoot === undefined
            ? { signal }
            : { signal, workspaceRoot };
        const text = await dispatch(runtime, sub, positionals, flags, call);
        return { kind: 'success', text };
    }
    catch (error) {
        return { kind: 'error', text: errorMessage(error) };
    }
}
/** Dispatch one subcommand to the core operations. */
async function dispatch(runtime, sub, args, flags, call) {
    switch (sub) {
        case 'help':
        case '--help':
        case '-h':
            return USAGE;
        case 'resolve': {
            requireArgs(sub, args, 1);
            const result = await lsRemote(runtime, { repo: args[0], ref: args[1] }, call);
            const lines = [
                `${result.owner}/${result.repo} (${result.forge})`,
                result.defaultBranch !== undefined ? `default branch: ${result.defaultBranch}` : '',
                result.resolvedSha !== undefined ? `${result.ref}: ${result.resolvedSha}` : '',
                result.latestReleaseTag !== undefined ? `latest release: ${result.latestReleaseTag}` : '',
                `branches: ${result.branches.map(b => b.name).join(', ')}`,
                `tags: ${result.tags.map(t => t.name).join(', ')}`,
            ];
            return lines.filter(line => line.length > 0).join('\n');
        }
        case 'clone': {
            requireArgs(sub, args, 1);
            // The ref rides on the repo spec (`repo@ref`); the first positional is the dir.
            const result = await cloneSource(runtime, {
                repo: args[0],
                dir: args[1],
                subdir: stringFlag(flags.subdir),
                replace: flags.replace === true,
            }, call);
            return `cloned ${result.owner}/${result.repo}@${result.ref} → ${result.targetDir}\n` +
                `commit ${result.sha}: ${result.files} files, ${result.totalBytes} bytes (${result.elapsedMs} ms)\n` +
                `meta: ${result.metaPath}`;
        }
        case 'get': {
            requireArgs(sub, args, 1);
            const result = await fetchReleaseAssets(runtime, {
                repo: args[0],
                tag: args[1],
                pattern: args[2],
            }, call);
            if (result.listed !== undefined) {
                const lines = [`release ${result.owner}/${result.repo} @ ${result.tagName}:`];
                for (const asset of result.listed) {
                    lines.push(`  ${asset.name}${asset.size !== undefined ? ` (${asset.size} bytes)` : ''} — ${asset.url}`);
                }
                return lines.join('\n');
            }
            const lines = [`downloaded ${result.assets.length} asset(s) → ${result.targetDir}`];
            for (const asset of result.assets) {
                lines.push(`  ${asset.name} (${asset.size} bytes, sha256 ${asset.sha256.slice(0, 16)}…${asset.verified ? ', verified' : ''})`);
            }
            return lines.join('\n');
        }
        case 'show': {
            requireArgs(sub, args, 2);
            const result = await showFile(runtime, {
                repo: args[0],
                path: args[1],
                ref: args[2],
                saveTo: stringFlag(flags['save-to']),
            }, call);
            if (result.binary)
                return `${result.path} @ ${result.ref}: binary file (${result.bytes} bytes)`;
            return `=== ${result.path} @ ${result.ref} ===\n${result.text}${result.truncated ? '\n(truncated)' : ''}`;
        }
        case 'ls': {
            requireArgs(sub, args, 1);
            const result = await lsTree(runtime, { repo: args[0], path: args[1], ref: args[2] }, call);
            const lines = [`${result.repo} @ ${result.ref}:`];
            for (const entry of result.entries) {
                lines.push(`  ${entry.type === 'tree' ? 'dir ' : 'blob'} ${entry.size ?? ''}  ${entry.path}`);
            }
            if (result.truncated)
                lines.push(`(truncated at ${result.entries.length} entries)`);
            return lines.join('\n');
        }
        case 'log': {
            requireArgs(sub, args, 1);
            const result = await log(runtime, { repo: args[0], ref: args[1], count: args[2] !== undefined ? Number(args[2]) : undefined }, call);
            const lines = [`${result.repo} @ ${result.ref} (${result.sha.slice(0, 12)}):`];
            for (const entry of result.entries) {
                lines.push(`  ${entry.sha.slice(0, 12)}  ${entry.date.slice(0, 10)}  ${entry.author}  ${entry.subject}`);
            }
            return lines.join('\n');
        }
        case 'diff': {
            requireArgs(sub, args, 3);
            const result = await diff(runtime, { repo: args[0], base: args[1], head: args[2], path: args[3] }, call);
            if (result.singleFile !== undefined) {
                return `diff ${result.singleFile.path} (${result.singleFile.status}) ${result.base} → ${result.head}\n${result.singleFile.patch ?? '[no patch available]'}`;
            }
            const lines = [
                `${result.repo}: ${result.base} → ${result.head} — ${result.commits.length} commits, ${result.files.length} files, +${result.totalAdditions} −${result.totalDeletions}`,
            ];
            for (const file of result.files) {
                lines.push(`  ${file.status} +${file.additions} −${file.deletions}  ${file.path}`);
            }
            return lines.join('\n');
        }
        case 'status': {
            requireArgs(sub, args, 1);
            const result = await status(runtime, { dir: args[0], repo: args[1] }, call);
            if (result.upToDate)
                return `${result.dir}: up to date @ ${result.meta.sha.slice(0, 12)}`;
            const behind = result.behindBy === null ? '?' : String(result.behindBy);
            const lines = [`${result.dir}: remote moved — ${behind} new commit(s) (remote ${result.remoteSha.slice(0, 12)})`];
            for (const commit of result.newCommits) {
                lines.push(`  ${commit.sha.slice(0, 12)}  ${commit.date.slice(0, 10)}  ${commit.author}  ${commit.subject}`);
            }
            return lines.join('\n');
        }
        case 'download': {
            requireArgs(sub, args, 1);
            const result = await download(runtime, { url: args[0], path: args[1], sha256: stringFlag(flags.sha256) }, call);
            return `downloaded ${result.url} → ${result.path} (${result.size} bytes, sha256 ${result.sha256})`;
        }
        default:
            throw new Error(`unknown zgit subcommand "${sub}" — run /zgit help for usage`);
    }
}
function requireArgs(sub, args, count) {
    if (args.length < count) {
        throw new Error(`/zgit ${sub} requires ${count} argument${count === 1 ? '' : 's'}; run /zgit help for usage`);
    }
}
function stringFlag(value) {
    return typeof value === 'string' ? value : undefined;
}
//# sourceMappingURL=command.js.map