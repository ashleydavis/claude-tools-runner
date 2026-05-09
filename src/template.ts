// Project-wide template-expansion context. The compile module passes one of these per layer so that
// `${{project}}` substitution and other layer-scoped expansion logic can reference the layer's project root.
// Per-file variables are not part of this context: they come from the `ChangedFile` argument supplied to
// per-file expanders alongside the context.
export interface TemplateContext {
    // Absolute path used as the value of `${{project}}` for any trigger whose layer holds this context.
    // Equals the `scopeDir` of the config layer that owns the trigger.
    projectDir: string;
}
