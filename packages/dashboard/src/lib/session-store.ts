// Storage of the connection settings for one browser tab.
//
// The admin token is kept only in sessionStorage. It is never in localStorage or in a URL.
// Each storage call is in try/catch: a private window or blocked site data can throw. Then
// the dashboard works without storage and asks for the token again after a reload.

import type { Connection } from "./api.ts";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const TOKEN_KEY = "anon-credit.dashboard.admin-token";
const ADMIN_URL_KEY = "anon-credit.dashboard.admin-url";
const GATEWAY_URL_KEY = "anon-credit.dashboard.gateway-url";

export const DEFAULT_ADMIN_URL = "http://127.0.0.1:8082";
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8081";

// The sessionStorage of the tab, or null if the browser refuses it.
export function tabStorage(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(store: KeyValueStore | null, key: string): string | null {
  try {
    return store === null ? null : store.getItem(key);
  } catch {
    return null;
  }
}

function write(store: KeyValueStore | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Storage is not available. The value stays in memory only.
  }
}

function remove(store: KeyValueStore | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // Storage is not available. There is nothing to remove.
  }
}

export interface StoredSettings {
  readonly adminUrl: string;
  readonly gatewayUrl: string;
  readonly token: string | null;
}

// Read the stored settings. Use the defaults for URLs that are not stored.
export function loadSettings(store: KeyValueStore | null, defaults: { adminUrl: string; gatewayUrl: string }): StoredSettings {
  const token = read(store, TOKEN_KEY);
  return {
    adminUrl: read(store, ADMIN_URL_KEY) ?? defaults.adminUrl,
    gatewayUrl: read(store, GATEWAY_URL_KEY) ?? defaults.gatewayUrl,
    token: token === "" ? null : token,
  };
}

// Keep the connection settings for this tab.
export function saveConnection(store: KeyValueStore | null, connection: Connection): void {
  write(store, ADMIN_URL_KEY, connection.adminUrl);
  write(store, GATEWAY_URL_KEY, connection.gatewayUrl);
  write(store, TOKEN_KEY, connection.token);
}

// Remove the token. Keep the URLs.
export function forgetToken(store: KeyValueStore | null): void {
  remove(store, TOKEN_KEY);
}
