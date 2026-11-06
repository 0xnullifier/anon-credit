// HTTP helpers. Every response body goes through a protocol schema before the UI uses it.

// The fetch function. Tests give a fake one.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// A JSON value from JSON.parse.
export type Json = string | number | boolean | null | object;

export interface SchemaIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

// The part of a zod schema that the dashboard uses.
export interface Parser<T> {
  safeParse(value: Json):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: { readonly issues: readonly SchemaIssue[] } };
}

export type FailureKind = "unauthorized" | "not_found" | "http" | "invalid" | "network";

// A failed request. The message never has the admin token.
export class RequestFailure extends Error {
  readonly kind: FailureKind;
  readonly status: number | null;

  constructor(kind: FailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = "RequestFailure";
    this.kind = kind;
    this.status = status;
  }
}

// The global fetch, bound so that it can be called as a plain function.
export const browserFetch: FetchLike = (url, init) => fetch(url, init);

// Join a base URL and a path. Remove the slashes at the end of the base.
export function joinUrl(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, "")}${path}`;
}

// Short text of the first schema issue, for example "recent_events.3.kind: Invalid option".
export function issueText(issues: readonly SchemaIssue[]): string {
  const first = issues[0];
  if (first === undefined) {
    return "schema check failed";
  }
  const path = first.path.map((part) => String(part)).join(".");
  return path === "" ? first.message : `${path}: ${first.message}`;
}

export type JsonResult = { readonly ok: true; readonly value: Json } | { readonly ok: false };

// Parse JSON text. The result is not ok if the text is not JSON.
export function parseJson(text: string): JsonResult {
  try {
    const value: Json = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

// Check a JSON value with a schema. Throw RequestFailure("invalid") if it does not match.
export function check<T>(parser: Parser<T>, value: Json, what: string): T {
  const result = parser.safeParse(value);
  switch (result.success) {
    case true:
      return result.data;
    case false:
      throw new RequestFailure("invalid", `${what} does not match the protocol schema (${issueText(result.error.issues)})`);
  }
}

function statusFailure(status: number, what: string): RequestFailure {
  switch (status) {
    case 401:
      return new RequestFailure("unauthorized", `${what}: the gateway rejected the admin token (401)`, status);
    case 404:
      return new RequestFailure("not_found", `${what}: not found (404)`, status);
    default:
      return new RequestFailure("http", `${what}: HTTP ${status}`, status);
  }
}

// GET a JSON body and check it with the schema.
export async function getJson<T>(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  parser: Parser<T>,
  what: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, method: "GET", cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new RequestFailure("network", `${what}: network error or CORS refusal`);
  }
  if (!response.ok) {
    throw statusFailure(response.status, what);
  }
  const body = parseJson(await response.text());
  switch (body.ok) {
    case true:
      return check(parser, body.value, what);
    case false:
      throw new RequestFailure("invalid", `${what}: the body is not JSON`);
  }
}
