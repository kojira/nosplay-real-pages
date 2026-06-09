// Default fallback relay list + relay URL normalization.
//
// These public relays are used when the logged-in user has no NIP-65
// (kind:10002) relay list, or as the bootstrap set used to discover that
// list (requirements §8.2).

export const DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.wine',
]

/**
 * Normalize a relay URL: trim whitespace, ensure a `wss://` scheme, and strip
 * any trailing slash. Returns the normalized URL (best-effort; does not throw).
 */
export function normalizeRelayUrl(url: string): string {
  let u = url.trim()
  if (!u) return u
  // Add a scheme if missing; upgrade ws:// → keep, bare host → wss://.
  if (!/^wss?:\/\//i.test(u)) {
    u = `wss://${u}`
  }
  // Strip a single trailing slash (and any trailing whitespace already gone).
  u = u.replace(/\/+$/, '')
  return u
}
