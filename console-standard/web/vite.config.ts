import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { configsPlugin } from "./configs-plugin";
import { flowProxyPlugin } from "./flow-proxy-plugin";

const PAGE_PORT = Number(process.env.CONSOLE_STANDARD_PAGE_PORT ?? 4351);
const BOT = `http://127.0.0.1:${process.env.CONSOLE_STANDARD_BOT_PORT ?? 4352}`;
// Only the two routes the console uses reach the bot; its other routes (documentation, status, webhooks) stay unexposed.
// A call starts only through /start (the Connect button) and then talks to its own session route.
const proxy = { "^/start(\\?.*)?$": BOT, "^/sessions/[0-9a-f-]{36}/api/offer(\\?.*)?$": BOT };
// Prompts panel: the prompt setup and agent instruction routes of the harness dev server (default 4311; a preview copy may use another port).
const HARNESS = process.env.CONSOLE_STANDARD_HARNESS_URL ?? "http://127.0.0.1:4311";
Object.assign(proxy, { "^/api/(prompt-setups|agent-instructions|lead-context)": HARNESS });
// The microphone is allowed for this page itself and for nothing else.
const headers = { "Permissions-Policy": "microphone=(self), camera=(), geolocation=()" };

// The page is served on 4351 and the bot on 4352, both on 127.0.0.1 only.
export default defineConfig({
  plugins: [react(), tailwindcss(), configsPlugin(PAGE_PORT), flowProxyPlugin({ pagePort: PAGE_PORT })],
  server: { headers, host: "127.0.0.1", port: PAGE_PORT, strictPort: true, proxy },
  preview: { headers, host: "127.0.0.1", port: PAGE_PORT, strictPort: true, proxy },
});
