// Vite configuration for the customer app.
//
// The repository artifacts/ directory is the public directory: the page serves
// /batch-open/prover-manifest.json and the WASM files that it pins. The server sends COOP and
// COEP headers, so the page is cross-origin isolated and the threaded prover can run.

import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  publicDir: fileURLToPath(new URL("../../artifacts", import.meta.url)),
  // noir_js loads its WASM with new URL(..., import.meta.url). Pre-bundling breaks those URLs.
  optimizeDeps: { exclude: ["@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"] },
  worker: { format: "es" },
  server: { port: 5175, headers: isolationHeaders },
  preview: { port: 5175, headers: isolationHeaders },
});
