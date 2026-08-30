// Split follows the Merge shape: staged input -> device-tier budget check ->
// engine call with progress -> EngineError.code switch -> download.
// See docs/tools/split.md.
//
// The engine returns every SplitPart in one call, already in memory — unlike
// PdfToZip's per-page streaming loop, there's no "never collect in an array"
// concern here, since the array already exists by the time this file sees
// it. "Download All" zips it with jszip, the same dependency PdfToZip added
// (with direct user go-ahead) — this file doesn't re-litigate that decision,
// it just reuses the library that's already in the bundle. Per-part
// downloads stay available too, for the single-part case (no ZIP needed at
// all) and for anyone who wants just one piece.

import { useState } from 'react'
import JSZip from 'jszip'
import { FilePicker } from '../../components/FilePicker'
import { engine } from '../../engine/EngineClient'
import { EngineError } from '../../engine/protocol'
import type { SplitPart } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateEngineBytes, formatBytes } from '../../lib/device'
import { downloadBlob, downloadBytes } from '../../lib/download'

type Mode = 'each' | 'span' | 'ranges'

interface Staged {
  file: File
  pages?: number
  needsPassword?: boolean
  error?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; stage: string; done: number; total: number }
  | { kind: 'done'; parts: SplitPart[] }
  | { kind: 'error'; message: string; code: string }

export default function SplitTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<Mode>('each')
  const [span, setSpan] = useState(1)
  const [rangesText, setRangesText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [zipping, setZipping] = useState(false)
  const caps = deviceCaps()

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    const next: Staged = { file }
    setStaged(next)
    setStatus({ kind: 'idle' })

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
    setStatus({ kind: 'working', stage: 'reading', done: 0, total: 0 })
    try {
      const buffer = await staged.file.arrayBuffer()
      const ranges = rangesText
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
      const parts = await engine.split(
        buffer,
        { mode, span, ranges, password: staged.needsPassword ? password : undefined },
        (done, total, stage) => setStatus({ kind: 'working', stage, done, total }),
      )
      setStatus({ kind: 'done', parts })
    } catch (err) {
      if (err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  async function downloadAllAsZip(parts: SplitPart[]) {
    setZipping(true)
    try {
      const zip = new JSZip()
      for (const p of parts) zip.file(p.name, p.bytes)
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `${staged?.file.name.replace(/\.pdf$/i, '') ?? 'split'}.zip`)
    } finally {
      setZipping(false)
    }
  }

  const modeReady = mode === 'each' || (mode === 'span' && span >= 1) || (mode === 'ranges' && rangesText.trim() !== '')
  const blocked = !staged || !!staged.error || staged.needsPassword || !budget.ok || !modeReady

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, split into parts" />

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
          <p className="muted">Device tier <code>{caps.tier}</code> (cap {formatBytes(caps.maxFileBytes)})</p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <fieldset>
            <legend>Mode</legend>
            <label>
              <input type="radio" checked={mode === 'each'} onChange={() => setMode('each')} /> Every page
            </label>
            <br />
            <label>
              <input type="radio" checked={mode === 'span'} onChange={() => setMode('span')} /> Every{' '}
              <input
                type="number"
                min={1}
                value={span}
                disabled={mode !== 'span'}
                onChange={(e) => setSpan(Number(e.target.value))}
                style={{ width: '4rem' }}
              />{' '}
              pages
            </label>
            <br />
            <label>
              <input type="radio" checked={mode === 'ranges'} onChange={() => setMode('ranges')} /> By ranges (
              <code>1-3, 5, 7-10</code>)
              <br />
              <input
                type="text"
                disabled={mode !== 'ranges'}
                value={rangesText}
                onChange={(e) => setRangesText(e.target.value)}
                placeholder="1-3, 5, 7-10"
              />
            </label>
          </fieldset>

          <div className="actions">
            <button onClick={run} disabled={blocked || status.kind === 'working'}>
              {status.kind === 'working' ? 'Splitting…' : 'Split'}
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
          <p>{status.parts.length} file{status.parts.length === 1 ? '' : 's'} produced.</p>
          <ol className="files">
            {status.parts.map((p) => (
              <li key={p.name}>
                <span className="name">{p.name}</span>
                <span className="controls">
                  <button onClick={() => downloadBytes(p.bytes, p.name)}>Download</button>
                </span>
              </li>
            ))}
          </ol>
          {status.parts.length > 1 && (
            <button onClick={() => downloadAllAsZip(status.parts)} disabled={zipping}>
              {zipping ? 'Zipping…' : 'Download All'}
            </button>
          )}
        </div>
      )}
    </>
  )
}
