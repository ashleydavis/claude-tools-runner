# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules

- SMOKE TESTS ARE ALWAYS IMPLEMENTED THROUGH SHELL SCRIPTS + YAML FILES, SMOKE TESTS ARE NEVER TYPESCRIPT CODE.
- THIS IS A BUN PROJECT, NOT NODE.JS
- NEVER USE EM DASHES OR DOUBLE HYPHENS
- IT IS ALWAYS YOUR RESPONSIBILTY TO FIX COMPILE ERRORS AND FAILING TESTS. NEVER USE THE "PREEXISTING" EXCUSE.
- Never use memory.
- All Claude configuration goes in this repository only, not in the home directory.
- Never stash code unless asked.
- NEVER USE SYNC VERSIONS OF FUNCTIONS (e.g. readFileSync, appendFileSync, mkdirSync). Always use async/await equivalents from `fs/promises`.
- This project uses the Jest test runner. Never use the Bun test runner.
- This project is Bun, never use Node or npx.

## Project Overview

A Claude Code plugin that runs project commands (tests, linters, type-checks) only when the files they care about have actually changed. Configured per-project via YAML; gated by cooldown and a content hash of matched files so unchanged files don't re-trigger.

## Commands

- `bun run compile` — compile TypeScript (use this, not tsc directly)
- `bun run test` — unit tests
- `bun run smoke` — end-to-end smoke tests
- `bun run hook-smoke` — bundle-integrity smoke tests
- `bun run test:all` — all tests
- `bun run bundle` — bundle `src/stop-hook.ts` into `plugin/dist/stop-hook.js`

## Tech Stack

- **Runtime**: Bun (runs `plugin/dist/stop-hook.js`; users must have Bun installed)
- **Language**: TypeScript
- **Bundler**: `bun build` via `bun run bundle` script (produces `plugin/dist/stop-hook.js` from `src/stop-hook.ts`)
- **Test runner**: Jest with `ts-jest`
- **Runtime deps** (bundled): `yaml`, `picomatch`
- **Dev deps**: `typescript`, `jest`, `ts-jest`, `@types/jest`

## Coding Style
- **Types**: Use interfaces with PascalCase (`IFoo`) for types, explicit return types
- **Naming**: camelCase for variables/methods, PascalCase for classes/interfaces
- **Imports**: Named imports for functions, default imports for modules
- **Functions**: Named functions for top-level methods, arrow functions for callbacks
- **Async**: Use async/await pattern for asynchronous code
- **Error Handling**: Try/catch blocks with specific error handling, custom error classes
- **Formatting**: 4-space indentation, braces on same line as control statements
- **Comments**: Line comments with `//` preceded by blank line, method docs above function. Use `//` comments for method docs.
- All global symbols (functions, types, interfaces, classes, constants) must have a `//` comment block above them explaining their intent.
- All fields in interfaces and classes must have a `//` comment explaining their purpose.
- Never use single-character variable names, including arrow function parameters (e.g. use `fileName => ...` not `f => ...`). Use long descriptive identifiers.
- Avoid single line if statements. All if statements should have curly brackets around the function body.
- Never put multiple statements on one line. Each statement should be on its own line.
- Use 4 space tabs for indentation.
- Put `else` and `catch` blocks on a new line.
- Tests should go under the directory src/test in each package.
- Use `test(` not `it(` in Jest test files.
- Refrain from using the `any` type in normal code, although it's ok sometimes in test code.
- Never use anonymous object types inline (e.g. `Promise<{ foo: number }>`). Always define a named interface instead, unless specifically asked to use an anonymous type.
- Never use IIFE async generator pattern (`(async function* () { ... })()`). Extract to a named `async function*` instead.
- Never use `ReturnType<typeof ...>`. Use the actual type directly (e.g. `NodeJS.Timeout` instead of `ReturnType<typeof setTimeout>`).
- Never use inline type casts (e.g. `(x as Foo).bar`). Assign to a typed variable instead (e.g. `const foo: Foo = x; foo.bar`).
- Never use the `unknown` type. Use the actual type directly.
- Don't add explicit type annotations on local variables unless they are required to make the code compile (e.g. empty array initializers that would otherwise infer as `never[]`, `let foo: T | undefined = undefined` declarations, `let foo: T;` declarations without an initializer, narrowing from `any`, or object literals whose later mutations need wider type slots). Let TypeScript infer the type from the right-hand side wherever it can.

## Restrictions

- TypeScript code should always compile after making changes.
- All tests should pass after making changes.
- Prefer to minimize the size of code changes.
- Prefer not to update test code unless needed.
- Add new tests for new code. Every function that is new, that you edit, or that the user asks you about should have unit tests. Every function should be directly unit tested.
- Backward compatibility is not required.
- Use imports instead of requires.
- All imports should be at the top of the file and not inside any functions.
- Don't use dynamic imports.
- Don't add exception handling unless I ask for it.]
- Don't use default or optional parameter values unless specifically asked to.
- Never reformat or rewrite entire files. Only edit the specific lines that need to change.
