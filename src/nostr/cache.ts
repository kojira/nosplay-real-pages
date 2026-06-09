// IndexedDB persistence (idb-keyval) — a practical subset of requirements
// §9.6 / §9.8. We persist a bounded set of recent kind:1 events plus the
// session (pubkey, relays) and the playback state.
//
// NOTE: This is a SIMPLIFIED cache. The full LRU 24h-memory / 1-week-IndexedDB
// tiering of §9.8/§9.9 is approximated by keeping only the most recent ~2000
// events from the last ~7 days. There is no per-slot LRU eviction.

import { get, set } from 'idb-keyval'
import type { Event } from 'nostr-tools'
import type { PersistedPlayback } from '../types'

const EVENTS_KEY = 'np:events'
const PLAYBACK_KEY = 'np:playback'
const SESSION_KEY = 'np:session'

const MAX_EVENTS = 2000
const MAX_AGE_SEC = 7 * 24 * 60 * 60 // ~1 week

export interface PersistedSession {
  pubkey: string | null
  relays: string[]
}

/** Persist recent kind:1 events (most-recent ~2000, last ~7 days). */
export async function saveEvents(events: Event[]): Promise<void> {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_SEC
    const trimmed = events
      .filter((e) => e.created_at >= cutoff)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, MAX_EVENTS)
    await set(EVENTS_KEY, trimmed)
  } catch {
    // Swallow persistence errors (private mode, quota, etc.).
  }
}

/** Load cached kind:1 events. Returns [] on any error. */
export async function loadEvents(): Promise<Event[]> {
  try {
    const events = await get<Event[]>(EVENTS_KEY)
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/** Persist the playback state (requirements §9.6). */
export async function savePlaybackState(
  state: PersistedPlayback,
): Promise<void> {
  try {
    await set(PLAYBACK_KEY, state)
  } catch {
    // ignore
  }
}

/** Load the persisted playback state, or null if absent/invalid. */
export async function loadPlaybackState(): Promise<PersistedPlayback | null> {
  try {
    const state = await get<PersistedPlayback>(PLAYBACK_KEY)
    return state ?? null
  } catch {
    return null
  }
}

/** Persist the session (entered pubkey + resolved relays). */
export async function saveSession(session: PersistedSession): Promise<void> {
  try {
    await set(SESSION_KEY, session)
  } catch {
    // ignore
  }
}

/** Load the persisted session, or null if absent. */
export async function loadSession(): Promise<PersistedSession | null> {
  try {
    const session = await get<PersistedSession>(SESSION_KEY)
    return session ?? null
  } catch {
    return null
  }
}
