// Operation domain tags for signed messages and configuration digests.
// Each tag is 32 bytes: the ASCII name, then zero bytes to fill 32 bytes.

import { EncodingError } from "./bytes.ts";

export const DOMAIN_TAG_LENGTH = 32;

// Make a domain tag from printable ASCII text of at most 32 bytes.
export function domainTag(text: string): Uint8Array {
  if (!/^[\x21-\x7e]*$/.test(text) || text.length > DOMAIN_TAG_LENGTH) {
    throw new EncodingError("domain tag text must be printable ASCII of at most 32 bytes");
  }
  const out = new Uint8Array(DOMAIN_TAG_LENGTH);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

// Domain of the deployment configuration digest (deployment_id).
export const DEPLOYMENT_DOMAIN = domainTag("anon-credit/deployment");
// Domain of the session-open signature. Phase 3 defines its message layout.
export const OPEN_DOMAIN = domainTag("anon-credit/open");
// Domain of the spend signature.
export const SPEND_DOMAIN = domainTag("anon-credit/spend");
// Domain of the session-status signature. Phase 3 defines its message layout.
export const STATUS_DOMAIN = domainTag("anon-credit/status");
