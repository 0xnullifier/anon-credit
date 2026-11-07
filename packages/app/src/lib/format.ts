// Display formats. Times are UTC or local wall-clock time with the zone named.

// "0x0a43…8861"
export function shortHex(hex: string, head = 6, tail = 4): string {
  return hex.length <= head + tail + 3 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

// "12:34:56.123" (UTC wall-clock time of Unix milliseconds).
export function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

// "2026-11-07 12:34:56" (UTC).
export function utc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

// "412 ms", "3.2 s", "1 m 12 s".
export function duration(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));
  switch (true) {
    case rounded < 1000:
      return `${rounded} ms`;
    case rounded < 60_000:
      return `${(rounded / 1000).toFixed(1)} s`;
    default: {
      const minutes = Math.floor(rounded / 60_000);
      const seconds = Math.round((rounded % 60_000) / 1000);
      return `${minutes} m ${seconds} s`;
    }
  }
}

// "512 B", "317.2 KB", "1.20 MB" (decimal units, as the transport limits are).
export function bytes(count: number): string {
  switch (true) {
    case count < 1000:
      return `${count} B`;
    case count < 1_000_000:
      return `${(count / 1000).toFixed(1)} KB`;
    default:
      return `${(count / 1_000_000).toFixed(2)} MB`;
  }
}

// Wei as ETH with up to 6 decimals, without trailing zeros.
export function eth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fraction === "" ? `${whole} ETH` : `${whole}.${fraction} ETH`;
}

// Etherscan link of a transaction, or null for a chain without an explorer here.
export function explorerTx(chainId: number, txHash: string): string | null {
  switch (chainId) {
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${txHash}`;
    case 1:
      return `https://etherscan.io/tx/${txHash}`;
    default:
      return null;
  }
}

// Etherscan link of an address, or null for a chain without an explorer here.
export function explorerAddress(chainId: number, address: string): string | null {
  switch (chainId) {
    case 11155111:
      return `https://sepolia.etherscan.io/address/${address}`;
    case 1:
      return `https://etherscan.io/address/${address}`;
    default:
      return null;
  }
}

export function chainName(chainId: number): string {
  switch (chainId) {
    case 11155111:
      return "Sepolia";
    case 1:
      return "mainnet";
    case 31337:
      return "anvil (local)";
    default:
      return `chain ${chainId}`;
  }
}

// A JSON value on one line, cut at `max` characters.
export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
