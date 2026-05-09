import { ChangedFile } from "../types";
import {
    TemplateContext,
    expandPerFile,
    expandStatic,
    findGroupDir,
    hasGroupDirVariable,
    hasPerFileVariable,
    shellQuote,
} from "../template";

// Helper that builds a `TemplateContext` so each test only has to specify the project directory of
// interest. Keeps test bodies focused on the substitution behavior rather than fixture plumbing.
function makeContext(projectDir: string): TemplateContext {
    return {
        projectDir,
    };
}

// Helper that builds a `ChangedFile` from an absolute path. The scope-relative `path` field is
// synthesized from the absolute path because the template helpers only ever read `absPath`.
function makeChangedFile(absolutePath: string): ChangedFile {
    return {
        path: absolutePath,
        absPath: absolutePath,
    };
}

describe("shellQuote", () => {
    test("wraps the empty string in single quotes", () => {
        expect(shellQuote("")).toBe("''");
    });

    test("wraps a plain word in single quotes", () => {
        expect(shellQuote("plain")).toBe("'plain'");
    });

    test("escapes embedded single quotes via the '\\'' sequence", () => {
        expect(shellQuote("a'b")).toBe("'a'\\''b'");
    });

    test("preserves shell metacharacters inside the quoted result", () => {
        expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    });
});

describe("expandStatic", () => {
    test("replaces ${{project}} with ctx.projectDir", () => {
        const ctx = makeContext("/repo");
        expect(expandStatic("cd ${{project}}", ctx)).toBe("cd /repo");
    });

    test("replaces multiple occurrences of ${{project}}", () => {
        const ctx = makeContext("/repo");
        expect(expandStatic("${{project}}/a:${{project}}/b", ctx)).toBe("/repo/a:/repo/b");
    });

    test("returns input unchanged when no variables appear", () => {
        const ctx = makeContext("/repo");
        expect(expandStatic("npm test", ctx)).toBe("npm test");
    });

    test("throws when ${{file_path}} appears", () => {
        const ctx = makeContext("/repo");
        expect(() => expandStatic("${{file_path}}", ctx)).toThrow();
    });

    test("throws when ${{file_name}} appears", () => {
        const ctx = makeContext("/repo");
        expect(() => expandStatic("${{file_name}}", ctx)).toThrow();
    });

    test("throws when ${{file_basename}} appears", () => {
        const ctx = makeContext("/repo");
        expect(() => expandStatic("${{file_basename}}", ctx)).toThrow();
    });

    test("throws when ${{file_ext}} appears", () => {
        const ctx = makeContext("/repo");
        expect(() => expandStatic("${{file_ext}}", ctx)).toThrow();
    });

    test("throws when ${{file_dir}} appears", () => {
        const ctx = makeContext("/repo");
        expect(() => expandStatic("${{file_dir}}", ctx)).toThrow();
    });

    test("throws when ${{group_dir}} appears", () => {
        const ctx = makeContext("/repo");
        expect(() => expandStatic("${{group_dir}}", ctx)).toThrow();
    });
});

describe("expandPerFile", () => {
    const ctx = makeContext("/repo");
    const file = makeChangedFile("/repo/src/foo.ts");

    test("replaces ${{project}} with the projectDir", () => {
        expect(expandPerFile("cd ${{project}}", ctx, file, null, { forShell: false })).toBe("cd /repo");
    });

    test("replaces ${{file_path}} with the absolute path", () => {
        expect(expandPerFile("${{file_path}}", ctx, file, null, { forShell: false })).toBe("/repo/src/foo.ts");
    });

    test("replaces ${{file_name}} with the basename including extension", () => {
        expect(expandPerFile("${{file_name}}", ctx, file, null, { forShell: false })).toBe("foo.ts");
    });

    test("replaces ${{file_basename}} with the basename without extension", () => {
        expect(expandPerFile("${{file_basename}}", ctx, file, null, { forShell: false })).toBe("foo");
    });

    test("${{file_basename}} of archive.tar.gz strips only the final extension", () => {
        const archiveFile = makeChangedFile("/repo/dist/archive.tar.gz");
        expect(expandPerFile("${{file_basename}}", ctx, archiveFile, null, { forShell: false })).toBe("archive.tar");
    });

    test("replaces ${{file_ext}} with the extension including dot", () => {
        expect(expandPerFile("${{file_ext}}", ctx, file, null, { forShell: false })).toBe(".ts");
    });

    test("${{file_ext}} of an extensionless file resolves to the empty string", () => {
        const makefile = makeChangedFile("/repo/Makefile");
        expect(expandPerFile("${{file_ext}}", ctx, makefile, null, { forShell: false })).toBe("");
    });

    test("replaces ${{file_dir}} with the dirname of the file", () => {
        expect(expandPerFile("${{file_dir}}", ctx, file, null, { forShell: false })).toBe("/repo/src");
    });

    test("replaces ${{group_dir}} when groupDir is provided", () => {
        expect(expandPerFile("${{group_dir}}", ctx, file, "/repo/packages/foo", { forShell: false })).toBe("/repo/packages/foo");
    });

    test("forShell: true shell-quotes ${{file_path}}", () => {
        const dangerousFile = makeChangedFile("/repo/it's; rm -rf /");
        expect(expandPerFile("cat ${{file_path}}", ctx, dangerousFile, null, { forShell: true })).toBe("cat '/repo/it'\\''s; rm -rf /'");
    });

    test("forShell: true shell-quotes ${{file_name}}", () => {
        const dangerousFile = makeChangedFile("/repo/it's bad.ts");
        expect(expandPerFile("echo ${{file_name}}", ctx, dangerousFile, null, { forShell: true })).toBe("echo 'it'\\''s bad.ts'");
    });

    test("forShell: true shell-quotes ${{file_basename}}", () => {
        const dangerousFile = makeChangedFile("/repo/it's.ts");
        expect(expandPerFile("echo ${{file_basename}}", ctx, dangerousFile, null, { forShell: true })).toBe("echo 'it'\\''s'");
    });

    test("forShell: true shell-quotes ${{file_ext}}", () => {
        expect(expandPerFile("echo ${{file_ext}}", ctx, file, null, { forShell: true })).toBe("echo '.ts'");
    });

    test("forShell: true shell-quotes ${{file_dir}}", () => {
        const dangerousFile = makeChangedFile("/repo/it's/foo.ts");
        expect(expandPerFile("cd ${{file_dir}}", ctx, dangerousFile, null, { forShell: true })).toBe("cd '/repo/it'\\''s'");
    });

    test("forShell: true shell-quotes ${{group_dir}}", () => {
        expect(expandPerFile("cd ${{group_dir}}", ctx, file, "/repo/it's", { forShell: true })).toBe("cd '/repo/it'\\''s'");
    });

    test("forShell: false substitutes ${{file_path}} verbatim", () => {
        const dangerousFile = makeChangedFile("/repo/it's; rm -rf /");
        expect(expandPerFile("${{file_path}}", ctx, dangerousFile, null, { forShell: false })).toBe("/repo/it's; rm -rf /");
    });

    test("forShell: false substitutes ${{file_name}} verbatim", () => {
        const dangerousFile = makeChangedFile("/repo/it's bad.ts");
        expect(expandPerFile("${{file_name}}", ctx, dangerousFile, null, { forShell: false })).toBe("it's bad.ts");
    });

    test("forShell: false substitutes ${{file_basename}} verbatim", () => {
        const dangerousFile = makeChangedFile("/repo/it's.ts");
        expect(expandPerFile("${{file_basename}}", ctx, dangerousFile, null, { forShell: false })).toBe("it's");
    });

    test("forShell: false substitutes ${{file_ext}} verbatim", () => {
        expect(expandPerFile("${{file_ext}}", ctx, file, null, { forShell: false })).toBe(".ts");
    });

    test("forShell: false substitutes ${{file_dir}} verbatim", () => {
        const dangerousFile = makeChangedFile("/repo/it's/foo.ts");
        expect(expandPerFile("${{file_dir}}", ctx, dangerousFile, null, { forShell: false })).toBe("/repo/it's");
    });

    test("forShell: false substitutes ${{group_dir}} verbatim", () => {
        expect(expandPerFile("${{group_dir}}", ctx, file, "/repo/it's", { forShell: false })).toBe("/repo/it's");
    });

    test("forShell: true does not shell-quote ${{project}}", () => {
        const trickyCtx = makeContext("/path with spaces/repo");
        expect(expandPerFile("cd ${{project}}", trickyCtx, file, null, { forShell: true })).toBe("cd /path with spaces/repo");
    });

    test("throws when ${{group_dir}} appears but groupDir is null", () => {
        expect(() => expandPerFile("${{group_dir}}", ctx, file, null, { forShell: false })).toThrow();
    });

    test("throws when ${{group_dir}} appears under forShell: true but groupDir is null", () => {
        expect(() => expandPerFile("${{group_dir}}", ctx, file, null, { forShell: true })).toThrow();
    });
});

describe("findGroupDir", () => {
    test("returns the package directory for a deeply nested file", () => {
        expect(findGroupDir("packages/foo/src/lib/util.ts", "packages/*")).toBe("packages/foo");
    });

    test("returns the same package directory for a shallower file in the same package", () => {
        expect(findGroupDir("packages/foo/src/util.ts", "packages/*")).toBe("packages/foo");
    });

    test("strips a single trailing slash from the group_by pattern", () => {
        expect(findGroupDir("packages/foo/src/util.ts", "packages/*/")).toBe("packages/foo");
    });

    test("returns null when no segment prefix matches the pattern", () => {
        expect(findGroupDir("scripts/test.sh", "packages/*")).toBeNull();
    });

    test("returns the first matching prefix for a multi-segment glob", () => {
        expect(findGroupDir("packages/foo/src/lib/util.ts", "packages/*/src")).toBe("packages/foo/src");
    });

    test("returns null for a file with only one segment", () => {
        expect(findGroupDir("README.md", "packages/*")).toBeNull();
    });
});

describe("hasPerFileVariable", () => {
    test("is true when ${{file_path}} appears", () => {
        expect(hasPerFileVariable("cat ${{file_path}}")).toBe(true);
    });

    test("is true when ${{file_name}} appears", () => {
        expect(hasPerFileVariable("echo ${{file_name}}")).toBe(true);
    });

    test("is true when ${{file_basename}} appears", () => {
        expect(hasPerFileVariable("echo ${{file_basename}}")).toBe(true);
    });

    test("is true when ${{file_ext}} appears", () => {
        expect(hasPerFileVariable("echo ${{file_ext}}")).toBe(true);
    });

    test("is false when only ${{project}} appears", () => {
        expect(hasPerFileVariable("cd ${{project}}")).toBe(false);
    });

    test("is false when only ${{file_dir}} appears", () => {
        expect(hasPerFileVariable("cd ${{file_dir}}")).toBe(false);
    });

    test("is false when only ${{group_dir}} appears", () => {
        expect(hasPerFileVariable("cd ${{group_dir}}")).toBe(false);
    });

    test("is false for plain text without any variables", () => {
        expect(hasPerFileVariable("npm test")).toBe(false);
    });
});

describe("hasGroupDirVariable", () => {
    test("is true when ${{group_dir}} appears", () => {
        expect(hasGroupDirVariable("cd ${{group_dir}}")).toBe(true);
    });

    test("is false when ${{project}} appears", () => {
        expect(hasGroupDirVariable("cd ${{project}}")).toBe(false);
    });

    test("is false when ${{file_path}} appears", () => {
        expect(hasGroupDirVariable("cat ${{file_path}}")).toBe(false);
    });

    test("is false when ${{file_name}} appears", () => {
        expect(hasGroupDirVariable("echo ${{file_name}}")).toBe(false);
    });

    test("is false when ${{file_basename}} appears", () => {
        expect(hasGroupDirVariable("echo ${{file_basename}}")).toBe(false);
    });

    test("is false when ${{file_ext}} appears", () => {
        expect(hasGroupDirVariable("echo ${{file_ext}}")).toBe(false);
    });

    test("is false when ${{file_dir}} appears", () => {
        expect(hasGroupDirVariable("cd ${{file_dir}}")).toBe(false);
    });

    test("is false for plain text without any variables", () => {
        expect(hasGroupDirVariable("npm test")).toBe(false);
    });
});
