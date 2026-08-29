// Extract Pages follows the Merge shape. See docs/tools/extract-pages.md.
//
// No thumbnail picker here: that needs the render worker (pdf.js), which is
// Lane D's territory per docs/PARALLEL.md — this tool ships with the text
// selection field only, same as the engine op itself expects.

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
  | { kind: 'working'; stage: string; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'error'; message: string; code: string }

export default function ExtractPagesTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [selection, setSelection] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('extracted.pdf')
  const caps = deviceCaps()

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    setStaged({ file })
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
      const bytes = await engine.extractPages(
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

  const blocked = !staged || !!staged.error || staged.needsPassword || !budget.ok || selection.trim() === ''

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, pick the pages to keep" />

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

          <p>
            <label>
              Pages to extract (<code>1-3, 5, 8-12</code> — order is kept as typed)
              <br />
              <input
                type="text"
                value={selection}
                onChange={(e) => setSelection(e.target.value)}
                placeholder="1-3, 5, 8-12"
              />
            </label>
          </p>

          <div className="actions">
            <button onClick={run} disabled={blocked || status.kind === 'working'}>
              {status.kind === 'working' ? 'Extracting…' : 'Extract'}
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
          <p>Extracted {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'extracted.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
