import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const TMP_SUFFIX = ".tmp";

export async function writeJsonAtomic<T>(filePath: string, value: T): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const unique = randomBytes(8).toString("hex");
  const tmpPath = `${filePath}.${unique}${TMP_SUFFIX}`;
  const json = JSON.stringify(value);
  try {
    await writeFile(tmpPath, json, { encoding: "utf8" });
    await rename(tmpPath, filePath);
  } catch (cause) {
    await unlink(tmpPath).catch(() => undefined);
    throw cause;
  }
}

export async function readJsonIfPresent<T>(filePath: string): Promise<T | null> {
  if (filePath.endsWith(TMP_SUFFIX)) return null;
  try {
    const raw = await readFile(filePath, { encoding: "utf8" });
    return JSON.parse(raw) as T;
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
