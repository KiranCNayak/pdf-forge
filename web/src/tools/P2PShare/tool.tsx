// P2P Share sends a file directly between two browsers over a WebRTC data
// channel — see docs/tools/p2p-share.md for the full design and the teardown
// of ihatepdf's actual (signaling-server-free, manual-paste) implementation
// this replaces. signaling/ is the Go relay: it pairs two browsers by a
// 6-character room code and forwards SDP/ICE as opaque payloads, never file
// bytes and never anything it parses.
//
// This file is UI + choreography only. The actual mechanics live in
// web/src/lib/p2p/: SignalingClient (the WebSocket), PeerLink (RTCPeerConnection
// + trickle ICE), transfer.ts (chunking, backpressure, the header/accept/
// reject/end control protocol, and the optional password layer from
// crypto.ts). See transfer.ts's header comment for the specific V1
// departures still left from the doc (whole-file-in-memory rather than
// IndexedDB, single file per transfer) — documented there, not silently cut.
//
// The password field is optional and off by default. Per docs/tools/
// p2p-share.md, it defends against a compromised signaling server, not
// passive eavesdropping (DTLS already covers that) — and only if the
// password travels to the other person by a channel OTHER than the one
// carrying the room code. Neither this file nor any other can enforce that;
// it's a one-line reminder in the UI at most.
//
// No TURN, STUN only: symmetric NAT and strict firewalls will fail outright
// for some fraction of attempts. ICE state 'failed' is reported with the
// doc's exact honest message, not a spinner that hangs forever.

import { useRef, useState } from 'react'
import { formatBytes } from '../../lib/device'
import { downloadBlob } from '../../lib/download'
import { WrongPasswordError } from '../../lib/p2p/crypto'
import { signalingUrl } from '../../lib/p2p/config'
import { PeerLink } from '../../lib/p2p/PeerLink'
import type { FileHeader, SignalErrorCode } from '../../lib/p2p/protocol'
import { SignalingClient } from '../../lib/p2p/SignalingClient'
import {
  receiveFile,
  sendFile,
  TransferCancelledError,
  TransferRejectedError,
  type OfferDecision,
} from '../../lib/p2p/transfer'

const SIGNAL_ERROR_MESSAGES: Record<SignalErrorCode, string> = {
  room_not_found: "That code doesn't match a live room. Check it and try again.",
  room_full: 'That room already has two people in it.',
  room_expired: 'That room expired — room codes are only valid for 10 minutes.',
  invalid_code: 'That doesn’t look like a room code — check for typos.',
  rate_limited: 'Too many rooms created from this connection recently. Wait a moment and try again.',
  invalid_message: 'Something in the connection went wrong. Try again.',
  internal_error: 'The signaling server hit an internal error. Try again.',
}

const ICE_FAILED_MESSAGE =
  'Your network blocks direct connections — this usually means a corporate firewall or a mobile carrier NAT. Try a different network, or use a regular file transfer.'

type SendStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'waiting'; code: string }
  | { kind: 'linking' }
  | { kind: 'offering' }
  | { kind: 'transferring'; sent: number; total: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

type ReceiveStatus =
  | { kind: 'idle' }
  | { kind: 'joining' }
  | { kind: 'waiting' }
  | { kind: 'incoming'; header: FileHeader }
  | { kind: 'receiving'; received: number; total: number }
  | { kind: 'done'; blob: Blob; header: FileHeader; verified: boolean }
  | { kind: 'error'; message: string }

export default function P2PShareTool() {
  const [role, setRole] = useState<'send' | 'receive' | null>(null)

  return (
    <>
      {role === null && (
        <div className="actions">
          <button onClick={() => setRole('send')}>Send a file</button>
          <button onClick={() => setRole('receive')}>Receive a file</button>
        </div>
      )}
      {role === 'send' && <SendPanel onReset={() => setRole(null)} />}
      {role === 'receive' && <ReceivePanel onReset={() => setRole(null)} />}
    </>
  )
}

function SendPanel({ onReset }: { onReset: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<SendStatus>({ kind: 'idle' })
  const signaling = useRef<SignalingClient | null>(null)
  const link = useRef<PeerLink | null>(null)
  const cancelled = useRef(false)

  function cleanup() {
    link.current?.close()
    signaling.current?.close()
    link.current = null
    signaling.current = null
  }

  async function start() {
    if (!file) return
    cancelled.current = false
    setStatus({ kind: 'connecting' })

    const sig = new SignalingClient()
    signaling.current = sig
    try {
      await sig.connect(signalingUrl())
    } catch {
      setStatus({ kind: 'error', message: 'Could not reach the signaling server. Is it running?' })
      return
    }

    // Registered once for the lifetime of this connection and left in place
    // rather than individually unsubscribed — each handler filters on
    // envelope type and is a no-op once its one relevant message has
    // arrived, and SignalingClient itself is torn down wholesale on
    // cancel/reset. See PeerLink's #handle for the same "filter, don't
    // subscribe-once" shape.
    sig.onMessage((env) => {
      if (env.type === 'error') {
        const code = (env.data as { code?: SignalErrorCode })?.code
        setStatus({ kind: 'error', message: code ? SIGNAL_ERROR_MESSAGES[code] : 'Something went wrong.' })
      }
    })

    sig.send({ type: 'create' })

    sig.onMessage((env) => {
      if (env.type !== 'created' || !env.code) return
      setStatus({ kind: 'waiting', code: env.code })

      const pl = new PeerLink(sig, env.code)
      link.current = pl
      pl.onState = (s) => {
        if (s === 'failed') setStatus({ kind: 'error', message: ICE_FAILED_MESSAGE })
        else if (s === 'disconnected' || s === 'closed') {
          setStatus((cur) => (cur.kind === 'done' ? cur : { kind: 'error', message: 'The other side disconnected.' }))
        }
      }

      sig.onMessage((joinEnv) => {
        if (joinEnv.type !== 'peer-joined') return
        setStatus({ kind: 'linking' })
        void (async () => {
          const dc = await pl.startAsSender()
          dc.onopen = () => {
            setStatus({ kind: 'offering' })
            sendFile(
              dc,
              file,
              (sent, total) => setStatus({ kind: 'transferring', sent, total }),
              () => cancelled.current,
              password || undefined,
            )
              .then(() => setStatus({ kind: 'done' }))
              .catch((err: unknown) => {
                if (err instanceof TransferRejectedError) setStatus({ kind: 'error', message: err.message })
                else if (err instanceof TransferCancelledError) setStatus({ kind: 'error', message: 'Cancelled.' })
                else setStatus({ kind: 'error', message: 'Transfer failed.' })
              })
          }
        })()
      })
    })
  }

  function cancel() {
    cancelled.current = true
    cleanup()
    setStatus({ kind: 'error', message: 'Cancelled.' })
  }

  function reset() {
    cleanup()
    setFile(null)
    setStatus({ kind: 'idle' })
    onReset()
  }

  return (
    <>
      {status.kind === 'idle' && (
        <>
          <p>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </p>
          {file && (
            <p className="muted">
              {file.name} · {formatBytes(file.size)}
            </p>
          )}
          <p>
            <label>
              Password (optional)
              <br />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for none"
              />
            </label>
          </p>
          {password && (
            <p className="muted">
              Share this password with them a different way than the room code — sending both together defeats the
              point.
            </p>
          )}
          <div className="actions">
            <button onClick={start} disabled={!file}>
              Create room
            </button>
            <button onClick={onReset}>Back</button>
          </div>
        </>
      )}

      {status.kind === 'connecting' && <p className="muted">Connecting to the signaling server…</p>}

      {status.kind === 'waiting' && (
        <div className="result">
          <p className="muted">Share this code with the other device — it's valid for 10 minutes:</p>
          <p style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '.1em' }}>{status.code}</p>
          <p className="muted">Waiting for them to join…</p>
          <button onClick={cancel}>Cancel</button>
        </div>
      )}

      {status.kind === 'linking' && <p className="muted">Peer joined — connecting…</p>}
      {status.kind === 'offering' && <p className="muted">Connected. Waiting for them to accept the file…</p>}

      {status.kind === 'transferring' && (
        <div className="result">
          <p>
            Sending {file?.name} — {formatBytes(status.sent)} / {formatBytes(status.total)}
          </p>
          <progress value={status.sent} max={status.total} style={{ width: '100%' }} />
          <button onClick={cancel}>Cancel</button>
        </div>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <p>Sent · {file?.name}</p>
          <button onClick={reset}>Send another</button>
        </div>
      )}

      {status.kind === 'error' && (
        <div className="result">
          <p className="err">{status.message}</p>
          <button onClick={reset}>Start over</button>
        </div>
      )}
    </>
  )
}

function ReceivePanel({ onReset }: { onReset: () => void }) {
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<ReceiveStatus>({ kind: 'idle' })
  const signaling = useRef<SignalingClient | null>(null)
  const link = useRef<PeerLink | null>(null)
  const decision = useRef<((decision: OfferDecision) => void) | null>(null)
  const [incomingPassword, setIncomingPassword] = useState('')

  function cleanup() {
    link.current?.close()
    signaling.current?.close()
    link.current = null
    signaling.current = null
  }

  async function start() {
    const trimmed = code.trim().toUpperCase()
    if (!trimmed) return
    setStatus({ kind: 'joining' })

    const sig = new SignalingClient()
    signaling.current = sig
    try {
      await sig.connect(signalingUrl())
    } catch {
      setStatus({ kind: 'error', message: 'Could not reach the signaling server. Is it running?' })
      return
    }

    sig.onMessage((env) => {
      if (env.type === 'error') {
        const errCode = (env.data as { code?: SignalErrorCode })?.code
        setStatus({ kind: 'error', message: errCode ? SIGNAL_ERROR_MESSAGES[errCode] : 'Something went wrong.' })
      }
    })

    sig.send({ type: 'join', code: trimmed })

    sig.onMessage((env) => {
      if (env.type !== 'joined') return
      setStatus({ kind: 'waiting' })

      const pl = new PeerLink(sig, trimmed)
      link.current = pl
      pl.onState = (s) => {
        if (s === 'failed') setStatus({ kind: 'error', message: ICE_FAILED_MESSAGE })
        else if (s === 'disconnected' || s === 'closed') {
          setStatus((cur) => (cur.kind === 'done' ? cur : { kind: 'error', message: 'The other side disconnected.' }))
        }
      }
      pl.onChannel = (dc) => {
        void receiveFile(
          dc,
          (header) =>
            new Promise<OfferDecision>((resolve) => {
              decision.current = resolve
              setStatus({ kind: 'incoming', header })
            }),
          (received, total) => setStatus({ kind: 'receiving', received, total }),
        )
          .then((result) => setStatus({ kind: 'done', blob: result.blob, header: result.header, verified: result.verified }))
          .catch((err: unknown) => {
            if (err instanceof TransferRejectedError) setStatus({ kind: 'idle' })
            else if (err instanceof TransferCancelledError) setStatus({ kind: 'error', message: 'The sender cancelled.' })
            else if (err instanceof WrongPasswordError) setStatus({ kind: 'error', message: 'Wrong password.' })
            else setStatus({ kind: 'error', message: 'Transfer failed.' })
          })
      }
      pl.startAsReceiver()
    })
  }

  function respond(accept: boolean) {
    decision.current?.({ accept, password: incomingPassword || undefined })
    decision.current = null
    setIncomingPassword('')
  }

  function reset() {
    cleanup()
    setCode('')
    setStatus({ kind: 'idle' })
    onReset()
  }

  return (
    <>
      {status.kind === 'idle' && (
        <>
          <p>
            <label>
              Room code
              <br />
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXXXX"
                style={{ textTransform: 'uppercase', letterSpacing: '.1em' }}
              />
            </label>
          </p>
          <div className="actions">
            <button onClick={start} disabled={!code.trim()}>
              Connect
            </button>
            <button onClick={onReset}>Back</button>
          </div>
        </>
      )}

      {status.kind === 'joining' && <p className="muted">Connecting…</p>}
      {status.kind === 'waiting' && <p className="muted">Connected. Waiting for the sender…</p>}

      {status.kind === 'incoming' && (
        <div className="result">
          <p>
            Incoming: {status.header.name} · {formatBytes(status.header.size)}
          </p>
          {status.header.encrypted && (
            <p>
              <label>
                This file is password protected.
                <br />
                <input
                  type="password"
                  value={incomingPassword}
                  onChange={(e) => setIncomingPassword(e.target.value)}
                  placeholder="Password"
                />
              </label>
            </p>
          )}
          <div className="actions">
            <button onClick={() => respond(true)} disabled={status.header.encrypted && !incomingPassword}>
              Accept
            </button>
            <button onClick={() => respond(false)}>Decline</button>
          </div>
        </div>
      )}

      {status.kind === 'receiving' && (
        <div className="result">
          <p>
            Receiving — {formatBytes(status.received)} / {formatBytes(status.total)}
          </p>
          <progress value={status.received} max={status.total} style={{ width: '100%' }} />
        </div>
      )}

      {status.kind === 'done' && (
        <div className="result">
          {status.verified ? (
            <p>Received · {status.header.name} · {formatBytes(status.header.size)} · integrity verified</p>
          ) : (
            <p className="err">
              Received {status.header.name}, but its checksum doesn't match what the sender declared — the file may
              be corrupt. Download at your own risk, or ask them to resend.
            </p>
          )}
          <button onClick={() => downloadBlob(status.blob, status.header.name)}>Download</button>
          <button onClick={reset}>Receive another</button>
        </div>
      )}

      {status.kind === 'error' && (
        <div className="result">
          <p className="err">{status.message}</p>
          <button onClick={reset}>Start over</button>
        </div>
      )}
    </>
  )
}
