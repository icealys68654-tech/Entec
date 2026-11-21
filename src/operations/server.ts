import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { TagEngineClient } from "../tagengine/client";

const port = Number(process.env.ENTEC_DASHBOARD_PORT ?? 4173);
const host = process.env.ENTEC_DASHBOARD_HOST ?? "127.0.0.1";
const token = process.env.ENTEC_DASHBOARD_TOKEN;
const baseUrl = process.env.TAGENGINE_URL;
if (!baseUrl) throw new Error("TAGENGINE_URL is required");
if (host !== "127.0.0.1" && host !== "::1" && !token) throw new Error("ENTEC_DASHBOARD_TOKEN is required for non-loopback binding");
if (token !== undefined && !token.trim()) throw new Error("ENTEC_DASHBOARD_TOKEN must not be blank");

const client = new TagEngineClient({ baseUrl, apiToken: process.env.TAGENGINE_API_TOKEN });
const publicDir = path.resolve(__dirname, "../../public");
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" };

function authorized(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress || "";
  const loopback = address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
  if (!token) return loopback;
  const supplied = /^Bearer (.+)$/i.exec(req.headers.authorization || "")?.[1] || "";
  const a = Buffer.from(supplied), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (Buffer.byteLength(raw) > 16_384) { reject(new Error("Request body too large")); req.destroy(); } });
    req.on("end", () => { try { const parsed = raw ? JSON.parse(raw) : {}; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); resolve(parsed); } catch { reject(new Error("Invalid JSON body")); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
    const file = path.join(publicDir, name);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res); return;
  }
  if (!authorized(req)) { send(res, 401, { error: "Dashboard access token required" }); return; }
  try {
    if (req.method === "GET" && url.pathname === "/api/snapshots") {
      send(res, 200, { snapshots: await client.listSnapshots({ volumeId: url.searchParams.get("volumeId") || undefined, limit: Number(url.searchParams.get("limit") || 500) }) }); return;
    }
    if (req.method === "GET" && url.pathname === "/api/snapshot-comparisons") {
      send(res, 200, { comparisons: await client.listComparisons({ volumeId: url.searchParams.get("volumeId") || undefined, limit: Number(url.searchParams.get("limit") || 500) }) }); return;
    }
    const comparison = /^\/api\/snapshot-comparisons\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (req.method === "GET" && comparison) { send(res, 200, { comparison: await client.getComparison(comparison[1]) }); return; }
    if (req.method === "POST" && url.pathname === "/api/retention") {
      const input = await body(req);
      const dryRun = input.dryRun !== false;
      if (!dryRun && input.confirmation !== "DELETE EXPIRED DATA") { send(res, 400, { error: "Explicit deletion confirmation is required" }); return; }
      const retention = await client.runRetention({ retentionDays: Number(input.retentionDays), keepLatestPerVolume: Number(input.keepLatestPerVolume), dryRun });
      send(res, 200, { retention }); return;
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dashboard request failed";
    send(res, 502, { error: message });
  }
});
server.listen(port, host, () => console.log("Entec operations dashboard listening on http://" + host + ":" + port));
