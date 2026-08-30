// Fingerprint is a pure UI layer over the addWatermark op — same reasoning
// as PageNumbers/HeadersFooters: no new engine code, no new EngineClient
// method. See docs/tools/fingerprint.md for the design.
//
// The catalog's own spec ("per-recipient invisible marks for leak
// attribution") doesn't need anything pdfcpu can't already do: a genuinely
// invisible (steganographic, whitespace-encoded, ...) mark is its own
// research project, but a faint, small, four-corner text stamp — real
// vector text, extractable, just visually unobtrusive at normal reading
// size — already achieves the actual goal (a document that leaks can be
// traced to the copy it came from) with the exact mechanism AddWatermark
// already has. Four corners, not one placement, so a single corner being
// cropped or covered doesn't erase every copy of the mark; four sequential
// engine.addWatermark calls chained the same way HeadersFooters chains two.
//
// A random suffix is always appended to whatever label the user types —
// even a blank label, or two recipients given the same label by mistake,
// still produce a genuinely unique code per download.

import { useState } from 'react'
import { FilenameField } from '../../components/FilenameField'
import { FilePicker } from '../../components/FilePicker'
import { engine } from '../../engine/EngineClient'
import { EngineError } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateEngineBytes, formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'
import { sanitizeFilename } from '../../lib/filename'

interface Staged {
  file: File
  pages?: number
  needsPassword?: boolean
  error?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; corner: number; total: number }
  | { kind: 'done'; bytes: Uint8Array; code: string }
  | { kind: 'error'; message: string; code: string }

const CORNERS = ['tl', 'tr', 'bl', 'br']

/** Same reasoning as HeadersFooters' toArrayBuffer — the next chained call
 * needs precisely this call's output bytes as its own input. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** 6 hex chars from real randomness — collision-resistant enough that two
 * recipients never end up sharing a traceable code by chance. */
function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

export default function FingerprintTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('fingerprinted.pdf')
  const caps = deviceCaps()

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    setStaged({ file })
    setStatus({ kind: 'idle' })
    setFilename(`${file.name.replace(/\.pdf$/i, '')}-fingerprinted.pdf`)
    try {
      const pages = await engine.pageCount(await file.arrayBuffer())
      setStaged((cur) => (cur && cur.file === file ? { ...cur, pages } : cur))
    } catch (err) {
      if (err instanceof EngineError && err.code === 'ERR_ENCRYPTED') {
        setStaged((cur) => (cur && cur.file === file ? { ...cur, needsPassword: true } : cur))
      } else {
        const msg = err instanceof EngineError ? err.userMessage : 'Could not read this file.'
        setStaged((cur) => (cur && cur.file === file ? { ...cur, error: msg } : cur))
      }
    }
  }

  async function confirmPassword() {
    if (!staged) return
    try {
      const pages = await engine.pageCount(await staged.file.arrayBuffer(), password)
      setStaged((cur) => (cur ? { ...cur, pages, needsPassword: false, error: undefined } : cur))
    } catch (err) {
      const msg = err instanceof EngineError ? err.userMessage : 'Could not read this file.'
      setStaged((cur) => (cur ? { ...cur, error: msg } : cur))
    }
  }

  async function run() {
    if (!staged) return
    const code = label.trim() ? `${label.trim()}-${randomSuffix()}` : randomSuffix()
    setStatus({ kind: 'working', corner: 0, total: CORNERS.length })

    try {
      let buffer = await staged.file.arrayBuffer()
      const pw = staged.needsPassword ? password : undefined

      for (let i = 0; i < CORNERS.length; i++) {
        const bytes = await engine.addWatermark(buffer, {
          text: code,
          fontSize: 7,
          color: '#cccccc',
          position: CORNERS[i],
          rotation: 0,
          opacity: 0.15,
          onTop: true,
          password: pw,
        })
        buffer = toArrayBuffer(bytes)
        setStatus({ kind: 'working', corner: i + 1, total: CORNERS.length })
      }

      setStatus({ kind: 'done', bytes: new Uint8Array(buffer), code })
    } catch (err) {
      if (err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  const blocked = !staged || !!staged.error || staged.needsPassword || !budget.ok || status.kind === 'working'

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, stamped with a faint per-copy code" />

      {staged && (
        <p className="muted">
          {staged.file.name} · {formatBytes(staged.file.size)}
          {staged.pages !== undefined && ` · ${staged.pages} page${staged.pages === 1 ? '' : 's'}`}
          {staged.error && <strong className="err"> · {staged.error}</strong>}
        </p>
      )}

      {staged?.needsPassword && (
        <p>
          <label>
            This file is password protected.{' '}
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
          </label>{' '}
          <button onClick={confirmPassword} disabled={!password}>
            Unlock
          </button>
        </p>
      )}

      {staged && !staged.needsPassword && (
        <>
          <p className="muted">
            Device tier <code>{caps.tier}</code> (cap {formatBytes(caps.maxFileBytes)})
          </p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <p>
            <label>
              Recipient label (optional)
              <br />
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="jane@example.com, Copy for Legal, …"
              />
            </label>
          </p>
          <p className="muted">
            A random code is always appended, even with no label — every download gets its own unique fingerprint.
            Stamped faintly in all four corners of every page, real (extractable) text, not an image — small and
            unobtrusive at normal reading size, but present in the file if this copy ever leaks.
          </p>

          <div className="actions">
            <button onClick={run} disabled={blocked}>
              {status.kind === 'working' ? 'Fingerprinting…' : 'Fingerprint'}
            </button>
          </div>
        </>
      )}

      {status.kind === 'working' && (
        <p className="muted">
          Stamping corner {status.corner}/{status.total}
        </p>
      )}

      {status.kind === 'error' && (
        <p className="err">
          {status.message} <code>{status.code}</code>
        </p>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <p>
            Fingerprinted · {formatBytes(status.bytes.byteLength)}
            <br />
            Code: <code>{status.code}</code> — record this alongside who the copy is going to.
          </p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'fingerprinted.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
