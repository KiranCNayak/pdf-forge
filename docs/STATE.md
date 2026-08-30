# Current state

Updated 2026-08-25. **Read this first** — it says what exists, what is proven, and what
the next task is. `docs/HLD.md` and `docs/LLD.md` say how it is meant to work; this file
says how far it actually got.

---

## What works today

Phase 0 is complete. The engine runs end-to-end in a browser.

| Layer                                                              | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/internal/ops`                                              | 12 ops: merge, split, extractPages, rotate, encrypt, decrypt, pageCount, isEncrypted, compress, organize, imagesToPDF (Phase 2: JPEG/PNG/TIFF/WebP → one PDF via `api.ImportImages`; "fit" page size is free — pdfcpu sizes the page to the image's own pixel dimensions whenever `Pos` is left at its default `Full`, no per-image dimension decoding needed), **addWatermark**/**removeWatermark**/**hasWatermarks** (Phase 4, first ops outside the original V1 catalog: `api.TextWatermark` + `api.AddWatermarks`/`api.RemoveWatermarks`/`api.HasWatermarks`, all fully in-memory. `addWatermark` has its own pre-check for a selection resolving to zero pages — pdfcpu's own `AddWatermarks` silently no-ops on that rather than erroring. `removeWatermark` has the opposite problem and the opposite fix: pdfcpu's own `RemoveWatermarks` ERRORS ("no watermarks found") when there's nothing to remove rather than no-oping, so `RemoveWatermark` catches exactly that message and hands back the original bytes unchanged — added directly from a user request after Add Watermark shipped, not from the original reverse-engineering pass)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `engine/internal/bridge`                                           | Error codes + `Classify`; `Promisify`, buffer copy, progress relay (js build tag)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `engine/internal/wasmapi`                                          | Self-registering JS adapters; ops register from `init()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `engine/cmd/wasm`                                                  | 4 lines. Calls `wasmapi.Install()` — never needs editing again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `engine/cmd/cli`                                                   | Same ops natively — `merge`, `split`, `extract`, `rotate`, `encrypt`, `decrypt`, `info`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `engine/cmd/genfixtures`                                           | Test PDF generator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `web/src/engine/EngineClient.ts`                                   | Worker lifecycle, RPC correlation, transferables, respawn policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `web/src/workers/engine.worker.ts`                                 | Hosts the Wasm instance; main thread never touches it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `web/src/workers/render.worker.ts`, `web/src/lib/render/`          | Lane D: pdf.js render pipeline — `RenderClient` (worker lifecycle, matches `EngineClient`'s shape), page rasterization to JPEG/PNG via `OffscreenCanvas` (`getOptimalScale`/16,384px clamp, white-fill + `intent: 'print'` per `docs/tools/pdf-to-image.md`), and text extraction with line/paragraph/column reconstruction plus scanned/low-confidence detection (`docs/tools/extract-text.md`). Independent of the engine, per the boundary rule. Now wired into `web/src/tools/PdfToImage`, `web/src/tools/ExtractText`, `web/src/tools/PdfToZip` and (for thumbnails only) `web/src/tools/OrganizePages`. `images-to-pdf` turned out not to need it after all — see its own row below. Adds `pdfjs-dist` to `web/package.json`, bundled locally (its own worker script pulled in via a Vite `?url` import, not a CDN)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `web/src/tools/registry.ts`                                        | Filesystem-discovered tools via `import.meta.glob`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `web/src/lib/router.ts`                                            | ~25-line hash router, no dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `web/src/tools/Merge`                                              | Reference tool: `meta.ts` + `tool.tsx` — **copy this shape**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `web/src/tools/{Split,ExtractPages,Rotate,Encrypt,RemovePassword}` | Lane B: five Phase 1 tool pages built on `EngineClient`, same staged-input → budget → call → error-switch → download shape. `Rotate`/`ExtractPages` skip the thumbnail picker (needs Lane D's render worker); `Split` offers per-part downloads instead of a ZIP (no zip dependency added — flag before adding one, per `docs/PARALLEL.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `web/src/tools/PdfToImage`                                         | Phase 2, first render-worker tool: `render.open()` → `docId` stays live in the worker across per-page `renderPage` calls (unlike the engine's stateless calls), format/DPI/page-selection controls, batch-with-pause per `docs/tools/pdf-to-image.md`'s memory rules, per-page + "Download all" (no ZIP, same precedent as `Split`). Cancellation checks a ref rather than terminating the worker, since termination would drop the open `docId`. Page-selection parsing lives in `web/src/lib/pageSelection.ts` (JS-side subset of the Go `ParsePageSelection` syntax — no `even`/`odd`/`!exclusion`, nothing here needs it yet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `web/src/tools/Compress`                                           | Phase 2, closes out the last engine op without a UI: preset (screen/eBook/printer/prepress) or target-size mode, multiple files compressed sequentially (no ZIP, same precedent as `Split`), skip-reason copy surfaced per `docs/tools/compress.md` ("0 of 3 images compressed; 3 skipped (already low DPI)"), fallback/unreachable-target states called out explicitly. Always `engine.terminate()`s in a `finally` regardless of outcome — the highest-water-mark op we run. Adds `Optimize` to `registry.ts`'s category union (`docs/PARALLEL.md` allows appending to that list)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `web/src/tools/ExtractText`                                        | Phase 2, second render-worker tool: single `render.extractText()` call spans every requested page and streams a per-page callback so the preview fills in incrementally. No client-side per-page loop (unlike `PdfToImage`), so cancel terminates the worker rather than checking a ref — same shape as the Go engine tools. Surfaces `isScanned` ("needs OCR, which we don't offer") and `lowConfidence` (missing `/ToUnicode`) explicitly rather than returning a silently-empty or garbled result. Copy-to-clipboard and `.txt` download; no budget gate (doc calls this op "light — text only, no canvases")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `web/src/tools/PdfToZip`                                           | Phase 2, third render-worker tool: mechanically `PdfToImage` plus archiving via `jszip` — first tool needing an actual ZIP dependency, added with the user's direct go-ahead. Pages stream straight into the archive and are dropped, never accumulated in an array (JSZip holds the whole archive in memory pre-`generateAsync`, which is the real ceiling per `docs/tools/pdf-to-zip.md`). JPEG default, not PNG. Single-page documents skip the ZIP and hand back the image directly. Verified in-browser: multi-page ZIP round-trips through real `unzip -l` with correctly zero-padded names; single-page path correctly skips the archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `web/src/tools/OrganizePages`                                      | Phase 2, first **Hybrid** tool — thumbnails from the render worker, the actual edit from the new `organize` Go op. All edits are local UI state (a `Card[]` intent list plus undo/redo history) until Apply sends one `organize` call; dragging 40 pages must not trigger 40 engine round-trips. V1 skips thumbnail virtualisation and the bookmark-outline warning (documented in the file header, not an oversight). Caught and fixed a real bug during verification: the thumbnail-URL cleanup effect was keyed to the `thumbs` state itself, so it revoked each blob URL the instant the _next_ page's thumbnail arrived, corrupting duplicated-page thumbnails — fixed by tracking URLs in a ref, revoked only on file-switch and unmount. Verified in-browser: rotate/duplicate/delete/undo/redo all correct, drag-reorder confirmed via dispatched DragEvents (native `left_click_drag` doesn't trigger HTML5 D&D in this environment), Apply produces a real 5-page PDF whose page order and content were confirmed by round-tripping it through `PdfToImage`, and "every page deleted" correctly blocks Apply                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `web/src/tools/P2PShare`                                           | Phase 3, first tool built on `signaling/`: `web/src/lib/p2p/` (`SignalTransport` — the structural interface `PeerLink` actually depends on; `SignalingClient` — WS wrapper, push-driven not request/response like the other two clients; `BroadcastSignalingClient` — the same-browser shortcut, a second `SignalTransport` over a `BroadcastChannel`, no server round trip; `PeerLink` — RTCPeerConnection + trickle ICE over either transport, buffers ICE candidates that race ahead of `setRemoteDescription`; `ManualLink` — the copy-paste fallback for when neither transport reaches the other side, vanilla ICE (blocks on full gathering, no channel for late candidates), reachable directly from either panel's idle screen; `transfer.ts` — header/accept/reject/end control protocol over the data channel, chunked sending with `bufferedAmountLowThreshold` backpressure, gzip via `CompressionStream` kept only when it shrinks the file, SHA-256 verification, **sequential multi-file transfer** (`sendFiles`/`receiveFiles`, one accept covers a whole batch via `batchIndex`/`batchTotal` on each `FileHeader`); `crypto.ts` — optional PBKDF2-SHA256 → AES-256-GCM password layer, same envelope as ihatepdf's own construction). **V1 departure, documented in `transfer.ts`'s header, not silent:** whole file in memory rather than IndexedDB. Building multi-file transfer caught two real concurrency bugs in `receiveFiles` — see `docs/tools/p2p-share.md`'s Status section and "Things that will bite you" below — both now regression-tested by `web/e2e/p2p-share.spec.ts`. Verified with two real browser tabs against a locally-run signaling server: full offer/answer/ICE handshake, a transferred file confirmed **byte-identical** to the original via `diff` both unencrypted and through a full encrypt/decrypt round trip, wrong password correctly reported as "Wrong password." not "file corrupt", invalid-room-code and peer-declined error paths both correctly messaged, a 2-file batch received off one accept with per-file download, zero console errors throughout. The same-browser `BroadcastChannel` shortcut and the manual-paste fallback are both now regression-tested end-to-end too (two pages in one browser context for the former, since separate Playwright contexts are separate storage partitions and don't share a channel) |
| `web/src/tools/ImagesToPdf`                                        | Phase 2's last catalogued tool page: JPEG/PNG/TIFF/WebP → one PDF, one page per image, via the new `imagesToPDF` Go op — turned out to need no render-worker involvement at all. Staged list follows Merge's up/down-reorder shape (no thumbnails — see the file header for why). "Fit to image" / A4 / Letter page size, portrait/landscape orientation (A4/Letter only; no per-image "auto" in V1 — see the engine op's doc comment on why that needs per-image dimension decoding this pass skips). HEIC is detected via an ISO-BMFF `ftyp` box sniff and rejected with a clear message, per the doc's explicit V1 scope. Verified in-browser: 3 real JPEG/PNG images (portrait/landscape/square) → 3-page PDF, page order and aspect ratios confirmed correct by round-tripping through `PdfToImage`; A4 landscape output confirmed 842×595pt (exactly A4 portrait's dimensions swapped) via `api.PageDims`; zero console errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `web/src/tools/AddWatermark`                                       | Phase 4's first tool — also the first tool outside the original 12-tool V1 catalog. Text watermark: font size, color, 9-point anchor position, rotation (always sent explicitly, unlike pdfcpu's own diagonal-by-default), opacity, on-top-vs-behind-content toggle, apply to all pages or a typed selection (same shape as extract-pages/rotate). New `Annotate` category appended to `registry.ts`'s category union, per `docs/PARALLEL.md`'s "append, don't reorder" rule. Verified: 9 new Go tests including an encrypted-input round trip and a selection-resolves-to-zero-pages case (`docs/tools/add-watermark.md`'s own edge-case table), 2 new Playwright e2e tests, zero console errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `web/src/tools/RemoveWatermark`                                    | The removal counterpart, same file on the engine side. Pre-flight detection (`api.HasWatermarks`) shown as soon as a file loads — "No watermark detected" does NOT block the button, unlike `RemovePassword`'s analogous "not encrypted" block, since running removal on an unwatermarked file is a genuine no-op per the doc, not a mistake to prevent. Page selection reuses pdfcpu's raw token syntax directly (`even`/`odd`/`!`/ranges) with no new parsing — proven by a dedicated Go test, not just claimed in the doc. Verified via a full add→remove round trip in `web/e2e/add-remove-watermark.spec.ts` (produces a real watermarked PDF, downloads it, feeds it back in, confirms detection then removal) plus the no-watermark no-op path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `web/src/dev/smoke.ts`                                             | 16-check browser smoke test, including add/remove watermark (including the no-watermark no-op path) and compress (preset round trip + unreachable target reports `reachedTarget: false`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `web/e2e/`                                                         | Playwright end-to-end tests: real Chromium, real Vite dev server, real `engine.wasm` (plus a real `signaling/` server for `p2p-share.spec.ts` — `playwright.config.ts`'s second `webServer` entry) — the layer above the browser smoke test, covering UI wiring (file pickers, staged-list reorder, option forms, downloads) that no unit test touches. 16 specs across every tool: `merge`, `split`, `extract-pages`, `rotate`, `compress`, `images-to-pdf`, `pdf-to-image`, `extract-text` (scanned-detection plus a real-text fixture, `web/e2e/fixtures/text-page.pdf`), `pdf-to-zip` (multi-page ZIP + single-page shortcut), `organize-pages` (rotate/duplicate/undo/redo/apply via button clicks — drag-reorder isn't exercised, see the spec's own header), `p2p-share` (two real browser contexts against one signaling server, unencrypted + wrong-password paths), an `encrypt` → `remove-password` round trip across two tools, and site-wide navigation. Caught two real bugs on its very first run — see "Things that will bite you" below. `npm run test:e2e`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `signaling/`                                                       | WebSocket signaling server (Go module, `cmd/signaling`): room create/join/relay for SDP+ICE via `internal/hub`, per-IP rate limiting via `internal/wsserver`, Crockford-base32 room codes via `internal/roomcode`. 27 Go tests pass, gofmt clean, vet clean. Now consumed by `web/src/tools/P2PShare`. See `signaling/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

88 Go tests pass. TypeScript is clean. Production build works. 33 Playwright e2e tests
across 15 spec files pass (`web/e2e/`, `npm run test:e2e`) — every tool has at least one.
`__smoke()` now has 12
checks including compress, but has not actually been run in a browser since the compress
checks were added — the Chrome extension wasn't available in the environment that wrote
this. Run `await __smoke()` yourself before trusting the count.

## Measured, not estimated

|                              |                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Wasm binary                  | 19.37 MB raw / 4.59 MB gzip / **3.23 MB Brotli** (was 19.31/4.58/3.24 before removeWatermark/hasWatermarks) |
| Cold boot + merge            | ~199 ms                                                                                                     |
| Warm merge                   | ~12.4 ms                                                                                                    |
| External requests at runtime | zero                                                                                                        |

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

```bash
cd web && npm run test:e2e
```

Playwright drives real Chromium against the Vite dev server (starts one itself if none is
running on :5173) and the already-built `engine.wasm` — build it first if missing or stale.
`npm run test:e2e:ui` opens Playwright's UI mode for debugging a single spec.

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
9. **`EncryptParams.Permissions` was `int16`, and every real encrypt call was broken.**
   The UI's own `PERMISSIONS_NONE` base value (`0xf0c3` = 61635, ISO-32000 Table 22's
   reserved bits forced to 1) exceeds int16's range, so `json.Unmarshal` silently failed
   on every UI-driven `encrypt` call. Invisible to every native Go test, because they all
   construct `EncryptParams{}` as a Go struct literal, bypassing JSON entirely. Now
   `int32`, matching `model.PermissionFlags`'s own underlying `int`. Caught by the
   Playwright suite's first real run, not by 57 passing Go tests — see `web/e2e/`'s row
   above and `TestEncryptParamsPermissionsSurvivesJSONRoundTrip`.
10. **Encrypting with only a user password used to fail.** pdfcpu requires a non-empty
    owner password outright ("please provide owner password and optional user password"),
    but the Encrypt UI's own placeholder text promises "leave blank to reuse the open
    password" on that field. `Encrypt` (`internal/ops/security.go`) now defaults
    `OwnerPW` to `UserPW` when blank, so the UI's placeholder is actually true. The
    resulting pdfcpu error also happened to contain the word "password", so
    `bridge.Classify` misread it as `ERR_ENCRYPTED` ("this file is already encrypted")
    rather than surfacing the real cause — worth remembering next time a `Classify`
    substring match looks too broad. Also caught by the Playwright suite; see
    `TestEncryptWithOnlyUserPasswordSucceeds`.
11. **Don't reset shared state in an async continuation that runs after the next message
    may already have arrived.** Building P2P Share's multi-file `receiveFiles`
    (`web/src/lib/p2p/transfer.ts`), the first working version reset `received`/`header`
    inside the `.then()` that ran after each file's async decrypt-and-verify step — by
    which point the _next_ file's header and chunks could already have arrived and
    started updating that same state, and the stale reset clobbered it. Symptom was an
    intermittent (not deterministic — timing-dependent) "Transfer ended before a file
    header arrived." Fixed by resetting synchronously in the handler for the message that
    starts the new state (`'header'`), never in a continuation that resolves later than
    messages the wire has no obligation to wait for. A closely related version of the
    same mistake, fixed first: don't tear down and re-install a message listener between
    logically-sequential messages either — the gap between removing the old one and
    adding the new one is exactly this class of race, and on a real (if same-machine)
    WebRTC connection it reproduced on roughly 1 in 3 runs, not never. Both caught by
    `web/e2e/p2p-share.spec.ts`'s multi-file test, not by any unit test — there isn't one
    for `transfer.ts`, and this class of bug is exactly what a real, if simulated, network
    surfaces that a mocked one wouldn't.

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

**Phase 3 (P2P share) has a working V1, now including the password layer and multi-file
transfer.** `web/src/tools/P2PShare` and `web/src/lib/p2p/` implement send/receive over a
real WebRTC data channel, signaling via `signaling/`, plus optional PBKDF2-SHA256 →
AES-256-GCM encryption (`p2p/crypto.ts`) — the layer `docs/tools/p2p-share.md` calls out
as earning its place specifically because we introduced a signaling server (defends
against a compromised server rewriting SDP fingerprints, not against passive
eavesdropping — DTLS already covers that). Verified with two live browser tabs against a
locally-run signaling server: full offer/answer/ICE handshake, a transferred file
confirmed byte-identical via `diff` both unencrypted and through a full encrypt/decrypt
round trip, wrong password correctly reported as "Wrong password." rather than "file
corrupt", invalid-code and peer-declined error paths, zero console errors.

`sendFiles`/`receiveFiles` (`transfer.ts`) send a whole batch over one data channel with
one accept — no new control-frame type, just `batchIndex`/`batchTotal` on each
`FileHeader`. Two real concurrency bugs surfaced while building it, both now
regression-tested by `web/e2e/p2p-share.spec.ts`'s multi-file spec — see "Things that
will bite you" #11 below and `docs/tools/p2p-share.md`'s Status section for the detail.

**gzip, the `BroadcastChannel` same-tab shortcut, and the manual-paste fallback are now
all built** — see `docs/tools/p2p-share.md`'s Status section for the detail on each.
Briefly: gzip (`transfer.ts`'s `gzipIfSmaller`/`gunzip`) is kept only when it actually
shrinks the file, since most PDFs are already partly compressed internally.
`BroadcastSignalingClient` is a second `SignalTransport` implementation (alongside
`SignalingClient`) over a `BroadcastChannel` instead of a WebSocket — same external shape,
so `PeerLink` needed no changes beyond depending on the interface rather than the concrete
WebSocket class. `ManualLink` is the copy-paste (vanilla ICE, no relay for late
candidates) fallback, reachable directly from either panel's idle screen rather than only
after a real signaling failure — which also made it straightforward to test without
faking one. All three are regression-tested in `web/e2e/p2p-share.spec.ts`.

**What's left before this is done, not started:**

- **IndexedDB assembly.** V1 buffers the whole file in memory on both ends (`transfer.ts`'s
  header explains why and what a correct chunked-IndexedDB version needs). Fine for
  realistic file sizes; revisit if huge transfers turn out to matter.
- Production signaling deployment (Fly.io, per the doc) — V1 was only run locally
  (`go run ./cmd/signaling`) against a local web dev server. `VITE_SIGNALING_URL` (see
  `web/.env.example`) needs to point at a real deployment before this ships to users. This
  is an outward-facing, billed cloud deployment — worth confirming with the user before
  spending on it, not something to do unilaterally.
- QR code for the room code (text only, for now).

**Phase 2 is now completely closed.** `images-to-pdf` is built (`web/src/tools/ImagesToPdf`)
— turned out to be a pure Go-engine tool, no render worker needed. Every tool named in
`docs/TOOL_CATALOG.md`'s Phase 1 and Phase 2 sections now has a page.

**Resolved:** `docs/tools/{merge,split,rotate,encrypt,remove-password,extract-pages}.md`
have been revisited against what actually shipped, per-tool:

- **Split** now ships the ZIP download its doc always described — `jszip` was a fresh
  dependency decision when this doc was written, but `PdfToZip` already added it (with
  direct user go-ahead) by the time this pass ran, so there was no reason left not to.
  "Download All" now zips every part with `jszip` instead of staggered individual
  downloads; per-part downloads stay available too. Regression-tested in
  `web/e2e/split.spec.ts`. The doc's "500-page split" edge case was also corrected to
  describe what's actually built (one RPC call returns every part at once, not a
  batched/streamed transfer) rather than the streaming design that was never implemented.
- **Rotate** and **Extract Pages** keep their typed-selection-only UI, doc updated rather
  than UI built. Both docs previously said the thumbnail picker "needs the render worker,
  built but not yet wired into any tool" — stale, since the render worker is now wired
  into several tools. The actual reason to leave these two alone: `OrganizePages` already
  ships a thumbnail-grid page picker with per-page rotate, duplicate, and delete, so a
  second thumbnail UI on either of these routes would duplicate that surface for little
  gain — typed selection is faster for the "I know the page numbers" search intent these
  two routes specifically target (see each doc's Purpose section on why they're separate
  routes from Split in the first place).
- **Merge**, **Encrypt**, **Remove Password** already matched reality; only Encrypt's
  code sample needed a fix (`Permissions` shown as `int16`, the very type this doc's own
  Status section says was the bug — corrected to `int32`).

**Playwright end-to-end tests now exist and cover every tool** (`web/e2e/`,
`npm run test:e2e`) — real Chromium against a real Vite dev server and the already-built
`engine.wasm` (plus a real `signaling/` server for `p2p-share.spec.ts`), covering UI
interactions no other test layer reaches: file-picker uploads, staged-list reorder,
option forms, and the download flow. The very first run caught two real, previously-
shipped bugs in Encrypt — see "Things that will bite you" items 9 and 10 — which is the
whole argument for having this layer at all: 57 native Go tests and a clean TypeScript
build both missed them because neither exercises the JSON-over-the-bridge parameter path
the real UI actually uses. 24 tests across 13 spec files: every Go-engine tool (`merge`,
`split`, `extract-pages`, `rotate`, `compress`, `images-to-pdf`, and a two-tool `encrypt`
→ `remove-password` round trip with a wrong-password path), every render-worker tool
(`pdf-to-image`, `extract-text` — scanned-detection against `sample-a.pdf` plus a real-
text fixture, `pdf-to-zip` — multi-page ZIP and the single-page shortcut), the one Hybrid
tool (`organize-pages` — rotate/duplicate/undo/redo/apply via button clicks; drag-reorder
itself isn't exercised, per the spec's own header comment), `p2p-share` (two real browser
contexts against one signaling server, unencrypted transfer plus the wrong-password
path), and site-wide navigation. Not covered: drag-and-drop interactions specifically
(`organize-pages`' reorder, `FilePicker`'s drag zone) — dispatching real HTML5 DragEvents
from Playwright has the same reliability problems the Chrome-extension manual
verification of `organize-pages` hit; worth a dedicated pass if it turns out to matter.

**A Vercel Web Interface Guidelines pass ran across every tool page and the shared
UI shell** (`web/src/components/`, `web/src/lib/device.ts`, `web/index.html`), against
the rule set at `vercel-labs/web-interface-guidelines`. Most categories already passed
— semantic `<button>`/`<label>` throughout (no `<div onClick>` anywhere), icon-only
buttons already carry `aria-label`, `:focus-visible` replaces rather than removes the
outline, hover states exist on every interactive element, no first-person copy, no
spelled-out numbers, `color-scheme: light dark` already set. Fixed:

- **Forms.** Every `type="password"` input (11, across 10 tools) now sets
  `autoComplete="off"` — PDF/file passwords aren't account credentials, and letting a
  browser's password manager offer to save or autofill them is actively wrong for a
  one-off document password. P2P Share's room-code field gained `autoComplete="off"` +
  `spellCheck={false}` (it's a code, not prose).
- **Typography.** `formatBytes` (`lib/device.ts`) and the low-memory warning message now
  join the number and unit with U+00A0 (non-breaking space) instead of a plain space —
  `1024` → `"1.0 KB"` where that space can never become a line break, so a size like
  "1.9 KB" can't wrap mid-value in a narrow layout. This is the single most reused
  string in the app — every tool's staged-file list and result summary goes through it.
- **Dark mode.** `index.html` gained two `<meta name="theme-color">` tags matching
  `styles.css`'s `--bg` for each `prefers-color-scheme`, so browser chrome (mobile
  status bar, pull-to-refresh background) doesn't mismatch the page.
- **Content & Copy.** Multi-word button labels moved from sentence case to Title Case
  (Chicago style, per the rule): "Download all" → "Download All", "Send a file" →
  "Send a File", "Receive a file" → "Receive a File", "Create room" → "Create Room",
  "Remove password" → "Remove Password", "Copy all" → "Copy All", "Send/Receive
  another" → "Send/Receive Another", "Start over" → "Start Over". Single-word labels
  (Merge, Split, Download, Cancel, …) were already correct. Safe because every e2e
  `getByRole('button', { name: /.../i })` selector is case-insensitive by construction
  — none needed updating.

Deliberately **not** changed, with reasoning: `transition: border-color/background-
color/color` on hover (guideline prefers `transform`/`opacity`-only) — these are cheap,
repaint-only properties, not the layout-triggering kind the rule is actually guarding
against, and switching hover feedback to opacity-only would be a real visual regression
for no performance gain. Progress-line captions like `"{stage} {done}/{total}"` don't end
in `…` — appending it after a numeral ("reading 3/5…") reads worse than the rule intends
to prevent. Example-format placeholders ("1-3, 5", "XXXXXX") don't end in `…` either —
that pattern is for prompt-style placeholders like "Search…", not literal format
examples shown as ghost text. Deep-linking tool-internal state (radio choices, staged
files) to the URL wasn't done — files aren't serializable to a URL and every tool's state
is meaningless to reload into anyway; `organize-pages` already warns before an
accidental reload via `beforeunload`, which is the actual risk the deep-linking rule
guards against. `OrganizePages`' un-virtualized thumbnail grid is a pre-existing,
already-documented V1 cut (own file header), not a silent violation to "fix" under this
pass.

Verified: gofmt/vet/go test clean for engine (no Go touched), web typecheck + build
clean, full 25-test Playwright suite green, and a live browser check (byte-size strings
render correctly with the embedded non-breaking space, theme-color meta tags present,
zero console errors on Merge/P2P Share/Encrypt).

**A visual redesign pass ran next** (`redesign-existing-projects` skill), plan at
`/Users/kcn/.claude/plans/cuddly-sleeping-tiger.md` — user-approved before any code
changed. The app already had a deliberate Swiss-minimal design system (`styles.css`'s
own header comment), so most of the skill's generic-SaaS-site checklist didn't apply
(no hero/pricing/testimonials to fix, the persistent left nav is correct information
architecture for a 15-tool catalog, not a cliché). What did apply and got fixed:

- **Typography**: bundled `@fontsource/geist-sans` + `@fontsource/geist-mono`
  (latin-only weight files specifically — the un-scoped per-weight CSS pulls in
  cyrillic/greek/vietnamese `@font-face` blocks this all-English app never needs;
  switching cut the font CSS from 47.6 KB to 6.8 KB). Self-hosted via `main.tsx`
  imports, no runtime CDN fetch. `text-wrap: balance` on headings,
  `font-variant-numeric: tabular-nums` on `.muted` (covers the recurring `N/M`
  progress fractions), weight 500 introduced for nav links.
- **Interactive states**: `:active` press feedback (`translateY(1px)`, transform-only)
  on buttons, `.file-picker`, and `ul.cards a`. Transition durations 150ms → 180ms.
- **Home page**: `ul.cards` went from an implicit single column to
  `repeat(auto-fill, minmax(15rem, 1fr))` — the ~13 tools now read as a catalog grid
  on wide viewports, one column on narrow ones, no separate media query.
- **Icons**: the reorder/remove/duplicate/rotate buttons (`Merge`, `ImagesToPdf`,
  `Compress`, `P2PShare`, `OrganizePages`) used raw Unicode glyphs (↑ ↓ ✕ ⧉ ↻), which
  render with different shapes/weights per OS. Replaced with a new
  `web/src/components/icons.tsx` — five small inline SVGs matching `FilePicker`'s
  existing icon style, `aria-hidden`, existing `aria-label`s untouched.
- **Favicon** (`web/public/favicon.svg`, a minimal document mark in the accent green)
  and a `<meta name="description">` — neither existed before.
- **Skip-to-content link** — new for a nav-heavy site. Not a plain `href="#main-
content"`: this app's hash _is_ the router (`lib/router.ts`), so a real hash
  navigation to `#main-content` would make the router look for a tool by that name
  and show "Not found" instead of just moving focus. The link's `onClick` calls
  `preventDefault()` and focuses `<main>` (`tabIndex={-1}`) directly instead.
  Regression-tested in `e2e/home.spec.ts`.

**Two real, pre-existing button-hierarchy bugs surfaced during live verification**
(not in the original plan — found by actually looking at the running app, not just
reading the CSS):

1. `OrganizePages`' Undo/Redo/Reset row and its separate Apply row are two different
   `.actions` groups on the same page; the shared `.actions button:first-child` accent
   rule made _both_ Undo and Apply solid green, contradicting the CSS's own comment
   ("exactly one accent target to look for"). Fixed with a `.actions--plain` escape
   hatch, applied only to the Undo/Redo/Reset row.
2. `.result button` (no `:first-child` scoping) accented _every_ button inside a
   `.result` box, not just the primary one. Invisible for single-button results, but
   Compress/Split/PdfToImage's multi-file results nest a Download button per row
   inside `ol.files li .controls`, several DOM levels deep — with 2 files staged, that
   rendered three stacked solid-green buttons (two per-row Downloads plus "Download
   All") with no hierarchy at all. Fixed by scoping to `.result > button` (or
   `.result > .actions button:first-child` for the few results — `ExtractText`'s Copy
   All/Download .txt — where the buttons sit inside a nested `.actions` div rather
   than being direct children).

Verified: same 26-test Playwright suite green (one new skip-link test added; icon
swaps changed only decorative glyph children inside already-tested
`aria-label`led buttons, so no existing selector needed updating), web typecheck +
build clean (font assets bundle to ~150 KB of woff2, lazily fetched per `@font-face`
only for glyphs actually rendered), gofmt/vet/go test clean for engine (no Go
touched), and an extensive live browser pass across Home, Merge, OrganizePages, and
Compress (multi-file) confirming the new icons/grid/fonts/button-hierarchy fixes all
render correctly with zero console errors.

**Phase 4 has started.** `docs/TOOL_CATALOG.md`'s Phase 4 bucket (29 tools: watermark,
page numbers, crop/resize, flatten, redact, invert colours, repair, privacy scanner, form
fill, sign, edit text, compare, fingerprint, plus the whole office-format-conversion
block) is otherwise untouched. **Add Watermark** (`web/src/tools/AddWatermark`,
`engine/internal/ops/watermark.go`) is the first tool built against it — text watermark,
`api.TextWatermark` + `api.AddWatermarks`, both fully in-memory, same shape as every other
Go op. `docs/tools/add-watermark.md` records the design, including the two deliberate V1
cuts (image/PDF watermarks, page-number/date tokens) and why an explicit `rotation:0` is
sent rather than falling back to pdfcpu's own diagonal-by-default placement. Added a new
`Annotate` category to `registry.ts`'s category union (append-only, per
`docs/PARALLEL.md`'s rule) rather than overloading `Organize`, since this tool doesn't
touch page order/structure the way the rest of that category does.

Building it surfaced one real gap in pdfcpu's own behaviour, not a bug in our code: unlike
`ExtractPages`, `api.AddWatermarks` silently no-ops when a selection resolves to zero
pages instead of erroring — a user who typed an out-of-range page and got their file back
unmodified would have no idea why. `AddWatermark` adds its own pre-check (page-count +
`api.PagesForPageSelection`) to turn that into an honest `ERR_UNSUPPORTED`, matching
`extract-pages.md`'s edge-case table. Covered by
`TestAddWatermarkRejectsSelectionResolvingToZeroPages`.

No plan doc was written for this ahead of time — `docs/tools/add-watermark.md` doubles as
both the design record and the implementation log, since the design was simple enough
(one pdfcpu API, no new architecture) not to need a separate `docs/plans/` file first.
Future Phase 4 tools that need real design decisions (redact, edit-pdf-text, sign) should
get one; watermark, page-numbers, and crop/resize are all thin wrappers over existing
pdfcpu APIs in the same shape as this one.

Verified: `gofmt`/`vet`/`go test` clean (80 Go tests, 9 new for this op), `tsc --noEmit`
clean, production build clean, wasm rebuilt (19.31 MB raw / 4.58 MB gzip / 3.24 MB
Brotli — adding one more op cost the same ~0.15–0.2 MB per op this doc's "Measured, not
estimated" section already noted), and 2 new Playwright e2e tests green (31 total).

**Remove Watermark followed immediately, from a direct user request rather than the
catalog.** `web/src/tools/RemoveWatermark`, `docs/tools/remove-watermark.md`, and three
new ops in the same `engine/internal/ops/watermark.go` file: `RemoveWatermark`
(`api.RemoveWatermarks`) and `HasWatermarks` (`api.HasWatermarks`, a cheap pre-flight
check, same role `isEncrypted`/`pageCount` play elsewhere). Added to
`docs/TOOL_CATALOG.md`'s Phase 4 table too, with a note on why it wasn't there originally
(not in ihatepdf's own catalog — the reverse-engineering pass that produced most of that
document never had a reason to find it).

The user specifically asked whether page-range variants — a subset of pages, `even`,
`odd` — were possible. They already were, for free: `Selection` on every page-selection
op here (`Rotate`, `ExtractPages`, `AddWatermark`, now `RemoveWatermark`) is a `[]string`
of pdfcpu's own raw tokens, and pdfcpu's token handler
(`handlePageSelectionToken`) recognises `even`/`odd` as special cases before falling
through to range parsing. Typing `even` into the exact same comma-separated text field
every other selection-based tool already has works with zero new code — proven by
`TestRemoveWatermarkAcceptsEvenOddTokensWithNoSpecialHandling`, not just asserted in the
doc.

Building removal surfaced a real, asymmetric gap in pdfcpu's own behaviour that a plain
read of its API would not predict: `AddWatermarks` silently no-ops on a selection
resolving to zero pages (needing `AddWatermark`'s own pre-check to turn into an honest
error), while `RemoveWatermarks` does the **opposite** — it ERRORS ("no watermarks
found") when there's simply nothing to remove, which is not a failure at all by this
tool's own stated behaviour ("no watermark detected" must be a harmless no-op, not a dead
end). First implementation surfaced this as a raw `ERR_INTERNAL` in the browser — caught
immediately by `web/e2e/add-remove-watermark.spec.ts`'s no-watermark test, not by any Go
test written before the UI was actually exercised, which is exactly the class of bug this
project's e2e layer exists to catch (see "Things that will bite you" for other examples
of native tests missing a real bridge-layer failure). Fixed by having `RemoveWatermark`
catch that specific pdfcpu message and hand back the original bytes unchanged —
regression-tested by `TestRemoveWatermarkOnPlainFileIsANoOp`.

Also gave `RemoveWatermark` a UX choice deliberately different from its closest
precedent: `RemovePassword` disables its button when the file isn't encrypted ("nothing
to remove"), but `RemoveWatermark` does NOT disable its button when no watermark is
detected — running it is a genuine, harmless no-op, and disabling the button would
contradict the doc's own promise that this is a safe thing to try rather than a blocked
path.

Verified: `gofmt`/`vet`/`go test` clean (88 Go tests, 8 new for removal), `tsc --noEmit`
clean, production build clean, wasm rebuilt (19.37 MB raw / 4.59 MB gzip / 3.23 MB
Brotli), and 4 new Playwright e2e tests green (33 total, 15 spec files) — including the
full add→download→re-upload→remove round trip and the no-watermark no-op path.

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
