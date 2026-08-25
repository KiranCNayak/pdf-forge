// Optional password layer for p2p-share, per docs/tools/p2p-share.md's
// "Encryption — getting the threat model right" section. Read that section
// before touching this file — the short version:
//
// WebRTC data channels are already DTLS-encrypted, so this layer does
// NOTHING against a passive network observer. What it defends against is a
// malicious or compromised SIGNALING SERVER rewriting SDP fingerprints to
// insert itself as a man in the middle. That threat is specific to our
// design — we introduced the signaling server that ihatepdf's version
// doesn't have — so this layer earns its place rather than being
// decorative "military-grade encryption" noise. The password must travel
// out-of-band from the room code (a different channel), or it protects
// nothing; that's a UI/process concern, not something this file can enforce.
//
// Construction matches ihatepdf's own (sound, per the doc's teardown):
// PBKDF2-SHA256, 200k iterations, deriving an AES-256-GCM key. Envelope on
// the wire is salt(16) || iv(12) || ciphertext, same layout, so there's
// nothing novel here to get wrong — just Web Crypto's standard incantation
// for it.

const PBKDF2_ITERATIONS = 200_000
const SALT_BYTES = 16
const IV_BYTES = 12

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password.')
    this.name = 'WrongPasswordError'
  }
}

async function deriveKey(password: string, salt: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

/** Encrypts plaintext into the salt‖iv‖ciphertext envelope. A fresh salt and
 * IV are drawn per call — never reuse an IV with the same derived key, the
 * one hard rule of GCM. */
export async function encryptBytes(plaintext: ArrayBuffer, password: string): Promise<ArrayBuffer> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(password, salt, 'encrypt')
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext)

  const envelope = new Uint8Array(SALT_BYTES + IV_BYTES + ciphertext.byteLength)
  envelope.set(salt, 0)
  envelope.set(iv, SALT_BYTES)
  envelope.set(new Uint8Array(ciphertext), SALT_BYTES + IV_BYTES)
  return envelope.buffer
}

/** Reverses encryptBytes. Throws WrongPasswordError specifically when GCM's
 * auth tag fails to verify — the doc is explicit that this must be
 * distinguishable from "the file arrived corrupt", because the fix for one
 * is "try the password again" and the fix for the other is "ask for a
 * resend". */
export async function decryptBytes(envelope: ArrayBuffer, password: string): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(envelope)
  const salt = bytes.slice(0, SALT_BYTES)
  const iv = bytes.slice(SALT_BYTES, SALT_BYTES + IV_BYTES)
  const ciphertext = bytes.slice(SALT_BYTES + IV_BYTES)
  const key = await deriveKey(password, salt, 'decrypt')

  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource)
  } catch {
    // AES-GCM's decrypt rejects on auth-tag mismatch, which is what a wrong
    // password looks like — it's also what actual bit-flip corruption looks
    // like, but corruption is what the SHA-256 check after a SUCCESSFUL
    // decrypt is for. A rejection here specifically means the key was wrong.
    throw new WrongPasswordError()
  }
}
