/**
 * The `/zgit` human command: a git-flavored CLI over the same core operations
 * as the zgit_* tools, for the command plane (Web UI slash menu, TUI). The
 * command runs in the human-only plane — its output never reaches the model.
 * @module dsh-zgit/command
 */
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { ZerogitRuntime } from './types.ts';
/** Split a command line into tokens, honoring double quotes. */
export declare function tokenize(input: string): string[];
/** Parse `--key value` / `--flag` pairs out of a token list. */
export declare function parseFlags(tokens: string[]): {
    flags: Record<string, string | true>;
    positionals: string[];
};
/**
 * Run one /zgit invocation; always settles as a CommandResult.
 * @param workspaceRoot - the calling agent's session workspace (session header cwd),
 *   so command writes land in the same project folder as tool calls; undefined keeps
 *   the runtime root (agentless callers).
 */
export declare function runZgitCommand(runtime: ZerogitRuntime, rawInput: string, signal: AbortSignal | undefined, workspaceRoot?: string): Promise<CommandResult>;
//# sourceMappingURL=command.d.ts.map