// Local key pairs of the app. A key is a plain secp256k1 private key made in the browser. It is
// stored in the same encrypted store as the batch secrets (AES-256-GCM per record, the record
// key as additional data, PBKDF2 key from the passphrase; packages/sdk/src/storage.ts). The
// records use the prefix "app/", so the SDK (prefix "batch/") and the backup never read them.

import type { EncryptedStore } from "@anon-credit/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

export const LOCAL_KEY_PREFIX = "app/local-key/";

const privateKeySchema = z.string().regex(/^0x[0-9a-f]{64}$/, "a private key is 0x and 64 hex digits");
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);

export const localKeyRecordSchema = z.strictObject({
  // Lowercase address of the key. Also the record key suffix.
  address: addressSchema,
  // Secret.
  private_key: privateKeySchema,
  // Unix milliseconds of the creation or the import.
  created_at: z.number().int().nonnegative(),
  // "generated" or "imported".
  origin: z.enum(["generated", "imported"]),
});
export type LocalKeyRecord = z.output<typeof localKeyRecordSchema>;

export function localKeyRecordKey(address: string): string {
  return `${LOCAL_KEY_PREFIX}${address.toLowerCase()}`;
}

// Normalize a typed private key: trim, lowercase, add the 0x prefix. Throw if it is not a key.
export function normalizePrivateKey(text: string): `0x${string}` {
  const trimmed = text.trim().toLowerCase();
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  const parsed = privateKeySchema.safeParse(withPrefix);
  if (!parsed.success) throw new Error("a private key is 0x and 64 hex digits");
  return `0x${parsed.data.slice(2)}`;
}

export async function listLocalKeys(store: EncryptedStore): Promise<LocalKeyRecord[]> {
  const out: LocalKeyRecord[] = [];
  for (const key of await store.keys(LOCAL_KEY_PREFIX)) {
    const record = await store.read(key, localKeyRecordSchema);
    if (record !== undefined) out.push(record);
  }
  return out.sort((a, b) => a.created_at - b.created_at);
}

async function storeKey(store: EncryptedStore, privateKey: `0x${string}`, origin: LocalKeyRecord["origin"], now: number): Promise<LocalKeyRecord> {
  const address = privateKeyToAccount(privateKey).address.toLowerCase();
  const known = await store.read(localKeyRecordKey(address), localKeyRecordSchema);
  if (known !== undefined) return known;
  const record: LocalKeyRecord = { address, private_key: privateKey, created_at: now, origin };
  await store.write(localKeyRecordKey(address), record);
  return record;
}

// Make a fresh key pair with viem (crypto.getRandomValues) and store it.
export function createLocalKey(store: EncryptedStore, now: number = Date.now()): Promise<LocalKeyRecord> {
  return storeKey(store, generatePrivateKey(), "generated", now);
}

// Store a typed private key. A key that is already stored is returned as it is.
export function importLocalKey(store: EncryptedStore, text: string, now: number = Date.now()): Promise<LocalKeyRecord> {
  return storeKey(store, normalizePrivateKey(text), "imported", now);
}

export async function readLocalKey(store: EncryptedStore, address: string): Promise<LocalKeyRecord | undefined> {
  return store.read(localKeyRecordKey(address), localKeyRecordSchema);
}

export function removeLocalKey(store: EncryptedStore, address: string): Promise<void> {
  return store.remove(localKeyRecordKey(address));
}
