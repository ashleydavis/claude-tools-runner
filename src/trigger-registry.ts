import { ChangedFile, CompiledCommand, Trigger } from "./types";
import { TemplateContext } from "./template";
import { compileCommands as pureCompileCommands } from "./compile";
import { loadConfigFile } from "./config";

// One layer of the trigger registry. A layer wraps a single config source (the home YAML or one
// per-directory YAML). Triggers stored inside a layer are NEVER exposed or concatenated outside it: the
// only way to act on them is via `compileCommands(changed)`, which returns the per-layer prepared command
// list. The registry composes layers; it never aggregates their triggers.
export interface ITriggerLayer {
    // Display path used in log lines and `CompiledCommand.sourceFile`. Each trigger's `sourceLine` lives on
    // the trigger itself (set by `loadConfigFile`), so the layer does not need a separate field for it.
    sourceFile: string;
    // Directory the layer's config governs. `${{project}}` expands to this path for every trigger emitted
    // from this layer. Equals the directory of the YAML file for `FileLayer`, or whatever the test passed
    // for `StaticLayer`.
    scopeDir: string;
    // Layer-scoped expansion context. `ctx.projectDir` equals `scopeDir`; the registry stores it once on the
    // layer and forwards it to `compileCommands` so per-trigger expansion does not need to recompute it.
    ctx: TemplateContext;
    // True when the layer holds zero triggers. The Stop hook combines `isEmpty()` across every layer to
    // decide whether to log `[tools-runner] no triggers configured, skipping`.
    isEmpty(): boolean;
    // Produces this layer's `CompiledCommand[]` for the given changed-file set. Internally delegates to the
    // pure `compileCommands` function from `compile.ts` with the layer's stored trigger list.
    compileCommands(changed: ChangedFile[]): CompiledCommand[];
}

// Test-only layer that wraps a fixed `Trigger[]` provided by the test fixture. Production code always uses
// `FileLayer`; `StaticLayer` exists so unit tests can construct synthetic layers without touching the
// filesystem and so log output unambiguously identifies which layer produced which `CompiledCommand`.
export class StaticLayer implements ITriggerLayer {
    // Display path stamped onto every `CompiledCommand` emitted from this layer.
    public readonly sourceFile: string;
    // Directory the layer's configuration governs. `${{project}}` expands to this path.
    public readonly scopeDir: string;
    // Layer-scoped template-expansion context.
    public readonly ctx: TemplateContext;
    // Private trigger list. Never read by anything outside this class: the only access path is
    // `compileCommands(changed)`, which forwards the list to the pure compile function.
    private readonly _triggers: Trigger[];

    constructor(triggers: Trigger[], sourceFile: string, scopeDir: string, ctx: TemplateContext) {
        this._triggers = triggers;
        this.sourceFile = sourceFile;
        this.scopeDir = scopeDir;
        this.ctx = ctx;
    }

    isEmpty(): boolean {
        return this._triggers.length === 0;
    }

    compileCommands(changed: ChangedFile[]): CompiledCommand[] {
        return pureCompileCommands(this._triggers, this.sourceFile, this.ctx, this.scopeDir, changed);
    }
}

// Production trigger layer backed by a single YAML config file. Triggers are loaded once at construction
// time via `FileLayer.create(...)`; the layer holds them privately for the lifetime of the Stop-hook
// process. There is no in-process file watcher: every Stop event spawns a fresh process that rebuilds the
// registry, which gives the same effect as a watcher for any edit made between turns.
export class FileLayer implements ITriggerLayer {
    // Display path stamped onto every `CompiledCommand` emitted from this layer. Used by log lines so the
    // user can locate the YAML source of each prepared command.
    public readonly sourceFile: string;
    // Absolute path of the directory whose config this layer represents. Equals the directory containing
    // the YAML file for per-project layers, or `$HOME/.claude` for the home layer.
    public readonly scopeDir: string;
    // Layer-scoped template-expansion context. `ctx.projectDir` equals `scopeDir`.
    public readonly ctx: TemplateContext;
    // Private trigger list captured at construction. Never read outside this class.
    private readonly _triggers: Trigger[];

    private constructor(triggers: Trigger[], sourceFile: string, scopeDir: string, ctx: TemplateContext) {
        this._triggers = triggers;
        this.sourceFile = sourceFile;
        this.scopeDir = scopeDir;
        this.ctx = ctx;
    }

    // Loads `filePath` via `loadConfigFile` and returns a populated `FileLayer`. A `null` `filePath` or a
    // missing file (`loadConfigFile` returns `null`) yields a layer with zero triggers; the layer is still
    // valid and `isEmpty()` reports `true`. Parse and validation errors thrown by `loadConfigFile` are NOT
    // caught here: they propagate so the Stop hook's top-level `try/catch` can format the stderr message
    // and emit a `hook_error` audit-log entry.
    public static async create(filePath: string | null, displayFile: string, scopeDir: string, ctx: TemplateContext): Promise<FileLayer> {
        let triggers: Trigger[] = [];
        if (filePath !== null) {
            const config = await loadConfigFile(filePath);
            if (config !== null) {
                triggers = config.triggers;
            }
        }
        return new FileLayer(triggers, displayFile, scopeDir, ctx);
    }

    isEmpty(): boolean {
        return this._triggers.length === 0;
    }

    compileCommands(changed: ChangedFile[]): CompiledCommand[] {
        return pureCompileCommands(this._triggers, this.sourceFile, this.ctx, this.scopeDir, changed);
    }
}

// Registry composing a variable number of trigger layers (home + N per-directory layers, N may be zero).
// The registry never exposes or aggregates layers' triggers. Its only operations are `isEmpty()` (true when
// every layer is empty) and `compileCommands(changed)` (concatenates each layer's prepared command list in
// registration order).
export class TriggerRegistry {
    // Layers in the order they were registered. The Stop hook supplies `[homeLayer, ...perProjectLayers]`
    // so home triggers always appear first in the concatenated `compileCommands` output.
    private readonly layers: ITriggerLayer[];

    constructor(layers: ITriggerLayer[]) {
        this.layers = layers;
    }

    isEmpty(): boolean {
        for (const layer of this.layers) {
            if (!layer.isEmpty()) {
                return false;
            }
        }
        return true;
    }

    compileCommands(changed: ChangedFile[]): CompiledCommand[] {
        const compiled: CompiledCommand[] = [];
        for (const layer of this.layers) {
            const layerCompiled = layer.compileCommands(changed);
            for (const entry of layerCompiled) {
                compiled.push(entry);
            }
        }
        return compiled;
    }
}
