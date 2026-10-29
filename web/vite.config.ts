import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

// The dev server serves web/dist at "/". The microphone client and the shared live-view logic are
// imported from src/server so the browser bundle and the standalone voice page run the same code.
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": `${here}src` } },
  build: { outDir: `${here}dist`, emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4310", "/ws": { target: "ws://127.0.0.1:4310", ws: true } } },
});
