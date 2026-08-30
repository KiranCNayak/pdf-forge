# Current state

Updated 2026-08-30. **Read this first** — it says what exists, what is proven, and what
the next task is. `docs/HLD.md` and `docs/LLD.md` say how it is meant to work; this file
says how far it actually got.

**tl;dr for a fresh agent, so you don't have to read the whole "Next task" history below
to find the current edge:** Phases 1–3 (all 12 V1 tools + P2P Share, including its
`BroadcastChannel` shortcut and manual-paste fallback) are done and shipped. Phase 4 has
started — every tool that was a thin UI layer over an existing pdfcpu API is now shipped
(Add/Remove Watermark, Page Numbers, Headers & Footers, Crop & Resize), and so is
**Redact** (`web/src/tools/Redact`, `docs/tools/redact.md`) — the first Phase 4 tool
needing real design work, built as full-page rasterization rather than the catalog's
originally-specced content-stream text removal (pdfcpu has no primitives for that; see
`docs/tools/redact.md`'s "A deliberate deviation" section and `## Next task`'s Redact
entry for the full reasoning). **A red-team review of Redact has now run** (separate
agent, Opus model, tasked with trying to break the redaction guarantee) and found two
real bugs, both fixed — one of them the exact "reports success but the file doesn't
actually reflect what's on screen" failure mode this tool exists to prevent. See `##
Next task`'s Redact entries for the detail; Redact is considered closed out. Nothing is
in flight — the next Phase 4 tool has not been chosen. The 23 remaining Phase 4 tools
(`docs/TOOL_CATALOG.md`'s Phase 4 section) all need real design work rather than a UI
layer over a one-call API — Flatten, Fill Form, Sign, Edit PDF Text, Invert Colours,
Repair, Compare, Privacy Scanner, Fingerprint, and the whole office-format-conversion
block. Ask the user which one before starting; don't assume the order in the catalog is a
priority order, it isn't.

---

## What works today

Phase 0 is complete. The engine runs end-to-end in a browser.

| Layer                                                              | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/internal/ops`                                              | 16 ops: merge, split, extractPages, rotate, encrypt, decrypt, pageCount, isEncrypted, compress, organize, imagesToPDF (Phase 2: JPEG/PNG/TIFF/WebP → one PDF via `api.ImportImages`; "fit" page size is free — pdfcpu sizes the page to the image's own pixel dimensions whenever `Pos` is left at its default `Full`, no per-image dimension decoding needed), **addWatermark**/**removeWatermark**/**hasWatermarks** (Phase 4, first ops outside the original V1 catalog: `api.TextWatermark` + `api.AddWatermarks`/`api.RemoveWatermarks`/`api.HasWatermarks`, all fully in-memory. `addWatermark` has its own pre-check for a selection resolving to zero pages — pdfcpu's own `AddWatermarks` silently no-ops on that rather than erroring. `removeWatermark` has the opposite problem and the opposite fix: pdfcpu's own `RemoveWatermarks` ERRORS ("no watermarks found") when there's nothing to remove rather than no-oping, so `RemoveWatermark` catches exactly that message and hands back the original bytes unchanged — added directly from a user request after Add Watermark shipped, not from the original reverse-engineering pass), **crop**/**resize** (`api.Crop`/`api.Resize`, both fully in-memory — crop sets `/CropBox` via a margin definition and leaves content alone, resize actually reflows `/MediaBox` and content by a scale factor or a named/explicit page size. `Crop` has its own pre-check for margins summing past a page's own media box — confirmed directly against pdfcpu v0.15.0 that `api.Crop` otherwise silently writes a negative-area crop box with no error at all. Also had to set `model.Resize.PageSize`, not just `PageDim`, for an explicit `"A4L"` landscape request to survive — `EnforceOrientation()` keys off a suffix on that string field specifically, not on `PageDim`'s own width/height)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
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
| `web/src/tools/PageNumbers`                                        | Pure UI layer over `addWatermark` — **zero new engine code**. pdfcpu substitutes `%p{offset}`/`%P` tokens per page INSIDE `AddWatermarks` itself, so a text string like `"Page %p0 of %P"` already produces the right number on every page with the op that already existed. `TestAddWatermarkSupportsPageNumberTokens` regression-tests this specifically. Format preset, "start numbering at" field, 6-point position preset, same style controls and selection field as `AddWatermark`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `web/src/tools/HeadersFooters`                                     | Same reasoning as `PageNumbers`, but a header and a footer are two independent placements and `AddWatermarks` only places one per call — this tool makes up to two sequential `engine.addWatermark` calls, chaining the first call's output bytes into the second's input (skips a call entirely for an empty field, never watermarks an empty string). Watermarking preserves an input's existing encryption (verified directly), which is what lets both calls reuse the same password with no second prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `web/src/tools/CropResize`                                         | One route, two engine calls behind a mode toggle — Crop trims the visible area (`engine.crop`, sets `/CropBox`, leaves content alone), Resize scales the whole page (`engine.resize`, scale factor / named page size incl. landscape / exact point dimensions). Same style controls and selection field (including `even`/`odd`) as every other page op here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `web/src/tools/Redact`                                             | Phase 4's first tool needing real design, and a deliberate deviation from `docs/TOOL_CATALOG.md`'s own spec (see `docs/tools/redact.md`'s "A deliberate deviation" section) — full-page rasterization, not surgical content-stream text removal, since pdfcpu has no primitives for the latter. Interactive canvas box editor over the render worker's per-page preview (fractional `[0,1]` box coordinates, resolution-independent of preview vs. output DPI); Apply re-renders every page, composites boxes onto the decoded pixels, and rebuilds the whole document via a new `pageSize: "exact"` mode on the `imagesToPDF` Go op (points computed from the render worker's own `effectiveDpi`, not `"fit"`'s pixel-dimensions-as-points behaviour). Caught a real bug during e2e test-writing: `onPointerUp` called `setBoxesByPage` as a side effect inside `setDraft`'s functional updater, which React StrictMode double-invokes in dev specifically to catch this — boxes were committing twice per drag. `web/e2e/redact.spec.ts` reads the raw output PDF bytes directly to confirm a known secret string is absent anywhere in the file (not just visually covered), against a real fixture with two vector-text stamps (`web/e2e/fixtures/redact-secret.pdf`, `cmd/genfixtures -redact`, content confirmed via `qpdf --qdf`) — plus a pixel-sampling check via the app's own PdfToImage tool that the box is black and untouched page area isn't. A later adversarial-review pass (Opus model, tasked with trying to break the redaction guarantee) found and fixed two more real bugs — the box editor staying live during an in-flight run, and an encrypted-PDF password-prompt regression shared by every render-worker tool — plus added 7 more Playwright tests (`web/e2e/redact-adversarial.spec.ts`) covering rotation, multi-page box-to-page mapping, the mixed-page-size fallback branch, and cancel — see this file's own `## Next task` entry and `docs/tools/redact.md`'s "Adversarial review" section for the detail                                                                                                                                                                                                                                                                                                                                                 |
| `web/src/tools/Fingerprint`                                        | Pure UI layer over `addWatermark` — zero new engine code, third tool in a row to reuse it for something other than a visible watermark (after Page Numbers, Headers & Footers). Four sequential chained calls place a faint, pale, small code in every page corner (not one placement, so a single cropped/covered corner doesn't erase every copy of the mark) — `{label}-{6 hex chars}` via `crypto.getRandomValues`, always unique even with a blank or duplicate label. Genuinely invisible/steganographic marking was out of scope; `docs/tools/fingerprint.md` says so rather than overclaiming. `web/e2e/fingerprint.spec.ts` proves the code survives as real, extractable text by feeding the output through the app's own ExtractText tool — a second, independent code path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `web/src/tools/Sign`                                               | New `AddImageWatermark` Go op (`api.ImageWatermarkForReader`, sharing the same "key:value" desc-string parser `AddWatermark`'s text call already uses) — the first tool to stamp an image rather than text, and the first Phase 4 tool that genuinely needed new engine code rather than reusing an existing op. Signature drawn on a fully-transparent-background canvas, exported as PNG (not JPEG — no alpha channel) so only ink strokes composite over page content; confirmed pdfcpu preserves a PNG's alpha as a real `/SMask` by extracting the embedded image back out of a real signed PDF and inspecting it directly, not assumed. Building this tool's own e2e verification surfaced a real bug in shared code — see "Things that will bite you" #12 and `docs/tools/sign.md` — a pdf.js Worker-compat crash (`document.createElement` inside its own internal image-scaling path) that could affect any render-worker tool given a small enough embedded image, not just this one. Fixed in `render.worker.ts` with a custom `OffscreenCanvasFactory`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `web/src/dev/smoke.ts`                                             | 16-check browser smoke test, including add/remove watermark (including the no-watermark no-op path) and compress (preset round trip + unreachable target reports `reachedTarget: false`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `web/e2e/`                                                         | Playwright end-to-end tests: real Chromium, real Vite dev server, real `engine.wasm` (plus a real `signaling/` server for `p2p-share.spec.ts` — `playwright.config.ts`'s second `webServer` entry) — the layer above the browser smoke test, covering UI wiring (file pickers, staged-list reorder, option forms, downloads) that no unit test touches. 16 specs across every tool: `merge`, `split`, `extract-pages`, `rotate`, `compress`, `images-to-pdf`, `pdf-to-image`, `extract-text` (scanned-detection plus a real-text fixture, `web/e2e/fixtures/text-page.pdf`), `pdf-to-zip` (multi-page ZIP + single-page shortcut), `organize-pages` (rotate/duplicate/undo/redo/apply via button clicks — drag-reorder isn't exercised, see the spec's own header), `p2p-share` (two real browser contexts against one signaling server, unencrypted + wrong-password paths), an `encrypt` → `remove-password` round trip across two tools, and site-wide navigation. Caught two real bugs on its very first run — see "Things that will bite you" below. `npm run test:e2e`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `signaling/`                                                       | WebSocket signaling server (Go module, `cmd/signaling`): room create/join/relay for SDP+ICE via `internal/hub`, per-IP rate limiting via `internal/wsserver`, Crockford-base32 room codes via `internal/roomcode`. 27 Go tests pass, gofmt clean, vet clean. Now consumed by `web/src/tools/P2PShare`. See `signaling/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

120 Go tests pass. TypeScript is clean. Production build works. 57 Playwright e2e tests
across 22 spec files pass (`web/e2e/`, `npm run test:e2e`) — every tool has at least one.
`__smoke()` now has 12
checks including compress, but has not actually been run in a browser since the compress
checks were added — the Chrome extension wasn't available in the environment that wrote
this. Run `await __smoke()` yourself before trusting the count.

## Measured, not estimated

|                              |                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Wasm binary                  | 19.52 MB raw / 4.62 MB gzip / **3.25 MB Brotli** (was 19.37/4.59/3.23 before crop/resize) |
| Cold boot + merge            | ~199 ms                                                                                   |
| Warm merge                   | ~12.4 ms                                                                                  |
| External requests at runtime | zero                                                                                      |

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
12. **pdf.js's own internal rendering code can call `document.createElement` even inside
    a Worker, where `document` doesn't exist.** Not this app's own render calls — those
    already build and pass in their own `OffscreenCanvas` explicitly — but pdf.js's image
    downscaling helper (`_scaleImage`) creates a _second_, temporary canvas of its own
    mid-render, via the default `DOMCanvasFactory`, for certain small images (an XObject
    image can still hit this, not only a literal inline one — pdf.js's own operator-list
    builder inlines small XObject images as an optimization). Silent and generic
    (`ERR_INTERNAL`) until Sign's own e2e test caught a real signed PDF failing to
    render — every render-worker tool (`PdfToImage`, `PdfToZip`, Redact,
    `OrganizePages`' thumbnails) was equally exposed to any real-world PDF with a small
    enough embedded image, not just this tool's own fixture. Fixed by passing a
    `CanvasFactory` option (an `OffscreenCanvas`-backed one, `render.worker.ts`'s own
    `OffscreenCanvasFactory`) into `getDocument()` — the exact extension point
    `pdfjs-dist` documents for non-DOM environments, the same one its own bundled
    `NodeCanvasFactory` uses for Node.js. See `docs/tools/sign.md`.

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

_This section is a chronological log, oldest first — the tl;dr at the top of this file
has the current state in one paragraph. Read on only for the detail on how each phase
got built._

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

**Page Numbers and Headers & Footers shipped next, and needed zero new engine code —
STATE.md's own earlier prediction ("thin wrappers over existing pdfcpu APIs") held
exactly.** Both are pure UI layers over the same `addWatermark` op `AddWatermark`/`Remove
Watermark` already use:

- **Page Numbers** (`web/src/tools/PageNumbers`) discovered that pdfcpu substitutes
  `%p{offset}`/`%P` tokens PER PAGE inside `AddWatermarks` itself
  (`pkg/pdfcpu/format.Text`, called once per page during rendering, not once up front) —
  so a text string like `"Page %p0 of %P"` already produces the right number on every
  page with the exact code `AddWatermark` already had. Confirmed with a throwaway test
  before committing to the design, then kept as a permanent regression test
  (`TestAddWatermarkSupportsPageNumberTokens`) so a future pdfcpu upgrade that changes the
  token format fails a Go test first, not silently in this tool's UI. The whole tool is a
  format-preset dropdown plus a "start numbering at" field that computes the right
  `%p{offset}`, and a call to `engine.addWatermark` — no new `EngineClient` method, no new
  wasm registration, no new Go file.
- **Headers & Footers** (`web/src/tools/HeadersFooters`) needed one more idea: a header
  and a footer are two independent placements, and `AddWatermarks` places exactly one per
  call. Rather than extend the engine op to accept two watermarks, this tool makes up to
  two sequential `engine.addWatermark` calls, chaining the first call's output bytes into
  the second call's input — the `/workflow` "chain ops in one pass" advantage
  `docs/TOOL_CATALOG.md` already called out, now actually exercised by a shipped tool
  rather than just claimed. Confirmed (via a throwaway test, not kept — the real coverage
  is `web/e2e/headers-footers.spec.ts` exercising the shipped behavior) that watermarking
  preserves an input's existing encryption, which is what lets both calls reuse one
  password with no second prompt. An empty header or footer field skips its call entirely
  rather than watermarking an empty string onto every page.

Verified: `gofmt`/`vet`/`go test` clean (89 Go tests, 1 new regression test — no other
Go changes), `tsc --noEmit` clean, production build clean, no wasm rebuild needed (zero
production Go code changed — the whole point of "pure UI layer"), and 4 new Playwright
e2e tests green (37 total, 17 spec files).

**Crop & Resize shipped next** (`web/src/tools/CropResize`, `engine/internal/ops/cropresize.go`,
`api.Crop`/`api.Resize`) — one route per `docs/TOOL_CATALOG.md`, one mode toggle between
two genuinely different operations: Crop sets `/CropBox` via a margin definition and
never touches page content; Resize actually reflows `/MediaBox` and content, by a scale
factor or a named/explicit page size.

Two real pdfcpu gotchas surfaced during a design-verification pass BEFORE writing the
final code (a throwaway scratch test first, kept only once it proved the design, deleted
otherwise — same discipline as Headers & Footers' encryption check):

- `api.Crop` accepts margins summing past a page's own media box and silently writes a
  **negative-area crop box with no error at all** — confirmed directly (a 60×80pt fixture
  with 100pt margins on every side produced a `(100, 100, -40, -20)` crop box, `err ==
nil`). `Crop` now reads page dimensions first and rejects any selected page where the
  requested margins would leave zero or negative width/height, checked per page rather
  than once globally since mixed page sizes are allowed elsewhere in this codebase.
- `model.Resize.EnforceOrientation()` — which decides whether an explicit landscape/
  portrait request overrides pdfcpu auto-matching the source page's orientation — checks
  for a trailing `L`/`P` suffix on `Resize.PageSize` specifically, not on `PageDim`'s own
  width/height. Setting only `PageDim` (the field that actually looked like "the
  dimensions") silently discarded `"A4L"`'s landscape intent back to portrait. Fixed by
  setting both fields; `TestResizeByPageSizeLandscape` regression-tests it.

Both ops reuse `requireSelectionResolvesToPages`, generalised out of `watermark.go` into
`ops.go` now that a third and fourth op need the identical zero-pages guard.

Verified: `gofmt`/`vet`/`go test` clean (108 Go tests, 19 new for crop/resize), `tsc
--noEmit` clean, production build clean, wasm rebuilt (19.52 MB raw / 4.62 MB gzip /
3.25 MB Brotli), and 4 new Playwright e2e tests green (41 total, 18 spec files).

**Every "thin wrapper over an existing pdfcpu API" tool from the easy-wins list is now
shipped**: Add/Remove Watermark, Page Numbers, Headers & Footers, Crop & Resize. What's
left in Phase 4 (24 tools) is genuinely harder — Flatten, Fill Form, Sign, Redact, Edit
PDF Text, Invert Colours, Repair, Compare, Privacy Scanner, Fingerprint, and the entire
office-format-conversion block — each needs real design work, not a UI layer over a
one-call pdfcpu API.

**Redact shipped next, by direct user request rather than working down the catalog in
order** (`web/src/tools/Redact`, `docs/tools/redact.md`) — the first Phase 4 tool that
needed real design work rather than a thin wrapper. It's also the first deliberate
deviation from `docs/TOOL_CATALOG.md`'s own spec for a tool: the catalog calls for
surgical content-stream text removal ("Engine: Go"), which pdfcpu has no primitives for
at all (no content-stream editor, no per-glyph bounding boxes, no image-region clipping)
— building that from scratch was judged too failure-prone to ship with confidence in one
pass, exactly the kind of half-correct redaction that's worse than an honest limitation.
Shipped instead: full-page rasterization (Hybrid, not Go) — every page, not just boxed
ones, is rendered in the worker, boxes are composited onto the decoded pixels, and the
whole document is rebuilt from images via a new `pageSize: "exact"` mode added to the
existing `imagesToPDF` op (`engine/internal/ops/imagestopdf.go`). This is strictly
stronger than the catalog's own requirement (nothing survives anywhere, not just the
boxed text) at a real, UI-stated cost: the whole document loses text search/selection,
not just the redacted area. `docs/tools/redact.md`'s "A deliberate deviation" section has
the full reasoning; `docs/TOOL_CATALOG.md`'s own Redact row was updated to match rather
than left stale.

The property that actually matters here — "the secret string cannot survive anywhere in
the output file" — isn't Go-testable, since Go in this pipeline never sees the original
vector PDF, only already-rasterized images handed to it by the browser. The real proof is
`web/e2e/redact.spec.ts`, against a real fixture with two known vector-text strings
(`web/e2e/fixtures/redact-secret.pdf`, generated by a new `-redact` flag on
`cmd/genfixtures`, content confirmed via `qpdf --qdf` rather than assumed from the
generator code): it reads the **raw output PDF bytes directly** and confirms the secret
string is absent anywhere in the file, then independently re-renders the output through
the app's own PdfToImage tool and samples pixels to confirm the box is black and
untouched page area isn't. Building this test caught a real bug before it shipped: boxes
were being committed twice per drag, because `onPointerUp` called `setBoxesByPage` as a
side effect _inside_ `setDraft`'s functional updater — React StrictMode double-invokes
updater functions in dev specifically to catch this class of impurity, and the e2e test's
box-count assertion caught it immediately. Fixed by reading `draft` directly in the plain
event handler instead of through the updater. A second, unrelated CSS bug surfaced during
the same test-writing pass: the redaction canvas had no `max-height`, only `max-width`, so
a portrait page at the preview DPI could overflow the viewport on an ordinary laptop
screen, not just in a Playwright viewport — fixed with `maxHeight: '70vh'`.

**Two hardening decisions were made proactively, before any adversarial review ran** —
closed as a "close to leaking isn't good enough" call rather than left for a red team to
surface: every drawn box is now filled outset by a few device pixels beyond its exact
fractional rectangle (a box boundary essentially never lands on an exact pixel line, and
`fillRect`'s anti-aliasing plus JPEG's 8×8 DCT blocks could otherwise spread a faint trace
of the true edge into an adjacent block — shared `fillBoxes` helper, used by both the live
preview and the final compositing so what's shown while dragging matches what ships), and
the default output format flipped from JPEG to PNG (lossless — the one tool in the app
where that differs from every other render-worker tool's JPEG default).

**The adversarial review then ran** (separate agent instance, Opus model, tasked
specifically with trying to break the redaction guarantee rather than a general code
review) and found two real bugs, both fixed, plus closed the one coverage gap the doc had
flagged:

1. **The box editor stayed live while a redaction run was in flight** — the exact
   "reports success but the shipped file doesn't reflect what's on screen" failure mode
   this tool exists to prevent, not a cosmetic bug. `apply()` freezes the box set as a JS
   closure at the moment Redact is clicked (now named explicitly as a snapshot rather than
   left implicit), but nothing stopped the user from drawing, deleting, or clearing boxes
   on the canvas _while a multi-page run was still running_ — the visible count/canvas
   updated immediately from a separate render, while the running `apply()` kept using its
   frozen closure. A user could watch a new box appear, see "Redacted" succeed, and
   download a file that never contained it. Fixed by disabling every box-editing control
   (canvas pointer handlers, "Redact Entire Page", "Clear This Page", "Clear All", each
   box's remove button) for the duration of a run.
2. **Encrypted PDFs silently broke the password prompt in every render-worker tool, not
   just Redact** — `render.worker.ts`'s error classifier used a bare `if (e?.code)` check
   to detect this codebase's own throws before falling through to pdf.js's
   `PasswordException` handling, but pdf.js's own exception ALSO carries a `code` (a
   number, `PasswordResponses.NEED_PASSWORD`), so it matched first and every encrypted
   document was misclassified as a generic internal error — the password prompt never
   opened, for Redact, PdfToImage, PdfToZip, ExtractText, and OrganizePages alike. Fixed
   by checking the actual shape this codebase's own throws use (a string starting
   `"ERR_"`) instead of bare truthiness. Redact's own adversarial fixture just happened to
   be what surfaced a bug that had nothing to do with Redact specifically.
3. The mixed-page-size fallback branch (per-page `imagesToPDF` + `merge`) — previously
   flagged as having zero coverage — is now exercised directly by a fixture with two
   different physical page sizes (Letter + A5), confirming each output page keeps its own
   aspect ratio through the merge. No bug found; the gap was coverage, not correctness.

Specifically tried and did NOT find a bug: a `/Rotate 90` source page (box drawn against
the rotated preview correctly lands on the same content in the separately re-rendered
output), page→box mapping and order across a 5-page document with boxes on non-contiguous
pages, and cancelling a run never leaving a downloadable result behind.

`web/e2e/redact-adversarial.spec.ts` (7 tests) and four fixtures
(`web/e2e/fixtures/adv-{rot90,multi5,encrypted,mixed}.pdf`) are the permanent result,
generated by a new `-adversarial` flag folded into `cmd/genfixtures` — the review agent
first wrote these via its own separate, explicitly-"temporary" `cmd/advfixtures` binary,
merged into the permanent generator afterward once its fixtures became permanent,
depended-on infrastructure rather than scratch work. `docs/tools/redact.md`'s
"Adversarial review" section has the full detail per bug.

One operational note worth recording: the first attempt at this review used
`isolation: "worktree"` for the reviewing agent, which checks out a fresh git worktree
from committed history — but all of this Redact work was (and, as of this writing, still
is) uncommitted in the working directory, so that worktree contained none of it, and the
agent correctly reported finding nothing to review. Re-run directly against the working
directory (no isolation) to fix. Worth remembering for any future review/audit agent
launched against uncommitted work: worktree isolation is the wrong tool unless the work
under review is actually committed first.

Verified after the fixes: `gofmt`/`vet`/`go test` clean (111 Go tests, unchanged — no new
Go logic, only a fixture-generator refactor), `tsc --noEmit` clean, production build
clean, and the full Playwright suite green — 53 tests across 20 spec files (12 of them
Redact's own: 5 in `redact.spec.ts`, 7 in `redact-adversarial.spec.ts`).

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
