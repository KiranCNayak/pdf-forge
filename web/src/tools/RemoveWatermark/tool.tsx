// Remove Watermark follows the RemovePassword/Rotate shape. See
// docs/tools/remove-watermark.md — the removal counterpart to AddWatermark,
// same file on the engine side (engine/internal/ops/watermark.go).
//
// Two independent things can require a password prompt or block progress
// here, and they're handled separately: the file itself may be encrypted
// (same needsPassword dance as Rotate/Split), and — unlike RemovePassword,
// where "not encrypted" blocks the button — "no watermark detected" does
// NOT block Remove. Running removal on a file with no watermark is a
// harmless no-op per the doc, and the button staying enabled is what makes
// that an honest statement rather than a UI lie.
//
// Selection accepts pdfcpu's raw page-selection tokens directly — typing
// "even" or "odd" into the same text field every other selection-based tool
// here already has works with no special UI, per the doc's "Page selection"
// section.

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
  hasWatermark?: boolean
  needsPassword?: boolean
  error?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; stage: string; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'error'; message: string; code: string }

export default function RemoveWatermarkTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [allPages, setAllPages] = useState(true)
  const [selectionText, setSelectionText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('unwatermarked.pdf')
  const caps = deviceCaps()

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    setStaged({ file })
    setStatus({ kind: 'idle' })

    try {
      const hasWatermark = await engine.hasWatermarks(await file.arrayBuffer())
      setStaged((cur) => (cur && cur.file === file ? { ...cur, hasWatermark } : cur))
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
      const hasWatermark = await engine.hasWatermarks(await staged.file.arrayBuffer(), password)
      setStaged((cur) => (cur ? { ...cur, hasWatermark, needsPassword: false, error: undefined } : cur))
    } catch (err) {
      const msg = err instanceof EngineError ? err.userMessage : 'Could not read this file.'
      setStaged((cur) => (cur ? { ...cur, error: msg } : cur))
    }
  }

  async function run() {
    if (!staged) return
    setStatus({ kind: 'working', stage: 'reading', done: 0, total: 0 })
    try {
      const buffer = await staged.file.arrayBuffer()
      const selection = allPages
        ? undefined
        : selectionText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
      const bytes = await engine.removeWatermark(
        buffer,
        { selection, password: staged.needsPassword ? password : undefined },
        (done, total, stage) => setStatus({ kind: 'working', stage, done, total }),
      )
      setStatus({ kind: 'done', bytes })
    } catch (err) {
      if (err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  const blocked =
    !staged ||
    !!staged.error ||
    staged.needsPassword ||
    !budget.ok ||
    (!allPages && selectionText.trim() === '')

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, watermark stripped" />

      {staged && (
        <p className="muted">
          {staged.file.name} · {formatBytes(staged.file.size)}
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

      {staged && !staged.needsPassword && !staged.error && staged.hasWatermark === false && (
        <p className="warn">
          No watermark detected. This tool only recognises watermarks pdfcpu itself (or a compatible tool)
          applied — running it anyway won't change the file.
        </p>
      )}

      {staged && !staged.needsPassword && !staged.error && staged.hasWatermark && (
        <p className="muted">Watermark detected.</p>
      )}

      {staged && !staged.needsPassword && !staged.error && (
        <>
          <p className="muted">
            Device tier <code>{caps.tier}</code> (cap {formatBytes(caps.maxFileBytes)})
          </p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <fieldset>
            <legend>Pages</legend>
            <label>
              <input type="radio" checked={allPages} onChange={() => setAllPages(true)} /> All pages
            </label>
            <br />
            <label>
              <input type="radio" checked={!allPages} onChange={() => setAllPages(false)} /> Selected pages (
              <code>1-3, 5, even, odd</code>)
              <br />
              <input
                type="text"
                disabled={allPages}
                value={selectionText}
                onChange={(e) => setSelectionText(e.target.value)}
                placeholder="1-3, 5, even, odd"
              />
            </label>
          </fieldset>

          <div className="actions">
            <button onClick={run} disabled={blocked || status.kind === 'working'}>
              {status.kind === 'working' ? 'Removing…' : 'Remove Watermark'}
            </button>
            {status.kind === 'working' && <button onClick={() => engine.terminate()}>Cancel</button>}
          </div>
        </>
      )}

      {status.kind === 'working' && (
        <p className="muted">
          {status.stage} {status.total > 0 && `${status.done}/${status.total}`}
        </p>
      )}

      {status.kind === 'error' && (
        <p className="err">
          {status.message} <code>{status.code}</code>
        </p>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <p>Watermark removed · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'unwatermarked.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
