// Compress follows the Merge shape — staged files, budget check, progress,
// typed error handling, download — but is the highest-water-mark op we run
// (docs/tools/compress.md's memory section): peak is set by the largest
// *decoded* image, not the file size. `EngineClient.compress`'s docstring
// says to `terminate()` after every job regardless of input size, not just
// when EngineClient's own RESPAWN_AFTER_BYTES threshold is crossed — this
// tool does that in a `finally`, win or lose.
//
// No password parameter (matches the engine op): an encrypted file comes
// back ERR_ENCRYPTED and is pointed at Remove Password rather than handled
// here, per the doc's explicit non-goal.
//
// Multiple files compress sequentially, each independently. No ZIP
// dependency — per-file + "Download all", same precedent as Split.

import { useState } from 'react'
import { FilePicker } from '../../components/FilePicker'
import { engine } from '../../engine/EngineClient'
import { EngineError, type CompressResult } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateEngineBytes, formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'
import { sanitizeFilename } from '../../lib/filename'

type Preset = 'screen' | 'ebook' | 'printer' | 'prepress'

interface Staged {
  file: File
}

interface Done {
  file: File
  result: CompressResult
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; fileIndex: number; fileCount: number; stage: string; done: number; total: number }
  | { kind: 'done'; results: Done[] }
  | { kind: 'error'; message: string; code: string }

const PRESETS: { value: Preset; label: string; hint: string }[] = [
  { value: 'screen', label: 'Screen', hint: '72 DPI · email, web' },
  { value: 'ebook', label: 'eBook', hint: '150 DPI · tablets, reading' },
  { value: 'printer', label: 'Printer', hint: '300 DPI · office printing' },
  { value: 'prepress', label: 'Prepress', hint: '300 DPI · professional print' },
]

// Keys are the Skip* constants in engine/internal/ops/compress.go. The skip
// counts are UI copy, not diagnostics — see docs/tools/compress.md.
const SKIP_LABELS: Record<string, string> = {
  transparency: 'transparency',
  stencil: 'stencil masks',
  thumbnail: 'thumbnails',
  jpeg2000: 'JPEG 2000',
  unsupportedType: 'unsupported image type',
  alreadyLowDPI: 'already low DPI',
  noGain: 'no size gain',
}

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '')
}

function skipSummary(result: CompressResult): string | null {
  if (result.imagesSkipped === 0) return null
  const reasons = Object.entries(result.skipReasons)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${SKIP_LABELS[reason] ?? reason}`)
    .join(', ')
  const total = result.imagesTouched + result.imagesSkipped
  return `${result.imagesTouched} of ${total} image${total === 1 ? '' : 's'} compressed; ${result.imagesSkipped} skipped${reasons ? ` (${reasons})` : ''}`
}

export default function CompressTool() {
  const [staged, setStaged] = useState<Staged[]>([])
  const [mode, setMode] = useState<'preset' | 'target'>('preset')
  const [preset, setPreset] = useState<Preset>('ebook')
  const [targetMB, setTargetMB] = useState(5)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const caps = deviceCaps()

  const totalBytes = staged.reduce((n, s) => n + s.file.size, 0)
  const budget = checkBudget(estimateEngineBytes(totalBytes), caps)

  function addFiles(list: FileList | null) {
    if (!list) return
    const incoming = Array.from(list).filter((f) => /\.pdf$/i.test(f.name))
    setStaged((cur) => [...cur, ...incoming.map((file) => ({ file }))])
    setStatus({ kind: 'idle' })
  }

  function removeAt(i: number) {
    setStaged((cur) => cur.filter((_, j) => j !== i))
  }

  async function run() {
    setStatus({ kind: 'working', fileIndex: 0, fileCount: staged.length, stage: 'reading', done: 0, total: 0 })
    const results: Done[] = []
    try {
      for (let i = 0; i < staged.length; i++) {
        const file = staged[i].file
        const buffer = await file.arrayBuffer()
        const opts =
          mode === 'preset'
            ? { mode: 'preset' as const, preset }
            : { mode: 'target' as const, targetBytes: Math.round(targetMB * 1024 ** 2) }
        const result = await engine.compress(buffer, opts, (done, total, stage) =>
          setStatus({ kind: 'working', fileIndex: i, fileCount: staged.length, stage, done, total }),
        )
        results.push({ file, result })
      }
      setStatus({ kind: 'done', results })
    } catch (err) {
      if (err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    } finally {
      // Highest-water-mark op we run — always respawn, per EngineClient.compress's
      // docstring, not just when EngineClient's own byte threshold is crossed.
      engine.terminate()
    }
  }

  function outputName(file: File): string {
    return sanitizeFilename(`${baseName(file.name)}-compressed.pdf`, 'compressed.pdf')
  }

  function downloadOne(d: Done) {
    downloadBytes(d.result.bytes, outputName(d.file))
  }

  function downloadAll(results: Done[]) {
    results.forEach((d, i) => setTimeout(() => downloadOne(d), i * 150))
  }

  const blocked =
    staged.length === 0 || !budget.ok || status.kind === 'working' || (mode === 'target' && targetMB <= 0)

  return (
    <>
      <FilePicker multiple onFiles={addFiles} hint="One or more PDFs, compressed independently" />

      {staged.length > 0 && (
        <ol className="files">
          {staged.map((s, i) => (
            <li key={`${s.file.name}-${i}`}>
              <span className="name">{s.file.name}</span>
              <span className="muted">{formatBytes(s.file.size)}</span>
              <span className="controls">
                <button onClick={() => removeAt(i)} aria-label="Remove">
                  ✕
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
            <legend>Mode</legend>
            <label>
              <input type="radio" checked={mode === 'preset'} onChange={() => setMode('preset')} /> Preset
            </label>
            <br />
            <label>
              <input type="radio" checked={mode === 'target'} onChange={() => setMode('target')} /> Target size
            </label>
          </fieldset>

          {mode === 'preset' && (
            <fieldset>
              <legend>Preset</legend>
              {PRESETS.map((p) => (
                <label key={p.value} style={{ display: 'block' }}>
                  <input type="radio" checked={preset === p.value} onChange={() => setPreset(p.value)} />{' '}
                  {p.label} <span className="muted">({p.hint})</span>
                </label>
              ))}
            </fieldset>
          )}

          {mode === 'target' && (
            <fieldset>
              <legend>Target size</legend>
              <label>
                Get under{' '}
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={targetMB}
                  onChange={(e) => setTargetMB(Number(e.target.value))}
                  style={{ width: '5rem' }}
                />{' '}
                MB
              </label>
            </fieldset>
          )}

          <p className="muted">
            pdfcpu does not subset fonts, so text-heavy documents see limited savings — this is an
            image-recompression pass, not a font trim.
          </p>

          <div className="actions">
            <button onClick={run} disabled={blocked}>
              {status.kind === 'working' ? 'Compressing…' : 'Compress'}
            </button>
            {status.kind === 'working' && <button onClick={() => engine.terminate()}>Cancel</button>}
          </div>
        </>
      )}

      {status.kind === 'working' && (
        <p className="muted">
          File {status.fileIndex + 1}/{status.fileCount} · {status.stage}{' '}
          {status.total > 0 && `${status.done}/${status.total}`}
        </p>
      )}

      {status.kind === 'error' && (
        <p className="err">
          {status.message} <code>{status.code}</code>
          {status.code === 'ERR_ENCRYPTED' && ' — remove the password first, then compress.'}
        </p>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <ol className="files">
            {status.results.map((d, i) => {
              const { result } = d
              const saved = pct(result.originalSize, result.resultSize)
              const skipped = skipSummary(result)
              return (
                <li key={`${d.file.name}-${i}`}>
                  <span className="name">{d.file.name}</span>
                  <span className="muted">
                    {formatBytes(result.originalSize)} → {formatBytes(result.resultSize)}
                    {result.fallback
                      ? ' · already optimised, nothing to gain'
                      : ` · ${saved > 0 ? `${saved}% smaller` : 'no reduction'}`}
                    {mode === 'target' && !result.reachedTarget && !result.fallback && (
                      <strong className="warn"> · target not reached, best effort shown</strong>
                    )}
                    {skipped && <> · {skipped}</>}
                  </span>
                  <span className="controls">
                    <button onClick={() => downloadOne(d)}>Download</button>
                  </span>
                </li>
              )
            })}
          </ol>
          {status.results.length > 1 && <button onClick={() => downloadAll(status.results)}>Download all</button>}
        </div>
      )}
    </>
  )
}

function pct(original: number, result: number): number {
  if (original === 0) return 0
  return Math.round((1 - result / original) * 100)
}
