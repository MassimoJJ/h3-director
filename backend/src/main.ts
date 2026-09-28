import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp } from "./app";
import { ComfyClient } from "./comfy";
import { Director } from "./queue";
import { ensureDirs, loadSettings } from "./settings";
import { reconcileOrphanJobs } from "./store";

ensureDirs();
const settings = loadSettings();

// Any job still marked queued/running in the log was orphaned by the last exit.
const orphans = reconcileOrphanJobs();
if (orphans) {
  // eslint-disable-next-line no-console
  console.log(`  Recovered ${orphans} interrupted job(s) from a previous run.`);
}

const comfy = new ComfyClient(settings.comfyUrl);
const busClients = new Set<WebSocket>();

const director = new Director(
  () => loadSettings(),
  () => new ComfyClient(loadSettings().comfyUrl),
  (event) => {
    const msg = JSON.stringify(event);
    for (const c of busClients) {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
  },
);

const app = buildApp({ director, getComfy: () => comfy });
const server = http.createServer(app);

// WebSocket hub for live job updates
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    busClients.add(ws);
    ws.on("close", () => busClients.delete(ws));
    ws.on("error", () => busClients.delete(ws));
    ws.send(JSON.stringify({ type: "hello", data: { comfyUrl: loadSettings().comfyUrl } }));
  });
});

server.listen(settings.port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`\n  H3 Director Studio running at http://127.0.0.1:${settings.port}`);
  console.log(`  ComfyUI engine: ${settings.comfyUrl}\n`);
});

process.on("uncaughtException", (e) => console.error("uncaught", e));
