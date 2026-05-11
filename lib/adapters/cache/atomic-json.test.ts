import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readJsonIfPresent, TMP_SUFFIX, writeJsonAtomic } from "./atomic-json";

describe("writeJsonAtomic", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "atomic-json-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("creates the target directory and writes the serialized object", async () => {
    const target = path.join(workDir, "nested", "data.json");
    await writeJsonAtomic(target, { hello: "world", n: 1 });
    const raw = await readFile(target, "utf8");
    expect(JSON.parse(raw)).toEqual({ hello: "world", n: 1 });
  });

  it("leaves no .tmp file behind on a successful write", async () => {
    const target = path.join(workDir, "data.json");
    await writeJsonAtomic(target, { ok: true });
    const entries = await readdir(workDir);
    expect(entries).toContain("data.json");
    expect(entries.some((e) => e.endsWith(TMP_SUFFIX))).toBe(false);
  });

  it("rejects and leaves no .tmp file when the target path is unwritable", async () => {
    const target = path.join(workDir, "blocked");
    await mkdir(target, { recursive: true });
    await expect(writeJsonAtomic(target, { x: 1 })).rejects.toBeInstanceOf(Error);
    const entries = await readdir(workDir);
    expect(entries.some((e) => e.endsWith(TMP_SUFFIX))).toBe(false);
  });
});

describe("readJsonIfPresent", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "atomic-json-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns null for a missing file", async () => {
    const result = await readJsonIfPresent(path.join(workDir, "missing.json"));
    expect(result).toBeNull();
  });

  it("returns the parsed object for a present file", async () => {
    const target = path.join(workDir, "present.json");
    await writeFile(target, JSON.stringify({ a: 1, b: [2, 3] }), "utf8");
    const result = await readJsonIfPresent<{ a: number; b: number[] }>(target);
    expect(result).toEqual({ a: 1, b: [2, 3] });
  });

  it("returns null when asked for a .tmp path", async () => {
    const target = path.join(workDir, "leftover.tmp");
    await writeFile(target, JSON.stringify({ partial: true }), "utf8");
    const result = await readJsonIfPresent(target);
    expect(result).toBeNull();
  });

  it("rethrows non-ENOENT errors (e.g. EISDIR when the path is a directory)", async () => {
    const target = path.join(workDir, "is-a-dir");
    await mkdir(target);
    await expect(readJsonIfPresent(target)).rejects.toBeInstanceOf(Error);
  });
});

describe("atomic-json integration", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "atomic-json-int-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("round-trips byte-equal JSON via writeJsonAtomic + readJsonIfPresent", async () => {
    const target = path.join(workDir, "round-trip.json");
    const value = {
      str: "hello",
      arr: [1, 2, 3],
      nested: { flag: true, list: ["a", "b"] },
    };
    await writeJsonAtomic(target, value);
    const got = await readJsonIfPresent<typeof value>(target);
    expect(JSON.stringify(got)).toBe(JSON.stringify(value));
  });

  it("survives concurrent writes to the same path without corruption", async () => {
    const target = path.join(workDir, "concurrent.json");
    const writers = Array.from({ length: 16 }, (_, i) =>
      writeJsonAtomic(target, { writer: i, payload: "x".repeat(2048) }),
    );
    await Promise.all(writers);
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { writer: number; payload: string };
    expect(parsed.writer).toBeGreaterThanOrEqual(0);
    expect(parsed.writer).toBeLessThan(16);
    expect(parsed.payload).toBe("x".repeat(2048));
    const entries = await readdir(workDir);
    expect(entries.filter((e) => e.endsWith(TMP_SUFFIX))).toHaveLength(0);
  });
});
