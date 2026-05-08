# tools-runner

A smart tool runner: runs your tests only when files have changed since the last time they were run.

## Installation

### Stable release

```
/plugin marketplace add ashleydavis/tools-runner
/plugin install tools-runner@tools-runner
```

### Pre-release / testing (pin to `dev` branch)

```
/plugin marketplace add https://github.com/ashleydavis/tools-runner.git#dev
/plugin install tools-runner@tools-runner
/plugin marketplace update tools-runner   # pull latest dev commits
```

To build and run from a local checkout instead of the marketplace, see [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Minimal example

Drop this file at `<your-project>/.claude/tools-runner.yaml`:

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

## Learn more

- [Configuration](docs/CONFIGURATION.md): How to write your `tools-runner.yaml` configuration.
- [How it works](docs/HOW_IT_WORKS.md): How the plugin works under the hood.
- [Development](docs/DEVELOPMENT.md): Instructions for cloning, building, and contributing to the plugin.
