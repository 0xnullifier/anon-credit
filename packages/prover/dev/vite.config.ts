// Vite configuration for the prover test page.
//
// The page is served from packages/prover/dev. The repository artifacts/ directory is the
// public directory, so /provekit-sample/... and /provekit-wasm/... are the built artifacts.
// Set PROVER_ISOLATED=1 to send COOP and COEP headers. The threaded build needs them.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const isolated = process.env["PROVER_ISOLATED"] === "1";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../../artifacts", import.meta.url)),
  // noir_js loads its WASM with new URL(..., import.meta.url). Pre-bundling breaks those URLs.
  optimizeDeps: { exclude: ["@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"] },
  worker: { format: "es" },
  server: {
    port: Number(process.env["PROVER_DEV_PORT"] ?? "5180"),
    strictPort: true,
    headers: isolated
      ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }
      : {},
  },
});
