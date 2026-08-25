// Organize Pages is the first Hybrid tool (docs/tools/organize-pages.md):
// thumbnails come from the render worker (JS/pdf.js), the actual reorder/
// delete/duplicate/rotate goes through a NEW Go engine op (`Organize`,
// engine/internal/ops/organize.go) — both halves of the boundary rule in one
// tool, unlike every other tool so far which sits entirely on one side.
//
// All edits are LOCAL UI STATE — nothing hits the engine until Apply. A user
// dragging 40 pages around must not trigger 40 engine round-trips; the intent
// list (a Card per final page, referencing an ORIGINAL page number + a
// rotation delta) accumulates in memory and is sent as one Organize call.
// Undo/redo is over that intent list (cheap, instant array snapshots), not
// over engine calls.
//
// V1 scope, documented departures from the doc:
//  - No thumbnail virtualisation. Thumbnails render at a fixed low DPI (72,
//    per the doc) so the per-page cost stays small, but a 500-page document
//    still renders 500 canvases up front rather than on demand. Revisit if
//    real usage says this matters.
//  - No bookmark-outline warning. Detecting it needs a new render-worker op
//    (reading pdf.js's getOutline()) that doesn't exist yet — a second new
//    surface on top of the new Go op was too much for one pass. Noted here so
//    it isn't mistaken for an oversight.
//  - A beforeunload warning covers "reloaded mid-edit" instead of persisting
//    drafts to IndexedDB.

import { useEffect, useRef, useState } from 'react'
import { FilenameField } from '../../components/FilenameField'
import { FilePicker } from '../../components/FilePicker'
import { engine } from '../../engine/EngineClient'
import { EngineError } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateEngineBytes, formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'
import { sanitizeFilename } from '../../lib/filename'
import { render } from '../../lib/render/RenderClient'
import { RenderError } from '../../lib/render/protocol'

interface Staged {
  file: File
  docId?: string
  pageCount?: number
  needsPassword?: boolean
  error?: string
}

interface Card {
  key: number
  /** 1-based page number in the ORIGINAL document. */
  source: number
  /** Relative rotation delta staged locally, same convention as Rotate. */
  rotation: number
}

interface Thumb {
  status: 'loading' | 'ready' | 'error'
  url?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'error'; message: string; code: string }

function identityCards(pageCount: number): Card[] {
  return Array.from({ length: pageCount }, (_, i) => ({ key: i + 1, source: i + 1, rotation: 0 }))
}

export default function OrganizePagesTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [thumbs, setThumbs] = useState<Record<number, Thumb>>({})
  const [history, setHistory] = useState<Card[][]>([])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('organized.pdf')
  const caps = deviceCaps()
  const nextKey = useRef(1)
  const dragIndex = useRef<number | null>(null)
  // Every created object URL, tracked outside React state so it can be
  // revoked exactly on file-switch and unmount — not on every thumbnail
  // arriving, which is what a cleanup effect keyed to `thumbs` would do
  // (revoking each blob URL the instant the *next* page's thumbnail loads).
  const thumbUrls = useRef<Set<string>>(new Set())

  const cards = history[historyIndex] ?? []
  const initial = history[0] ?? []
  const changed =
    cards.length !== initial.length ||
    cards.some((c, i) => c.source !== initial[i]?.source || c.rotation !== initial[i]?.rotation)

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  // Warn on unload rather than silently losing an in-progress arrangement —
  // staged edits are memory-only, per the doc's edge case table.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!changed) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [changed])

  // Revoke every tracked thumbnail URL only on unmount — see the note on
  // thumbUrls above for why this can't be keyed to `thumbs` itself.
  useEffect(
    () => () => {
      thumbUrls.current.forEach((url) => URL.revokeObjectURL(url))
      thumbUrls.current.clear()
    },
    [],
  )

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    if (staged?.docId) render.close(staged.docId)
    thumbUrls.current.forEach((url) => URL.revokeObjectURL(url))
    thumbUrls.current.clear()
    setStaged({ file })
    setThumbs({})
    setHistory([])
    setHistoryIndex(0)
    setStatus({ kind: 'idle' })
    try {
      const { docId, pageCount } = await render.open(await file.arrayBuffer())
      setStaged((cur) => (cur && cur.file === file ? { ...cur, docId, pageCount } : cur))
    } catch (err) {
      if (err instanceof RenderError && err.code === 'ERR_ENCRYPTED') {
        setStaged((cur) => (cur && cur.file === file ? { ...cur, needsPassword: true } : cur))
      } else {
        const msg = err instanceof RenderError ? err.userMessage : 'Could not read this file.'
        setStaged((cur) => (cur && cur.file === file ? { ...cur, error: msg } : cur))
      }
    }
  }

  async function confirmPassword() {
    if (!staged) return
    try {
      const { docId, pageCount } = await render.open(await staged.file.arrayBuffer(), { password })
      setStaged((cur) => (cur ? { ...cur, docId, pageCount, needsPassword: false, error: undefined } : cur))
    } catch (err) {
      const msg = err instanceof RenderError ? err.userMessage : 'Could not read this file.'
      setStaged((cur) => (cur ? { ...cur, error: msg } : cur))
    }
  }

  // Seeds the intent list and kicks off thumbnail rendering once a document
  // is open. Runs once per docId — reordering/rotating locally never
  // re-renders a thumbnail, it's the same source page either way.
  useEffect(() => {
    if (!staged?.docId || staged.pageCount === undefined) return
    const docId = staged.docId
    const pageCount = staged.pageCount
    nextKey.current = pageCount + 1
    setHistory([identityCards(pageCount)])
    setHistoryIndex(0)

    let cancelled = false
    ;(async () => {
      for (let pageNr = 1; pageNr <= pageCount; pageNr++) {
        if (cancelled) return
        setThumbs((cur) => ({ ...cur, [pageNr]: { status: 'loading' } }))
        try {
          const r = await render.renderPage(docId, pageNr, { dpi: 72, format: 'jpeg' })
          const url = URL.createObjectURL(new Blob([r.bytes as unknown as BlobPart], { type: 'image/jpeg' }))
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          thumbUrls.current.add(url)
          setThumbs((cur) => ({ ...cur, [pageNr]: { status: 'ready', url } }))
        } catch {
          if (!cancelled) setThumbs((cur) => ({ ...cur, [pageNr]: { status: 'error' } }))
        }

        if (pageNr % caps.maxPagesPerBatch === 0 && pageNr < pageCount) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged?.docId])

  function pushCards(next: Card[]) {
    setHistory((h) => [...h.slice(0, historyIndex + 1), next])
    setHistoryIndex((i) => i + 1)
  }

  function undo() {
    setHistoryIndex((i) => Math.max(0, i - 1))
  }
  function redo() {
    setHistoryIndex((i) => Math.min(history.length - 1, i + 1))
  }
  function reset() {
    if (initial.length) pushCards(initial)
  }

  function removeCard(index: number) {
    pushCards(cards.filter((_, i) => i !== index))
  }
  function rotateCard(index: number) {
    pushCards(cards.map((c, i) => (i === index ? { ...c, rotation: (c.rotation + 90) % 360 } : c)))
  }
  function duplicateCard(index: number) {
    const copy: Card = { ...cards[index], key: nextKey.current++ }
    pushCards([...cards.slice(0, index + 1), copy, ...cards.slice(index + 1)])
  }

  function onDragStart(index: number) {
    dragIndex.current = index
  }
  function onDrop(index: number) {
    const from = dragIndex.current
    dragIndex.current = null
    if (from === null || from === index) return
    const next = [...cards]
    const [moved] = next.splice(from, 1)
    next.splice(index, 0, moved)
    pushCards(next)
  }

  async function apply() {
    if (!staged || cards.length === 0) return
    setStatus({ kind: 'working', done: 0, total: 0 })
    try {
      const buffer = await staged.file.arrayBuffer()
      const bytes = await engine.organize(
        buffer,
        { pages: cards.map((c) => ({ source: c.source, rotation: c.rotation })), password: password || undefined },
        (done, total) => setStatus({ kind: 'working', done, total }),
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

  const blocked = !staged?.docId || cards.length === 0 || !changed || !budget.ok || status.kind === 'working'

  return (
    <>
      <FilePicker onFiles={addFile} hint="One PDF, edited on a thumbnail grid" />

      {staged && (
        <p className="muted">
          {staged.file.name} · {formatBytes(staged.file.size)}
          {staged.pageCount !== undefined && ` · ${staged.pageCount} page${staged.pageCount === 1 ? '' : 's'}`}
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

      {staged?.pageCount !== undefined && !staged.needsPassword && (
        <>
          <p className="muted">
            Device tier <code>{caps.tier}</code> (cap {formatBytes(caps.maxFileBytes)})
          </p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <div className="actions">
            <button onClick={undo} disabled={historyIndex === 0}>
              Undo
            </button>
            <button onClick={redo} disabled={historyIndex >= history.length - 1}>
              Redo
            </button>
            <button onClick={reset} disabled={!changed}>
              Reset
            </button>
          </div>

          {cards.length === 0 && <p className="err">Every page is deleted — a 0-page PDF is invalid.</p>}

          {/* Custom drag grid, not the shared `ol.files` list — this needs
              thumbnails and per-card controls wrapping into a grid, not a
              single-column list. */}
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: '1rem 0',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(7rem, 1fr))',
              gap: '.75rem',
            }}
          >
            {cards.map((c, i) => {
              const thumb = thumbs[c.source]
              return (
                <li
                  key={c.key}
                  draggable
                  onDragStart={() => onDragStart(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(i)}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: '8px',
                    padding: '.4rem',
                    cursor: 'grab',
                    textAlign: 'center',
                  }}
                >
                  <div
                    style={{
                      height: '6rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {thumb?.status === 'ready' && thumb.url ? (
                      <img
                        src={thumb.url}
                        alt={`Page ${c.source}`}
                        style={{
                          maxHeight: '100%',
                          maxWidth: '100%',
                          transform: c.rotation ? `rotate(${c.rotation}deg)` : undefined,
                        }}
                      />
                    ) : (
                      <span className="muted">{thumb?.status === 'error' ? 'failed' : '…'}</span>
                    )}
                  </div>
                  <p className="muted" style={{ margin: '.3rem 0' }}>
                    p.{c.source}
                    {c.rotation !== 0 && ` · ${c.rotation}°`}
                  </p>
                  <span className="controls" style={{ justifyContent: 'center' }}>
                    <button onClick={() => rotateCard(i)} aria-label="Rotate">
                      ↻
                    </button>
                    <button onClick={() => duplicateCard(i)} aria-label="Duplicate">
                      ⧉
                    </button>
                    <button onClick={() => removeCard(i)} aria-label="Delete">
                      ✕
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="actions">
            <button onClick={apply} disabled={blocked}>
              {status.kind === 'working' ? 'Applying…' : 'Apply'}
            </button>
          </div>
        </>
      )}

      {status.kind === 'error' && (
        <p className="err">
          {status.message} <code>{status.code}</code>
        </p>
      )}

      {status.kind === 'done' && (
        <div className="result">
          <p>Applied · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'organized.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
