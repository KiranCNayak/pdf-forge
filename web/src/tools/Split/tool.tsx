// Split follows the Merge shape: staged input -> device-tier budget check ->
// engine call with progress -> EngineError.code switch -> download.
// See docs/tools/split.md.
//
// The engine returns one SplitPart per output document. We don't bundle a zip
// library (that's a shared dependency decision per docs/PARALLEL.md), so
// results are offered as individual downloads, per split.md's fallback for
// "few outputs" — and the single-part case is the common one anyway.

import { useState } from 'react'
import { engine } from '../../engine/EngineClient'
import { EngineError } from '../../engine/protocol'
import type { SplitPart } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateEngineBytes, formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'

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

  function downloadAll(parts: SplitPart[]) {
    parts.forEach((p, i) => setTimeout(() => downloadBytes(p.bytes, p.name), i * 150))
  }

  const modeReady = mode === 'each' || (mode === 'span' && span >= 1) || (mode === 'ranges' && rangesText.trim() !== '')
  const blocked = !staged || !!staged.error || staged.needsPassword || !budget.ok || !modeReady

  return (
    <>
      <input type="file" accept="application/pdf" onChange={(e) => addFile(e.target.files)} />

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
            <button onClick={() => downloadAll(status.parts)}>Download all</button>
          )}
        </div>
      )}
    </>
  )
}
