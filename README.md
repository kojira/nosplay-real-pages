# NostrPlayer

A **real, browser-based Nostr timeline-playback client**, built with React +
TypeScript + Vite and deployable as a static site on GitHub Pages.

It fetches **real Nostr events** from public relays in the browser (via
[`nostr-tools`](https://github.com/nbd-wtf/nostr-tools)) and lets you play back
your follow timeline like a DVR: the **right edge of the time axis is always
"now"**, and a playhead moves across it revealing notes as it crosses their
timestamps. You can pause, change speed, seek, jump to an arbitrary past time,
zoom, follow the live edge, and post notes (with a NIP-07 signer).

> This is a real client talking to real relays. There is **no demo/sample
> data**. If you enter a pubkey with no follows or whose relays are
> unreachable, you may see an empty or sparse timeline — that's the real data.

## How the real fetching works

1. **Login** — enter your `npub` (or 64-char hex pubkey), or click
   **Login with extension (NIP-07)** if a signer (Alby, nos2x, …) is installed.
2. **Relay discovery (NIP-65)** — the app queries `kind:10002` from a set of
   default public relays to find your relay list. If you have none, it falls
   back to the built-in default relays.
3. **Contacts (kind:3)** — it fetches your contact list from the resolved
   relays and extracts the followed pubkeys (`p` tags). Your own pubkey is
   always included. If you follow no one, the timeline is just your own notes.
4. **Profiles (kind:0)** — display names/avatars are fetched best-effort;
   cards show a short npub until names load.
5. **Chunked timeline fetch (kind:1)** — the visible time window is divided
   into **10-minute chunks** (`Math.floor(created_at / 600) * 600`). As the
   playhead/window moves over un-fetched chunks, the app issues
   `since`/`until`-bounded REQs (unix **seconds**) and stores results in a
   flat, relay-DB-like event store (deduplicated by id). Each chunk is fetched
   at most once.
6. **Live subscription** — a `kind:1` subscription starting at "now" streams
   new notes in real time straight into the store.
7. **Posting (NIP-07)** — the composer builds a `kind:1` event, signs it with
   `window.nostr.signEvent`, and publishes it to your relays. Per-relay
   accept/reject results are surfaced (including the NIP-01
   "created_at too far off" rejection when posting at a past playback time).

Persistence: playback state (position, speed, play/pause, zoom, TTS), the
entered pubkey, the resolved relays, and a bounded set of recent events are
written to **IndexedDB** (via `idb-keyval`) and restored on reload.

## Controls

- **Play / Pause**
- **Speed**: 1.0× / 1.2× / 1.5× / 2.0× (drives both scroll and TTS rate)
- **⏪ / ⏩**: nudge the playhead −1 min / +1 min (+1 clamps to now)
- **Seek slider**: scrub the playhead across the visible window
- **Follow live**: grey ● when behind (click to jump to now & follow); shown
  green/`LIVE` and disabled while at the live edge
- **Wheel-to-zoom** on the ruler: continuously adjust the visible window
  duration (right edge stays "now")
- **Jump to** (date/time picker): move the playhead to an arbitrary past time
  and fetch chunks around it
- **TTS toggle**: speaks each note as the playhead crosses it (Web Speech API)

## Develop

```bash
npm install
npm run dev      # http://localhost:5173 (base "/")
```

## Build & preview

```bash
npm run build    # tsc -b && vite build → dist/ (base "/nosplay-real-pages/")
npm run preview  # serve the production build locally
npm run lint
```

The production `base` is `/nosplay-real-pages/` (see `vite.config.ts`) so the
app works from a GitHub Pages project subpath. In dev the base is `/`.

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` builds and deploys `dist/` on every push to
`main`. In the repo **Settings → Pages**, set **Source** to **GitHub Actions**.
The app is then served at:

```
https://<your-username>.github.io/nosplay-real-pages/
```

## Project structure

| File                      | Purpose                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `src/App.tsx`             | Full timeline-playback UI, wired to real relay data.              |
| `src/nostr/relays.ts`     | Default fallback relays + URL normalization.                      |
| `src/nostr/keys.ts`       | npub/hex decode, encode, short-npub, NIP-07 access.               |
| `src/nostr/pool.ts`       | SimplePool wrappers: NIP-65, kind:3, kind:0, kind:1, publish.     |
| `src/nostr/eventStore.ts` | Flat event store + 10-min chunk fetch-state tracking.             |
| `src/nostr/cache.ts`      | IndexedDB persistence (events, playback state, session).          |
| `src/tts.ts`              | Web Speech API TTS (basic subset).                                |
| `src/time.ts`             | Time math: clock/date labels, fractions, adaptive ruler ticks.    |
| `src/types.ts`            | Shared types (`PersistedPlayback`, `PlaybackSpeed`, …).           |

## Status

### Implemented

- Real NIP-65 relay discovery (with fallback), kind:3 contacts, kind:0
  profiles, chunked kind:1 fetch, and a live kind:1 subscription.
- Time-axis playback UI (right edge = now), playhead, adaptive ruler ticks.
- Play/pause, speed (1.0–2.0×), seek slider, ⏪/⏩ ±1 min, follow-live toggle,
  wheel-to-zoom (continuous window duration), date/time jump.
- NIP-07 login and posting, with per-relay accept/reject feedback and a NOW vs
  playback-position timestamp mode.
- Basic Web Speech API TTS that reads the note crossing the playhead.
- IndexedDB persistence of playback state, session, and recent events;
  restored on reload.

### Partially implemented

- **Caching/LRU** — recent events are persisted to IndexedDB, but the §9.8/§9.9
  24h-memory / 1-week-storage LRU tiering is simplified to a bounded
  most-recent set; there is no per-slot LRU eviction or chunk re-lock.
- **Zoom** — continuous "seconds-per-pixel" zoom (§4.2) is approximated by an
  adjustable visible-window duration (5 min – 1 year).
- **Chunk fetch architecture** — the §9.10 two-layer FakeRelay/ChunkStore
  Observable design is approximated by on-demand, playhead-driven chunk
  fetching into a flat store.

### NOT implemented

- The exact rx-nostr Observable architecture (we use `nostr-tools`
  `SimplePool` instead) and the FakeRelay/ChunkStore split (§9.10).
- `@konemono/nostr-login` (we use raw NIP-07 instead).
- Chunk `ChunkStatus` lifecycle with grace-period unlock and delayed-arrival
  rejection (§9.5), and manual per-slot reload (§9.9).
- TTS advanced features: voice-per-npub, reply/mention filtering, and reliable
  background playback (§5.3/§5.4).
- Reply/thread composition mode (§6 reply mode).
- Tauri desktop / Android targets and background services (§10) — out of scope
  for the GitHub Pages static build.

See `docs/IMPLEMENTATION_STATUS.md` for a section-by-section mapping.
