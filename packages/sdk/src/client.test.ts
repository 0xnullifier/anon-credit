// SDK tests against the in-process fake gateway and issuer.

import { directTransport } from "@anon-credit/anon-transport";
import { spendRequestSchema } from "@anon-credit/protocol";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createClient, importBackup } from "./client.ts";
import { LostResultError, SdkError, ServiceError } from "./errors.ts";
import { batchRecordSchema } from "./state.ts";
import { indexedDbStorage, memoryStorage, openEncryptedStore } from "./storage.ts";
import { GATEWAY_URL, ISSUER_URL, MANIFEST_SHA, fakeServices } from "./test-support/fake-services.ts";
import { EPOCH_MS, fakeProver, issued, testClient } from "./test-support/client.ts";

function spendBodies(calls: readonly { path: string; body: string | undefined }[]): string[] {
  return calls.filter((call) => call.path === "/v1/rpc").map((call) => call.body ?? "");
}

describe("open and spend", () => {
  it("opens a batch and charges 1, 1, 2 units with sequences 0, 1, 2", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 3);
    if (first === undefined) throw new Error("no batch");
    const opened = await setup.client.open(first);
    expect(opened.existing).toBe(false);
    expect(opened.session.remaining).toBe(100);
    expect(opened.session.next_seq).toBe("0");

    const session = await setup.client.session(first);
    const a = await session.rpc("eth_chainId", []);
    const b = await session.rpc("eth_blockNumber", []);
    const c = await session.rpc("eth_getBalance", ["0x000000000000000000000000000000000000dead", "latest"]);
    expect([a.remaining, b.remaining, c.remaining]).toEqual([99, 98, 96]);
    expect([a.nextSeq, b.nextSeq, c.nextSeq]).toEqual([1n, 2n, 3n]);
    expect([a.seq, b.seq, c.seq]).toEqual([0n, 1n, 2n]);
    expect(c.unitsTotal).toBe(4n);
    expect(a.stateSource).toBe("headers");
    expect(a.replayed).toBe(false);
    expect(new TextDecoder().decode(Uint8Array.from(atob(a.request.rpc), (ch) => ch.charCodeAt(0)))).toBe(
      '{"jsonrpc":"2.0","id":0,"method":"eth_chainId","params":[]}',
    );

    // The exact first request again: the stored response, no new charge.
    const replay = await session.sendRaw(a.request);
    expect(replay.body).toBe(a.body);
    expect(replay.headers?.replayed).toBe(true);
    expect(replay.headers?.remaining).toBe(96);

    // The same sequence with a different body is rejected.
    const conflict = await session.sendRaw(session.buildRequest(0n, 1n, "eth_blockNumber", []));
    expect(conflict.errorCode).toBe("sequence_conflict");
    const gap = await session.sendRaw(session.buildRequest(9n, 5n, "eth_chainId", []));
    expect(gap.errorCode).toBe("sequence_gap");
    const status = await session.status();
    expect(status.session.remaining).toBe(96);
    expect(status.session.next_seq).toBe("3");
  });

  it("an exact open retry returns the existing session without a reset", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    const prepared = await setup.client.prepareOpen(first);
    await setup.client.submitOpen(first, prepared.request);
    await (await setup.client.session(first)).rpc("eth_chainId", []);
    const again = await setup.client.submitOpen(first, prepared.request);
    expect(again.existing).toBe(true);
    expect(again.session.remaining).toBe(99);
  });

  it("rejects a tampered proof and leaves no session", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    const prepared = await setup.client.prepareOpen(first);
    await expect(setup.client.submitOpen(first, { ...prepared.request, proof: "dGFtcGVyZWQ=" })).rejects.toMatchObject({
      serviceCode: "proof_invalid",
    });
    await expect(setup.client.status(first)).rejects.toMatchObject({ serviceCode: "not_found" });
    const opened = await setup.client.submitOpen(first, prepared.request);
    expect(opened.session.remaining).toBe(100);
  });

  it("exhausts a batch; a further spend fails without a sequence change", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    const session = await setup.client.session(first);
    for (let index = 0; index < 100; index += 1) await session.rpc("eth_chainId", []);
    expect(session.state.remaining).toBe(0);
    expect(session.state.state).toBe("exhausted");
    await expect(session.rpc("eth_chainId", [])).rejects.toMatchObject({ serviceCode: "insufficient_units" });
    expect(session.state.next_seq).toBe("100");
    expect(session.pending).toBeNull();
    expect((await session.status()).session.next_seq).toBe("100");
  });

  it("client.rpc opens the next batch when the current one has too few units", async () => {
    const setup = await testClient();
    const [first, second] = await issued(setup, 2);
    const one = await setup.client.rpc("eth_chainId", []);
    expect(one.remaining).toBe(99);
    expect(await setup.client.rotate()).toBe(first);
    const two = await setup.client.rpc("eth_blockNumber", []);
    expect(two.seq).toBe(0n);
    const summaries = await setup.client.batches();
    expect(summaries.find((batch) => batch.batchId === second)?.remaining).toBe(99);
    expect(summaries.find((batch) => batch.batchId === first)?.retired).toBe(true);
  });
});

describe("retry and recovery", () => {
  it("sends a lost request again with the same seq, bytes, and signature, and is charged once", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    const session = await setup.client.session(first);
    setup.fake.hooks.dropResponses = 1;
    const outcome = await session.rpc("eth_chainId", []);
    expect(outcome.attempts).toBe(2);
    expect(outcome.replayed).toBe(true);
    expect(outcome.remaining).toBe(99);
    const bodies = spendBodies(setup.fake.calls);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(spendRequestSchema.parse(JSON.parse(bodies[0] ?? "")).seq).toBe("0");
  });

  it("after response_expired, reads the status and reports the lost result without a new charge", async () => {
    const setup = await testClient({ retry: { attempts: 1, delayMs: 1 } });
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    const session = await setup.client.session(first);
    setup.fake.hooks.dropResponses = 1;
    await expect(session.rpc("eth_chainId", [])).rejects.toMatchObject({ code: "transport_failed" });
    expect(session.pending?.seq).toBe("0");
    await expect(session.rpc("eth_chainId", [])).rejects.toMatchObject({ code: "pending_request" });

    setup.fake.expireResponses();
    const error = await session.resume().then(
      () => null,
      (thrown: Error) => thrown,
    );
    expect(error).toBeInstanceOf(LostResultError);
    expect(error instanceof LostResultError ? error.receipt?.seq : null).toBe("0");
    expect(session.pending).toBeNull();
    expect(session.state.next_seq).toBe("1");
    expect(session.state.remaining).toBe(99);
    // No new charge: the status shows one request.
    expect((await session.status()).session.units_total).toBe("1");
  });

  it("retryAsNew sends the lost request as a new charged request", async () => {
    const setup = await testClient({ retry: { attempts: 1, delayMs: 1 } });
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    const session = await setup.client.session(first);
    setup.fake.hooks.dropResponses = 1;
    await expect(session.rpc("eth_blockNumber", [])).rejects.toBeInstanceOf(SdkError);
    setup.fake.expireResponses();
    const outcome = await session.resume({ retryAsNew: true });
    expect(outcome?.seq).toBe(1n);
    expect(outcome?.remaining).toBe(98);
    expect(outcome?.lostReceipt?.seq).toBe("0");
  });

  it("resumes the journaled request after a restart with the same bytes and signature", async () => {
    const fake = fakeServices();
    const storage = memoryStorage();
    const setup = await testClient({ storage }, fake);
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    fake.hooks.transportDown = true;
    await expect((await setup.client.session(first)).rpc("eth_getBalance", ["0x000000000000000000000000000000000000dead", "latest"])).rejects.toMatchObject({
      code: "transport_failed",
    });
    // The journal has the signed request before any byte reached the gateway.
    const store = await openEncryptedStore(storage, { passphrase: "test passphrase" });
    const record = await store.read(`batch/${first}`, batchRecordSchema);
    expect(record?.pending?.seq).toBe("0");
    expect(spendBodies(fake.calls)).toHaveLength(0);

    // A new client on the same storage resumes it.
    fake.hooks.transportDown = false;
    const restarted = await testClient({ storage }, fake);
    const outcomes = await restarted.client.resumePending();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.seq).toBe(0n);
    expect(outcomes[0]?.request.rpc).toBe(record?.pending?.rpc);
    expect(outcomes[0]?.request.signature).toBe(record?.pending?.signature);
    expect(outcomes[0]?.remaining).toBe(98);
    const next = await (await restarted.client.session(first)).rpc("eth_chainId", []);
    expect(next.seq).toBe(1n);
  });

  it("uses the signed status when the transport drops the X-Anon-* headers", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    setup.fake.hooks.omitHeaders = true;
    const outcome = await (await setup.client.session(first)).rpc("eth_getBalance", ["0x000000000000000000000000000000000000dead", "latest"]);
    expect(outcome.stateSource).toBe("status");
    expect(outcome.remaining).toBe(98);
    expect(outcome.nextSeq).toBe(1n);
    expect(outcome.replayed).toBeNull();
    expect(setup.fake.calls.at(-1)?.path).toBe("/v1/session/status");
  });

  it("does not keep a request that the gateway rejected before a charge", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    const session = await setup.client.session(first);
    await expect(session.rpc("eth_call", [])).rejects.toMatchObject({ code: "method_not_priced" });
    expect(session.pending).toBeNull();
  });
});

describe("isolation and transport", () => {
  it("uses one isolation key per batch and a distinct key for registry paths", async () => {
    const setup = await testClient();
    const [first, second] = await issued(setup, 2);
    if (first === undefined || second === undefined) throw new Error("no batch");
    await setup.client.open(first);
    await setup.client.open(second);
    await (await setup.client.session(first)).rpc("eth_chainId", []);
    await (await setup.client.session(second)).rpc("eth_chainId", []);
    await setup.client.status(first);
    const keysFor = (path: string) => new Set(setup.fake.calls.filter((call) => call.path === path).map((call) => call.isolationKey));
    expect(keysFor("/v1/open")).toEqual(new Set([first, second]));
    expect(keysFor("/v1/rpc")).toEqual(new Set([first, second]));
    expect(keysFor("/v1/session/status")).toEqual(new Set([first]));
    const pathKeys = setup.fake.calls.filter((call) => call.path.startsWith("/v1/tree/path/")).map((call) => call.isolationKey);
    expect(pathKeys).toEqual([`registry:${first}`, `registry:${second}`]);
    for (const call of setup.fake.calls.filter((item) => item.path === "/v1/open" || item.path === "/v1/rpc")) {
      expect(call.isolationKey.startsWith("registry:")).toBe(false);
    }
  });

  it("refuses a direct transport unless it is allowed by name", async () => {
    await expect(
      createClient({
        gatewayUrl: GATEWAY_URL,
        issuerUrl: ISSUER_URL,
        transport: directTransport(),
        prover: fakeProver(),
        storage: memoryStorage(),
        passphrase: "p",
        proverManifestSha256: MANIFEST_SHA,
      }),
    ).rejects.toMatchObject({ code: "direct_transport_refused" });
    const allowed = await testClient({ allowDirectTransport: true }, fakeServices("direct"));
    expect(allowed.client.transport.kind).toBe("direct");
  });

  it("never falls back to a direct fetch when the anonymous transport fails", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    const realFetch = globalThis.fetch;
    let direct = 0;
    globalThis.fetch = async () => {
      direct += 1;
      return new Response("{}");
    };
    try {
      setup.fake.hooks.transportDown = true;
      await expect((await setup.client.session(first)).rpc("eth_chainId", [])).rejects.toMatchObject({ code: "transport_failed" });
      await expect(setup.client.status(first)).rejects.toMatchObject({ code: "transport_failed" });
      expect(direct).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a prover manifest digest that the deployment does not pin", async () => {
    await expect(testClient({ proverManifestSha256: `0x${"cd".repeat(32)}` })).rejects.toMatchObject({ code: "deployment_mismatch" });
  });
});

describe("eligibility", () => {
  it("waits for the first-use delay, then uses a root that both services report", async () => {
    const progress: string[] = [];
    const setup = await testClient({ firstUseDelayEpochs: 2, onOpenProgress: (item) => progress.push(item.phase) });
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    const root = await setup.client.waitForEligibleRoot(first);
    expect(root.sourceEpoch).toBe(1001n);
    expect(Math.floor(setup.clock.nowMs() / EPOCH_MS)).toBe(1003);
    expect(progress).toEqual(["delay", "delay"]);
  });

  it("chooses the delay from the random source", async () => {
    const setup = await testClient({ firstUseDelayEpochs: "random", delayRandom: () => 0.99 });
    await issued(setup, 1);
    expect((await setup.client.batches())[0]?.delayEpochs).toBe(3);
  });
});

describe("storage and backup", () => {
  it("encrypts records, rejects a wrong passphrase, and works on IndexedDB", async () => {
    const storage = await indexedDbStorage({ name: "sdk-test", factory: new IDBFactory() });
    const setup = await testClient({ storage });
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    const store = await openEncryptedStore(storage, { passphrase: "test passphrase" });
    const record = await store.read(`batch/${first}`, batchRecordSchema);
    if (record === undefined) throw new Error("no record");
    const raw = new TextDecoder("latin1").decode(await storage.get(`batch/${first}`));
    expect(raw.includes(record.k.slice(2))).toBe(false);
    expect(raw.includes(record.session_secret.slice(2))).toBe(false);
    await expect(openEncryptedStore(storage, { passphrase: "wrong" })).rejects.toMatchObject({ code: "storage_locked" });
  });

  it("exports and imports a backup with a checksum", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 2);
    if (first === undefined) throw new Error("no batch");
    await setup.client.open(first);
    const backup = await setup.client.exportBackup();
    expect(backup.startsWith("acb1.")).toBe(true);
    const target = memoryStorage();
    expect(await importBackup(target, "other passphrase", backup, { kdfIterations: 1000 })).toBe(2);
    const restored = await testClient({ storage: target, passphrase: "other passphrase" }, setup.fake);
    const outcome = await (await restored.client.session(first)).rpc("eth_chainId", []);
    expect(outcome.remaining).toBe(99);
    const damaged = `${backup.slice(0, -6)}${backup.slice(-6) === "AAAAAA" ? "BBBBBB" : "AAAAAA"}`;
    await expect(importBackup(memoryStorage(), "p", damaged)).rejects.toMatchObject({ code: "backup_invalid" });
  });
});

describe("errors", () => {
  it("keeps the protocol code of a service error", () => {
    const error = new ServiceError("busy", 503, "busy", true);
    expect(error.code).toBe("service_error");
    expect(error.serviceCode).toBe("busy");
  });
});
