// Core domain types for the NostrPlayer timeline playback client.

/** Position of a post relative to the current playback head. */
export type PostStatus = 'played' | 'current' | 'upcoming'

/** Timestamp mode for the composer (requirements §6.1). */
export type ComposerMode = 'now' | 'playback'

/** Available playback speeds (real-time multipliers). */
export type PlaybackSpeed = 1 | 1.2 | 1.5 | 2

/**
 * Persisted playback state (requirements §9.6). Stored in IndexedDB and
 * restored on load.
 *
 * `position` is the playhead timestamp in unix SECONDS. `zoomLevel` is the
 * visible window duration in seconds (our continuous-zoom approximation of the
 * spec's "seconds per pixel").
 */
export interface PersistedPlayback {
  position: number // playhead, unix seconds
  speed: PlaybackSpeed
  state: 'playing' | 'paused'
  zoomLevel: number // visible window duration, seconds
  ttsEnabled: boolean
}
