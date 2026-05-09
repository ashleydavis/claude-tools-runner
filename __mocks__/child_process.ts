// Manual mock for `node:child_process` loaded by Jest when a test calls `jest.mock("node:child_process")`
// (or `jest.mock("child_process")`). Only `spawn` is exposed because that is the only export the production
// code currently consumes; future tests that need `exec`, `fork`, or other surface should extend this file
// rather than reach for inline mocks. Tests install per-call behaviour via `(spawn as jest.Mock).mockImplementation(...)`.
export const spawn = jest.fn();
