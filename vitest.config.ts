import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The front end under web/ uses the "@" alias and the automatic JSX runtime; its tests run in jsdom.
  // The console package has its own node_modules; one copy of React keeps its panel tests and the testing library on the same renderer.
  resolve: { alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) }, dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts", "web/src/**/*.test.{ts,tsx}", "console-standard/web/src/flow/**/*.test.{ts,tsx}", "console-standard/web/src/conversation/**/*.test.{ts,tsx}", "console-standard/web/src/decision/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup-records.ts", "tests/setup-data.ts", "tests/setup-no-azure-listing.ts"],
  },
});
