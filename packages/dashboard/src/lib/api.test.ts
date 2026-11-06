// Tests of the admin and public API clients: token placement, schema checks, and failures.

import { describe, expect, it } from "vitest";
import { sharedDemoPeer, sharedPrices, sharedRoots, sharedSessionDetail, sharedSnapshot, type RecordedRequest } from "../testing/shared.ts";
import { fetchPrices, fetchRoots, fetchSession, fetchSnapshot, probePeer, type Connection } from "./api.ts";
import { RequestFailure, type FetchLike } from "./http.ts";

const TOKEN = "secret-admin-token-0123456789";
const connection: Connection = { adminUrl: "http://127.0.0.1:8082", gatewayUrl: "http://127.0.0.1:8081/", token: TOKEN };
const batchId = sharedSessionDetail.summary.session.batch_id;

// A fake fetch that records requests and answers with a JSON body.
function recorder(body: string | object, status = 200): { fetchFn: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, headers: new Headers(init.headers) });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status });
  };
  return { fetchFn, requests };
}

async function failureOf(promise: Promise<object>): Promise<RequestFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RequestFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("the request did not fail");
}

describe("admin api client", () => {
  it("gets and checks the snapshot with the token in the header only", async () => {
    const { fetchFn, requests } = recorder(sharedSnapshot);
    expect(await fetchSnapshot(fetchFn, connection)).toEqual(sharedSnapshot);
    expect(requests[0]?.url).toBe("http://127.0.0.1:8082/admin/v1/snapshot");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("gets a session by canonical batch ID", async () => {
    const { fetchFn, requests } = recorder(sharedSessionDetail);
    expect(await fetchSession(fetchFn, connection, batchId)).toEqual(sharedSessionDetail);
    expect(requests[0]?.url).toBe(`http://127.0.0.1:8082/admin/v1/sessions/${batchId}`);
  });

  it("refuses a batch ID that is not canonical hex without a request", async () => {
    const { fetchFn, requests } = recorder(sharedSessionDetail);
    const failure = await failureOf(fetchSession(fetchFn, connection, "0xABC/../snapshot"));
    expect(failure.kind).toBe("invalid");
    expect(requests).toHaveLength(0);
  });

  it("never puts the token in a request URL", async () => {
    const all: RecordedRequest[] = [];
    const bodies = [sharedSnapshot, sharedSessionDetail, sharedDemoPeer, sharedPrices, sharedRoots];
    for (const body of bodies) {
      const { fetchFn, requests } = recorder(body);
      await Promise.allSettled([
        fetchSnapshot(fetchFn, connection),
        fetchSession(fetchFn, connection, batchId),
        probePeer(fetchFn, connection.gatewayUrl),
        fetchPrices(fetchFn, connection.gatewayUrl),
        fetchRoots(fetchFn, connection.gatewayUrl),
      ]);
      all.push(...requests);
    }
    expect(all.length).toBe(25);
    for (const request of all) {
      expect(request.url).not.toContain(TOKEN);
      expect(decodeURIComponent(request.url)).not.toContain(TOKEN);
    }
  });

  it("sends no token to the public gateway", async () => {
    const { fetchFn, requests } = recorder(sharedDemoPeer);
    expect(await probePeer(fetchFn, connection.gatewayUrl)).toEqual(sharedDemoPeer);
    expect(requests[0]?.url).toBe("http://127.0.0.1:8081/v1/demo/peer");
    expect(requests[0]?.headers.get("authorization")).toBeNull();
  });

  it("rejects a snapshot that does not match the schema", async () => {
    const { fetchFn } = recorder({ ...sharedSnapshot, counters: { ...sharedSnapshot.counters, units_charged: 5 } });
    const failure = await failureOf(fetchSnapshot(fetchFn, connection));
    expect(failure.kind).toBe("invalid");
    expect(failure.message).toContain("counters.units_charged");
  });

  it("rejects a body that is not JSON and a snapshot with an unknown field", async () => {
    expect((await failureOf(fetchSnapshot(recorder("<html>").fetchFn, connection))).kind).toBe("invalid");
    const extra = recorder({ ...sharedSnapshot, admin_token: TOKEN });
    expect((await failureOf(fetchSnapshot(extra.fetchFn, connection))).kind).toBe("invalid");
  });

  it("maps 401, 404, and network failures", async () => {
    expect((await failureOf(fetchSnapshot(recorder("", 401).fetchFn, connection))).kind).toBe("unauthorized");
    expect((await failureOf(fetchSession(recorder("", 404).fetchFn, connection, batchId))).kind).toBe("not_found");
    const offline: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect((await failureOf(probePeer(offline, connection.gatewayUrl))).kind).toBe("network");
  });
});
