/**
 * Starts only the flows editor routes on 127.0.0.1, so the console Flow panel can be previewed
 * without the whole harness server. The runtime flow comes from VOICE_HARNESS_FLOW_FILE and the
 * interpreter from VOICE_HARNESS_PIPECAT_PYTHON, exactly as the routes read them; the catalog is
 * src/flow-tools/catalog.json when it exists (otherwise the routes answer 404 catalog_not_found).
 *
 *   PORT=4376 tsx scripts/flows-editor/routes-only-server.ts
 */
import { createServer } from "node:http";
import { handleFlowEditorRoute } from "../../src/server/flow-editor-routes.js";

const port = Number(process.env.PORT ?? 4376);

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  handleFlowEditorRoute(req.method ?? "GET", path, req, res)
    .then((handled) => {
      if (!handled) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      }
    })
    .catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`flows editor routes only: http://127.0.0.1:${port}`);
});
