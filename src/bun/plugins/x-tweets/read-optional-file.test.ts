import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOptionalFile } from "./index";

describe("readOptionalFile (file-contract read-back)", () => {
  test("returns '' for a missing file (ENOENT, never throws)", () => {
    const missing = join(tmpdir(), `detour-x-missing-${Date.now()}.txt`);
    expect(readOptionalFile(missing)).toBe("");
  });

  test("returns trimmed contents for an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "detour-x-read-"));
    try {
      const path = join(dir, "x-radar-latest.txt");
      writeFileSync(path, "  As of 2026-05-29: AI agents shipping\n", "utf8");
      expect(readOptionalFile(path)).toBe("As of 2026-05-29: AI agents shipping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns '' when the path is a directory (read fails, never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "detour-x-dir-"));
    try {
      expect(readOptionalFile(dir)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
