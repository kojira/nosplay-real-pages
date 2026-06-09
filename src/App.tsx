import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { Event } from 'nostr-tools'
import type { ComposerMode, PersistedPlayback, PlaybackSpeed } from './types'
import {
  HOUR,
  MINUTE,
  formatClock,
  generateTicks,
  isLive,
  minutesAgoLabel,
  timeToFraction,
  toDatetimeLocalValue,
  toSec,
  toMs,
} from './time'
import { DEFAULT_RELAYS } from './nostr/relays'
import { decodePubkey, getNip07Pubkey, hasNip07, shortNpub } from './nostr/keys'
import {
  fetchContacts,
  fetchProfiles,
  fetchRelayList,
  fetchTimelineChunk,
  publishNote,
  subscribeLive,
  type ProfileMeta,
} from './nostr/pool'
import { EventStore, SLOT_SEC } from './nostr/eventStore'
import {
  loadEvents,
  loadPlaybackState,
  loadSession,
  saveEvents,
  savePlaybackState,
  saveSession,
} from './nostr/cache'
import { cancelSpeech, speak, ttsAvailable } from './tts'

const SPEEDS: PlaybackSpeed[] = [1, 1.2, 1.5, 2]

// Continuous-zoom bounds (visible window duration, ms). The spec asks for
// continuous pixel-per-second zoom (§4.2); we approximate with an adjustable
// window duration from ~5 minutes up to ~1 year.
const MIN_RANGE_MS = 5 * MINUTE
const MAX_RANGE_MS = 365 * 24 * HOUR
const DEFAULT_RANGE_MS = 30 * MINUTE

// How far on each side of the visible window to prefetch chunks.
const PREFETCH_MS = 5 * MINUTE

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

// Flat, relay-DB-like event store (requirements §9.4/§9.9). A module-level
// singleton so it survives re-renders without being a React ref (React 19's
// lint forbids reading ref values during render).
const store = new EventStore()

/** Deterministic accent color from a pubkey (for avatars). */
function avatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  return `hsl(${h}, 65%, 55%)`
}

type ResolveStage =
  | 'idle'
  | 'relays'
  | 'contacts'
  | 'profiles'
  | 'ready'
  | 'error'

export default function App() {
  // ---- Session: pubkey + resolved relays + authors -------------------------
  const [pubkey, setPubkey] = useState<string | null>(null)
  const [loginInput, setLoginInput] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [relays, setRelays] = useState<string[]>(DEFAULT_RELAYS)
  const [authors, setAuthors] = useState<string[]>([])
  const [profiles, setProfiles] = useState<Map<string, ProfileMeta>>(new Map())
  const [stage, setStage] = useState<ResolveStage>('idle')
  const [stageNote, setStageNote] = useState<string>('')
  const [bootstrapped, setBootstrapped] = useState(false)

  // ---- Event store (flat, relay-like) -------------------------------------
  // The store is a module-level singleton (see `store` below) — a mutable,
  // relay-DB-like cache. We bump `storeVersion` to re-render when it mutates.
  const [storeVersion, setStoreVersion] = useState(0)
  const bumpStore = useCallback(() => setStoreVersion((v) => v + 1), [])

  // ---- Playback state ------------------------------------------------------
  const [now, setNow] = useState(() => Date.now())
  const [playheadAt, setPlayheadAt] = useState(() => Date.now())
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<PlaybackSpeed>(1)
  const [follow, setFollow] = useState(true)
  const [rangeMs, setRangeMs] = useState(DEFAULT_RANGE_MS)
  const [ttsEnabled, setTtsEnabled] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // ---- Composer ------------------------------------------------------------
  const [composerText, setComposerText] = useState('')
  const [composerMode, setComposerMode] = useState<ComposerMode>('now')
  const [posting, setPosting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const nip07 = useMemo(() => hasNip07(), [])
  const ttsOk = useMemo(() => ttsAvailable(), [])

  // ---- Restore persisted session + playback + cached events on first load --
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [session, pb, cached] = await Promise.all([
        loadSession(),
        loadPlaybackState(),
        loadEvents(),
      ])
      if (cancelled) return
      if (cached.length) {
        store.addMany(cached)
        bumpStore()
      }
      if (pb) {
        setSpeed(pb.speed)
        setRangeMs(clamp(pb.zoomLevel * 1000, MIN_RANGE_MS, MAX_RANGE_MS))
        setTtsEnabled(pb.ttsEnabled)
        const posMs = toMs(pb.position)
        const realNow = Date.now()
        // If the saved playhead is near "now", stay live; else restore behind.
        if (realNow - posMs <= 10_000) {
          setPlayheadAt(realNow)
          setFollow(true)
        } else {
          setPlayheadAt(posMs)
          setFollow(false)
        }
        setPlaying(pb.state === 'playing')
      }
      if (session?.pubkey) {
        if (session.relays.length) setRelays(session.relays)
        setPubkey(session.pubkey)
      }
      setBootstrapped(true)
    })()
    return () => {
      cancelled = true
    }
  }, [bumpStore])

  // ---- Resolve pipeline when pubkey is set (requirements §8) ---------------
  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    ;(async () => {
      try {
        setStage('relays')
        setStageNote('Resolving relay list (NIP-65)…')
        let userRelays = await fetchRelayList(DEFAULT_RELAYS, pubkey)
        if (cancelled) return
        if (userRelays.length === 0) {
          userRelays = DEFAULT_RELAYS
          setStageNote('No NIP-65 relay list found — using fallback relays.')
        } else {
          setStageNote(`Using ${userRelays.length} relay(s) from NIP-65.`)
        }
        setRelays(userRelays)

        setStage('contacts')
        setStageNote('Fetching contact list (kind:3)…')
        const contacts = await fetchContacts(userRelays, pubkey)
        if (cancelled) return
        // Always include the user themselves; fall back to just the user when
        // the follow list is empty.
        const authorList =
          contacts.length > 0
            ? [...new Set([pubkey, ...contacts])]
            : [pubkey]
        setAuthors(authorList)
        if (contacts.length === 0) {
          setStageNote(
            'No follows found (empty kind:3). Showing only your own notes.',
          )
        } else {
          setStageNote(`Following ${contacts.length} author(s).`)
        }

        // Persist the session now that relays are resolved.
        void saveSession({ pubkey, relays: userRelays })

        setStage('ready')

        // Profiles are best-effort and async; cards show shortNpub until ready.
        setStage('profiles')
        const metas = await fetchProfiles(userRelays, authorList)
        if (cancelled) return
        setProfiles(metas)
        setStage('ready')
      } catch (err) {
        if (cancelled) return
        setStage('error')
        setStageNote(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pubkey])

  // ---- Live subscription (requirements §9.3) -------------------------------
  useEffect(() => {
    if (authors.length === 0) return
    const close = subscribeLive(relays, authors, (e: Event) => {
      if (store.add(e)) bumpStore()
    })
    return close
  }, [relays, authors, bumpStore])

  // ---- Animation loop: advance now + playhead (real-time deltas) ----------
  const lastFrame = useRef<number | null>(null)
  useEffect(() => {
    let raf = 0
    const tick = (t: number) => {
      if (lastFrame.current === null) lastFrame.current = t
      const dt = t - lastFrame.current
      lastFrame.current = t
      const realNow = Date.now()
      setNow(realNow)
      setPlayheadAt((prev) => {
        // Advance, then keep the playhead within [now - rangeMs, now] so it
        // never runs off either edge of the visible window.
        let next: number
        if (follow) next = realNow
        else if (!playing) next = prev
        else next = prev + dt * speed
        return clamp(next, realNow - rangeMs, realNow)
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, follow, rangeMs])

  const live = isLive(playheadAt, now)
  const secondsBehind = Math.max(0, Math.round((now - playheadAt) / 1000))

  // ---- Chunk fetching driven by the playhead (requirements §9.1/§9.2) ------
  // We prefetch the chunk slots overlapping the visible window plus a margin.
  // Each 10-min slot is fetched at most once (tracked in the EventStore).
  const fetchWindow = useCallback(
    async (windowStartMs: number, windowEndMs: number) => {
      if (authors.length === 0) return
      const sinceSec = toSec(windowStartMs - PREFETCH_MS)
      const untilSec = toSec(windowEndMs)
      const slots = store.chunkSlotsInRange(sinceSec, untilSec)
      const missing = slots.filter((s) => !store.isChunkFetched(s))
      if (missing.length === 0) return

      // Mark eagerly so concurrent rAF ticks don't re-issue the same chunks.
      for (const s of missing) store.markChunkFetched(s)

      const since = missing[0]
      const until = missing[missing.length - 1] + SLOT_SEC - 1
      setSyncing(true)
      try {
        const events = await fetchTimelineChunk(relays, authors, since, until)
        if (store.addMany(events) > 0) bumpStore()
      } catch {
        // On failure these slots remain marked as fetched; a fuller impl would
        // reset their ChunkStatus to unfetched for retry (requirements §9.9).
      } finally {
        setSyncing(false)
      }
    },
    [authors, relays, bumpStore],
  )

  // Debounced chunk fetching as the visible window moves.
  const lastFetchKey = useRef<string>('')
  // When the author set changes (login / contacts resolved), force the next
  // window to refetch even if its slot range is unchanged.
  useEffect(() => {
    lastFetchKey.current = ''
  }, [authors])
  useEffect(() => {
    if (authors.length === 0) return
    const windowStart = playheadAt - rangeMs
    const windowEnd = now
    // Key on the slot range so we only refetch when crossing slot boundaries.
    const key = `${Math.floor(toSec(windowStart) / SLOT_SEC)}:${Math.floor(
      toSec(windowEnd) / SLOT_SEC,
    )}`
    if (key === lastFetchKey.current) return
    lastFetchKey.current = key
    void fetchWindow(windowStart, windowEnd)
  }, [playheadAt, now, rangeMs, authors, fetchWindow])

  // ---- Persist playback + events in real time (requirements §9.6) ----------
  useEffect(() => {
    if (!bootstrapped) return
    const state: PersistedPlayback = {
      position: toSec(playheadAt),
      speed,
      state: playing ? 'playing' : 'paused',
      zoomLevel: Math.round(rangeMs / 1000),
      ttsEnabled,
    }
    void savePlaybackState(state)
  }, [bootstrapped, playheadAt, speed, playing, rangeMs, ttsEnabled])

  // Persist cached events periodically (every storeVersion change, throttled).
  const lastSaveAt = useRef(0)
  useEffect(() => {
    if (!bootstrapped) return
    const t = Date.now()
    if (t - lastSaveAt.current < 5000) return
    lastSaveAt.current = t
    void saveEvents(store.all())
  }, [storeVersion, bootstrapped])

  // ---- Toast auto-dismiss --------------------------------------------------
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(id)
  }, [toast])

  // ---- Derived feed --------------------------------------------------------
  // Posts revealed up to the playhead within the visible window (catch-up
  // playback): created_at in [playheadAt - rangeMs, playheadAt].
  const visiblePosts = useMemo(() => {
    void storeVersion // re-derive when the store changes
    const since = toSec(playheadAt - rangeMs)
    const until = toSec(playheadAt)
    return store.getRange(since, until)
  }, [playheadAt, rangeMs, storeVersion])

  // The "current" post is the newest one at or before the playhead.
  const currentPostId = useMemo(() => {
    const ph = toSec(playheadAt)
    let candidate: Event | null = null
    for (const e of visiblePosts) {
      if (e.created_at <= ph) candidate = e
      else break
    }
    return candidate?.id ?? null
  }, [visiblePosts, playheadAt])

  // ---- TTS: speak the post crossing the playhead while playing -------------
  const lastSpokenId = useRef<string | null>(null)
  useEffect(() => {
    if (!ttsEnabled || !playing) return
    if (!currentPostId || currentPostId === lastSpokenId.current) return
    const post = visiblePosts.find((p) => p.id === currentPostId)
    if (!post) return
    lastSpokenId.current = currentPostId
    speak(post.content, speed)
  }, [currentPostId, ttsEnabled, playing, speed, visiblePosts])

  useEffect(() => {
    if (!ttsEnabled || !playing) cancelSpeech()
  }, [ttsEnabled, playing])

  function authorLabel(pk: string): string {
    return profiles.get(pk)?.name || shortNpub(pk)
  }

  // ---- Control handlers ----------------------------------------------------
  const togglePlay = useCallback(() => {
    setFollow(false)
    setPlaying((p) => !p)
  }, [])

  const jump = useCallback(
    (deltaMin: number) => {
      setFollow(false)
      setPlayheadAt((prev) =>
        clamp(prev + deltaMin * MINUTE, now - rangeMs, now),
      )
    },
    [now, rangeMs],
  )

  const toggleFollow = useCallback(() => {
    setFollow((f) => {
      const next = !f
      if (next) {
        setPlayheadAt(Date.now())
        setPlaying(true)
      }
      return next
    })
  }, [])

  const onSeek = useCallback(
    (fraction: number) => {
      setFollow(false)
      const ts = now - rangeMs + fraction * rangeMs
      setPlayheadAt(clamp(ts, now - rangeMs, now))
    },
    [now, rangeMs],
  )

  // Wheel-to-zoom on the ruler: change the visible window duration. The right
  // edge stays "now" (requirements §4.2, approximated).
  const onWheelZoom = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
    setRangeMs((prev) => clamp(prev * factor, MIN_RANGE_MS, MAX_RANGE_MS))
  }, [])

  // Date/time picker: jump the playhead to an arbitrary past time (§4.5).
  const onJumpTo = useCallback(
    (value: string) => {
      const ms = new Date(value).getTime()
      if (Number.isNaN(ms)) return
      setFollow(false)
      const target = Math.min(ms, Date.now())
      setPlayheadAt(target)
      // Trigger a fetch around the jumped-to time immediately.
      void fetchWindow(target - rangeMs, target + PREFETCH_MS)
    },
    [rangeMs, fetchWindow],
  )

  const onPost = useCallback(async () => {
    if (!nip07) return
    const content = composerText.trim()
    if (!content) return
    const stampMs = composerMode === 'now' ? Date.now() : playheadAt
    setPosting(true)
    try {
      const res = await publishNote(relays, content, toSec(stampMs))
      const okN = res.ok.length
      const failN = res.failed.length
      if (failN === 0) {
        setToast(`Published to ${okN} relay(s).`)
        setComposerText('')
      } else {
        const reasons = res.failed
          .map((f) => `${f.relay}: ${f.reason}`)
          .join(' · ')
        setToast(
          `Accepted by ${okN}, rejected by ${failN}. ${reasons}`,
        )
        if (okN > 0) setComposerText('')
      }
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Post failed.')
    } finally {
      setPosting(false)
    }
  }, [nip07, composerText, composerMode, playheadAt, relays])

  // ---- Login handlers ------------------------------------------------------
  const onSubmitLogin = useCallback(() => {
    const hex = decodePubkey(loginInput)
    if (!hex) {
      setLoginError('Enter a valid npub1… or 64-char hex pubkey.')
      return
    }
    setLoginError(null)
    setPubkey(hex)
  }, [loginInput])

  const onLoginExtension = useCallback(async () => {
    try {
      const hex = await getNip07Pubkey()
      setLoginError(null)
      setPubkey(hex)
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Extension login failed.')
    }
  }, [])

  const onLogout = useCallback(() => {
    setPubkey(null)
    setAuthors([])
    setProfiles(new Map())
    setStage('idle')
    setStageNote('')
    void saveSession({ pubkey: null, relays: DEFAULT_RELAYS })
  }, [])

  // ---- Render --------------------------------------------------------------
  const ticks = useMemo(() => generateTicks(now, rangeMs), [now, rangeMs])
  const playheadFraction = timeToFraction(playheadAt, now, rangeMs)
  const seekValue = Math.round(playheadFraction * 1000)

  if (!pubkey) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="logo-dot" />
            <div>
              <h1>NostrPlayer</h1>
              <p className="tagline">Nostr timeline playback — real events from relays</p>
            </div>
          </div>
        </header>

        <section className="login-panel" aria-label="Login">
          <h2>Sign in to load your timeline</h2>
          <p className="login-hint">
            Enter your <strong>npub</strong> (or 64-char hex pubkey) to fetch
            your real follow list and timeline from public Nostr relays. Posting
            requires a NIP-07 browser extension.
          </p>
          <div className="login-row">
            <input
              className="login-input"
              type="text"
              placeholder="npub1… or hex pubkey"
              value={loginInput}
              onChange={(e) => setLoginInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmitLogin()
              }}
              spellCheck={false}
            />
            <button type="button" className="ctrl primary" onClick={onSubmitLogin}>
              Load timeline
            </button>
          </div>
          {nip07 && (
            <button type="button" className="ctrl" onClick={onLoginExtension}>
              Login with extension (NIP-07)
            </button>
          )}
          {!nip07 && (
            <p className="login-note">
              No NIP-07 extension detected — you can still view a timeline by
              pubkey, but posting will be disabled.
            </p>
          )}
          {loginError && <p className="login-error">{loginError}</p>}
        </section>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo-dot" />
          <div>
            <h1>NostrPlayer</h1>
            <p className="tagline">Nostr timeline playback — real events from relays</p>
          </div>
        </div>
        <div className="status-cluster">
          {syncing && (
            <span className="sync-badge" title="Fetching timeline chunks">
              🔄 syncing
            </span>
          )}
          <span className={`live-badge ${live ? 'is-live' : ''}`}>
            <span className="live-pip" />
            {live ? 'LIVE' : `-${secondsBehind}s`}
          </span>
          <span className="clock" aria-label="current time">
            {formatClock(now)}
          </span>
          <button type="button" className="ctrl ghost" onClick={onLogout}>
            {shortNpub(pubkey)} · Logout
          </button>
        </div>
      </header>

      <div className="status-line" role="status">
        <span>
          {stage === 'error' ? '⚠️ ' : ''}
          {stageNote || 'Ready.'}
        </span>
        <span className="status-meta">
          {relays.length} relays · {authors.length} authors ·{' '}
          {store.size} notes cached
        </span>
      </div>

      <main className="stage">
        <section className="timeline-panel" aria-label="Timeline">
          <div className="timeline-head">
            <h2>Timeline</h2>
            <span className="window-label">
              window {Math.round(rangeMs / MINUTE)} min · playhead{' '}
              {live ? 'at NOW' : minutesAgoLabel(playheadAt, now)}
            </span>
          </div>

          <div className="ruler" onWheel={onWheelZoom}>
            <div className="ruler-track">
              {visiblePosts.map((p) => (
                <span
                  key={p.id}
                  className={`density-mark ${
                    toSec(playheadAt) >= p.created_at ? 'played' : 'upcoming'
                  }`}
                  style={{
                    left: `${
                      timeToFraction(toMs(p.created_at), now, rangeMs) * 100
                    }%`,
                  }}
                />
              ))}
              <div
                className="playhead"
                style={{ left: `${playheadFraction * 100}%` }}
              >
                <span className="playhead-flag">
                  {formatClock(playheadAt, false)}
                </span>
              </div>
            </div>
            <div className="ruler-labels">
              {ticks.map((t) => (
                <span
                  key={t.ts}
                  className={`ruler-label ${t.isNow ? 'now' : ''}`}
                  style={{ left: `${t.fraction * 100}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>
          </div>

          <input
            className="seek"
            type="range"
            min={0}
            max={1000}
            value={seekValue}
            aria-label="Seek playback position"
            onChange={(e) => onSeek(Number(e.target.value) / 1000)}
          />

          <div className="controls">
            <button
              type="button"
              className="ctrl primary"
              onClick={togglePlay}
              aria-pressed={playing}
            >
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button type="button" className="ctrl" onClick={() => jump(-1)}>
              ⏪ 1 min
            </button>
            <button type="button" className="ctrl" onClick={() => jump(1)}>
              ⏩ 1 min
            </button>

            <label className="ctrl-field">
              <span>Speed</span>
              <select
                value={speed}
                onChange={(e) =>
                  setSpeed(Number(e.target.value) as PlaybackSpeed)
                }
              >
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s.toFixed(1)}×
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className={`ctrl follow ${live ? 'on' : ''}`}
              onClick={toggleFollow}
              disabled={live}
              aria-pressed={live}
              title={live ? 'Live — following now' : 'Jump to now and follow'}
            >
              <span className={`follow-dot ${live ? 'green' : 'grey'}`} />
              {live ? 'LIVE' : 'Follow live'}
            </button>

            {ttsOk && (
              <button
                type="button"
                className={`ctrl toggle ${ttsEnabled ? 'on' : ''}`}
                onClick={() => setTtsEnabled((v) => !v)}
                aria-pressed={ttsEnabled}
              >
                {ttsEnabled ? '🔊 TTS on' : '🔇 TTS off'}
              </button>
            )}

            <label className="ctrl-field">
              <span>Jump to</span>
              <input
                type="datetime-local"
                value={toDatetimeLocalValue(playheadAt)}
                max={toDatetimeLocalValue(now)}
                onChange={(e) => onJumpTo(e.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="feed-panel" aria-label="Feed">
          <div className="feed-head">
            <h2>Feed</h2>
            <span className="feed-count">
              {visiblePosts.length} notes up to playhead
            </span>
          </div>
          <ul className="feed">
            {visiblePosts.length === 0 && (
              <li className="empty">
                No notes yet in this window. Notes appear as the playhead reaches
                their timestamp.
              </li>
            )}
            {visiblePosts
              .slice()
              .reverse()
              .map((post) => {
                const isCurrent = post.id === currentPostId
                const tsMs = toMs(post.created_at)
                return (
                  <li
                    key={post.id}
                    className={`card ${isCurrent ? 'current' : 'played'}`}
                  >
                    <div
                      className="avatar"
                      style={{ background: avatarColor(post.pubkey) }}
                      aria-hidden
                    >
                      {authorLabel(post.pubkey).slice(0, 1).toUpperCase()}
                    </div>
                    <div className="card-body">
                      <div className="card-head">
                        <span className="author">{authorLabel(post.pubkey)}</span>
                        <span className="npub">{shortNpub(post.pubkey)}</span>
                        <span className="time">{formatClock(tsMs)}</span>
                        {isCurrent && (
                          <span className="now-tag">
                            ▶ playing
                            {ttsEnabled && playing ? ' · 🔊' : ''}
                          </span>
                        )}
                      </div>
                      <p className="content">{post.content}</p>
                    </div>
                  </li>
                )
              })}
          </ul>
        </section>
      </main>

      <section className="composer" aria-label="Composer">
        <div className="composer-head">
          <h2>Compose</h2>
          {!nip07 && (
            <span className="stub-tag">
              NIP-07 extension required to post
            </span>
          )}
        </div>
        <textarea
          className="composer-input"
          placeholder={
            nip07
              ? "What's happening on nostr?"
              : 'Posting is disabled — install a NIP-07 signer extension to post.'
          }
          value={composerText}
          onChange={(e) => setComposerText(e.target.value)}
          rows={2}
          disabled={!nip07}
        />
        <div className="composer-foot">
          <fieldset className="ts-mode">
            <legend>Post timestamp</legend>
            <label>
              <input
                type="radio"
                name="ts-mode"
                checked={composerMode === 'now'}
                onChange={() => setComposerMode('now')}
              />
              Now ({formatClock(now)})
            </label>
            <label>
              <input
                type="radio"
                name="ts-mode"
                checked={composerMode === 'playback'}
                onChange={() => setComposerMode('playback')}
              />
              Playback position ({formatClock(playheadAt)})
            </label>
          </fieldset>
          <button
            type="button"
            className="ctrl primary"
            onClick={onPost}
            disabled={!nip07 || posting || !composerText.trim()}
          >
            {posting ? 'Posting…' : 'Post'}
          </button>
        </div>
        {composerMode === 'playback' && (
          <p className="composer-note">
            Note: posting with a past <code>created_at</code> may be rejected by
            relays as “too far off from the current time” (NIP-01). Rejections
            are reported per-relay.
          </p>
        )}
      </section>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
