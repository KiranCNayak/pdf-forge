// Merge is the reference tool: it exercises the whole bridge — multi-buffer in,
// one buffer out, progress, error codes — without needing any rendering.
// Every other tool should follow this shape. See docs/tools/merge.md.

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
  error?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; stage: string; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array; pages: number }
  | { kind: 'error'; message: string; code: string }

export default function MergeTool() {
  const [staged, setStaged] = useState<Staged[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('merged.pdf')
  const caps = deviceCaps()

  const totalBytes = staged.reduce((n, s) => n + s.file.size, 0)
  // The device tier applies to the SUM: merge holds every source document's
  // object model open at once. See docs/tools/merge.md.
  const budget = checkBudget(estimateEngineBytes(totalBytes), caps)

  async function addFiles(list: FileList | null) {
    if (!list) return
    const incoming = Array.from(list).filter((f) => /\.pdf$/i.test(f.name))
    const next: Staged[] = [...staged, ...incoming.map((file) => ({ file }))]
    setStaged(next)
    setStatus({ kind: 'idle' })

    // Read page counts opportunistically so the UI is informative before the
    // user commits. A failure here is per-file, never fatal.
    for (const [i, s] of next.entries()) {
      if (s.pages !== undefined || s.error) continue
      try {
        const pages = await engine.pageCount(await s.file.arrayBuffer())
        setStaged((cur) => cur.map((c, j) => (j === i ? { ...c, pages } : c)))
      } catch (err) {
        const msg = err instanceof EngineError ? err.userMessage : 'Could not read this file.'
        setStaged((cur) => cur.map((c, j) => (j === i ? { ...c, error: msg } : c)))
      }
    }
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= staged.length) return
    const next = [...staged]
    ;[next[i], next[j]] = [next[j], next[i]]
    setStaged(next)
  }

  async function run() {
    setStatus({ kind: 'working', stage: 'reading', done: 0, total: staged.length })
    try {
      const buffers = await Promise.all(staged.map((s) => s.file.arrayBuffer()))
      const bytes = await engine.merge(buffers, {}, (done, total, stage) =>
        setStatus({ kind: 'working', stage, done, total }),
      )
      // Copy before handing back: the transferred buffer is the same memory the
      // worker detached, and we want an independent page count read.
      const pages = await engine.pageCount(bytes.slice().buffer)
      setStatus({ kind: 'done', bytes, pages })
    } catch (err) {
      if (err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  const blocked = staged.length < 2 || staged.some((s) => s.error) || !budget.ok

  return (
    <>
      <FilePicker multiple onFiles={addFiles} hint="Two or more PDFs, merged in the order below" />

      {staged.length > 0 && (
        <ol className="files">
          {staged.map((s, i) => (
            <li key={`${s.file.name}-${i}`}>
              <span className="name">{s.file.name}</span>
              <span className="muted">
                {formatBytes(s.file.size)}
                {s.pages !== undefined && ` · ${s.pages} page${s.pages === 1 ? '' : 's'}`}
                {s.error && <strong className="err"> · {s.error}</strong>}
              </span>
              <span className="controls">
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === staged.length - 1} aria-label="Move down">↓</button>
                <button onClick={() => setStaged(staged.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {staged.length > 0 && (
        <p className="muted">
          Total {formatBytes(totalBytes)} · device tier <code>{caps.tier}</code> (cap{' '}
          {formatBytes(caps.maxFileBytes)})
        </p>
      )}

      {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
      {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

      <div className="actions">
        <button onClick={run} disabled={blocked || status.kind === 'working'}>
          {status.kind === 'working' ? 'Merging…' : 'Merge'}
        </button>
        {status.kind === 'working' && <button onClick={() => engine.terminate()}>Cancel</button>}
      </div>

      {staged.length === 1 && <p className="muted">Add at least one more file to merge.</p>}

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
          <p>
            Merged {status.pages} pages · {formatBytes(status.bytes.byteLength)}
          </p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'merged.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
