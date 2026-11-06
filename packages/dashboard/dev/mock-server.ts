// Mock of the gateway admin API and of the public endpoints that the dashboard reads.
// It replays the events of dev/fixtures/mock-admin.json. Development and tests only.
//
// Admin listener (bearer token, CORS for the dashboard origins):
//   GET /admin/v1/snapshot, GET /admin/v1/events (SSE, Last-Event-ID), GET /admin/v1/sessions/{id}
// Public listener (CORS, no credentials):
//   GET /v1/demo/peer (only with IP logging on), GET /v1/prices, GET /v1/roots
//
// The mock checks each fixture value with the protocol schemas. It keeps state like the
// gateway: counters by the same rules as crates/gateway/src/events.rs, and session state from
// the replayed debit events. The direct probe returns the real socket peer of the request.

import {
  adminSnapshotSchema,
  gatewayEventSchema,
  IP_UNAVAILABLE,
  pricesResponseSchema,
  rootsResponseSchema,
  sessionDetailSchema,
  sessionSummarySchema,
  type AdminSnapshot,
  type EventCounters,
  type GatewayEvent,
  type PricesResponse,
  type RootsResponse,
  type SessionDetail,
  type SessionSummary,
} from "@anon-credit/protocol";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_TOKEN = "mock-admin-token-0123456789";
const DEFAULT_FIXTURE = new URL("./fixtures/mock-admin.json", import.meta.url);
const DEFAULT_ORIGINS = ["http://localhost:5174", "http://127.0.0.1:5174"];
const MAX_EVENTS = 10_000;
const RESPONSE_RETENTION_SECONDS = 60;
const KEEP_ALIVE_MS = 15_000;
// Receipts in a session view: SESSION_RECEIPTS of crates/gateway/src/admin.rs.
const SESSION_RECEIPTS = 200;

export interface MockOptions {
  readonly adminPort?: number;
  readonly publicPort?: number;
  readonly host?: string;
  readonly token?: string;
  readonly ipLogging?: boolean;
  // Multiply each script delay by this factor.
  readonly speed?: number;
  // Replay on timers. Tests set false and call step().
  readonly autoplay?: boolean;
  // Number of script entries that the mock replays at start, with no delay.
  readonly prefill?: number;
  // Replay the script again after the end.
  readonly loop?: boolean;
  readonly origins?: readonly string[];
  readonly fixturePath?: URL | string;
}

type ScriptEntry = { readonly afterMs: number; readonly event: GatewayEvent } | { readonly afterMs: number; readonly raw: string };

interface Fixture {
  readonly base: AdminSnapshot;
  readonly epochSeconds: number;
  readonly sessions: ReadonlyMap<string, SessionSummary>;
  readonly prices: PricesResponse;
  readonly roots: RootsResponse;
  readonly script: readonly ScriptEntry[];
}

function fail(message: string): never {
  throw new Error(`mock fixture: ${message}`);
}

// A JSON value of the fixture file.
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

function objectAt(value: JsonValue | undefined, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${what} is not an object`);
  }
  return value;
}

function arrayAt(value: JsonValue | undefined, what: string): JsonValue[] {
  return Array.isArray(value) ? value : fail(`${what} is not an array`);
}

// Read and check the fixture file.
export function loadFixture(path: URL | string = DEFAULT_FIXTURE): Fixture {
  const root = objectAt(JSON.parse(readFileSync(path, "utf8")), "file");
  const gateway = objectAt(root["gateway"], "gateway");
  const epochSeconds = gateway["epoch_seconds"];
  if (typeof epochSeconds !== "number" || epochSeconds <= 0) {
    return fail("gateway.epoch_seconds is not a positive number");
  }
  const prices = pricesResponseSchema.parse(root["prices"]);
  const roots = rootsResponseSchema.parse(root["roots"]);
  const zero = { open_received: "0", open_rejected: "0", sessions_opened: "0", rpc_received: "0", rpc_completed: "0" };
  const base = adminSnapshotSchema.parse({
    status: gateway["status"],
    started_at: "0",
    now: "0",
    current_epoch: gateway["current_epoch"],
    deployment_id: gateway["deployment_id"],
    gateway_id: gateway["gateway_id"],
    upstream_chain_id: gateway["upstream_chain_id"],
    epoch_seconds: epochSeconds,
    circuit_id: gateway["circuit_id"],
    verifier_artifact_hash: gateway["verifier_artifact_hash"],
    demo_ip_logging: true,
    verifier: gateway["verifier"],
    price_table_hash: prices.price_table_hash,
    price_table: prices.price_table,
    roots: gateway["roots"],
    root_window_epochs: roots.root_window_epochs,
    accepted_roots: roots.roots,
    counters: { ...zero, rpc_replayed: "0", rpc_rejected: "0", upstream_failed: "0", storage_failed: "0", units_charged: "0" },
    sessions: { active: "0", exhausted: "0", expired: "0", units_charged: "0" },
    recent_events: [],
    recent_sessions: [],
  });
  const sessions = new Map<string, SessionSummary>();
  for (const value of arrayAt(root["sessions"], "sessions")) {
    const summary = sessionSummarySchema.parse(value);
    sessions.set(summary.session.batch_id, summary);
  }
  const script: ScriptEntry[] = arrayAt(root["script"], "script").map((value, index) => {
    const entry = objectAt(value, `script[${index}]`);
    const afterMs = entry["after_ms"];
    const raw = entry["raw"];
    if (typeof afterMs !== "number" || afterMs < 0) {
      return fail(`script[${index}].after_ms is not a number`);
    }
    switch (true) {
      case typeof raw === "string":
        return { afterMs, raw };
      case entry["event"] !== undefined:
        return { afterMs, event: gatewayEventSchema.parse(entry["event"]) };
      default:
        return fail(`script[${index}] has no event and no raw text`);
    }
  });
  return {
    base,
    epochSeconds,
    sessions,
    prices,
    roots,
    script,
  };
}

// One event in the ring: its ID and its SSE data text.
interface Frame {
  readonly id: bigint;
  readonly data: string;
  readonly event: GatewayEvent | null;
}

interface SessionRecord {
  summary: SessionSummary;
  receipts: SessionDetail["receipts"];
}

type CounterName = keyof EventCounters;

const COUNTER_NAMES: readonly CounterName[] = [
  "open_received",
  "open_rejected",
  "sessions_opened",
  "rpc_received",
  "rpc_completed",
  "rpc_replayed",
  "rpc_rejected",
  "upstream_failed",
  "storage_failed",
  "units_charged",
];

// The counter of an event, by the rules of the gateway event bus.
function counterOf(event: GatewayEvent): CounterName | null {
  switch (event.kind) {
    case "open_received":
      return "open_received";
    case "open_verified":
      return null;
    case "open_rejected":
      return "open_rejected";
    case "session_opened":
      return event.units === null ? null : "sessions_opened";
    case "rpc_received":
      return "rpc_received";
    case "rpc_completed":
      return "rpc_completed";
    case "rpc_replayed":
      return "rpc_replayed";
    case "rpc_rejected":
      return "rpc_rejected";
    case "upstream_failed":
      return "upstream_failed";
    case "storage_failed":
      return "storage_failed";
  }
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function digestHex(text: string): string {
  return `0x${createHash("sha256").update(text).digest("hex")}`;
}

// The batch ID of a template batch in a replay round. Round 0 uses the fixture ID. The first
// byte is 0x0f or less, so that the ID stays below the BN254 field modulus.
function roundBatchId(template: string, round: number): string {
  if (round === 0) {
    return template;
  }
  const digest = digestHex(`${template}:${round}`);
  return `0x0${digest.slice(3)}`;
}

// The state of the mock gateway.
export class MockGateway {
  readonly fixture: Fixture;
  readonly ipLogging: boolean;
  readonly startedAt = nowSeconds();
  // Paths of all requests, for the tests: the token must never be in one.
  readonly requestPaths: string[] = [];
  #frames: Frame[] = [];
  #nextId = 1n;
  #counters = new Map<CounterName, bigint>(COUNTER_NAMES.map((name) => [name, 0n]));
  #sessions = new Map<string, SessionRecord>();
  #subscribers = new Set<(frame: Frame) => void>();

  constructor(fixture: Fixture, ipLogging: boolean) {
    this.fixture = fixture;
    this.ipLogging = ipLogging;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  currentEpoch(): bigint {
    const elapsed = nowSeconds() - this.startedAt;
    return BigInt(this.fixture.base.current_epoch) + elapsed / BigInt(this.fixture.epochSeconds);
  }

  // Publish a script entry with the next ID and the current time. Each replay round of the
  // script uses new batch IDs, because a real gateway never opens a batch twice.
  publish(entry: ScriptEntry, round = 0): Frame {
    const id = this.#nextId;
    this.#nextId += 1n;
    let frame: Frame;
    if ("event" in entry) {
      const template = entry.event.batch_id;
      const batchId = template === null ? null : roundBatchId(template, round);
      const event = this.#observe({ ...entry.event, batch_id: batchId, id: id.toString(), at_ms: String(Date.now()) });
      this.#apply(event, template);
      frame = { id, data: JSON.stringify(event), event };
    } else {
      // A malformed event on purpose. The dashboard must discard and count it.
      frame = { id, data: entry.raw, event: null };
    }
    this.#frames.push(frame);
    if (this.#frames.length > MAX_EVENTS) {
      this.#frames.shift();
    }
    for (const subscriber of this.#subscribers) {
      subscriber(frame);
    }
    return frame;
  }

  // With IP logging off, the gateway does not read the peer address.
  #observe(event: GatewayEvent): GatewayEvent {
    return this.ipLogging ? event : { ...event, observed_ip: IP_UNAVAILABLE, ip_attribution: "unavailable", proxy_hop: null };
  }

  #apply(event: GatewayEvent, template: string | null): void {
    const counter = counterOf(event);
    if (counter !== null) {
      this.#counters.set(counter, (this.#counters.get(counter) ?? 0n) + 1n);
    }
    const batch = event.batch_id;
    if (batch === null) {
      return;
    }
    switch (event.kind) {
      case "session_opened": {
        const summary = template === null ? undefined : this.fixture.sessions.get(template);
        if (summary !== undefined && event.units !== null) {
          const opened = { ...summary, opened_at: nowSeconds().toString() };
          const openEpoch = this.currentEpoch();
          const session = {
            ...summary.session,
            batch_id: batch,
            open_epoch: openEpoch.toString(),
            deadline_epoch: (openEpoch + 35_040n).toString(),
          };
          this.#sessions.set(batch, { summary: { ...opened, session }, receipts: [] });
        }
        break;
      }
      case "rpc_completed": {
        const record = this.#sessions.get(batch);
        if (record === undefined || event.units === null || event.remaining === null || event.seq === null) {
          break;
        }
        this.#counters.set("units_charged", (this.#counters.get("units_charged") ?? 0n) + BigInt(event.units));
        const unitsTotal = (BigInt(record.summary.session.units_total) + BigInt(event.units)).toString();
        record.summary = {
          ...record.summary,
          session: {
            ...record.summary.session,
            remaining: event.remaining,
            units_total: unitsTotal,
            next_seq: (BigInt(event.seq) + 1n).toString(),
            state: event.remaining === 0 ? "exhausted" : "active",
          },
        };
        const receipt = {
          seq: event.seq,
          request_digest: digestHex(`${batch}:${event.seq}:${event.id}`),
          units: event.units,
          units_total: unitsTotal,
          committed_at: nowSeconds().toString(),
          response_retained: true,
        };
        record.receipts = [{ receipt, method: event.method ?? "unknown" }, ...record.receipts];
        break;
      }
      default:
        break;
    }
  }

  // Frames after an ID, oldest first.
  framesAfter(after: bigint): Frame[] {
    return this.#frames.filter((frame) => frame.id > after);
  }

  subscribe(subscriber: (frame: Frame) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  #withRetention(receipts: SessionDetail["receipts"]): SessionDetail["receipts"] {
    const now = nowSeconds();
    return receipts.map(({ receipt, method }) => ({
      receipt: { ...receipt, response_retained: BigInt(receipt.committed_at) + BigInt(RESPONSE_RETENTION_SECONDS) >= now },
      method,
    }));
  }

  snapshot(): AdminSnapshot {
    const now = nowSeconds();
    const counter = (name: CounterName): string => (this.#counters.get(name) ?? 0n).toString();
    const summaries = [...this.#sessions.values()].map((record) => record.summary).reverse();
    const states = { active: 0n, exhausted: 0n, expired: 0n };
    let unitsCharged = 0n;
    for (const summary of summaries) {
      states[summary.session.state] += 1n;
      unitsCharged += BigInt(summary.session.units_total);
    }
    const events: GatewayEvent[] = [];
    for (const frame of this.#frames.slice(-100)) {
      if (frame.event !== null) {
        events.push(frame.event);
      }
    }
    const base = this.fixture.base;
    return adminSnapshotSchema.parse({
      ...base,
      started_at: this.startedAt.toString(),
      now: now.toString(),
      current_epoch: this.currentEpoch().toString(),
      demo_ip_logging: this.ipLogging,
      roots: { ...base.roots, last_refresh_at: (now - (now % 10n)).toString() },
      counters: Object.fromEntries(COUNTER_NAMES.map((name) => [name, counter(name)])),
      sessions: {
        active: states.active.toString(),
        exhausted: states.exhausted.toString(),
        expired: states.expired.toString(),
        units_charged: unitsCharged.toString(),
      },
      recent_events: events,
      recent_sessions: summaries.slice(0, 50),
    });
  }

  session(batchId: string): SessionDetail | null {
    const record = this.#sessions.get(batchId);
    if (record === undefined) {
      return null;
    }
    return sessionDetailSchema.parse({ summary: record.summary, receipts: this.#withRetention(record.receipts).slice(0, SESSION_RECEIPTS) });
  }

  roots(): RootsResponse {
    return { ...this.fixture.roots, current_epoch: this.currentEpoch().toString() };
  }
}

function sendJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { code, message, retryable: false });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && expected.length > 0 && timingSafeEqual(given, expected);
}

// Set the CORS headers. Return true if the request was a preflight and is done.
function cors(request: IncomingMessage, response: ServerResponse, origins: readonly string[], admin: boolean): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && origins.includes(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    response.setHeader("access-control-allow-methods", "GET");
    response.setHeader("access-control-allow-headers", admin ? "authorization, content-type, last-event-id" : "content-type");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }
  return false;
}

function canonicalPeer(address: string | undefined): string {
  const text = address ?? "unknown";
  return text.startsWith("::ffff:") ? text.slice("::ffff:".length) : text;
}

function streamEvents(gateway: MockGateway, request: IncomingMessage, response: ServerResponse): void {
  const header = request.headers["last-event-id"];
  const text = typeof header === "string" ? header.trim() : "";
  const after = /^[0-9]+$/.test(text) ? BigInt(text) : 0n;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const write = (frame: Frame): void => {
    response.write(`id: ${frame.id}\ndata: ${frame.data}\n\n`);
  };
  for (const frame of gateway.framesAfter(after)) {
    write(frame);
  }
  const unsubscribe = gateway.subscribe(write);
  const keepAlive = setInterval(() => response.write(":\n\n"), KEEP_ALIVE_MS);
  const stop = (): void => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  request.on("close", stop);
  response.on("close", stop);
}

function adminHandler(gateway: MockGateway, token: string, origins: readonly string[]) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const path = request.url ?? "/";
    gateway.requestPaths.push(path);
    if (cors(request, response, origins, true)) {
      return;
    }
    if (!tokenMatches(request.headers.authorization, token)) {
      response.setHeader("www-authenticate", "Bearer");
      sendError(response, 401, "invalid_request", "admin token is required");
      return;
    }
    const sessionMatch = /^\/admin\/v1\/sessions\/([^/?]+)$/.exec(path);
    switch (true) {
      case request.method !== "GET":
        sendError(response, 405, "invalid_request", "method not allowed");
        return;
      case path === "/admin/v1/snapshot":
        sendJson(response, 200, gateway.snapshot());
        return;
      case path === "/admin/v1/events":
        streamEvents(gateway, request, response);
        return;
      case sessionMatch !== null: {
        const batchId = decodeURIComponent(sessionMatch?.[1] ?? "");
        if (!/^0x[0-9a-f]{64}$/.test(batchId)) {
          sendError(response, 400, "invalid_request", "batch_id is not canonical hex");
          return;
        }
        const detail = gateway.session(batchId);
        if (detail === null) {
          sendError(response, 404, "not_found", "unknown session");
          return;
        }
        sendJson(response, 200, detail);
        return;
      }
      default:
        sendError(response, 404, "not_found", "not found");
    }
  };
}

function publicHandler(gateway: MockGateway, origins: readonly string[]) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const path = request.url ?? "/";
    gateway.requestPaths.push(path);
    if (cors(request, response, origins, false)) {
      return;
    }
    switch (true) {
      case path === "/v1/demo/peer" && gateway.ipLogging:
        sendJson(response, 200, { observed_ip: canonicalPeer(request.socket.remoteAddress), attribution: "socket", proxy_hop: null });
        return;
      case path === "/v1/prices":
        sendJson(response, 200, gateway.fixture.prices);
        return;
      case path === "/v1/roots":
        sendJson(response, 200, gateway.roots());
        return;
      default:
        sendError(response, 404, "not_found", "not found");
    }
  };
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const info: AddressInfo | null = typeof address === "object" ? address : null;
      resolve(info?.port ?? port);
    });
  });
}

export interface RunningMock {
  readonly gateway: MockGateway;
  readonly adminUrl: string;
  readonly publicUrl: string;
  readonly token: string;
  // Publish the next script entry now. Return false at the end of a script without loop.
  step(): boolean;
  close(): Promise<void>;
}

// Start both listeners and the replay.
export async function startMock(options: MockOptions = {}): Promise<RunningMock> {
  const fixture = loadFixture(options.fixturePath);
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? MOCK_TOKEN;
  const origins = options.origins ?? DEFAULT_ORIGINS;
  const speed = options.speed ?? 1;
  const loop = options.loop ?? true;
  const gateway = new MockGateway(fixture, options.ipLogging ?? true);
  const admin = createServer(adminHandler(gateway, token, origins));
  const publicServer = createServer(publicHandler(gateway, origins));
  const adminPort = await listen(admin, options.adminPort ?? 8082, host);
  const publicPort = await listen(publicServer, options.publicPort ?? 8081, host);

  let index = 0;
  let round = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const step = (): boolean => {
    if (index >= fixture.script.length) {
      if (!loop) {
        return false;
      }
      index = 0;
      round += 1;
    }
    const entry = fixture.script[index];
    index += 1;
    if (entry !== undefined) {
      gateway.publish(entry, round);
    }
    return true;
  };
  const schedule = (): void => {
    const entry = fixture.script[index >= fixture.script.length ? 0 : index];
    if (closed || entry === undefined || (index >= fixture.script.length && !loop)) {
      return;
    }
    timer = setTimeout(() => {
      step();
      schedule();
    }, entry.afterMs * speed);
  };
  for (let i = 0; i < (options.prefill ?? 0); i += 1) {
    step();
  }
  if (options.autoplay ?? true) {
    schedule();
  }

  const close = async (): Promise<void> => {
    closed = true;
    clearTimeout(timer);
    admin.closeAllConnections();
    publicServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => admin.close(() => resolve())),
      new Promise<void>((resolve) => publicServer.close(() => resolve())),
    ]);
  };
  return {
    gateway,
    adminUrl: `http://${host}:${adminPort}`,
    publicUrl: `http://${host}:${publicPort}`,
    token,
    step,
    close,
  };
}
