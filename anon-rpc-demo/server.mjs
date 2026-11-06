// Tiny static server for the Anon-RPC demo. It has no framework.
// It serves the files in ./public and one config endpoint.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);

// The target RPC URL for the anonymized calls. Set RPC_URL to change it.
// Do not put an API key here. Use a public RPC.
const CONFIG = {
  rpcUrl: process.env.RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  worker: process.env.WORKER ?? "nox",
  bootstrapRpcUrl: process.env.BOOTSTRAP_RPC_URL ?? "",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/config.json") {
    res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
    res.end(JSON.stringify(CONFIG));
    return;
  }
  // Do not let the path go out of the public directory.
  const file = normalize(join(PUBLIC_DIR, path === "/" ? "index.html" : path));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`anon-rpc demo: http://localhost:${PORT}/`);
  console.log(`  default worker=${CONFIG.worker} rpcUrl=${CONFIG.rpcUrl}`);
  console.log("  Open the URL in a browser. Add ?worker=passthrough (or nym, tor-js) to change the worker.");
});
