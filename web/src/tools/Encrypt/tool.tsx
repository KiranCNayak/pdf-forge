// Encrypt follows the Merge shape. See docs/tools/encrypt.md.
//
// Permission bit values are pdfcpu's own (model.PermissionFlags, ISO-32000
// Table 22) — verified against pdfcpu v0.15.0's configuration.go, not guessed:
//   PermissionsNone = 0xF0C3 (baseline: reserved bits set, all real
//     permissions cleared). We OR in bits for what the user grants.
// AES-256 is the only key length offered here; 128/40 are compatibility
// escape hatches the doc treats as advanced-only, so V1 doesn't expose them.

import { useState } from 'react'
import { engine } from '../../engine/EngineClient'
import { EngineError } from '../../engine/protocol'
import { checkBudget, deviceCaps, estimateEngineBytes, formatBytes } from '../../lib/device'
import { downloadBytes } from '../../lib/download'

interface Staged {
  file: File
  error?: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; stage: string; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array }
  | { kind: 'error'; message: string; code: string }

const PERMISSIONS_NONE = 0xf0c3

// [label, bit, default-on]
const PERMISSION_BITS: Array<[string, number]> = [
  ['Print', (1 << 2) | (1 << 11)], // low-res + high-res print
  ['Modify contents', 1 << 3],
  ['Copy / extract text & graphics', (1 << 4) | (1 << 9)],
  ['Annotate & fill forms', (1 << 5) | (1 << 8)],
  ['Assemble document', 1 << 10],
]

export default function EncryptTool() {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [userPW, setUserPW] = useState('')
  const [ownerPW, setOwnerPW] = useState('')
  const [granted, setGranted] = useState<boolean[]>(PERMISSION_BITS.map(() => true))
  const [acknowledged, setAcknowledged] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const caps = deviceCaps()

  const budget = checkBudget(estimateEngineBytes(staged?.file.size ?? 0), caps)

  function addFile(list: FileList | null) {
    const file = list?.[0]
    if (!file) return
    setStaged({ file })
    setStatus({ kind: 'idle' })
  }

  async function run() {
    if (!staged) return
    setStatus({ kind: 'working', stage: 'reading', done: 0, total: 0 })
    try {
      const buffer = await staged.file.arrayBuffer()
      const permissions = granted.reduce(
        (acc, on, i) => (on ? acc | PERMISSION_BITS[i][1] : acc),
        PERMISSIONS_NONE,
      )
      const bytes = await engine.encrypt(
        buffer,
        { userPW, ownerPW, keyLength: 256, permissions },
        (done, total, stage) => setStatus({ kind: 'working', stage, done, total }),
      )
      setStatus({ kind: 'done', bytes })
      setUserPW('')
      setOwnerPW('')
    } catch (err) {
      if (err instanceof EngineError) {
        setStatus({ kind: 'error', message: err.userMessage, code: err.code })
      } else {
        setStatus({ kind: 'error', message: String(err), code: 'ERR_INTERNAL' })
      }
    }
  }

  const noPasswords = userPW === '' && ownerPW === ''
  const ownerOnly = userPW === '' && ownerPW !== ''
  const blocked = !staged || !!staged.error || !budget.ok || noPasswords || (userPW !== '' && !acknowledged)

  return (
    <>
      <input type="file" accept="application/pdf" onChange={(e) => addFile(e.target.files)} />

      {staged && (
        <p className="muted">
          {staged.file.name} · {formatBytes(staged.file.size)}
          {staged.error && <strong className="err"> · {staged.error}</strong>}
        </p>
      )}

      {staged && (
        <>
          <p className="muted">Device tier <code>{caps.tier}</code> (cap {formatBytes(caps.maxFileBytes)})</p>
          {!budget.ok && budget.message && <p className="err">{budget.message}</p>}
          {budget.degrade && budget.message && <p className="warn">{budget.message}</p>}

          <p>
            <label>
              Open password (required to open the file)
              <br />
              <input
                type="password"
                value={userPW}
                onChange={(e) => setUserPW(e.target.value)}
                placeholder="Leave blank for no open password"
              />
            </label>
          </p>

          <p>
            <label>
              Owner password (governs permissions only)
              <br />
              <input
                type="password"
                value={ownerPW}
                onChange={(e) => setOwnerPW(e.target.value)}
                placeholder="Leave blank to reuse the open password"
              />
            </label>
          </p>

          {ownerOnly && (
            <p className="warn">
              With no open password, anyone can still open this file. This only restricts what
              compliant readers allow — and some readers ignore these restrictions entirely. It is
              advisory, not security.
            </p>
          )}

          <fieldset>
            <legend>Permissions</legend>
            {PERMISSION_BITS.map(([label], i) => (
              <label key={label} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={granted[i]}
                  onChange={(e) =>
                    setGranted((cur) => cur.map((v, j) => (j === i ? e.target.checked : v)))
                  }
                />{' '}
                {label}
              </label>
            ))}
          </fieldset>

          <p className="muted">AES-256 encryption.</p>

          {userPW !== '' && (
            <p className="warn">
              <label>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />{' '}
                I understand this password cannot be recovered. If I forget it, this file is
                unreadable forever — there is no reset and no server-side copy.
              </label>
            </p>
          )}

          <div className="actions">
            <button onClick={run} disabled={blocked || status.kind === 'working'}>
              {status.kind === 'working' ? 'Encrypting…' : 'Encrypt'}
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
          <p>Encrypted · {formatBytes(status.bytes.byteLength)}</p>
          <button onClick={() => downloadBytes(status.bytes, 'encrypted.pdf')}>Download</button>
        </div>
      )}
    </>
  )
}
