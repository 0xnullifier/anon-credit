// Display formats. All times are UTC.

// Event time from Unix milliseconds (decimal text): "2026-11-07 12:34:56.123".
export function utcFromMs(ms: string): string {
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? ms : date.toISOString().replace("T", " ").replace("Z", "");
}

// Time from Unix seconds (decimal text): "2026-11-07 12:34:56".
export function utcFromSeconds(seconds: string): string {
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? seconds : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// Short form of a 0x hex ID: "0x0a4352…8861".
export function shortHex(hex: string): string {
  return hex.length <= 16 ? hex : `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

// Name of a chain ID.
export function chainName(id: number): string {
  switch (id) {
    case 1:
      return "Ethereum mainnet";
    case 11155111:
      return "Sepolia";
    case 17000:
      return "Holesky";
    default:
      return "unknown chain";
  }
}

// A duration in seconds as "3d 4h", "2h 5m", "4m 10s", or "12s".
export function duration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  switch (true) {
    case days > 0:
      return `${days}d ${hours}h`;
    case hours > 0:
      return `${hours}h ${minutes}m`;
    case minutes > 0:
      return `${minutes}m ${seconds}s`;
    default:
      return `${seconds}s`;
  }
}

// A byte count as "512 B", "1.5 KiB", or "2.3 MiB".
export function bytes(count: number): string {
  switch (true) {
    case count < 1024:
      return `${count} B`;
    case count < 1024 * 1024:
      return `${(count / 1024).toFixed(1)} KiB`;
    default:
      return `${(count / (1024 * 1024)).toFixed(2)} MiB`;
  }
}

// A decimal u64 text with group separators. Bad text is shown as it is.
export function count(decimal: string): string {
  return /^(?:0|[1-9][0-9]*)$/.test(decimal) ? BigInt(decimal).toLocaleString("en-US") : decimal;
}

// Difference a - b of two decimal u64 texts, as a number. Null if a value is null.
export function difference(a: string | null, b: string | null): number | null {
  return a === null || b === null ? null : Number(BigInt(a) - BigInt(b));
}
