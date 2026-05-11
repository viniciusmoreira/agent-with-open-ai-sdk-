import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: [
      "lib/**/*.test.ts",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "lib/**/*.ts",
        "components/chat/**/*.{ts,tsx}",
        "components/upload-panel/**/*.{ts,tsx}",
        "scripts/smoke-helpers.ts",
      ],
      exclude: [
        "lib/**/*.test.ts",
        "lib/utils.ts",
        "components/chat/**/*.test.{ts,tsx}",
        "components/upload-panel/**/*.test.{ts,tsx}",
      ],
      reporter: ["text", "html"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
