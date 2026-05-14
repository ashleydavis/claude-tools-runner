# claude-tools-runner

A smart tool runner: runs your tests only when files have changed since the last time they were run.

## Installation

### Stable release

```
/plugin marketplace add ashleydavis/claude-tools-runner
/plugin install claude-tools-runner@claude-tools-runner
```

### Pre-release / testing (pin to `dev` branch)

```
/plugin marketplace add https://github.com/ashleydavis/claude-tools-runner.git#dev
/plugin install claude-tools-runner@claude-tools-runner
/plugin marketplace update claude-tools-runner   # pull latest dev commits
```

To build and run from a local checkout instead of the marketplace, see [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Minimal example

Drop this file at `<your-project>/.claude/claude-tools-runner.yaml`:

```yaml
triggers:
  - paths:
      - src/**/*.ts
    commands:
      - run: bun run test
        cooldown: 30s
        timeout: 5m
```

Now whenever Claude finishes a turn that left changed `.ts` files under `src/` in your working tree, `bun run test` runs once. The hook records a hash of the matched files; on the next turn, if the same files have not changed and the cooldown (`30s`) has not elapsed, the command is skipped. If the command runs longer than `timeout` (`5m`), it is killed and recorded as a failure.

## Let your AI configure this for you

Point your AI assistant at [docs/CONFIG-QUICKREF.md](docs/CONFIG-QUICKREF.md) and ask it to create or update your `claude-tools-runner.yaml`. That document is written specifically for AI: concise schema reference, variable table, invocation rules, and ready-to-copy examples with no prose to wade through.

Example prompt to give your AI:

> Read docs/CONFIG-QUICKREF.md, then add a trigger to .claude/claude-tools-runner.yaml that runs `bun run test` whenever a `.ts` file under `src/` changes.

## Learn more

- [Config guide for AI](docs/CONFIG-QUICKREF.md): Concise reference for AI assistants creating or editing configuration files.
- [Configuration](docs/CONFIGURATION.md): Full configuration reference with detailed explanations.
- [How it works](docs/HOW_IT_WORKS.md): How the plugin works under the hood.
- [Development](docs/DEVELOPMENT.md): Instructions for cloning, building, and contributing to the plugin.
