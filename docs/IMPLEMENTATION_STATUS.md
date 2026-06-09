# Implementation Status

Maps `requirements.md` (§3–§10) to the current implementation. Honest
assessment — "partial" and "unimplemented" mean exactly that.

This build targets a **static GitHub Pages site** that fetches **real Nostr
events in the browser** using `nostr-tools` (`SimplePool`) and NIP-07. Several
spec items assume rx-nostr, Svelte, Tauri, and `@konemono/nostr-login`; those
specific technologies are intentional deviations (see §10).

| § | Topic | Status | Notes |
|---|-------|--------|-------|
| 3 | Playback ops: start-time, catch-up, pause, speed, seek, zoom, ⏪/⏩, follow | **Implemented** | Start-time via the date/time picker; catch-up playback as the playhead advances; pause; speeds 1.0/1.2/1.5/2.0×; seek slider; wheel zoom; ⏪/⏩ ±1 min (⏩ clamps to now); follow-live toggle (grey ● → click jumps to now; green/disabled while LIVE). |
| 4.1 | Time axis, right edge = now | **Implemented** | `timeToFraction` maps `[now-range, now] → [0,1]`; right edge pinned to now, advancing each rAF frame. |
| 4.2 | Continuous zoom (sec/pixel) | **Partial** | Approximated by an adjustable **visible-window duration** (5 min – 1 year) via wheel-to-zoom. Not literally seconds-per-pixel; ruler step/labels adapt from seconds to dates. |
| 4.3 | LIVE auto-detect/return | **Implemented** | `isLive` (within 10 s of now); seeking/jumping drops out of LIVE; reaching the live edge re-enables follow. |
| 4.4 | Drag-to-seek examples | **Partial** | Seeking is via the slider + ⏪/⏩ + date picker rather than direct time-axis drag. |
| 4.5 | Far-past access (date picker, zoom-in) | **Implemented** | Date/time picker jumps the playhead and triggers a fetch around the target; wheel zoom navigates scale. |
| 5.1 | TTS reads along the playhead | **Partial** | The note crossing the playhead is spoken (cancel-then-speak); a per-character "audio cursor" is not modeled. |
| 5.2 | TTS speed link, queue, pause/resume, seek restart | **Partial** | Rate follows playback speed; on a new current note we cancel and speak it; no persistent queue; pausing cancels speech. |
| 5.3 | Voice-per-npub, reply/emoji filtering | **Unimplemented** | Single default voice; no reply/mention filtering. |
| 5.4 | Background TTS | **Unimplemented** | Web Speech API is throttled/suspended in background tabs; no native fallback (no Tauri here). |
| 6 | Composer (kind:1), reply mode | **Partial** | Note composing + posting implemented; **reply mode is not**. |
| 6.1 | Timestamp mode (now vs playback position) | **Implemented** | Radio toggle; playback mode posts a past `created_at`. |
| 6.1 | Relay rejection feedback ("created_at too far off") | **Implemented** | `publishNote` reports per-relay accept/reject with the relay's reason; surfaced in a toast. |
| 8.1 | Resolve pipeline: relay list → contacts → authors → kind:1 | **Implemented** | `fetchRelayList` (10002) → `fetchContacts` (3) → `authors` → `fetchTimelineChunk` (1). |
| 8.2 | Relay selection + fallback | **Implemented** | Uses NIP-65 relays; falls back to `DEFAULT_RELAYS` when absent. |
| 9.1 | 10-minute chunks, unix-second slots | **Implemented** | `timeSlot = Math.floor(created_at/600)*600`; REQs use integer `since`/`until` seconds. |
| 9.2 | Past-playback fetching, intra-chunk pagination | **Partial** | Playhead-driven chunk fetch implemented; **the max_limit intra-chunk re-REQ loop** (re-querying within a slot when limit is hit) is **not** implemented (single REQ per missing slot range, limit 500). |
| 9.3 | LIVE real-time subscription, immediate display | **Implemented** | `subscribeLive` (kind:1, since=now) adds straight to the flat store; rendered without waiting for chunk finalization. |
| 9.4 | Flat store + slot-status management | **Partial** | Flat `EventStore` with per-slot "fetched" tracking; full `ChunkStatus` state machine not modeled. |
| 9.5 | Delayed-arrival handling, grace period, lock | **Unimplemented** | Late events are simply accepted into the flat store; no `CHUNK_GRACE_PERIOD_SEC` lock/ignore logic. |
| 9.6 | Persist & restore playback state | **Implemented** | `{position, speed, state, zoomLevel, ttsEnabled}` persisted to IndexedDB in real time, plus pubkey + relays; restored on load (live if near now, else paused-behind). |
| 9.7 | Reconnect/background-resume, "🔄 syncing" UI | **Partial** | A "🔄 syncing" indicator shows during chunk fetches; `SimplePool` handles reconnection, but there is **no** explicit catch-up-on-resume orchestration. |
| 9.8 | Cache lifecycle (memory 24h → IndexedDB 1week, LRU) | **Partial** | Recent events persisted to IndexedDB (bounded ~2000 / ~7 days). No tiered memory cache, no LRU eviction. |
| 9.9 | Store management, manual reload | **Partial** | Flat event store + slot fetch-tracking present; LRU and per-slot manual reload not implemented. |
| 9.10 | FakeRelay / ChunkStore 2-layer Observable design | **Unimplemented (approximated)** | Replaced by direct, playhead-driven `querySync` chunk fetching into the flat store. No Observable FakeRelay replaying at playback position. |
| 10 | Tauri/Svelte/rx-nostr/nostr-login, Android | **Out of scope** | This is a React + `nostr-tools` + raw NIP-07 static web build. No Tauri/Android, no Svelte, no rx-nostr, no `@konemono/nostr-login`. |

## Key deviations (summary)

- **`nostr-tools` `SimplePool`** instead of rx-nostr (Observable streaming).
- **Raw NIP-07** instead of `@konemono/nostr-login`.
- **React** instead of Svelte 5; **static Pages build** instead of Tauri.
- **On-demand playhead-driven chunk fetch** approximates the §9.10
  FakeRelay/ChunkStore two-layer architecture.
- **Window-duration zoom** approximates §4.2 continuous seconds-per-pixel zoom.
- **Simplified IndexedDB cache** (bounded recent set) approximates the §9.8/9.9
  24h/1-week LRU tiering.
- **Basic TTS**; voice-per-npub, reply reading, and reliable background
  playback are unimplemented.
