/**
 * Stands in for Deepgram on a local port (no paid calls). One `ws` server
 * routes /v1/listen (speech to text) and /v1/speak (text to speech) by path,
 * the way api.deepgram.com does, and records what the sidecar sent.
 *
 * Speech to text answers only when the test calls `sendTranscript`. Text to
 * speech sends no audio until it receives Flush, as the real service does.
 */

import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeDeepgramOptions {
  /** Pieces of audio sent for each Flush, and how long to wait between them. */
  speechChunks?: number;
  /** Chunk count for a given text, overriding speechChunks (a short opening and a long reply). */
  chunksFor?: (text: string) => number;
  speechChunkMs?: number;
  /** When true, Clear is answered but audio already scheduled keeps coming (a stale tail). */
  ignoreClear?: boolean;
  /** The key the fake accepts. */
  apiKey: string;
}

export async function fakeDeepgram(options: FakeDeepgramOptions) {
  const speechChunks = options.speechChunks ?? 3;
  const speechChunkMs = options.speechChunkMs ?? 10;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const seen = {
    listenUrls: [] as string[],
    speakUrls: [] as string[],
    listenBytes: 0,
    spoken: [] as string[],
    flushes: 0,
    clears: 0,
    wrongKey: 0,
  };
  const listeners = new Set<WebSocket>();
  let transcriptCount = 0;

  wss.on("connection", (ws, req) => {
    const url = req.url ?? "";
    if (req.headers.authorization !== `Token ${options.apiKey}`) seen.wrongKey += 1;
    if (url.startsWith("/v1/listen")) {
      seen.listenUrls.push(url);
      listeners.add(ws);
      ws.on("message", (data, isBinary) => {
        if (isBinary) seen.listenBytes += (data as Buffer).length;
      });
      ws.on("close", () => listeners.delete(ws));
    } else if (url.startsWith("/v1/speak")) {
      seen.speakUrls.push(url);
      let pending = "";
      let epoch = 0;
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString()) as { type?: string; text?: string };
        if (m.type === "Speak") {
          seen.spoken.push(m.text ?? "");
          pending += m.text ?? "";
        } else if (m.type === "Flush") {
          seen.flushes += 1;
          if (!pending) return;
          const total = options.chunksFor?.(pending) ?? speechChunks;
          pending = "";
          const mine = epoch;
          let sent = 0;
          const tick = () => {
            if (ws.readyState !== ws.OPEN) return;
            if (!options.ignoreClear && mine !== epoch) return;
            if (sent < total) {
              // 100 milliseconds of a 440-ish square wave, 16-bit little-endian samples at 8 kilohertz.
              const pcm = Buffer.alloc(1600);
              for (let i = 0; i < 800; i += 1) pcm.writeInt16LE(i % 18 < 9 ? 6000 : -6000, i * 2);
              ws.send(pcm);
              sent += 1;
              setTimeout(tick, speechChunkMs);
            } else if (mine === epoch) {
              ws.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
            }
          };
          tick();
        } else if (m.type === "Clear") {
          seen.clears += 1;
          epoch += 1;
          pending = "";
          ws.send(JSON.stringify({ type: "Cleared", sequence_id: 0 }));
        } else if (m.type === "Close") {
          ws.close();
        }
      });
    } else {
      ws.close();
    }
  });

  const { port } = wss.address() as AddressInfo;
  return {
    /** What the sidecar takes as DEEPGRAM_BASE_URL. */
    baseUrl: `ws://127.0.0.1:${port}`,
    seen,
    get listening(): boolean {
      return listeners.size > 0;
    },
    /** A speech to text result as the real service would send it. */
    sendTranscript(transcript: string, flags: { final?: boolean; speechFinal?: boolean } = {}) {
      transcriptCount += 1;
      const message = {
        type: "Results",
        channel_index: [0, 1],
        duration: 1.0,
        start: transcriptCount,
        is_final: flags.final ?? true,
        speech_final: flags.speechFinal ?? true,
        channel: { alternatives: [{ transcript, confidence: 0.99, words: [] }] },
        metadata: { request_id: "fake", model_info: { name: "nova-3", version: "fake", arch: "nova" }, model_uuid: "fake" },
        from_finalize: false,
      };
      for (const ws of listeners) ws.send(JSON.stringify(message));
    },
    close: () =>
      new Promise<void>((r) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => r());
      }),
  };
}
