// Random bytes and the clock. Tests inject their own.

// Random bytes from WebCrypto.
export type RandomSource = (length: number) => Uint8Array<ArrayBuffer>;

export const webCryptoRandom: RandomSource = (length) => {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
};

export interface Clock {
  // Unix time in milliseconds.
  readonly nowMs: () => number;
  // Wait for `ms` milliseconds.
  readonly sleep: (ms: number) => Promise<void>;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// The epoch of a Unix time: floor(seconds / epoch_seconds).
export function epochAt(nowMs: number, epochSeconds: number): bigint {
  return BigInt(Math.floor(nowMs / 1000 / epochSeconds));
}
