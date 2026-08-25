# Current state

Updated 2026-08-25. **Read this first** — it says what exists, what is proven, and what
the next task is. `docs/HLD.md` and `docs/LLD.md` say how it is meant to work; this file
says how far it actually got.

---

## What works today

Phase 0 is complete. The engine runs end-to-end in a browser.

| Layer                                                              | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/internal/ops`                                              | 10 ops: merge, split, extractPages, rotate, encrypt, decrypt, pageCount, isEncrypted, compress, **organize** (Phase 2: reorder/delete/duplicate via `api.Collect`, then grouped `api.Rotate` passes against post-Collect page positions — see the file's own comment on why that indexing is the sharp edge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `engine/internal/bridge`                                           | Error codes + `Classify`; `Promisify`, buffer copy, progress relay (js build tag)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `engine/internal/wasmapi`                                          | Self-registering JS adapters; ops register from `init()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `engine/cmd/wasm`                                                  | 4 lines. Calls `wasmapi.Install()` — never needs editing again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `engine/cmd/cli`                                                   | Same ops natively — `merge`, `split`, `extract`, `rotate`, `encrypt`, `decrypt`, `info`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `engine/cmd/genfixtures`                                           | Test PDF generator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `web/src/engine/EngineClient.ts`                                   | Worker lifecycle, RPC correlation, transferables, respawn policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `web/src/workers/engine.worker.ts`                                 | Hosts the Wasm instance; main thread never touches it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `web/src/workers/render.worker.ts`, `web/src/lib/render/`          | Lane D: pdf.js render pipeline — `RenderClient` (worker lifecycle, matches `EngineClient`'s shape), page rasterization to JPEG/PNG via `OffscreenCanvas` (`getOptimalScale`/16,384px clamp, white-fill + `intent: 'print'` per `docs/tools/pdf-to-image.md`), and text extraction with line/paragraph/column reconstruction plus scanned/low-confidence detection (`docs/tools/extract-text.md`). Independent of the engine, per the boundary rule. Now wired into `web/src/tools/PdfToImage`, `web/src/tools/ExtractText`, `web/src/tools/PdfToZip` and (for thumbnails only) `web/src/tools/OrganizePages`; `images-to-pdf` still needs it. Adds `pdfjs-dist` to `web/package.json`, bundled locally (its own worker script pulled in via a Vite `?url` import, not a CDN)                                                                                                                                                                                                                                                                                                                                           |
| `web/src/tools/registry.ts`                                        | Filesystem-discovered tools via `import.meta.glob`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `web/src/lib/router.ts`                                            | ~25-line hash router, no dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `web/src/tools/Merge`                                              | Reference tool: `meta.ts` + `tool.tsx` — **copy this shape**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `web/src/tools/{Split,ExtractPages,Rotate,Encrypt,RemovePassword}` | Lane B: five Phase 1 tool pages built on `EngineClient`, same staged-input → budget → call → error-switch → download shape. `Rotate`/`ExtractPages` skip the thumbnail picker (needs Lane D's render worker); `Split` offers per-part downloads instead of a ZIP (no zip dependency added — flag before adding one, per `docs/PARALLEL.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `web/src/tools/PdfToImage`                                         | Phase 2, first render-worker tool: `render.open()` → `docId` stays live in the worker across per-page `renderPage` calls (unlike the engine's stateless calls), format/DPI/page-selection controls, batch-with-pause per `docs/tools/pdf-to-image.md`'s memory rules, per-page + "Download all" (no ZIP, same precedent as `Split`). Cancellation checks a ref rather than terminating the worker, since termination would drop the open `docId`. Page-selection parsing lives in `web/src/lib/pageSelection.ts` (JS-side subset of the Go `ParsePageSelection` syntax — no `even`/`odd`/`!exclusion`, nothing here needs it yet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `web/src/tools/Compress`                                           | Phase 2, closes out the last engine op without a UI: preset (screen/eBook/printer/prepress) or target-size mode, multiple files compressed sequentially (no ZIP, same precedent as `Split`), skip-reason copy surfaced per `docs/tools/compress.md` ("0 of 3 images compressed; 3 skipped (already low DPI)"), fallback/unreachable-target states called out explicitly. Always `engine.terminate()`s in a `finally` regardless of outcome — the highest-water-mark op we run. Adds `Optimize` to `registry.ts`'s category union (`docs/PARALLEL.md` allows appending to that list)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `web/src/tools/ExtractText`                                        | Phase 2, second render-worker tool: single `render.extractText()` call spans every requested page and streams a per-page callback so the preview fills in incrementally. No client-side per-page loop (unlike `PdfToImage`), so cancel terminates the worker rather than checking a ref — same shape as the Go engine tools. Surfaces `isScanned` ("needs OCR, which we don't offer") and `lowConfidence` (missing `/ToUnicode`) explicitly rather than returning a silently-empty or garbled result. Copy-to-clipboard and `.txt` download; no budget gate (doc calls this op "light — text only, no canvases")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `web/src/tools/PdfToZip`                                           | Phase 2, third render-worker tool: mechanically `PdfToImage` plus archiving via `jszip` — first tool needing an actual ZIP dependency, added with the user's direct go-ahead. Pages stream straight into the archive and are dropped, never accumulated in an array (JSZip holds the whole archive in memory pre-`generateAsync`, which is the real ceiling per `docs/tools/pdf-to-zip.md`). JPEG default, not PNG. Single-page documents skip the ZIP and hand back the image directly. Verified in-browser: multi-page ZIP round-trips through real `unzip -l` with correctly zero-padded names; single-page path correctly skips the archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `web/src/tools/OrganizePages`                                      | Phase 2, first **Hybrid** tool — thumbnails from the render worker, the actual edit from the new `organize` Go op. All edits are local UI state (a `Card[]` intent list plus undo/redo history) until Apply sends one `organize` call; dragging 40 pages must not trigger 40 engine round-trips. V1 skips thumbnail virtualisation and the bookmark-outline warning (documented in the file header, not an oversight). Caught and fixed a real bug during verification: the thumbnail-URL cleanup effect was keyed to the `thumbs` state itself, so it revoked each blob URL the instant the _next_ page's thumbnail arrived, corrupting duplicated-page thumbnails — fixed by tracking URLs in a ref, revoked only on file-switch and unmount. Verified in-browser: rotate/duplicate/delete/undo/redo all correct, drag-reorder confirmed via dispatched DragEvents (native `left_click_drag` doesn't trigger HTML5 D&D in this environment), Apply produces a real 5-page PDF whose page order and content were confirmed by round-tripping it through `PdfToImage`, and "every page deleted" correctly blocks Apply |
| `web/src/dev/smoke.ts`                                             | 12-check browser smoke test, including compress (preset round trip + unreachable target reports `reachedTarget: false`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `signaling/`                                                       | WebSocket signaling server (Go module, `cmd/signaling`): room create/join/relay for SDP+ICE via `internal/hub`, per-IP rate limiting via `internal/wsserver`, Crockford-base32 room codes via `internal/roomcode`. 27 Go tests pass, gofmt clean, vet clean. See `signaling/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

57 Go tests pass. TypeScript is clean. Production build works. `__smoke()` now has 12
checks including compress, but has not actually been run in a browser since the compress
checks were added — the Chrome extension wasn't available in the environment that wrote
this. Run `await __smoke()` yourself before trusting the count.

## Measured, not estimated

|                              |                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Wasm binary                  | 18.29 MB raw / 4.37 MB gzip / **3.08 MB Brotli** (was 17.70/4.24/3.00 before compress) |
| Cold boot + merge            | ~199 ms                                                                                |
| Warm merge                   | ~12.4 ms                                                                               |
| External requests at runtime | zero                                                                                   |

Adding ops is nearly free — going from one to eight added 0.8 MB. pdfcpu's fixed cost
dominates, so do not bother splitting the engine per tool.

## Still guesses

Flagged so nobody mistakes them for findings:

- `RESPAWN_AFTER_BYTES` (64 MB) in `EngineClient.ts` — arbitrary.
- `ENGINE_MULTIPLIER` (4.0) in `lib/device.ts` — the real pdfcpu heap multiplier is
  unmeasured. **The spike used 2 KB fixtures**, which proves correctness and says nothing
  about memory.
- Device tier caps — inherited from ihatepdf's JS-tuned numbers, not ours.

Measuring these needs a 100 MB+ fixture: `go run ./cmd/genfixtures -out /tmp/big -pages 500`.

---

## Commands

```bash
cd engine && go test ./...
```

```bash
./scripts/build-wasm.sh
```

```bash
cd web && npm install && npm run dev
```

Then open http://localhost:5173 and run `await __smoke()` in the console.

```bash
cd engine && go run ./cmd/cli info ../web/public/fixtures/sample-a.pdf
```

**Rebuild the Wasm after any change under `engine/`.** Vite serves
`web/public/wasm/engine.wasm` as a static asset and will not rebuild it for you — this
is the single easiest way to spend an hour debugging a change that was never compiled.

---

## Things that will bite you

Each of these cost real time during Phase 0. All are guarded now; the guards are load-bearing.

1. **Never do work directly inside a `js.FuncOf` callback.** It runs on the thread
   servicing the Wasm event loop; the worker hangs with no error and no timeout. Use
   `bridge.Promisify`, which spawns a goroutine.
2. **pdfcpu needs `model.ConfigPath = "disable"` under `GOOS=js`** — otherwise it tries
   to `mkdir /tmp` and dies on the first call. See `internal/ops/config_js.go`. No native
   test catches this.
3. **`js.CopyBytesToGo` needs a `Uint8Array`, not an `ArrayBuffer`.** Handing it a buffer
   copies zero bytes and surfaces much later as a confusing parse error.
4. **Measuring binary size needs a real call path.** `_ = ops.Merge` does not defeat
   dead-code elimination; pdfcpu drops out and you measure a bare runtime. Our first
   measurement was wrong by 3× this way.
5. **Rotation is relative**, not absolute — it adds to the page's existing `/Rotate`.
   Most scans already carry one.
6. **Don't use `api.Split` or `api.SplitByPageNr`.** They demand an output directory,
   which would drag a filesystem shim into the Wasm build. `api.Collect` does it in memory.
7. **Passwords with spaces are rejected on purpose.** pdfcpu encrypts them and then can
   never decrypt them. See `docs/tools/encrypt.md`.
8. **`api.UpdateImages` cannot downsample.** pdfcpu v0.15.0 rejects a replacement image
   whose pixel dimensions differ from the original, which is most of what compress does.
   Compress replaces the xref entry itself instead — `docs/LLD.md` §3.1 explains why that
   is safe. Also: extracting an image mutates its stream dict, so the context you plan on
   must never be the context you write.

---

## Backlog

**Plan docs.** Backlog items with an implementation plan more involved than a paragraph
get one under `docs/plans/`. Delete the plan file in the same change that implements it
— fold anything worth keeping into this file or the relevant `docs/tools/*.md` instead
of leaving a stale plan sitting around once the code exists.

Empty right now — both prior items (output-filename renaming, `FilePicker`'s dragleave
flicker) shipped. Output filenames are now editable before download via the shared
`web/src/lib/filename.ts` (`sanitizeFilename`) + `web/src/components/FilenameField.tsx`,
wired into Merge/Rotate/Encrypt/ExtractPages/RemovePassword; Split stays out of scope,
per-part names are engine-derived. `FilePicker` now tracks drag depth with a counter
(`web/src/components/FilePicker.tsx`) instead of a boolean, so nested `dragenter`/
`dragleave` on child elements no longer clears the drag-active state early.

## Next task

**Phase 1 UI is done.** All six Phase 1 tool pages (`Merge`, `Split`, `ExtractPages`,
`Rotate`, `Encrypt`, `RemovePassword`) are built and follow the shared shape: staged
input → device-tier budget check → engine call with progress → typed error handling on
`EngineError.code` → download. `web/src/tools/Merge/` is still the reference to copy for
anything new.

**What's next is closing out Phase 2's remaining render-worker tools.** `compress` is
now built (`web/src/tools/Compress`) — mode toggle (preset/target), sequential
multi-file compression, skip-reason copy, always-terminate-after cleanup. Verified
against a realistic photo-heavy fixture (not `sample-a.pdf`, whose images are
deliberately too small to compress): 5.43 MB → 285.9 KB, 95% smaller, through both
the Go layer directly and the actual browser UI.

`extract-text` is also built (`web/src/tools/ExtractText`) — pdf.js's
`getTextContent()` plus this codebase's own line/paragraph reconstruction
(`render.worker.ts`), not an LLM or an external library: deterministic
coordinate math, same as `pdf-to-image`'s pipeline. Verified in-browser against a
real 2-page text fixture (correct extraction, copy, `.txt` download) and against
`sample-a.pdf` (image-only — correctly detects `isScanned` and explains rather than
returning an empty result).

**Phase 2 is now fully closed.** All five render-worker tools are built:
`pdf-to-image` (per-page loop, cancel-via-ref), `extract-text` (single call spanning every
page, cancel-via-terminate), `pdf-to-zip` (same shape as `pdf-to-image` plus streaming
into a `jszip` archive — first tool needing that dependency, added with direct user
go-ahead), and `organize-pages` (the first **Hybrid** tool: thumbnails from the render
worker, the actual edit from a new Go op, `engine/internal/ops/organize.go`). Building
`organize-pages` caught a real bug — its thumbnail-cleanup effect was keyed to the
`thumbs` state itself, so it revoked each blob URL the instant the next page's thumbnail
arrived, corrupting duplicated-page thumbnails specifically. Fixed by tracking URLs in a
ref, revoked only on file-switch and unmount — worth remembering as a general pattern
anywhere object URLs are created inside a loop that updates the state the cleanup effect
depends on.

**What's next is Phase 3: P2P share.** The signaling server already exists (Lane C) and
is untouched by any tool page; see `docs/tools/p2p-share.md`. `images-to-pdf` is the one
Phase-2-catalogued tool page still unbuilt — it may not need the render worker at all
(check whether it's closer to the Go-engine shape before starting).

- Now that the render worker is wired into several tools, revisit `docs/tools/{merge,
split,rotate,encrypt,remove-password,extract-pages}.md` — several describe thumbnail
  pickers, drag-reorder, or ZIP downloads that Phase 1 shipped without (documented in
  each `tool.tsx`'s header comment). Decide per-tool whether to build the richer UX now,
  or update the doc to match what shipped.

**This work parallelises.** `docs/PARALLEL.md` defines four non-overlapping lanes —
engine ops, tool UIs, signaling server, render pipeline — and the worktree flow for
running them at once.

---

## Handing this to another agent

The repo is self-contained; no context from the originating conversation is required.
Point the agent at `CLAUDE.md` (constraints and commands), then this file (state), then
`docs/HLD.md` and `docs/LLD.md` (design), then the relevant `docs/tools/*.md`.

For **several** agents at once, `docs/PARALLEL.md` assigns lanes and lists the few
shared files that need coordination. Give each agent its own worktree
(`./scripts/worktree.sh add <lane>`) and exactly one lane.

The one thing not in the repo is the reverse-engineering of ihatepdf.cv that produced the
tool catalog. Its conclusions are recorded in `docs/HLD.md` §3 and
`docs/tools/p2p-share.md` §1 — including where that site's public write-up does not match
its shipped code, so do not treat that write-up as a reference.
