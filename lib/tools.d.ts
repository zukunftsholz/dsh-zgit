/**
 * The model-facing zgit_* tools: schemas, canonical values, and renderers over
 * the core operations. Every tool is registered into the global tools layer
 * (host plane), so all agents see them; enablement is per-tool config.
 * @module dsh-zgit/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ZerogitRuntime } from './types.ts';
/** Register every enabled zgit tool on the context. */
export declare function applyZgitTools(ctx: Context, runtime: ZerogitRuntime, enabled: Record<ZgitToolName, boolean>): void;
/** Tool enablement keys. */
export type ZgitToolName = 'lsRemote' | 'clone' | 'show' | 'lsTree' | 'log' | 'diff' | 'status' | 'release' | 'download';
//# sourceMappingURL=tools.d.ts.map