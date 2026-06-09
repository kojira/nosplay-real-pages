// Basic Web Speech API text-to-speech (requirements §5, basic subset).
//
// UNIMPLEMENTED (documented in IMPLEMENTATION_STATUS.md):
//  - Voice-per-npub (§5.3): a distinct voice hashed from each author's pubkey.
//  - Reply-target reading and emoji/mention filtering (§5.3).
//  - Reliable background playback (§5.4): browsers throttle/suspend the Web
//    Speech API in background tabs; we make no special accommodation.
//
// Behavior here is intentionally simple: cancel any in-flight utterance, then
// speak the current post. Rate is mapped from the playback speed.

export function ttsAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  )
}

/** Speak `text` at the given rate (playback speed multiplier). */
export function speak(text: string, rate: number): void {
  if (!ttsAvailable() || !text.trim()) return
  try {
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    // Clamp to the Web Speech API's valid rate range [0.1, 10].
    u.rate = Math.min(10, Math.max(0.1, rate))
    window.speechSynthesis.speak(u)
  } catch {
    // Ignore TTS errors.
  }
}

/** Cancel any in-flight speech. */
export function cancelSpeech(): void {
  if (!ttsAvailable()) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    // ignore
  }
}
