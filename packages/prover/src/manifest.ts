// The prover manifest: the pinned list of artifacts for one circuit.
//
// The client pins the SHA-256 digest of the manifest bytes in its own configuration.
// A manifest from a server does not establish its own trust. Each file entry pins the size
// and the SHA-256 digest of one artifact. Paths are relative to the manifest URL.

import { z } from "zod";
import { sha256Hex, sha256HexSchema } from "./digest.ts";
import { ProverError } from "./errors.ts";
import { fetchBytes, type FetchFunction } from "./artifacts.ts";

export const MANIFEST_FORMAT = "anon-credit/prover-manifest/v1";

// The manifest is small. A larger response is not a manifest.
const MAX_MANIFEST_BYTES = 64 * 1024;

export const fileEntrySchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256HexSchema,
    bytes: z.number().int().positive(),
  })
  .strict();

export type FileEntry = z.infer<typeof fileEntrySchema>;

export const proverManifestSchema = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    circuit: z.string().min(1),
    provekit: z
      .object({
        repo: z.string().min(1),
        rev: z.string().regex(/^[0-9a-f]{40}$/),
        // Only the hiding witness commitment is accepted.
        witnessMode: z.literal("zk"),
        hash: z.string().min(1),
      })
      .strict(),
    noir: z.string().min(1),
    numPublicInputs: z.number().int().nonnegative(),
    pkp: fileEntrySchema,
    pkv: fileEntrySchema,
    wasm: z
      .object({
        scalar: z.object({ glue: fileEntrySchema, binary: fileEntrySchema }).strict(),
        threaded: z
          .object({ glue: fileEntrySchema, binary: fileEntrySchema, helper: fileEntrySchema })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export type ProverManifest = z.infer<typeof proverManifestSchema>;

// Fetch a manifest, check its digest against the pinned digest, then parse it.
// The digest check happens before the JSON parse.
export async function loadManifest(
  fetchFn: FetchFunction,
  url: URL,
  expectedSha256: string,
): Promise<ProverManifest> {
  const pin = sha256HexSchema.safeParse(expectedSha256);
  if (!pin.success) {
    throw new ProverError("manifest_invalid", "the pinned manifest digest is not 64 lowercase hex digits");
  }
  const bytes = await fetchBytes(fetchFn, url, MAX_MANIFEST_BYTES);
  const actual = await sha256Hex(bytes);
  if (actual !== pin.data) {
    throw new ProverError("manifest_invalid", `manifest digest ${actual} is not the pinned digest ${pin.data}`);
  }
  return parseManifest(bytes);
}

export function parseManifest(bytes: Uint8Array): ProverManifest {
  let parsed: ReturnType<typeof proverManifestSchema.safeParse>;
  try {
    parsed = proverManifestSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    throw new ProverError("manifest_invalid", "manifest is not UTF-8 JSON", { cause: error });
  }
  if (!parsed.success) {
    throw new ProverError("manifest_invalid", `manifest is not valid: ${parsed.error.message}`);
  }
  return parsed.data;
}
