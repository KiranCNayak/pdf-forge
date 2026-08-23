# pdf-forge

A browser-based PDF toolkit where every byte stays on the user's machine. No upload, no
account, no watermark, works offline after first load.

The engine is **Go compiled to WebAssembly** (pdfcpu core), not the pile of JavaScript
libraries every competitor assembles. The same Go code also builds a native CLI, giving us
a self-hostable binary and a free benchmark baseline.

---

## The one rule

> **Go owns byte → byte structural transformation.**
> **JS owns rasterization, text-layout extraction, file I/O and UI.**
> **Pixels never round-trip through Go.**

Both sides *look* capable of the other's job, which is why this is stated first. Merge,
split, rotate, organize, encrypt, decrypt, compress and images→PDF go to Go. PDF→image,
text extraction, thumbnails and previews stay in JS on pdf.js — Go has no PDF rasterizer,
and pdf.js reconstructs text layout far better than pdfcpu does.

Full table in `docs/HLD.md` §4.

## Layout

| Path | What |
| --- | --- |
| `engine/` | Go module → Wasm (`cmd/wasm`) + native CLI (`cmd/cli`). Ops in `internal/ops` |
| `web/` | Vite + React + TypeScript SPA. One lazy route per tool |
| `signaling/` | Go WebSocket server for P2P share. SDP relay only |
| `docs/` | HLD, LLD, tool catalog, per-tool plans. **Design decisions live here** |

**`docs/STATE.md` says what currently exists and what the next task is. Read it before
starting work** — the docs describe the design, STATE describes reality.

## Commands

```bash
cd engine && go test ./...
```

```bash
./scripts/build-wasm.sh
```

```bash
cd web && npm run dev
```

```bash
cd engine && go run ./cmd/cli --help
```

Rebuild the Wasm after any change under `engine/` — Vite serves it as a static asset and
will not do it for you. Browser smoke test: `await __smoke()` in the dev console.

## Hard constraints

**Never load anything from a CDN at runtime.** Bundle it. ihatepdf.cv pulls 14 libraries
from jsdelivr/cdnjs/unpkg, which tells three third parties every visitor's IP, User-Agent
and *which tool they opened* — the last being the most sensitive signal on a site with
routes like `/redact` and `/remove-password`. It also makes their offline claim contingent
on cache state. Ours is structural. Do not erode it for convenience.

**Every exported Go op returns a Promise and works in a goroutine.** A `js.FuncOf`
callback runs on the single thread servicing the Wasm event loop; doing long work inline
hangs the worker permanently, with no error and no timeout. See `docs/LLD.md` §1.4 for the
`promisify` helper — use it, don't hand-roll.

**Respawn the engine worker after large jobs.** `WebAssembly.Memory` grows and never
shrinks, so one 150 MB PDF permanently inflates the heap for the tab's life. Termination
is our only way to reclaim it. `docs/LLD.md` §2.1.

**No telemetry that names a file or a tool.** Sizes and counts are fine. Filenames, file
contents, passwords and per-route analytics are not. Passwords live in memory for the
duration of a call and are never persisted, logged, or placed in a URL.

**localStorage holds metadata only.** File bytes go to IndexedDB (`idb-keyval`) or stay in
RAM. Never bytes in localStorage.

## Working on this

Design decisions belong in `docs/`, not in commit messages or code comments. If behaviour
diverges from what a doc says, fix the doc in the same change — a stale HLD is worse than
no HLD.

Figures in the docs marked *(estimate)* have not been measured. Replace them with real
numbers rather than quietly inheriting them; several device-tier constants are placeholders
until the Phase 0 spike runs.

Known gaps that are deliberate, not oversights — don't "fix" them without reading the
reasoning first:

- **No font subsetting** in compress. We lose to Ghostscript on text-heavy PDFs.
  `docs/LLD.md` §3.4.
- **No TURN** in P2P share. ~10–15% of networks will fail. Adding TURN would relay bytes
  through a server and break the premise. `docs/tools/p2p-share.md`.
- **Images with `/SMask` or `/Mask` are skipped** during compression in V1. Mishandling
  them produces visibly corrupt output.
- **Passwords containing spaces are rejected.** pdfcpu will encrypt with them and then
  never decrypt again — a data-loss bug we guard against. `docs/tools/encrypt.md`.
- **`model.ConfigPath = "disable"`** in `internal/ops/config_js.go` is required, not
  tidiness: without it pdfcpu tries to `mkdir /tmp` and dies on the first browser call.

`docs/STATE.md` §"Things that will bite you" has the full list, each with the failure it
prevents.

## Scope

V1 is 12 tools (Phases 1–2): core page ops, encrypt/remove-password, compress, and
render/convert. The full in-scope target is 43. AI tools, local-ML tools (OCR/TTS) and
India-specific business tools are **out of scope** with reasons recorded in
`docs/TOOL_CATALOG.md` §Deferred.
