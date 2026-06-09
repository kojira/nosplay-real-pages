// Flat event store — modeled on a relay DB (requirements §9.4 / §9.9).
//
// Events are stored flat in a Map keyed by id (deduplicated). The 10-minute
// "chunk" concept is used ONLY to track which time slots have been fetched
// (requirements §9.1), not to bucket the events themselves.

import type { Event } from 'nostr-tools'

/** Slot size in seconds (10 minutes), per requirements §9.1. */
export const SLOT_SEC = 600

/** Compute the chunk slot key (slot-start unix seconds) for a created_at. */
export function timeSlot(createdAtSec: number): number {
  return Math.floor(createdAtSec / SLOT_SEC) * SLOT_SEC
}

export class EventStore {
  private events = new Map<string, Event>()
  private fetchedSlots = new Set<number>()

  /** Add an event, deduplicating by id. Returns true if newly added. */
  add(event: Event): boolean {
    if (this.events.has(event.id)) return false
    this.events.set(event.id, event)
    return true
  }

  /** Add many events; returns how many were newly added. */
  addMany(events: Event[]): number {
    let added = 0
    for (const e of events) if (this.add(e)) added++
    return added
  }

  /** All events whose created_at is in [sinceSec, untilSec], ascending. */
  getRange(sinceSec: number, untilSec: number): Event[] {
    const out: Event[] = []
    for (const e of this.events.values()) {
      if (e.created_at >= sinceSec && e.created_at <= untilSec) out.push(e)
    }
    out.sort((a, b) => a.created_at - b.created_at)
    return out
  }

  /** All events, ascending by created_at. */
  all(): Event[] {
    return [...this.events.values()].sort(
      (a, b) => a.created_at - b.created_at,
    )
  }

  get size(): number {
    return this.events.size
  }

  // ---- Chunk fetch-state tracking (requirements §9.1 / §9.9) --------------

  /** Mark a 10-minute slot (slot-start unix seconds) as fetched. */
  markChunkFetched(slotKey: number): void {
    this.fetchedSlots.add(slotKey)
  }

  isChunkFetched(slotKey: number): boolean {
    return this.fetchedSlots.has(slotKey)
  }

  /** Every 10-minute slot-start key overlapping [sinceSec, untilSec]. */
  chunkSlotsInRange(sinceSec: number, untilSec: number): number[] {
    const slots: number[] = []
    const start = timeSlot(sinceSec)
    const end = timeSlot(untilSec)
    for (let s = start; s <= end; s += SLOT_SEC) slots.push(s)
    return slots
  }
}
