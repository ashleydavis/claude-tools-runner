import { parseDuration } from "../duration";

describe("parseDuration", () => {
    describe("happy paths", () => {
        test("bare digits are interpreted as seconds", () => {
            expect(parseDuration("30", "cooldown")).toBe(30);
        });

        test("seconds suffix", () => {
            expect(parseDuration("30s", "cooldown")).toBe(30);
        });

        test("minutes suffix", () => {
            expect(parseDuration("5m", "cooldown")).toBe(300);
        });

        test("hours suffix", () => {
            expect(parseDuration("1h", "cooldown")).toBe(3600);
        });

        test("zero without unit", () => {
            expect(parseDuration("0", "cooldown")).toBe(0);
        });

        test("zero with seconds unit", () => {
            expect(parseDuration("0s", "cooldown")).toBe(0);
        });
    });

    describe("rejections", () => {
        test("bare YAML number is rejected with field name in error", () => {
            expect(() => parseDuration(30, "cooldown")).toThrow(/cooldown/);
            expect(() => parseDuration(30, "cooldown")).toThrow(/duration string/);
        });

        test("decimal value is rejected", () => {
            expect(() => parseDuration("1.5s", "cooldown")).toThrow(/cooldown/);
        });

        test("negative value is rejected", () => {
            expect(() => parseDuration("-5s", "cooldown")).toThrow(/cooldown/);
        });

        test("milliseconds suffix is rejected", () => {
            expect(() => parseDuration("500ms", "cooldown")).toThrow(/cooldown/);
        });

        test("days suffix is rejected", () => {
            expect(() => parseDuration("7d", "timeout")).toThrow(/timeout/);
        });

        test("empty string is rejected", () => {
            expect(() => parseDuration("", "cooldown")).toThrow(/cooldown/);
        });

        test("leading whitespace is rejected", () => {
            expect(() => parseDuration(" 30s", "cooldown")).toThrow(/cooldown/);
        });

        test("trailing whitespace is rejected", () => {
            expect(() => parseDuration("30s ", "cooldown")).toThrow(/cooldown/);
        });

        test("null is rejected", () => {
            expect(() => parseDuration(null, "cooldown")).toThrow(/cooldown/);
        });

        test("undefined is rejected", () => {
            expect(() => parseDuration(undefined, "cooldown")).toThrow(/cooldown/);
        });

        test("plain object is rejected", () => {
            const objectInput: Record<string, number> = { value: 30 };
            expect(() => parseDuration(objectInput, "cooldown")).toThrow(/cooldown/);
        });

        test("array is rejected", () => {
            const arrayInput: string[] = ["30s"];
            expect(() => parseDuration(arrayInput, "cooldown")).toThrow(/cooldown/);
        });

        test("error message contains the field name so different fields are distinguishable", () => {
            let cooldownError: Error | null = null;
            let timeoutError: Error | null = null;
            try {
                parseDuration("bad", "cooldown");
            }
            catch (caughtErr) {
                const errorObj: Error = caughtErr as Error;
                cooldownError = errorObj;
            }
            try {
                parseDuration("bad", "timeout");
            }
            catch (caughtErr) {
                const errorObj: Error = caughtErr as Error;
                timeoutError = errorObj;
            }
            expect(cooldownError).not.toBeNull();
            expect(timeoutError).not.toBeNull();
            expect(cooldownError!.message).toContain("cooldown");
            expect(timeoutError!.message).toContain("timeout");
            expect(cooldownError!.message).not.toBe(timeoutError!.message);
        });
    });
});
