// Public-key helpers: npub/hex decoding, encoding, truncation, and NIP-07
// (browser extension) access.

import { nip19 } from 'nostr-tools'

const HEX64 = /^[0-9a-f]{64}$/i

/**
 * Decode a user-supplied pubkey. Accepts an `npub1...` (NIP-19) string or a
 * 64-char hex pubkey. Returns the lowercase hex pubkey, or `null` if invalid.
 */
export function decodePubkey(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (HEX64.test(s)) return s.toLowerCase()
  if (s.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(s)
      if (decoded.type === 'npub' && typeof decoded.data === 'string') {
        return decoded.data.toLowerCase()
      }
    } catch {
      return null
    }
  }
  return null
}

/** Encode a hex pubkey as an `npub1...` string. */
export function npubEncode(hex: string): string {
  return nip19.npubEncode(hex)
}

/**
 * npub-encode then truncate to a compact `npub1abc…wxyz` form for display.
 */
export function shortNpub(hex: string): string {
  let npub: string
  try {
    npub = nip19.npubEncode(hex)
  } catch {
    // Fall back to a truncated hex if encoding fails for any reason.
    return hex.length > 12 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex
  }
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`
}

/** Whether a NIP-07 signer extension is present in the browser. */
export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!window.nostr
}

/**
 * Get the logged-in pubkey from a NIP-07 extension. Throws a clear error if no
 * extension is available.
 */
export async function getNip07Pubkey(): Promise<string> {
  if (!hasNip07() || !window.nostr) {
    throw new Error(
      'No NIP-07 extension found. Install a Nostr signer (e.g. Alby, nos2x) to log in with your extension.',
    )
  }
  const pk = await window.nostr.getPublicKey()
  return pk.toLowerCase()
}
