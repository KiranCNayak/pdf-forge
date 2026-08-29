// Remove Password follows the Merge shape. See docs/tools/remove-password.md.
//
// This is not password recovery — pdfcpu decrypts with a password you supply,
// it does not crack one. Said up front, per the doc, because a lot of arriving
// traffic is looking for recovery and shouldn't waste a click finding out.
//
// Wrong password keeps the file staged and re-prompts rather than forcing a
// re-pick, per the doc's edge-case table.

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
  encrypted?: boolean
  error?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; stage: string; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'wrongPassword' }
  | { kind: 'error'; message: string; code: string }

export default function RemovePasswordTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [filename, setFilename] = useState('unlocked.pdf')
  const caps = deviceCaps()

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  async function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    setStaged({ file })
    setStatus({ kind: 'idle' })
    setPassword('')

    try {
      const encrypted = await engine.isEncrypted(await file.arrayBuffer())
      setStaged((cur) => (cur && cur.file === file ? { ...cur, encrypted } : cur))
    } catch (err) {
      const msg = err instanceof EngineError ? err.userMessage : 'Could not read this file.'
      setStaged((cur) => (cur && cur.file === file ? { ...cur, error: msg } : cur))
    }
  }

  async function run() {
    if (!staged) return
    setStatus({ kind: 'working', stage: 'reading', done: 0, total: 0 })
    try {
      const buffer = await staged.file.arrayBuffer()
      const bytes = await engine.decrypt(buffer, { password }, (done, total, stage) =>
        setStatus({ kind: 'working', stage, done, total }),
      )
      setStatus({ kind: 'done', bytes })
      setPassword('')
    } catch (err) {
      if (err instanceof EngineError) {
        if (err.code === 'ERR_BAD_PASSWORD') {
          setStatus({ kind: 'wrongPassword' })
        } else {
          setStatus({ kind: 'error', message: err.userMessage, code: err.code })
        }
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  const blocked = !staged || !!staged.error || staged.encrypted === false || !budget.ok || password === ''

  return (
    <>
      <FilePicker onFiles={addFile} hint="One password-protected PDF" />

      {staged && (
        <p className="muted">
          {staged.file.name} · {formatBytes(staged.file.size)}
          {staged.error && <strong className="err"> · {staged.error}</strong>}
        </p>
      )}

      {staged && staged.encrypted === false && (
        <p className="warn">This file isn't password protected — there's nothing to remove.</p>
      )}

      {staged && staged.encrypted && (
        <>
          <p className="muted">Device tier <code>{caps.tier}</code> (cap {formatBytes(caps.maxFileBytes)})</p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <p className="muted">
            This tool removes a password you already know. It cannot recover or crack a forgotten
            one.
          </p>

          <p>
            <label>
              Password
              <br />
              <input
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
              />
            </label>
          </p>

          {status.kind === 'wrongPassword' && (
            <p className="err">Wrong password. The file is still here — try again.</p>
          )}

          <div className="actions">
            <button onClick={run} disabled={blocked || status.kind === 'working'}>
              {status.kind === 'working' ? 'Removing…' : 'Remove Password'}
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
          <p>Password removed · {formatBytes(status.bytes.byteLength)}</p>
          <FilenameField value={filename} onChange={setFilename} />
          <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'unlocked.pdf'))}>
            Download
          </button>
        </div>
      )}
    </>
  )
}
