/** Ten ways to show the decision tree, served by the dev server at /tree-designs. Build with `pnpm build:designs`. */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "/tree-designs/",
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("./dist", import.meta.url)), emptyOutDir: true, sourcemap: false },
  server: { port: 4321, strictPort: true },
});
