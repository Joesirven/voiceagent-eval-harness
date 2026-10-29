/**
 * The spot-check page: one clip at a time, the labels we assigned with each
 * turn's text, and two buttons. Loopback only (127.0.0.1:4315); reads clips and
 * the manifest from SPOT_DIR and writes answers to SPOT_DIR/answers.json (0600).
 * Usage: SPOT_DIR=<dir> node scripts/spot-check-page.mjs
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.SPOT_DIR;
if (!dir) throw new Error("set SPOT_DIR");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const answersFile = join(dir, "answers.json");
const answers = existsSync(answersFile) ? JSON.parse(readFileSync(answersFile, "utf8")) : {};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page() {
  const next = manifest.clips.find((c) => !(c.n in answers));
  const done = Object.keys(answers).length;
  if (!next) return `<!doctype html><meta charset=utf-8><title>Spot check</title><body style="font:18px system-ui;max-width:640px;margin:40px auto"><h1>Done</h1><p>${done} of ${manifest.clips.length} answered. Thank you.</p>`;
  const turns = next.turns.map((t) => `<li><b>${t.label === "producer" ? "Producer says" : "Lead says"}:</b> ${esc(t.text)}</li>`).join("");
  return `<!doctype html><meta charset=utf-8><title>Spot check ${next.n}</title>
<body style="font:18px system-ui;max-width:640px;margin:40px auto">
<p>Clip ${done + 1} of ${manifest.clips.length}</p>
<audio controls autoplay src="/clip/${next.n}" style="width:100%"></audio>
<ul>${turns}</ul>
<form method=post action="/answer/${next.n}" style="display:flex;gap:12px">
<button name=a value=right style="font:20px system-ui;padding:12px 24px">Labels right</button>
<button name=a value=wrong style="font:20px system-ui;padding:12px 24px">Labels wrong</button>
</form>`;
}

const server = createServer((req, res) => {
  const host = (req.headers.host ?? "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") return res.writeHead(403).end();
  const clip = req.url?.match(/^\/clip\/(\d{1,2})$/);
  if (req.method === "GET" && clip) {
    const c = manifest.clips.find((x) => x.n === Number(clip[1]));
    if (!c) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
    return res.end(readFileSync(join(dir, c.clipFile)));
  }
  const ans = req.url?.match(/^\/answer\/(\d{1,2})$/);
  if (req.method === "POST" && ans) {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const a = new URLSearchParams(body).get("a");
      if ((a === "right" || a === "wrong") && manifest.clips.some((x) => x.n === Number(ans[1]))) {
        answers[ans[1]] = a;
        writeFileSync(answersFile, JSON.stringify(answers, null, 2), { mode: 0o600 });
      }
      res.writeHead(303, { location: "/" }).end();
    });
    return;
  }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(page());
  }
  res.writeHead(404).end();
});
server.listen(4315, "127.0.0.1", () => console.log("spot check on http://127.0.0.1:4315/"));
