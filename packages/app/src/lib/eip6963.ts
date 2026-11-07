// EIP-6963 wallet discovery. A wallet extension announces itself with a
// "eip6963:announceProvider" event; the page asks with "eip6963:requestProvider". The list
// has one row per announced provider, by uuid. A plain window.ethereum is the fallback row.

import type { EIP1193Provider } from "viem";
import { z } from "zod";

export interface AnnouncedProvider {
  readonly uuid: string;
  readonly name: string;
  // A data: URI image, at most shown at 16 px.
  readonly icon: string;
  readonly rdns: string;
  readonly provider: EIP1193Provider;
}

// The provider object of an announcement must have a request function.
const providerSchema = z.custom<EIP1193Provider>((value) => typeof value === "object" && value !== null && "request" in value && typeof value.request === "function");

const announcementSchema = z.object({
  info: z.object({
    uuid: z.string().min(1),
    name: z.string().min(1),
    icon: z.string().startsWith("data:"),
    rdns: z.string().min(1),
  }),
  provider: providerSchema,
});

// Read the detail of an announcement event. Return null if it is not an EIP-6963 announcement.
export function parseAnnouncement(detail: {} | null | undefined): AnnouncedProvider | null {
  const parsed = announcementSchema.safeParse(detail);
  if (!parsed.success) return null;
  return { ...parsed.data.info, provider: parsed.data.provider };
}

// Add an announcement to the list. A provider with a known uuid replaces its row.
export function reduceAnnouncements(list: readonly AnnouncedProvider[], announced: AnnouncedProvider): AnnouncedProvider[] {
  const index = list.findIndex((item) => item.uuid === announced.uuid);
  switch (index) {
    case -1:
      return [...list, announced];
    default:
      return list.map((item, position) => (position === index ? announced : item));
  }
}

// Listen for announcements and ask the wallets to announce. Return the function that stops it.
export function discoverProviders(onAnnounce: (announced: AnnouncedProvider) => void): () => void {
  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const announced = parseAnnouncement(event.detail);
    if (announced !== null) onAnnounce(announced);
  };
  window.addEventListener("eip6963:announceProvider", listener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => window.removeEventListener("eip6963:announceProvider", listener);
}
