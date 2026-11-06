// Persistent client storage.
//
// StorageAdapter is a plain key-value store of bytes. There are two adapters:
// - indexedDbStorage: IndexedDB in the browser (fake-indexeddb in Node tests).
// - memoryStorage: an in-memory map for tests.
//
// EncryptedStore encrypts every value with AES-GCM (256-bit key, 12-byte random IV). The key
// comes from the passphrase with PBKDF2-SHA-256 and a random 16-byte salt. The record key is
// the additional authenticated data, so a value cannot move to another key. The salt and the
// iteration count are in the plain "meta" record. The meta record also has an encrypted check
// value: a wrong passphrase fails at unlock, not at the first read.

import { decodeBase64, encodeBase64 } from "@anon-credit/protocol";
import { z } from "zod";
import { SdkError } from "./errors.ts";
import { webCryptoRandom, type RandomSource } from "./random.ts";

export interface StorageAdapter {
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  readonly put: (key: string, value: Uint8Array) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
  // All keys that start with `prefix`, in ascending order.
  readonly keys: (prefix: string) => Promise<string[]>;
}

export function memoryStorage(): StorageAdapter & { readonly entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    get: async (key) => entries.get(key),
    put: async (key, value) => {
      entries.set(key, new Uint8Array(value));
    },
    delete: async (key) => {
      entries.delete(key);
    },
    keys: async (prefix) => [...entries.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

const STORE_NAME = "records";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export interface IndexedDbOptions {
  // Database name. Use one database per deployment and client.
  readonly name: string;
  // IndexedDB factory. Default: globalThis.indexedDB.
  readonly factory?: IDBFactory;
}

// Open an IndexedDB adapter. Each write is one transaction that completes before the
// promise resolves, so a journal write is durable before the request is sent.
export async function indexedDbStorage(options: IndexedDbOptions): Promise<StorageAdapter> {
  const factory = options.factory ?? globalThis.indexedDB;
  const open = factory.open(options.name, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore(STORE_NAME);
  };
  const db = await requestResult(open);
  const bytesSchema = z.instanceof(Uint8Array);
  return {
    get: async (key) => {
      const value = await requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key));
      const parsed = bytesSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
    put: async (key, value) => {
      const transaction = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
      transaction.objectStore(STORE_NAME).put(new Uint8Array(value), key);
      await transactionDone(transaction);
    },
    delete: async (key) => {
      const transaction = db.transaction(STORE_NAME, "readwrite", { durability: "strict" });
      transaction.objectStore(STORE_NAME).delete(key);
      await transactionDone(transaction);
    },
    keys: async (prefix) => {
      const all = await requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAllKeys());
      return all
        .filter((key) => typeof key === "string")
        .map((key) => String(key))
        .filter((key) => key.startsWith(prefix))
        .sort();
    },
  };
}

// Default PBKDF2 iteration count (OWASP 2023 value for PBKDF2-HMAC-SHA256).
export const DEFAULT_KDF_ITERATIONS = 600_000;

const META_KEY = "meta";
const CHECK_TEXT = "anon-credit/storage-check/v1";
const IV_BYTES = 12;

const metaSchema = z.strictObject({
  format: z.literal("anon-credit/encrypted-store/v1"),
  kdf: z.literal("PBKDF2-SHA-256"),
  iterations: z.number().int().min(1000),
  salt: z.string(),
  check: z.string(),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function bufferCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bufferCopy(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(key: CryptoKey, aad: string, plain: Uint8Array, random: RandomSource): Promise<Uint8Array> {
  const iv = random(IV_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, bufferCopy(plain)),
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return out;
}

async function open(key: CryptoKey, aad: string, value: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bufferCopy(value.subarray(0, IV_BYTES)), additionalData: encoder.encode(aad) },
        key,
        bufferCopy(value.subarray(IV_BYTES)),
      ),
    );
  } catch {
    throw new SdkError("storage_locked", `cannot decrypt record ${aad}: wrong passphrase or damaged data`);
  }
}

export interface EncryptedStoreOptions {
  readonly passphrase: string;
  // PBKDF2 iterations for a new store. Default: DEFAULT_KDF_ITERATIONS. An existing store
  // keeps its own count.
  readonly iterations?: number;
  readonly random?: RandomSource;
}

// A JSON record store with encrypted values.
export interface EncryptedStore {
  // Read and validate one record. Return undefined if it does not exist.
  readonly read: <S extends z.ZodType>(key: string, schema: S) => Promise<z.output<S> | undefined>;
  // Write one record. The promise resolves after the adapter has stored it.
  readonly write: (key: string, value: object) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
  readonly keys: (prefix: string) => Promise<string[]>;
}

// Unlock (or create) the encrypted store on an adapter.
export async function openEncryptedStore(adapter: StorageAdapter, options: EncryptedStoreOptions): Promise<EncryptedStore> {
  const random = options.random ?? webCryptoRandom;
  if (options.passphrase.length === 0) throw new SdkError("storage_locked", "the storage passphrase is empty");
  const metaBytes = await adapter.get(META_KEY);
  let key: CryptoKey;
  switch (metaBytes) {
    case undefined: {
      const salt = random(16);
      const iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS;
      key = await deriveKey(options.passphrase, salt, iterations);
      const check = await seal(key, META_KEY, encoder.encode(CHECK_TEXT), random);
      const meta = {
        format: "anon-credit/encrypted-store/v1",
        kdf: "PBKDF2-SHA-256",
        iterations,
        salt: encodeBase64(salt),
        check: encodeBase64(check),
      };
      await adapter.put(META_KEY, encoder.encode(JSON.stringify(meta)));
      break;
    }
    default: {
      const meta = metaSchema.safeParse(JSON.parse(decoder.decode(metaBytes)));
      if (!meta.success) throw new SdkError("storage_locked", "the storage meta record is not valid");
      key = await deriveKey(options.passphrase, decodeBase64(meta.data.salt), meta.data.iterations);
      const check = decoder.decode(await open(key, META_KEY, decodeBase64(meta.data.check)));
      if (check !== CHECK_TEXT) throw new SdkError("storage_locked", "the storage check value is wrong");
    }
  }
  return {
    read: async (recordKey, schema) => {
      const value = await adapter.get(recordKey);
      if (value === undefined) return undefined;
      const plain = decoder.decode(await open(key, recordKey, value));
      const parsed = schema.safeParse(JSON.parse(plain));
      if (!parsed.success) throw new SdkError("storage_locked", `record ${recordKey} does not match its schema`);
      return parsed.data;
    },
    write: async (recordKey, value) => {
      if (recordKey === META_KEY) throw new SdkError("storage_locked", "the meta key is reserved");
      await adapter.put(recordKey, await seal(key, recordKey, encoder.encode(JSON.stringify(value)), random));
    },
    remove: (recordKey) => adapter.delete(recordKey),
    keys: async (prefix) => (await adapter.keys(prefix)).filter((recordKey) => recordKey !== META_KEY),
  };
}
