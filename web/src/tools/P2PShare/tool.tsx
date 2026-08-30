// P2P Share sends a file directly between two browsers over a WebRTC data
// channel — see docs/tools/p2p-share.md for the full design and the teardown
// of ihatepdf's actual (signaling-server-free, manual-paste) implementation
// this replaces. signaling/ is the Go relay: it pairs two browsers by a
// 6-character room code and forwards SDP/ICE as opaque payloads, never file
// bytes and never anything it parses.
//
// This file is UI + choreography only. The actual mechanics live in
// web/src/lib/p2p/: SignalingClient (the WebSocket) or BroadcastSignalingClient
// (the same-browser, no-server shortcut — same SignalTransport interface, a
// checkbox on each panel picks which one), PeerLink (RTCPeerConnection +
// trickle ICE over either transport), ManualLink (the copy-paste fallback for
// when neither transport can reach the other side at all — vanilla ICE,
// surfaced only after a signaling connection actually fails), transfer.ts
// (chunking, backpressure, the header/accept/reject/end control protocol,
// gzip, and the optional password layer from crypto.ts). See transfer.ts's
// header comment for the one V1 departure still left from the doc (whole
// file in memory rather than IndexedDB) — documented there, not silently cut.
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
import { XIcon } from '../../components/icons'
import { BroadcastSignalingClient } from '../../lib/p2p/BroadcastSignalingClient'
import { formatBytes } from '../../lib/device'
import { downloadBlob } from '../../lib/download'
import { WrongPasswordError } from '../../lib/p2p/crypto'
import { signalingUrl } from '../../lib/p2p/config'
import { ManualLink } from '../../lib/p2p/ManualLink'
import { PeerLink } from '../../lib/p2p/PeerLink'
import type { FileHeader, SignalErrorCode } from '../../lib/p2p/protocol'
import { SignalingClient } from '../../lib/p2p/SignalingClient'
import type { SignalTransport } from '../../lib/p2p/SignalTransport'
import {
  receiveFiles,
  sendFiles,
  TransferCancelledError,
  TransferRejectedError,
  type OfferDecision,
  type ReceivedFile,
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
  | { kind: 'signal-unreachable' }
  | { kind: 'manual-generating' }
  | { kind: 'manual-offer'; code: string }
  | { kind: 'waiting'; code: string }
  | { kind: 'linking' }
  | { kind: 'offering' }
  | { kind: 'transferring'; fileIndex: number; fileCount: number; sent: number; total: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

type ReceiveStatus =
  | { kind: 'idle' }
  | { kind: 'joining' }
  | { kind: 'signal-unreachable' }
  | { kind: 'manual-paste' }
  | { kind: 'manual-generating' }
  | { kind: 'manual-answer'; code: string }
  | { kind: 'waiting' }
  | { kind: 'incoming'; header: FileHeader }
  | { kind: 'receiving'; fileIndex: number; fileCount: number; received: number; total: number }
  | { kind: 'done'; files: ReceivedFile[] }
  | { kind: 'error'; message: string }

function downloadAll(files: ReceivedFile[]) {
  files.forEach((f, i) => setTimeout(() => downloadBlob(f.blob, f.header.name), i * 150))
}

export default function P2PShareTool() {
  const [role, setRole] = useState<'send' | 'receive' | null>(null)

  return (
    <>
      {role === null && (
        <div className="actions">
          <button onClick={() => setRole('send')}>Send a File</button>
          <button onClick={() => setRole('receive')}>Receive a File</button>
        </div>
      )}
      {role === 'send' && <SendPanel onReset={() => setRole(null)} />}
      {role === 'receive' && <ReceivePanel onReset={() => setRole(null)} />}
    </>
  )
}

function SendPanel({ onReset }: { onReset: () => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [password, setPassword] = useState('')
  const [sameBrowser, setSameBrowser] = useState(false)
  const [status, setStatus] = useState<SendStatus>({ kind: 'idle' })
  const [manualAnswerInput, setManualAnswerInput] = useState('')
  const signaling = useRef<SignalTransport | null>(null)
  const link = useRef<PeerLink | null>(null)
  const manualLink = useRef<ManualLink | null>(null)
  const manualDc = useRef<RTCDataChannel | null>(null)
  const cancelled = useRef(false)

  function addFiles(list: FileList | null) {
    if (!list) return
    setFiles((cur) => [...cur, ...Array.from(list)])
  }

  function removeAt(i: number) {
    setFiles((cur) => cur.filter((_, j) => j !== i))
  }

  function cleanup() {
    link.current?.close()
    signaling.current?.close()
    manualLink.current?.close()
    link.current = null
    signaling.current = null
    manualLink.current = null
    manualDc.current = null
  }

  /** Shared by both paths (signaling-relayed and manual-paste) — once a data
   * channel exists and opens, sending a batch looks identical either way. */
  function beginSending(dc: RTCDataChannel) {
    dc.onopen = () => {
      setStatus({ kind: 'offering' })
      sendFiles(
        dc,
        files,
        (fileIndex, sent, total) =>
          setStatus({ kind: 'transferring', fileIndex, fileCount: files.length, sent, total }),
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
  }

  /** The manual-paste fallback, per docs/tools/p2p-share.md's edge-case
   * table — only reachable after the signaling server has already failed.
   * See ManualLink's own header for why this has to block on full ICE
   * gathering instead of trickling candidates. */
  async function startManual() {
    cancelled.current = false
    setStatus({ kind: 'manual-generating' })
    const ml = new ManualLink()
    manualLink.current = ml
    ml.onState = (s) => {
      if (s === 'failed') setStatus({ kind: 'error', message: ICE_FAILED_MESSAGE })
    }
    const { dc, code } = await ml.createOfferCode()
    manualDc.current = dc
    setStatus({ kind: 'manual-offer', code })
  }

  function connectManual(answerCode: string) {
    setStatus({ kind: 'linking' })
    void manualLink.current
      ?.applyAnswerCode(answerCode)
      .then(() => beginSending(manualDc.current!))
      .catch(() => setStatus({ kind: 'error', message: "That code doesn't look right. Check it and try again." }))
  }

  async function start() {
    if (files.length === 0) return
    cancelled.current = false
    setStatus({ kind: 'connecting' })

    const sig: SignalTransport = sameBrowser ? new BroadcastSignalingClient() : new SignalingClient()
    signaling.current = sig
    try {
      await sig.connect(signalingUrl())
    } catch {
      setStatus({ kind: 'signal-unreachable' })
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
          beginSending(dc)
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
    setFiles([])
    setStatus({ kind: 'idle' })
    onReset()
  }

  return (
    <>
      {status.kind === 'idle' && (
        <>
          <p>
            <input type="file" multiple onChange={(e) => addFiles(e.target.files)} />
          </p>
          {files.length > 0 && (
            <ol className="files">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <span className="name">{f.name}</span>
                  <span className="muted">{formatBytes(f.size)}</span>
                  <span className="controls">
                    <button onClick={() => removeAt(i)} aria-label="Remove">
                      <XIcon />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p>
            <label>
              Password (optional)
              <br />
              <input
                type="password"
                autoComplete="off"
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
          <p>
            <label>
              <input type="checkbox" checked={sameBrowser} onChange={(e) => setSameBrowser(e.target.checked)} />{' '}
              Same browser, different tab (skips the signaling server entirely)
            </label>
          </p>
          <div className="actions">
            <button onClick={start} disabled={files.length === 0}>
              Create Room
            </button>
            <button onClick={onReset}>Back</button>
          </div>
          <p className="muted">
            No signaling server available?{' '}
            <button onClick={startManual} disabled={files.length === 0} style={{ padding: 0 }}>
              Connect directly by pasting codes.
            </button>
          </p>
        </>
      )}

      {status.kind === 'connecting' && <p className="muted">Connecting to the signaling server…</p>}

      {status.kind === 'signal-unreachable' && (
        <div className="result">
          <p className="err">Could not reach the signaling server. Is it running?</p>
          <p className="muted">
            You can still connect directly by pasting a connection code back and forth — slower to set up, but needs
            no server at all.
          </p>
          <div className="actions">
            <button onClick={startManual}>Connect Without a Server</button>
            <button onClick={onReset}>Back</button>
          </div>
        </div>
      )}

      {status.kind === 'manual-generating' && <p className="muted">Generating a connection code…</p>}

      {status.kind === 'manual-offer' && (
        <div className="result">
          <p className="muted">Send this code to the other person (chat, email, read it aloud — anything works):</p>
          <textarea readOnly value={status.code} rows={4} style={{ width: '100%', fontFamily: 'monospace' }} />
          <p className="muted">Then paste the answer code they send back:</p>
          <textarea
            value={manualAnswerInput}
            onChange={(e) => setManualAnswerInput(e.target.value)}
            rows={4}
            style={{ width: '100%', fontFamily: 'monospace' }}
            placeholder="Paste their answer code here"
          />
          <div className="actions">
            <button onClick={() => connectManual(manualAnswerInput)} disabled={!manualAnswerInput.trim()}>
              Connect
            </button>
            <button onClick={onReset}>Back</button>
          </div>
        </div>
      )}

      {status.kind === 'waiting' && (
        <div className="result">
          <p className="muted">Share this code with the other device — it's valid for 10 minutes:</p>
          <p style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '.1em' }}>{status.code}</p>
          <p className="muted">Waiting for them to join…</p>
          <button onClick={cancel}>Cancel</button>
        </div>
      )}

      {status.kind === 'linking' && <p className="muted">Peer joined — connecting…</p>}
      {status.kind === 'offering' && (
        <p className="muted">
          Connected. Waiting for them to accept the file{files.length === 1 ? '' : 's'}…
        </p>
      )}

      {status.kind === 'transferring' && (
        <div className="result">
          <p>
            Sending {files[status.fileIndex]?.name}
            {status.fileCount > 1 && ` (${status.fileIndex + 1} of ${status.fileCount})`} —{' '}
            {formatBytes(status.sent)} / {formatBytes(status.total)}
          </p>
          <progress value={status.sent} max={status.total} style={{ width: '100%' }} />
          <button onClick={cancel}>Cancel</button>
        </div>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <p>
            Sent · {files.length} file{files.length === 1 ? '' : 's'}
          </p>
          <button onClick={reset}>Send Another</button>
        </div>
      )}

      {status.kind === 'error' && (
        <div className="result">
          <p className="err">{status.message}</p>
          <button onClick={reset}>Start Over</button>
        </div>
      )}
    </>
  )
}

function ReceivePanel({ onReset }: { onReset: () => void }) {
  const [code, setCode] = useState('')
  const [sameBrowser, setSameBrowser] = useState(false)
  const [status, setStatus] = useState<ReceiveStatus>({ kind: 'idle' })
  const signaling = useRef<SignalTransport | null>(null)
  const link = useRef<PeerLink | null>(null)
  const manualLink = useRef<ManualLink | null>(null)
  const decision = useRef<((decision: OfferDecision) => void) | null>(null)
  const fileCount = useRef(1)
  const [incomingPassword, setIncomingPassword] = useState('')
  const [manualOfferInput, setManualOfferInput] = useState('')

  function cleanup() {
    link.current?.close()
    signaling.current?.close()
    manualLink.current?.close()
    link.current = null
    signaling.current = null
    manualLink.current = null
  }

  /** Shared by both paths (signaling-relayed and manual-paste) — once the
   * data channel arrives, receiving a batch looks identical either way. */
  function beginReceiving(dc: RTCDataChannel) {
    void receiveFiles(
      dc,
      (header) =>
        new Promise<OfferDecision>((resolve) => {
          fileCount.current = header.batchTotal
          decision.current = resolve
          setStatus({ kind: 'incoming', header })
        }),
      (fileIndex, received, total) =>
        setStatus({ kind: 'receiving', fileIndex, fileCount: fileCount.current, received, total }),
    )
      .then((files) => setStatus({ kind: 'done', files }))
      .catch((err: unknown) => {
        if (err instanceof TransferRejectedError) setStatus({ kind: 'idle' })
        else if (err instanceof TransferCancelledError) setStatus({ kind: 'error', message: 'The sender cancelled.' })
        else if (err instanceof WrongPasswordError) setStatus({ kind: 'error', message: 'Wrong password.' })
        else setStatus({ kind: 'error', message: 'Transfer failed.' })
      })
  }

  /** The manual-paste fallback's receiver half — reachable only after
   * signaling has already failed to connect. See SendPanel's startManual/
   * ManualLink's own header for the matching sender-side flow. */
  async function generateManualAnswer(offerCode: string) {
    setStatus({ kind: 'manual-generating' })
    const ml = new ManualLink()
    manualLink.current = ml
    ml.onState = (s) => {
      if (s === 'failed') setStatus({ kind: 'error', message: ICE_FAILED_MESSAGE })
    }
    ml.onChannel = beginReceiving
    try {
      const answerCode = await ml.acceptOfferCode(offerCode)
      setStatus({ kind: 'manual-answer', code: answerCode })
    } catch {
      setStatus({ kind: 'error', message: "That code doesn't look right. Check it and try again." })
    }
  }

  async function start() {
    const trimmed = code.trim().toUpperCase()
    if (!trimmed) return
    setStatus({ kind: 'joining' })

    const sig: SignalTransport = sameBrowser ? new BroadcastSignalingClient() : new SignalingClient()
    signaling.current = sig
    try {
      await sig.connect(signalingUrl())
    } catch {
      setStatus({ kind: 'signal-unreachable' })
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
      pl.onChannel = beginReceiving
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
                autoComplete="off"
                spellCheck={false}
                style={{ textTransform: 'uppercase', letterSpacing: '.1em' }}
              />
            </label>
          </p>
          <p>
            <label>
              <input type="checkbox" checked={sameBrowser} onChange={(e) => setSameBrowser(e.target.checked)} />{' '}
              Same browser, different tab (skips the signaling server entirely)
            </label>
          </p>
          <div className="actions">
            <button onClick={start} disabled={!code.trim()}>
              Connect
            </button>
            <button onClick={onReset}>Back</button>
          </div>
          <p className="muted">
            Got a connection code from the sender instead of a room code?{' '}
            <button onClick={() => setStatus({ kind: 'manual-paste' })} style={{ padding: 0 }}>
              Paste it here.
            </button>
          </p>
        </>
      )}

      {status.kind === 'joining' && <p className="muted">Connecting…</p>}

      {status.kind === 'signal-unreachable' && (
        <div className="result">
          <p className="err">Could not reach the signaling server. Is it running?</p>
          <p className="muted">
            You can still connect directly by pasting a connection code back and forth — slower to set up, but needs
            no server at all.
          </p>
          <div className="actions">
            <button onClick={() => setStatus({ kind: 'manual-paste' })}>Paste a Connection Code</button>
            <button onClick={onReset}>Back</button>
          </div>
        </div>
      )}

      {status.kind === 'manual-paste' && (
        <div className="result">
          <p className="muted">Paste the connection code the sender gave you:</p>
          <textarea
            value={manualOfferInput}
            onChange={(e) => setManualOfferInput(e.target.value)}
            rows={4}
            style={{ width: '100%', fontFamily: 'monospace' }}
            placeholder="Paste their offer code here"
          />
          <div className="actions">
            <button onClick={() => generateManualAnswer(manualOfferInput)} disabled={!manualOfferInput.trim()}>
              Generate Answer
            </button>
            <button onClick={onReset}>Back</button>
          </div>
        </div>
      )}

      {status.kind === 'manual-generating' && <p className="muted">Generating a connection code…</p>}

      {status.kind === 'manual-answer' && (
        <div className="result">
          <p className="muted">Send this code back to the sender to complete the connection:</p>
          <textarea readOnly value={status.code} rows={4} style={{ width: '100%', fontFamily: 'monospace' }} />
          <p className="muted">Once they paste it in, the transfer will start automatically.</p>
        </div>
      )}

      {status.kind === 'waiting' && <p className="muted">Connected. Waiting for the sender…</p>}

      {status.kind === 'incoming' && (
        <div className="result">
          <p>
            Incoming: {status.header.name} · {formatBytes(status.header.size)}
            {status.header.batchTotal > 1 && ` (file ${status.header.batchIndex} of ${status.header.batchTotal})`}
          </p>
          {status.header.batchTotal > 1 && (
            <p className="muted">
              This is a batch of {status.header.batchTotal} files — accepting takes all of them.
            </p>
          )}
          {status.header.encrypted && (
            <p>
              <label>
                This file is password protected.
                <br />
                <input
                  type="password"
                  autoComplete="off"
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
            Receiving{status.fileCount > 1 && ` (file ${status.fileIndex + 1} of ${status.fileCount})`} —{' '}
            {formatBytes(status.received)} / {formatBytes(status.total)}
          </p>
          <progress value={status.received} max={status.total} style={{ width: '100%' }} />
        </div>
      )}

      {status.kind === 'done' && status.files.length === 1 && (
        <div className="result">
          {status.files[0].verified ? (
            <p>
              Received · {status.files[0].header.name} · {formatBytes(status.files[0].header.size)} · integrity
              verified
            </p>
          ) : (
            <p className="err">
              Received {status.files[0].header.name}, but its checksum doesn't match what the sender declared — the
              file may be corrupt. Download at your own risk, or ask them to resend.
            </p>
          )}
          <button onClick={() => downloadBlob(status.files[0].blob, status.files[0].header.name)}>Download</button>
          <button onClick={reset}>Receive Another</button>
        </div>
      )}

      {status.kind === 'done' && status.files.length > 1 && (
        <div className="result">
          <p>{status.files.length} files received.</p>
          <ol className="files">
            {status.files.map((f, i) => (
              <li key={`${f.header.name}-${i}`}>
                <span className="name">{f.header.name}</span>
                <span className="muted">
                  {formatBytes(f.header.size)}
                  {!f.verified && (
                    <strong className="err"> · checksum mismatch, may be corrupt</strong>
                  )}
                </span>
                <span className="controls">
                  <button onClick={() => downloadBlob(f.blob, f.header.name)}>Download</button>
                </span>
              </li>
            ))}
          </ol>
          <div className="actions">
            <button onClick={() => downloadAll(status.files)}>Download All</button>
            <button onClick={reset}>Receive Another</button>
          </div>
        </div>
      )}

      {status.kind === 'error' && (
        <div className="result">
          <p className="err">{status.message}</p>
          <button onClick={reset}>Start Over</button>
        </div>
      )}
    </>
  )
}
