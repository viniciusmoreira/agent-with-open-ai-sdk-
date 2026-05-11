import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stubUrl = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "server-only-stub.mjs",
  ),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: stubUrl, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
