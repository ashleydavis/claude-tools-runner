import { matchFiles, stripLeadingAnchor } from "../matcher";
import { ChangedFile } from "../types";

// Helper that builds a ChangedFile from a scope-relative POSIX path. The `absPath` value is
// synthetic and only needs to be unique enough for tests that exercise duplicate-path
// behavior; the matcher itself never inspects `absPath`.
function makeChangedFile(scopeRelativePath: string, absoluteSuffix: string): ChangedFile {
    return {
        path: scopeRelativePath,
        absPath: "/repo/" + absoluteSuffix,
    };
}

describe("stripLeadingAnchor", () => {
    test("strips a single leading slash", () => {
        expect(stripLeadingAnchor("/src/**/*.ts")).toBe("src/**/*.ts");
    });

    test("strips a single leading ./", () => {
        expect(stripLeadingAnchor("./src/**/*.ts")).toBe("src/**/*.ts");
    });

    test("leaves patterns without a leading anchor unchanged", () => {
        expect(stripLeadingAnchor("src/**/*.ts")).toBe("src/**/*.ts");
    });

    test("strips only one leading slash from a doubled prefix", () => {
        expect(stripLeadingAnchor("//src/foo.ts")).toBe("/src/foo.ts");
    });

    test("strips only the leading ./ from a .//foo prefix", () => {
        expect(stripLeadingAnchor(".//src/foo.ts")).toBe("/src/foo.ts");
    });

    test("does not strip a leading dot that is not followed by a slash", () => {
        expect(stripLeadingAnchor(".env")).toBe(".env");
    });

    test("returns the empty string unchanged", () => {
        expect(stripLeadingAnchor("")).toBe("");
    });
});

describe("matchFiles", () => {
    test("single glob matches files under the prefix and rejects others", () => {
        const fooSource = makeChangedFile("src/foo.ts", "src/foo.ts");
        const nestedSource = makeChangedFile("src/dir/bar.ts", "src/dir/bar.ts");
        const scriptFile = makeChangedFile("scripts/foo.sh", "scripts/foo.sh");
        const matched = matchFiles([fooSource, nestedSource, scriptFile], ["src/**/*.ts"]);
        expect(matched).toEqual([fooSource, nestedSource]);
    });

    test("multiple positive patterns OR together", () => {
        const tsFile = makeChangedFile("src/foo.ts", "src/foo.ts");
        const shellFile = makeChangedFile("scripts/run.sh", "scripts/run.sh");
        const docsFile = makeChangedFile("docs/readme.md", "docs/readme.md");
        const matched = matchFiles([tsFile, shellFile, docsFile], ["src/**/*.ts", "scripts/**/*.sh"]);
        expect(matched).toEqual([tsFile, shellFile]);
    });

    test("empty paths array matches no files and does not throw", () => {
        const tsFile = makeChangedFile("src/foo.ts", "src/foo.ts");
        const matched = matchFiles([tsFile], []);
        expect(matched).toEqual([]);
    });

    test("undefined paths matches no files and does not throw", () => {
        const tsFile = makeChangedFile("src/foo.ts", "src/foo.ts");
        const matched = matchFiles([tsFile], undefined);
        expect(matched).toEqual([]);
    });

    test("dotfiles match when included by glob (dot: true)", () => {
        const rootDotEnv = makeChangedFile(".env", ".env");
        const nestedDotEnv = makeChangedFile("config/.env", "config/.env");
        const matched = matchFiles([rootDotEnv, nestedDotEnv], ["**/.env"]);
        expect(matched).toEqual([rootDotEnv, nestedDotEnv]);
    });

    test("brace expansion matches both extensions", () => {
        const tsFile = makeChangedFile("src/foo.ts", "src/foo.ts");
        const tsxFile = makeChangedFile("src/bar.tsx", "src/bar.tsx");
        const jsFile = makeChangedFile("src/baz.js", "src/baz.js");
        const matched = matchFiles([tsFile, tsxFile, jsFile], ["src/**/*.{ts,tsx}"]);
        expect(matched).toEqual([tsFile, tsxFile]);
    });

    test("negation excludes a subtree from a positive match", () => {
        const includedFile = makeChangedFile("src/foo.ts", "src/foo.ts");
        const generatedFile = makeChangedFile("src/generated/foo.ts", "src/generated/foo.ts");
        const matched = matchFiles([includedFile, generatedFile], ["src/**/*.ts", "!src/generated/**"]);
        expect(matched).toEqual([includedFile]);
    });

    test("negation alone matches nothing", () => {
        const tsFile = makeChangedFile("src/foo.ts", "src/foo.ts");
        const otherFile = makeChangedFile("scripts/run.sh", "scripts/run.sh");
        const matched = matchFiles([tsFile, otherFile], ["!src/generated/**"]);
        expect(matched).toEqual([]);
    });

    test("leading slash is stripped so /src/**/*.ts behaves like src/**/*.ts", () => {
        const tsFile = makeChangedFile("src/foo.ts", "src/foo.ts");
        const matched = matchFiles([tsFile], ["/src/**/*.ts"]);
        expect(matched).toEqual([tsFile]);
    });

    test("leading ./ is stripped so ./src/**/*.ts behaves like src/**/*.ts", () => {
        const tsFile = makeChangedFile("src/foo.ts", "src/foo.ts");
        const matched = matchFiles([tsFile], ["./src/**/*.ts"]);
        expect(matched).toEqual([tsFile]);
    });

    test("matching is case-sensitive", () => {
        const upperCaseFile = makeChangedFile("src/Foo.TS", "src/Foo.TS");
        const matched = matchFiles([upperCaseFile], ["src/**/*.ts"]);
        expect(matched).toEqual([]);
    });

    test("two ChangedFile entries with identical path values are both kept", () => {
        const firstFile = makeChangedFile("src/foo.ts", "first/src/foo.ts");
        const duplicateFile = makeChangedFile("src/foo.ts", "second/src/foo.ts");
        const matched = matchFiles([firstFile, duplicateFile], ["src/**/*.ts"]);
        expect(matched).toEqual([firstFile, duplicateFile]);
    });
});
