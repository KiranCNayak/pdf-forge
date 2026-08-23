# pdf-forge — High-Level Design

> Status: design, pre-implementation. Measured figures in this document come from a
> feasibility probe run 2026-08-23 (pdfcpu v0.15.0, Go 1.25). Figures marked
> *(estimate)* are not yet measured.

---

## 1. What we are building

A browser-based PDF toolkit where every byte of the user's document is processed on
their own machine. No upload, no account, no watermark, works offline after first load.

The differentiator against the existing field (iLovePDF, Smallpdf, Sejda, PDF24,
ihatepdf) is the engine: a **single Go core compiled to WebAssembly**, rather than a
collection of JavaScript libraries glued together. That one core also compiles to a
native CLI, which gives us a self-hostable binary and a free performance baseline.

## 2. Why Go → WebAssembly

Two claims are commonly made about Wasm that are **not** the reason we chose it, and we
should be precise so the design doesn't inherit muddled thinking:

- *"Wasm makes it decentralised / more secure."* It does not. The privacy property comes
  from **processing client-side**. A pure-JavaScript tool that never uploads is exactly
  as private. Wasm is an implementation detail of *how* the client-side work gets done.
- *"Wasm is inherently faster."* Only sometimes. Wasm wins on tight numeric/binary work;
  it loses on anything that crosses the JS boundary frequently.

The actual reasons:

1. **Access to a mature PDF codebase.** [pdfcpu](https://pdfcpu.io/) is a complete,
   actively maintained PDF library — validation, xref repair, object-stream handling,
   AES-256 encryption, page tree surgery. Reimplementing that in JS is years of work;
   `pdf-lib` (what everyone else uses) notably cannot compress, cannot repair, and has
   thin encryption support.
2. **One engine, three deployment targets.** The same `internal/ops` package serves the
   browser (Wasm), a self-hosted CLI/server binary, and the benchmark harness. This
   mirrors the dual-mode SaaS/self-hosted shape we already like.
3. **Predictable performance on structural work.** Merging, splitting and rewriting the
   xref are object-graph operations where a compiled language with real structs beats
   JS object churn.

### Measured feasibility (2026-08-24)

| Metric | Result |
| --- | --- |
| pdfcpu v0.15.0 under `GOOS=js GOARCH=wasm` | Compiles clean, no patches, no shims |
| Wasm binary, 8 ops linked (merge, split, rotate, extract, encrypt, decrypt, pageCount, isEncrypted) | 17.73 MB raw |
| gzip -9 | 4.24 MB |
| brotli -q11 | **3.00 MB** |
| Filesystem emulation (memfs) required? | **No** — see §4 |

> An earlier probe reported 6.3 MB raw. That number was wrong: the probe referenced its
> functions as `_ = fn`, which does not defeat the linker's dead-code elimination, so
> pdfcpu was never actually linked. Anything measured this way needs a real call path.

**The honest comparison.** ihatepdf's Ghostscript build — which it lazily loads on the
compress route alone — is **14.0 MB raw / 10.4 MB Brotli**. Our engine is roughly **3.5×
smaller than their single-purpose compressor**, while covering eight operations and the
compress pipeline to come.

Against their *other* tools we are heavier: pdf.js (308 KB Brotli across main + worker)
and pdf-lib do the page ops in a fraction of the bytes. So the trade is real and worth
stating plainly: **we pay more on the cheap tools and far less on the expensive one.**
Since the engine is lazy-loaded on first tool use and cached immutably thereafter, the
cost is paid once per version rather than per tool.

The "Go Wasm binaries are too fat" objection survives in weakened form — 3 MB is not
nothing — but it is not disqualifying next to what the incumbents actually ship.

TinyGo is not an option — pdfcpu depends on `reflect`, `encoding/json` and
`golang.org/x/text`. Standard toolchain + Brotli + immutable caching is the answer.

---

## 3. Prior art: what ihatepdf.cv actually does

We reverse-engineered the shipped bundles rather than trusting the marketing copy. This
matters because several of their public claims don't match their code, and we'd have
designed the wrong thing by believing them.

**Architecture:** Vite + React SPA, static-hosted, **zero backend**. ~56 routes, one
lazily-loaded chunk per tool. The only outbound traffic is Microsoft Clarity analytics
and a Razorpay donation link.

**Libraries, all loaded from CDN at runtime:** `pdf-lib@1.17.1`, `pdf.js@3.11.174`,
`jspdf`, `pdfmake`, `html2canvas`, `html2pdf`, `jszip`, `mammoth`, `xlsx`,
`tesseract.js@5`, `kokoro-js`, `lamejs`, `@xenova/transformers`, `downloadjs`.

**The only real WebAssembly is Ghostscript** — `/background-worker.js` does
`importScripts('./gs-worker.js')` and drives it with `-sDEVICE=pdfwrite` arguments, used
solely for compression. Everything else is plain JavaScript. So the premise "they used
Wasm to build these PDF tools" is true for exactly one tool out of 56.

**Two things they got genuinely right, which we copy:**

- Device-tier caps and a memory estimator that refuses work the device can't survive
  (50/75/150 MB file caps, 300/450/600 DPI caps, batch sizes 10/25/50).
- Canvas hygiene: 16,384 px clamp, `canvas.width = canvas.height = 0` to force GPU
  texture release, batching with deliberate GC pauses.

**One thing they got wrong, which we fix:** loading 14 libraries from
jsdelivr/cdnjs/unpkg at runtime tells three third parties every visitor's IP, User-Agent,
*and which tool they opened* — the last being the most sensitive signal on the site
("redact", "remove-password", "privacy-scanner"). It also makes the offline guarantee
contingent on service-worker cache state. **We bundle everything and load nothing at
runtime.** See the hard constraint in `CLAUDE.md`.

**Their P2P share has no signaling server at all**, despite the blog implying one. See
`docs/tools/p2p-share.md` for the full teardown and our replacement design.

---

## 4. The engine boundary

> **Go owns byte → byte structural transformation.**
> **JS owns rasterization, text-layout extraction, file I/O and UI.**
> **Pixels never round-trip through Go.**

This is the single most important rule in the codebase. Violating it is the most
expensive mistake available, because both sides *look* capable of the other's job.

| Work | Owner | Why |
| --- | --- | --- |
| Merge, split, rotate, reorder, delete, extract pages | **Go** | Page-tree surgery; pdfcpu does it without re-rendering |
| Encrypt, decrypt, permissions | **Go** | pdfcpu has native AES-256 (R6) |
| Compress | **Go** | Needs stream-level image replacement — impossible in pdf-lib |
| Images → PDF | **Go** | `api.ImportImages` takes `[]io.Reader` directly |
| PDF → JPG/PNG, thumbnails, previews | **JS (pdf.js)** | Go has no PDF rasterizer. Writing one is out of the question |
| Extract text | **JS (pdf.js)** | pdf.js's text-layer reconstruction is far better than pdfcpu's |
| PDF → ZIP | **JS** | Rasterize (JS) then zip (JS); Go adds nothing |
| File pick, download, storage, routing | **JS** | Browser APIs |

**Why no memfs.** Earlier public pdfcpu-in-Wasm experiments shim Node's `fs` because they
drive pdfcpu's *CLI*. We drive the *library*, and pdfcpu exposes
`io.ReadSeeker → io.Writer` forms of everything we need (`MergeRaw`, `Rotate`, `Trim`,
`Collect`, `Optimize`, `Encrypt`, `Decrypt`, `ImportImages`, `ExtractImagesRaw`,
`UpdateImages`, `ExtractPage`). Nothing touches a filesystem. This removes an entire
layer of complexity and a class of bugs.

The one exception is `api.Split`, which insists on an output directory. We don't use it —
`ExtractPage(ctx, pageNr)` and `Trim` cover splitting in memory.

---

## 5. System shape

```
pdf-forge/
├── engine/                     # Go module → Wasm + native CLI
│   ├── cmd/wasm/main.go        # syscall/js entrypoint; registers ops, then blocks
│   ├── cmd/cli/main.go         # identical ops, native — self-host + benchmark baseline
│   ├── internal/ops/           # merge, split, rotate, organize, compress, encrypt, …
│   ├── internal/bridge/        # ArrayBuffer↔[]byte, promises, progress, error codes
│   └── internal/imaging/       # downsample + JPEG re-encode for compress
│
├── signaling/                  # Go WebSocket server for P2P (SDP relay only)
│   ├── cmd/server/main.go
│   ├── internal/room/
│   ├── Dockerfile
│   └── fly.toml
│
├── web/                        # Vite + React + TypeScript
│   ├── src/engine/             # EngineClient: worker lifecycle, RPC, transferables
│   ├── src/workers/
│   │   ├── engine.worker.ts    # hosts the Go Wasm instance
│   │   └── render.worker.ts    # hosts pdf.js rasterization
│   ├── src/tools/<Tool>/       # one lazily-routed component per tool
│   ├── src/lib/                # device tiers, memory estimator, storage, download
│   └── public/wasm/            # build output: engine.<hash>.wasm + wasm_exec.js
│
├── scripts/build-wasm.sh
└── docs/                       # this directory
```

Three processes at runtime, and they are deliberately separate:

- **Main thread** — React, routing, file pick, download. Never touches Wasm.
- **Engine worker** — one instance, hosts the Go Wasm module, handles structural ops.
  Terminated and respawned after large jobs (see §6).
- **Render worker(s)** — small pool, hosts pdf.js, produces canvases and text.

---

## 6. Memory model

This is where Go→Wasm differs most sharply from the JS-library approach, and it is not a
detail we can discover later.

**`WebAssembly.Memory` grows and never shrinks.** Once a 150 MB PDF has inflated the Go
heap, that memory belongs to the worker for the lifetime of the tab. JS libraries don't
have this problem — their garbage is collectible and the heap is returned. Ours is not.

Mitigations, in order of importance:

1. **Terminate and respawn the engine worker after any job above a size watermark.** A
   fresh `WebAssembly.instantiateStreaming` from the service-worker cache costs roughly
   100 ms *(estimate — measure in Phase 0)*, which is trivial compared with permanently
   leaking hundreds of megabytes.
2. **Keep the engine worker separate from the render workers.** Rasterization already has
   its own well-understood memory profile; don't entangle the two.
3. **Estimate before starting, and refuse or downgrade.** Port ihatepdf's device tiers and
   quadratic estimator, but **recalibrate the constants for Go** — pdfcpu builds a full
   in-memory object model, so expect roughly 2.5–3× file size *(estimate)* rather than
   their JS-tuned figures. Treat the shipped constants as placeholders until Phase 0
   measures the real multiplier.
4. **Preserve ihatepdf's canvas discipline verbatim on the JS side.** It is correct and
   hard-won.

Device tiers (starting values, inherited from ihatepdf, to be recalibrated):

| Tier | Max file | Max DPI | Pages/batch |
| --- | --- | --- | --- |
| Phone (`width < 768`) | 50 MB | 300 | 10 |
| Low-memory (`deviceMemory < 4`) | 100 MB | 450 | 30 |
| Desktop | 150 MB | 600 | 50 |

Note `navigator.deviceMemory` is unavailable in Safari — default to 4 GB and lean on the
mobile-width check.

---

## 7. Storage

Three tiers, same as ihatepdf, because their reasoning is sound:

| Tier | Holds | Lifetime | Notes |
| --- | --- | --- | --- |
| RAM | Active buffers, Go heap | Tab | Volatile, zero persistence |
| IndexedDB | Large file bytes for resume | Session, manual clear | Binary-native, gigabyte capacity. Use `idb-keyval`, don't hand-roll |
| localStorage | Filenames, sizes, timestamps | Until cleared | **Metadata only. Never file content.** 5–10 MB cap and string storage make it unfit for bytes |

All origin-isolated. Clearing browser data destroys everything with no recovery — that is
the honest trade for having no server, and the UI should say so rather than imply undo
exists.

---

## 8. Offline

Service worker, cache-first, precaching the app shell, `engine.<hash>.wasm`,
`wasm_exec.js` and pdf.js **as local bundled assets**. Because we never fetch from a CDN,
"works offline" is a structural guarantee rather than a hope about cache warmth.

Hashed asset filenames + `Cache-Control: immutable` mean the 1.32 MB Brotli'd engine is
downloaded once per version, ever.

The Wasm module is lazy-loaded on first tool use, never on the landing page.

---

## 9. Deployment

| Component | Target | Rationale |
| --- | --- | --- |
| Static SPA | **Cloudflare Pages** | Unlimited free bandwidth, Brotli by default, immutable asset caching. Bandwidth is the dominant cost when every cold visitor pulls a multi-MB engine; Vercel's 100 GB/month free tier is roughly 33k cold visits |
| Signaling server | **Fly.io**, 256 MB machine | Keeps the backend in Go. The workload — hold ~2 KB of SDP for ~10 s per transfer — is trivial for one small machine |

If scaled to zero, Fly cold-starts in 1–3 s on first room creation. Either keep one
machine warm (~$2/mo) or accept it.

The signaling protocol is specified transport-agnostically (§ `docs/tools/p2p-share.md`),
so porting to a Cloudflare Worker + Durable Object is an afternoon's work if Fly ever
becomes inconvenient.

---

## 10. Roadmap

| Phase | Contents |
| --- | --- |
| **0** | Bridge spike: Go module + pdfcpu, `merge` over `syscall/js`, worker harness. Measures real Wasm size, throughput vs pdf-lib, and the Go heap multiplier — replacing this document's estimates with numbers |
| **1** | Core page ops (merge, split, rotate, organize, extract pages) + security (encrypt, remove password) |
| **2** | Compress (Go) + render/convert (PDF→JPG, images→PDF, extract text, PDF→ZIP) |
| **3** | P2P share + Go signaling server |
| **4** | Office format conversion (~15 tools) |
| **5** | Benchmark harness (`docs/BENCHMARKING.md`) |

Phases 1–2 constitute V1. Out of scope entirely: AI tools, local-ML tools (OCR/TTS), and
India-specific business tools — see `docs/TOOL_CATALOG.md` §Deferred for the reasoning.

---

## 11. Phase 0 results (2026-08-24)

The bridge spike is **done**. Eight operations run end-to-end in a browser worker.

| Measurement | Result |
| --- | --- |
| Cold boot + merge (fetch, instantiate, register ops, merge 3+2 pages) | **~199 ms** |
| Warm merge, same input | **~12.4 ms** |
| Wasm binary | 17.73 MB raw / 3.00 MB Brotli |
| Filesystem emulation needed | None |
| External network requests during operation | **Zero** — verified in DevTools |

Cold boot under 200 ms means the lazy-load-on-first-tool-use strategy works without a
perceptible stall, and it makes worker respawn (§6) cheap enough to use freely rather
than hoard.

Three findings the spike produced that no amount of design could have:

1. **pdfcpu crashes immediately under `GOOS=js`** — `NewDefaultConfiguration` tries to
   create a config directory (`mkdir /tmp: not implemented on js`) before touching any
   PDF. Fixed by `model.ConfigPath = "disable"` in an init guarded by the js build tag.
   Invisible to every native test.
2. **pdfcpu v0.15.0 can encrypt a file it cannot then decrypt.** Passwords containing a
   space are accepted on encrypt and rejected forever on decrypt. We now refuse them up
   front. Details in `docs/tools/encrypt.md`.
3. **"Needs a password" and "wrong password" were indistinguishable** — pdfcpu emits the
   same message for both, and only the caller knows which happened. They drive different
   UI, so ops now disambiguate.

## 12. Open questions

1. **Real Go heap multiplier** for pdfcpu on large files — drives every device-tier
   constant. Still unmeasured: the spike used 2 KB fixtures. Needs a 100 MB+ document.
2. **Worker respawn threshold** — the 64 MB placeholder in `EngineClient` is still a
   guess, and depends on (1).
3. **Font subsetting.** Ghostscript trims embedded fonts to used glyphs (up to 90% off a
   font); pdfcpu does not. Text-heavy PDFs will compress worse than ihatepdf until we
   build it. See `docs/tools/compress.md`.
4. **Whether `PostProcessValidate` is affordable** in the browser, or whether validation
   cost outweighs its safety benefit on large documents.
