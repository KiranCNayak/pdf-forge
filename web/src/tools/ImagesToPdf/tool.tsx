// ImagesToPdf follows the Merge shape: staged input list → device-tier budget
// check → engine call with progress → typed error handling → download. See
// docs/tools/images-to-pdf.md.
//
// V1 departures from the doc, documented here rather than cut silently:
//  - No thumbnails or per-image rotate in the staged list — same simplification
//    Merge shipped with (reorder is up/down buttons, not drag), and this tool
//    has no engine-side per-image rotation to expose yet anyway (see
//    engine/internal/ops/imagestopdf.go's own doc comment on why "auto"
//    orientation and per-image rotation aren't in V1).
//  - No margin/scale controls — images fill as much of the page as their
//    aspect ratio allows, Center-anchored, no separate margin knob.
//  - HEIC is detected and rejected with a clear message (matches the doc's
//    explicit V1 scope — this one isn't a shortcut, it's the spec).

import { useState } from 'react'
import { FilenameField } from '../../components/FilenameField'
import { FilePicker } from '../../components/FilePicker'
import { ArrowDownIcon, ArrowUpIcon, XIcon } from '../../components/icons'
import { engine } from '../../engine/EngineClient'
import { EngineError } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateEngineBytes, formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'
import { sanitizeFilename } from '../../lib/filename'

interface Staged {
  file: File
  error?: string
}

type PageSize = 'A4' | 'Letter' | 'fit'
type Orientation = 'portrait' | 'landscape'

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; stage: string; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'error'; message: string; code: string }

const IMAGE_EXTENSIONS = /\.(jpe?g|png|tiff?|webp)$/i

export default function ImagesToPdfTool() {
  const [staged, setStaged] = useState<Staged[]>([])
  const [pageSize, setPageSize] = useState<PageSize>('fit')
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('images.pdf')
  const caps = deviceCaps()

  const totalBytes = staged.reduce((n, s) => n + s.file.size, 0)
  const budget = checkBudget(estimateEngineBytes(totalBytes), caps)

  function addFiles(list: FileList | null) {
    if (!list) return
    const incoming = Array.from(list).filter((f) => IMAGE_EXTENSIONS.test(f.name))
    setStaged((cur) => [...cur, ...incoming.map((file) => ({ file }))])
    setStatus({ kind: 'idle' })
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
      const bytes = await engine.imagesToPDF(
        buffers,
        { pageSize, orientation: pageSize === 'fit' ? undefined : orientation },
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

  const blocked = staged.length === 0 || staged.some((s) => s.error) || !budget.ok

  return (
    <>
      <FilePicker
        multiple
        onFiles={addFiles}
        accept="image/jpeg,image/png,image/tiff,image/webp"
        label="Drop images here, or click to browse"
        hint="One or more images, one PDF page per image, in the order below"
      />

      {staged.length > 0 && (
        <ol className="files">
          {staged.map((s, i) => (
            <li key={`${s.file.name}-${i}`}>
              <span className="name">{s.file.name}</span>
              <span className="muted">
                {formatBytes(s.file.size)}
                {s.error && <strong className="err"> · {s.error}</strong>}
              </span>
              <span className="controls">
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                  <ArrowUpIcon />
                </button>
                <button onClick={() => move(i, 1)} disabled={i === staged.length - 1} aria-label="Move down">
                  <ArrowDownIcon />
                </button>
                <button onClick={() => setStaged(staged.filter((_, j) => j !== i))} aria-label="Remove">
                  <XIcon />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {staged.length > 0 && (
        <>
          <p className="muted">
            Total {formatBytes(totalBytes)} · device tier <code>{caps.tier}</code> (cap{' '}
            {formatBytes(caps.maxFileBytes)})
          </p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <fieldset>
            <legend>Page size</legend>
            <label>
              <input type="radio" checked={pageSize === 'fit'} onChange={() => setPageSize('fit')} /> Fit to image{' '}
              <span className="muted">(each page sized to its own image)</span>
            </label>
            <br />
            <label>
              <input type="radio" checked={pageSize === 'A4'} onChange={() => setPageSize('A4')} /> A4
            </label>
            <br />
            <label>
              <input type="radio" checked={pageSize === 'Letter'} onChange={() => setPageSize('Letter')} /> Letter
            </label>
          </fieldset>

          {pageSize !== 'fit' && (
            <fieldset>
              <legend>Orientation</legend>
              <label>
                <input type="radio" checked={orientation === 'portrait'} onChange={() => setOrientation('portrait')} />{' '}
                Portrait
              </label>
              <br />
              <label>
                <input
                  type="radio"
                  checked={orientation === 'landscape'}
                  onChange={() => setOrientation('landscape')}
                />{' '}
                Landscape
              </label>
            </fieldset>
          )}

          <div className="actions">
            <button onClick={run} disabled={blocked || status.kind === 'working'}>
              {status.kind === 'working' ? 'Creating…' : 'Create PDF'}
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
          <p>Created · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'images.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
