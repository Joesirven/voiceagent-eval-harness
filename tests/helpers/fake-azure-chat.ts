/**
 * Stands in for the Azure Foundry chat route on a local port: POST
 * /openai/v1/chat/completions answers with a streamed reply, and every request
 * body is kept so a test can see what the model was sent.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function fakeAzureChat(options: { apiKey: string; reply: (messages: ChatMessage[]) => string; delayMs?: number }) {
  const requests: Array<{ model: string; messages: ChatMessage[]; stream: boolean }> = [];
  let wrongKey = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url !== "/openai/v1/chat/completions" || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const key = req.headers["api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (key !== options.apiKey) wrongKey += 1;
      const parsed = JSON.parse(body) as { model: string; messages: ChatMessage[]; stream?: boolean };
      requests.push({ model: parsed.model, messages: parsed.messages, stream: parsed.stream === true });
      const text = options.reply(parsed.messages);
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const words = text.split(/(?<= )/);
        res.write(chunk({ role: "assistant", content: "" }, null));
        for (const word of words) res.write(chunk({ content: word }, null));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      }, options.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    /** What the sidecar takes as AZURE_FOUNDRY_URL. */
    url: `http://127.0.0.1:${port}/openai/v1`,
    requests,
    get wrongKey(): number {
      return wrongKey;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

export function messageText(m: ChatMessage): string {
  return typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("");
}
