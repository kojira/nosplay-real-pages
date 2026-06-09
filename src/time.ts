// Time math helpers for the timeline playback dashboard.
//
// The timeline maps a time range [now - rangeMs, now] onto the horizontal axis,
// where the RIGHT edge (x = width) is always NOW and the LEFT edge is the
// oldest visible moment.

export const SECOND = 1_000
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000

/** Live-edge threshold: within this distance of NOW we consider it "LIVE". */
export const LIVE_THRESHOLD_MS = 10 * SECOND

// ---- Unix-seconds helpers (NIP-01 timestamps are unix SECONDS) -------------

/** Convert epoch-ms → unix seconds (floored integer). */
export function toSec(ms: number): number {
  return Math.floor(ms / 1000)
}

/** Convert unix seconds → epoch-ms. */
export function toMs(sec: number): number {
  return sec * 1000
}

/**
 * 10-minute chunk slot key (slot-start unix seconds) for a created_at in unix
 * seconds (requirements §9.1). `Math.floor(createdAtSec / 600) * 600`.
 */
export function timeSlot(createdAtSec: number): number {
  return Math.floor(createdAtSec / 600) * 600
}

/** Format an epoch-ms timestamp as a HH:MM:SS clock label. */
export function formatClock(ts: number, withSeconds = true): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  if (!withSeconds) return `${h}:${m}`
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/** Format an epoch-ms timestamp as `YYYY-MM-DD HH:MM`. */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day} ${h}:${mi}`
}

/**
 * Format an epoch-ms timestamp for a `datetime-local` input value
 * (`YYYY-MM-DDTHH:MM`), in local time.
 */
export function toDatetimeLocalValue(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day}T${h}:${mi}`
}

/** Human "N min ago" / "Ns ago" / "now" label for a timestamp vs. a reference. */
export function minutesAgoLabel(ts: number, now: number): string {
  const deltaMs = Math.max(0, now - ts)
  if (deltaMs < 5 * SECOND) return 'now'
  if (deltaMs < MINUTE) return `${Math.round(deltaMs / SECOND)}s ago`
  const mins = Math.floor(deltaMs / MINUTE)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}m ago`
}

/** Whether a timestamp is at the live edge (within LIVE_THRESHOLD_MS of now). */
export function isLive(ts: number, now: number): boolean {
  return now - ts <= LIVE_THRESHOLD_MS
}

/**
 * Map a timestamp to a horizontal fraction [0, 1] within the visible window.
 * 0 = left edge (oldest visible), 1 = right edge (NOW).
 */
export function timeToFraction(ts: number, now: number, rangeMs: number): number {
  const start = now - rangeMs
  const f = (ts - start) / rangeMs
  return Math.min(1, Math.max(0, f))
}

/** Map a timestamp to an x pixel position given the track width. */
export function timeToX(
  ts: number,
  now: number,
  rangeMs: number,
  width: number,
): number {
  return timeToFraction(ts, now, rangeMs) * width
}

/** Inverse of {@link timeToFraction}: a fraction [0,1] back to a timestamp. */
export function fractionToTime(fraction: number, now: number, rangeMs: number): number {
  const f = Math.min(1, Math.max(0, fraction))
  return now - rangeMs + f * rangeMs
}

export interface RulerTick {
  ts: number
  /** Fraction [0,1] across the visible window. */
  fraction: number
  label: string
  /** True for the rightmost tick (NOW / LIVE). */
  isNow: boolean
}

// Candidate tick steps (ms), from seconds up to ~1 year, used to pick a
// "nice" spacing for an arbitrary (continuously-zoomable) range.
const TICK_STEPS_MS: number[] = [
  10 * SECOND,
  30 * SECOND,
  MINUTE,
  3 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
  180 * DAY,
  365 * DAY,
]

/** Format a tick label appropriately for the chosen step size. */
function tickLabel(ts: number, stepMs: number): string {
  if (stepMs >= 7 * DAY) {
    const d = new Date(ts)
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
      d.getDate(),
    ).padStart(2, '0')}`
  }
  if (stepMs >= DAY) {
    const d = new Date(ts)
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(
      d.getDate(),
    ).padStart(2, '0')}`
  }
  return formatClock(ts, false)
}

/**
 * Generate evenly-spaced ruler ticks across the visible window, with the
 * rightmost tick pinned exactly to NOW (labelled "LIVE"). Adapts the step and
 * label format to the range duration so it works from minutes to a year
 * (requirements §4.2 continuous zoom, approximated).
 */
export function generateTicks(now: number, rangeMs: number): RulerTick[] {
  // Aim for ~6 labels; choose the smallest "nice" step >= rangeMs / 6.
  const target = rangeMs / 6
  let stepMs = TICK_STEPS_MS[TICK_STEPS_MS.length - 1]
  for (const s of TICK_STEPS_MS) {
    if (s >= target) {
      stepMs = s
      break
    }
  }

  const ticks: RulerTick[] = []
  // Walk from NOW backwards by the step; the last (rightmost) tick is NOW.
  for (let ts = now; ts >= now - rangeMs - 1; ts -= stepMs) {
    const isNowTick = ts === now
    ticks.push({
      ts,
      fraction: timeToFraction(ts, now, rangeMs),
      label: isNowTick ? 'LIVE' : tickLabel(ts, stepMs),
      isNow: isNowTick,
    })
  }

  return ticks.reverse()
}
