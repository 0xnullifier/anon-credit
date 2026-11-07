// JSON requests to the gateway and the issuer over a transport. Every response is checked
// with a zod schema. Error bodies become ServiceError with the stable protocol code.

import type { Transport, TransportRequestInit } from "@anon-credit/anon-transport";
import { gatewayErrorBodySchema } from "@anon-credit/protocol";
import type { z } from "zod";
import { SdkError, ServiceError, messageOf } from "./errors.ts";

export interface Endpoint {
  readonly transport: Transport;
  // Base URL without a trailing slash.
  readonly baseUrl: string;
}

// Size of a request body for an error message. Empty for no body and for a stream.
function bodySize(body: TransportRequestInit["body"]): string {
  switch (true) {
    case typeof body === "string":
      return ` (body ${body.length} bytes)`;
    case body instanceof Uint8Array:
      return ` (body ${body.byteLength} bytes)`;
    default:
      return "";
  }
}

// Send a request. Throw SdkError "transport_failed" if the transport fails.
export async function send(endpoint: Endpoint, path: string, init: TransportRequestInit, isolationKey: string): Promise<Response> {
  try {
    return await endpoint.transport.fetch(`${endpoint.baseUrl}${path}`, init, { isolationKey });
  } catch (error) {
    throw new SdkError("transport_failed", `request to ${path}${bodySize(init.body)} failed: ${messageOf(error)}`);
  }
}

// Read an error response as ServiceError. A body without the error schema is invalid_response.
export async function serviceError(response: Response): Promise<SdkError> {
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return new SdkError("invalid_response", `HTTP ${response.status} without a JSON error body`);
  }
  const body = gatewayErrorBodySchema.safeParse(json);
  if (!body.success) return new SdkError("invalid_response", `HTTP ${response.status} with an error body that is not valid`);
  return new ServiceError(body.data.code, response.status, body.data.message, body.data.retryable, body.data.receipt);
}

// Read a successful JSON body with `schema`, or throw the error of the response.
export async function readJson<S extends z.ZodType>(response: Response, schema: S, what: string): Promise<z.output<S>> {
  if (!response.ok) throw await serviceError(response);
  let json;
  try {
    json = await response.json();
  } catch {
    throw new SdkError("invalid_response", `${what}: the body is not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new SdkError("invalid_response", `${what}: ${parsed.error.message}`);
  return parsed.data;
}

export const JSON_HEADERS: Readonly<Record<string, string>> = { "content-type": "application/json" };
export const OCTET_HEADERS: Readonly<Record<string, string>> = { "content-type": "application/octet-stream" };

export async function getJson<S extends z.ZodType>(endpoint: Endpoint, path: string, schema: S, isolationKey: string): Promise<z.output<S>> {
  return readJson(await send(endpoint, path, { method: "GET" }, isolationKey), schema, `GET ${path}`);
}

export async function postJson<S extends z.ZodType>(
  endpoint: Endpoint,
  path: string,
  body: object,
  schema: S,
  isolationKey: string,
): Promise<z.output<S>> {
  const response = await send(endpoint, path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, isolationKey);
  return readJson(response, schema, `POST ${path}`);
}
