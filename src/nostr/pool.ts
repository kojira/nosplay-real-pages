// nostr-tools SimplePool wrappers: relay-list (NIP-65) discovery, contact-list
// (kind:3) fetch, profile (kind:0) fetch, chunked timeline (kind:1) fetch, a
// live subscription, and NIP-07 publishing.
//
// All `since`/`until` arguments are unix SECONDS (integers), per NIP-01.

import { SimplePool } from 'nostr-tools/pool'
import type { Event, Filter } from 'nostr-tools'
import { normalizeRelayUrl } from './relays'

/** Shared connection pool singleton for the whole app. */
export const pool = new SimplePool()

export interface ProfileMeta {
  name?: string
  picture?: string
}

/**
 * Fetch the user's NIP-65 relay list (kind:10002). Takes the newest event and
 * returns every relay URL from its `r` tags, normalized. Returns [] if none.
 */
export async function fetchRelayList(
  relays: string[],
  pubkey: string,
): Promise<string[]> {
  const events = await pool.querySync(relays, {
    kinds: [10002],
    authors: [pubkey],
    limit: 1,
  })
  if (events.length === 0) return []
  const newest = events.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
  const urls = newest.tags
    .filter((t) => t[0] === 'r' && typeof t[1] === 'string')
    .map((t) => normalizeRelayUrl(t[1]))
    .filter(Boolean)
  // Dedup while preserving order.
  return [...new Set(urls)]
}

/**
 * Fetch the user's contact list (kind:3). Takes the newest event and returns
 * the followed pubkeys (hex) from its `p` tags. Returns [] if none.
 */
export async function fetchContacts(
  relays: string[],
  pubkey: string,
): Promise<string[]> {
  const events = await pool.querySync(relays, {
    kinds: [3],
    authors: [pubkey],
    limit: 1,
  })
  if (events.length === 0) return []
  const newest = events.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
  const pubkeys = newest.tags
    .filter((t) => t[0] === 'p' && typeof t[1] === 'string')
    .map((t) => t[1].toLowerCase())
  return [...new Set(pubkeys)]
}

/** Split an array into chunks of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Fetch profile metadata (kind:0) for the given pubkeys. Chunks authors to
 * respect relay limits and caps at the first 500 pubkeys. Keeps the newest
 * profile per pubkey; parses content JSON safely.
 */
export async function fetchProfiles(
  relays: string[],
  pubkeys: string[],
): Promise<Map<string, ProfileMeta>> {
  const result = new Map<string, ProfileMeta>()
  if (pubkeys.length === 0) return result

  // Cap to keep the query bounded; relays may also limit author counts.
  const capped = [...new Set(pubkeys)].slice(0, 500)
  const newestAt = new Map<string, number>()

  for (const authors of chunk(capped, 100)) {
    const events = await pool.querySync(relays, { kinds: [0], authors })
    for (const ev of events) {
      const prev = newestAt.get(ev.pubkey) ?? -1
      if (ev.created_at <= prev) continue
      let meta: ProfileMeta = {}
      try {
        const parsed = JSON.parse(ev.content) as Record<string, unknown>
        meta = {
          name:
            (typeof parsed.display_name === 'string' && parsed.display_name) ||
            (typeof parsed.name === 'string' ? parsed.name : undefined) ||
            undefined,
          picture:
            typeof parsed.picture === 'string' ? parsed.picture : undefined,
        }
      } catch {
        // Ignore malformed profile JSON.
      }
      newestAt.set(ev.pubkey, ev.created_at)
      result.set(ev.pubkey, meta)
    }
  }
  return result
}

/**
 * Fetch a chunk of timeline notes (kind:1) for the given authors in the
 * [since, until] window (unix seconds). Returns [] if authors is empty.
 *
 * NOTE: Many relays cap the number of `authors` in a filter (often a few
 * thousand). For large follow lists this single filter may be silently
 * truncated by some relays; partitioning the authors into multiple REQs would
 * be a future improvement.
 */
export async function fetchTimelineChunk(
  relays: string[],
  authors: string[],
  since: number,
  until: number,
  limit = 500,
): Promise<Event[]> {
  if (authors.length === 0) return []
  const filter: Filter = {
    kinds: [1],
    authors,
    since: Math.floor(since),
    until: Math.floor(until),
    limit,
  }
  return pool.querySync(relays, filter)
}

/**
 * Open a live subscription for new kind:1 notes from the given authors,
 * starting at "now". Calls `onEvent` for each event. Returns a close function.
 * No-ops (returns a no-op closer) when authors is empty.
 */
export function subscribeLive(
  relays: string[],
  authors: string[],
  onEvent: (e: Event) => void,
): () => void {
  if (authors.length === 0) return () => {}
  const nowSec = Math.floor(Date.now() / 1000)
  const sub = pool.subscribeMany(
    relays,
    { kinds: [1], authors, since: nowSec },
    { onevent: onEvent },
  )
  return () => {
    try {
      sub.close()
    } catch {
      // ignore
    }
  }
}

export interface PublishResult {
  ok: string[]
  failed: { relay: string; reason: string }[]
}

/**
 * Build, sign (via NIP-07), and publish a kind:1 note with the given
 * `created_at` (unix seconds). Returns which relays accepted vs. rejected it,
 * with the rejection reason — useful for surfacing the NIP-01
 * "created_at too far off" rejection (requirements §6.1).
 */
export async function publishNote(
  relays: string[],
  content: string,
  createdAtSec: number,
): Promise<PublishResult> {
  if (!window.nostr) {
    throw new Error(
      'No NIP-07 extension found. A signer extension is required to post.',
    )
  }
  const template = {
    kind: 1,
    created_at: Math.floor(createdAtSec),
    tags: [] as string[][],
    content,
  }
  const signed = await window.nostr.signEvent(template)

  const promises = pool.publish(relays, signed)
  const settled = await Promise.allSettled(promises)

  const ok: string[] = []
  const failed: { relay: string; reason: string }[] = []
  settled.forEach((res, i) => {
    const relay = relays[i] ?? `relay#${i}`
    if (res.status === 'fulfilled') {
      ok.push(relay)
    } else {
      const reason =
        res.reason instanceof Error
          ? res.reason.message
          : String(res.reason ?? 'rejected')
      failed.push({ relay, reason })
    }
  })
  return { ok, failed }
}
