/** @type {import("jest").Config} */
export default {
    preset: "ts-jest",
    testEnvironment: "node",
    testMatch: ["**/*.test.ts"],
    extensionsToTreatAsEsm: [".ts"],
    transform: {
        "^.+\\.ts$": ["ts-jest", { useESM: true }],
    },
};
