# Plan: let users rename the output file before download

> **This is a plan doc, not permanent documentation.** Delete this file in the same
> change that implements it — fold anything worth keeping into `docs/STATE.md` or the
> relevant `docs/tools/*.md` instead of leaving a stale plan lying around. See the
> "Plan docs" note in `docs/STATE.md`'s Backlog section.

## Problem

Every tool hardcodes its output filename:

| Tool | Current filename |
| --- | --- |
| Merge | `merged.pdf` |
| Rotate | `rotated.pdf` |
| Encrypt | `encrypted.pdf` |
| Extract Pages | `extracted.pdf` |
| Remove Password | `unlocked.pdf` |
| Split | per-part name already computed by the engine (`p.name`) — out of scope, see below |

(`web/src/tools/*/tool.tsx`, all calling `downloadBytes(bytes, '<hardcoded>.pdf')`.)

Users doing repeat operations either overwrite the previous download or have to rename
the file themselves after the fact in their OS file manager.

## Goal

Let the user edit the output filename before clicking Download, defaulting to today's
hardcoded value so nothing changes for someone who doesn't touch it.

## Non-goals (V1)

- **Split's per-part renaming.** It already produces multiple files with engine-derived
  names (`p.name`). Renaming N outputs individually is a different, bigger UI problem
  (bulk rename pattern, e.g. `{name}-{n}.pdf`) — track separately if it comes up, don't
  bolt it onto this plan.
- Remembering the user's last-used name across sessions. localStorage holds metadata
  only per `CLAUDE.md`, and a filename the user typed is arguably content, not metadata —
  needs its own decision if requested later.

## Proposed UX

In each tool's `status.kind === 'done'` block, replace the static filename with a text
input, pre-filled with the current default (e.g. `rotated.pdf`), editable before the
Download button is clicked:

```tsx
{status.kind === 'done' && (
  <div className="result">
    <p>Rotated · {formatBytes(status.bytes.byteLength)}</p>
    <label>
      File name
      <input
        type="text"
        value={filename}
        onChange={(e) => setFilename(e.target.value)}
      />
    </label>
    <button onClick={() => downloadBytes(status.bytes, sanitizeFilename(filename, 'rotated.pdf'))}>
      Download
    </button>
  </div>
)}
```

## Implementation sketch

1. **Shared helper, not per-tool duplication** — same pattern as `FilePicker`
   (`web/src/components/FilePicker.tsx`) and precedent in `CLAUDE.md`: a small reusable
   piece wired into every tool beats five copies of the same logic.
   - `web/src/lib/filename.ts`: `sanitizeFilename(input: string, fallback: string): string`
     — trims, strips path separators (`/`, `\`) and control characters, ensures a `.pdf`
     extension, falls back to the tool's default if the result is empty.
   - Optionally a tiny `web/src/components/FilenameField.tsx` if the markup ends up
     repeated identically across tools; skip it if each tool's JSX differs enough that a
     wrapper just adds indirection.
2. Add `const [filename, setFilename] = useState(<default>)` to each of Merge, Rotate,
   Encrypt, ExtractPages, RemovePassword's `tool.tsx`.
3. Swap the hardcoded string in `downloadBytes(...)` for `sanitizeFilename(filename, <default>)`.
4. Sanitize on download, not on every keystroke — let the user type freely, only clean
   up the value at the point it becomes a filename.

## Files touched

- `web/src/lib/filename.ts` (new)
- `web/src/tools/{Merge,Rotate,Encrypt,ExtractPages,RemovePassword}/tool.tsx`
- Possibly `web/src/components/FilenameField.tsx` (new, only if warranted per step 1)

No shared registration file changes needed — this doesn't add a tool or an op, just
touches existing tool pages, same as the `FilePicker` rollout did.

## Open questions

- Should the extension be enforced (always `.pdf`) or editable? Recommend enforced —
  every output here actually is a PDF, and letting the user type a wrong extension buys
  nothing but confusing double-extension downloads.
- Character limit / OS-invalid-character handling (`<>:"|?*` on Windows) — worth
  sanitizing preemptively since this is a cross-platform browser app.
