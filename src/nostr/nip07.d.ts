// Global type declaration for the NIP-07 browser signer extension.
// (https://github.com/nostr-protocol/nips/blob/master/07.md)

import type { Event, EventTemplate } from 'nostr-tools'

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: EventTemplate): Promise<Event>
      getRelays?(): Promise<Record<string, { read: boolean; write: boolean }>>
      nip04?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>
        decrypt(pubkey: string, ciphertext: string): Promise<string>
      }
    }
  }
}

export {}
