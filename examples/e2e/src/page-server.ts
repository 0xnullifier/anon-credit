// Serve the end-to-end page with Vite. The repository artifacts/ directory is the public
// directory: /batch-open/prover-manifest.json and the files that it pins (the PKP and the WASM
// builds in /provekit-wasm/) are served from it. The digests in the manifest pin the bytes.
//
// With isolation on (the default), the server sends COOP and COEP headers, so the page is
// cross-origin isolated and the threaded prover can run. The page uses the scalar prover if
// the page is not isolated.

import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const MANIFEST_PATH = "/batch-open/prover-manifest.json";

export interface PageServer {
  readonly url: string;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

export async function startPageServer(port: number, isolated: boolean): Promise<PageServer> {
  const server: ViteDevServer = await createServer({
    configFile: false,
    logLevel: "warn",
    root: fileURLToPath(new URL("../browser", import.meta.url)),
    publicDir: fileURLToPath(new URL("../../../artifacts", import.meta.url)),
    // noir_js loads its WASM with new URL(..., import.meta.url). Pre-bundling breaks those URLs.
    optimizeDeps: { exclude: ["@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"] },
    worker: { format: "es" },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      headers: isolated
        ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }
        : {},
    },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  return { url: `${origin}/index.html`, origin, close: () => server.close() };
}
