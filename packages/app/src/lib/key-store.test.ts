import { memoryStorage, openEncryptedStore } from "@anon-credit/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createLocalKey, importLocalKey, listLocalKeys, normalizePrivateKey, readLocalKey, removeLocalKey, LOCAL_KEY_PREFIX } from "./key-store.ts";

// The public RFC test key of the anvil mnemonic (account 0). Test funds only.
const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("local key store", () => {
  it("stores a generated key encrypted and reads it back with the same passphrase", async () => {
    const adapter = memoryStorage();
    const store = await openEncryptedStore(adapter, { passphrase: "test-passphrase", iterations: 1000 });
    const made = await createLocalKey(store, 5);
    expect(made.origin).toBe("generated");
    expect(made.address).toBe(privateKeyToAccount(normalizePrivateKey(made.private_key)).address.toLowerCase());
    // The adapter holds only ciphertext.
    const raw = adapter.entries.get(`${LOCAL_KEY_PREFIX}${made.address}`);
    expect(raw).toBeDefined();
    expect(new TextDecoder().decode(raw)).not.toContain(made.private_key.slice(2, 20));
    const again = await openEncryptedStore(adapter, { passphrase: "test-passphrase" });
    expect(await readLocalKey(again, made.address)).toEqual(made);
    expect((await listLocalKeys(again)).map((item) => item.address)).toEqual([made.address]);
    // The SDK batch prefix does not see it.
    expect(await again.keys("batch/")).toEqual([]);
  });

  it("refuses a wrong passphrase", async () => {
    const adapter = memoryStorage();
    await openEncryptedStore(adapter, { passphrase: "right-passphrase", iterations: 1000 });
    await expect(openEncryptedStore(adapter, { passphrase: "wrong-passphrase" })).rejects.toThrow();
  });

  it("imports a typed key once, orders by creation, and removes", async () => {
    const store = await openEncryptedStore(memoryStorage(), { passphrase: "test-passphrase", iterations: 1000 });
    const first = await importLocalKey(store, ` ${ANVIL_KEY_0.toUpperCase().replace("0X", "0x")} `, 20);
    expect(first.origin).toBe("imported");
    expect(first.address).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    const made = await createLocalKey(store, 10);
    const same = await importLocalKey(store, ANVIL_KEY_0, 30);
    expect(same.created_at).toBe(20);
    expect((await listLocalKeys(store)).map((item) => item.created_at)).toEqual([10, 20]);
    await removeLocalKey(store, made.address);
    expect((await listLocalKeys(store)).map((item) => item.address)).toEqual([first.address]);
  });

  it("rejects text that is not a private key", () => {
    expect(() => normalizePrivateKey("0x1234")).toThrow();
    expect(normalizePrivateKey(ANVIL_KEY_0.slice(2))).toBe(ANVIL_KEY_0);
  });
});
