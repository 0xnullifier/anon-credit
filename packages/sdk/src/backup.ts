// Backup string: the deployment identity and every batch record (batch secret, session key,
// leaf metadata, open request, session state, and pending request). Paths are not in the
// backup; the client fetches them again.
//
// Format: "acb1." + base64(payload | checksum). payload is UTF-8 JSON. checksum is the first
// 4 bytes of keccak256(payload). The string has secrets: keep it as private as the passphrase.

import { decodeBase64, encodeBase64 } from "@anon-credit/protocol";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";
import { SdkError } from "./errors.ts";
import { batchRecordSchema, deploymentRecordSchema, type BatchRecord, type DeploymentRecord } from "./state.ts";

export const BACKUP_PREFIX = "acb1.";
const CHECKSUM_BYTES = 4;

export const backupSchema = z.strictObject({
  format: z.literal("anon-credit/backup/v1"),
  deployment: deploymentRecordSchema,
  batches: z.array(batchRecordSchema),
});
export type Backup = z.output<typeof backupSchema>;

function checksum(payload: Uint8Array): Uint8Array {
  return keccak_256(payload).subarray(0, CHECKSUM_BYTES);
}

export function encodeBackup(deployment: DeploymentRecord, batches: readonly BatchRecord[]): string {
  const payload = new TextEncoder().encode(JSON.stringify({ format: "anon-credit/backup/v1", deployment, batches }));
  const out = new Uint8Array(payload.length + CHECKSUM_BYTES);
  out.set(payload, 0);
  out.set(checksum(payload), payload.length);
  return `${BACKUP_PREFIX}${encodeBase64(out)}`;
}

export function decodeBackup(text: string): Backup {
  if (!text.startsWith(BACKUP_PREFIX)) throw new SdkError("backup_invalid", "the backup does not start with acb1.");
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(text.slice(BACKUP_PREFIX.length).trim());
  } catch {
    throw new SdkError("backup_invalid", "the backup is not canonical base64");
  }
  if (bytes.length <= CHECKSUM_BYTES) throw new SdkError("backup_invalid", "the backup is too short");
  const payload = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
  const expected = checksum(payload);
  const actual = bytes.subarray(bytes.length - CHECKSUM_BYTES);
  if (expected.some((byte, index) => byte !== actual[index])) throw new SdkError("backup_invalid", "the backup checksum is wrong");
  let json;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new SdkError("backup_invalid", "the backup payload is not JSON");
  }
  const parsed = backupSchema.safeParse(json);
  if (!parsed.success) throw new SdkError("backup_invalid", `the backup payload is not valid: ${parsed.error.message}`);
  return parsed.data;
}
