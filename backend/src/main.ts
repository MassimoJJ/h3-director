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

/**
 * One ComfyClient per ComfyUI address, rebuilt whenever Settings changes it.
 *
 * A single client created at startup froze the address for the whole process
 * life, so editing `comfyUrl` in Settings appeared to save but every route kept
 * talking to the old engine. Caching by URL keeps the connection reuse for the
 * common case while making a changed address take effect immediately.
 */
let comfyClient: ComfyClient | null = null;
let comfyClientUrl = "";
function getComfy(): ComfyClient {
  const url = loadSettings().comfyUrl;
  if (!comfyClient || comfyClientUrl !== url) {
    comfyClient = new ComfyClient(url);
    comfyClientUrl = url;
  }
  return comfyClient;
}

/** A live socket plus the liveness flag the heartbeat below maintains. */
type LiveSocket = WebSocket & { isAlive?: boolean };
const busClients = new Set<LiveSocket>();

const director = new Director(
  () => loadSettings(),
  () => new ComfyClient(loadSettings().comfyUrl),
  (event) => {
    const msg = JSON.stringify(event);
    for (const c of busClients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      // send() returns false once the socket's buffer is full. Without a check
      // a slow client grows an unbounded queue and the whole process slows down.
      if (c.bufferedAmount > 4 * 1024 * 1024) {
        busClients.delete(c);
        c.terminate();
        continue;
      }
      c.send(msg);
    }
  },
);

const app = buildApp({ director, getComfy });
const server = http.createServer(app);

// WebSocket hub for live job updates
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (wsRaw) => {
    const ws = wsRaw as LiveSocket;
    busClients.add(ws);
    // Without a heartbeat, a client whose machine slept or lost wifi stays in the
    // set as a half-open socket forever and still receives every event.
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    const drop = () => busClients.delete(ws);
    ws.on("close", drop);
    ws.on("error", drop);
    ws.send(JSON.stringify({ type: "hello", data: { comfyUrl: loadSettings().comfyUrl } }));
  });
});

const wsHeartbeat = setInterval(() => {
  for (const c of busClients) {
    if (c.isAlive === false) {
      busClients.delete(c);
      c.terminate();
      continue;
    }
    c.isAlive = false;
    c.ping();
  }
}, 30_000);
// Never hold the process open just for the heartbeat.
wsHeartbeat.unref();

server.listen(settings.port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`\n  H3 Director Studio running at http://127.0.0.1:${settings.port}`);
  console.log(`  ComfyUI engine: ${settings.comfyUrl}\n`);
});

process.on("uncaughtException", (e) => console.error("uncaught", e));

/**
 * A rejected promise with no handler is just as fatal as an uncaught throw in
 * Node 15+, and the render queue fires plenty of them: `void this.pumpRender()`
 * and the persistence calls around it are not wrapped, so a single failed
 * saveProject during a render killed the process mid-job. Log and keep serving.
 */
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});
