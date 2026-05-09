import * as crypto from "node:crypto";
import { ChangedFile, CompiledCommand, Trigger } from "./types";
import { TemplateContext } from "./template";

// Default working-directory template applied to a command emission whose `CommandConfig.cwd` is unset.
// Mirrors the YAML-side default applied by `parseCommand` in `config.ts` so synthetic `Trigger[]` fixtures
// (used by `StaticLayer` in tests) get the same `expandedCwd` as production triggers loaded from YAML.
const DEFAULT_CWD_TEMPLATE: string = "${{project}}";

// Compiles one layer's triggers into a flat list of `CompiledCommand` records keyed per `(trigger, command)`.
// Returns `[]` when no files have changed. Triggers whose `paths` field is empty or undefined are skipped
// without emitting any commands. For every remaining trigger, each `CommandConfig` produces one
// `CompiledCommand` carrying the layer's `sourceFile`, the trigger's 0-based index inside its source file,
// the command's 0-based index inside the trigger, the unexpanded `run` and `cwd` strings, the full set of
// changed files as `matchedFiles`, and a `commandKey` derived from `expandedRun` and `expandedCwd` so the
// state file can look up the entry without depending on YAML position.
export function compileCommands(triggers: Trigger[], sourceFile: string, ctx: TemplateContext, scopeDir: string, changed: ChangedFile[]): CompiledCommand[] {
    if (changed.length === 0) {
        return [];
    }
    const compiled: CompiledCommand[] = [];
    for (let triggerIndex = 0; triggerIndex < triggers.length; triggerIndex++) {
        const trigger = triggers[triggerIndex];
        if (!trigger.paths || trigger.paths.length === 0) {
            continue;
        }
        for (let commandIndex = 0; commandIndex < trigger.commands.length; commandIndex++) {
            const command = trigger.commands[commandIndex];
            const expandedRun = command.run;
            const expandedCwd = command.cwd ?? DEFAULT_CWD_TEMPLATE;
            const commandKey = crypto
                .createHash("sha256")
                .update(`${expandedRun}\0${expandedCwd}`)
                .digest("hex");
            compiled.push({
                sourceFile,
                sourceLine: trigger.sourceLine,
                triggerIndexInFile: triggerIndex,
                commandIndex,
                command,
                expandedCwd,
                expandedRun,
                commandKey,
                matchedFiles: changed,
            });
        }
    }
    return compiled;
}
