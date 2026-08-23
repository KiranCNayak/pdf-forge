# pdf-forge — Low-Level Design

> Companion to `docs/HLD.md`. This document holds the parts that are easy to get wrong
> and expensive to discover late. Everything here was checked against pdfcpu v0.15.0 and
> Go 1.25 unless marked *(estimate)*.

---

## 1. The Go ↔ JS bridge

### 1.1 Where the Wasm instance lives

Only inside `web/src/workers/engine.worker.ts`. The main thread never instantiates,
never calls, never holds a reference. Two reasons: a long op would otherwise freeze the
UI, and worker termination is our only reliable way to reclaim Wasm memory (§2).

### 1.2 Byte transfer

Go cannot read an `ArrayBuffer` directly. The only paths are:

```go
js.CopyBytesToGo(dst []byte, src js.Value) int   // src MUST be a Uint8Array, not ArrayBuffer
js.CopyBytesToJS(dst js.Value, src []byte) int
```

Each is a real memcpy. The full journey of a file:

```
File (main thread)
  → arrayBuffer()                          [1 copy, unavoidable, browser-side]
  → postMessage(buf, [buf])                [0 copies — transferable, buf is neutered]
  → new Uint8Array(buf)                    [0 copies — view]
  → js.CopyBytesToGo(goSlice, view)        [1 copy into the Go heap]
  → pdfcpu operates                        [pdfcpu builds its own object model on top]
  → js.CopyBytesToJS(outView, result)      [1 copy out]
  → postMessage(outBuf, [outBuf])          [0 copies]
```

Two copies of the file bytes plus pdfcpu's object model. Budget accordingly — §2.

Transferables are mandatory, not an optimisation. Structured-clone of a 150 MB buffer
costs a full copy *and* leaves the original alive on the main thread.

### 1.3 RPC envelope

Main thread → worker:

```ts
type Request = {
  id: string          // uuid, correlates the response
  op: string          // "merge" | "rotate" | "compress" | …
  params: unknown     // JSON-serialisable, op-specific
  buffers: ArrayBuffer[]   // passed in postMessage transfer list
}
```

Worker → main thread:

```ts
type Response =
  | { id: string; ok: true;  result: unknown; buffers: ArrayBuffer[] }
  | { id: string; ok: false; code: ErrorCode; message: string }
  | { id: string; kind: "progress"; done: number; total: number; stage?: string }
```

`EngineClient` (`web/src/engine/`) owns a `Map<id, {resolve, reject, onProgress}>` and the
worker lifecycle. Tools never talk to the worker directly.

### 1.4 The deadlock trap — read this before writing any op

A `js.FuncOf` callback executes on the single Go thread that is servicing the Wasm event
loop. **If that callback does long work, or blocks waiting on anything JavaScript, the
worker hangs permanently.** No error, no timeout — a dead worker. This is the most common
way Go/Wasm projects fail, and it will not show up in a small test.

Every exported op therefore returns a Promise and does its work in a goroutine:

```go
func promisify(fn func(args []js.Value) (any, error)) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) any {
		handler := js.FuncOf(func(_ js.Value, pr []js.Value) any {
			resolve, reject := pr[0], pr[1]
			go func() {                                  // ← the critical line
				defer func() {
					if r := recover(); r != nil {
						reject.Invoke(errValue(ErrInternal, fmt.Sprint(r)))
					}
				}()
				res, err := fn(args)
				if err != nil {
					reject.Invoke(errValue(classify(err), err.Error()))
					return
				}
				resolve.Invoke(res)
			}()
			return nil
		})
		defer handler.Release()
		return js.Global().Get("Promise").New(handler)
	})
}
```

Note `handler.Release()` — `js.Func` values leak until released, and an op invoked a
thousand times leaks a thousand of them.

`cmd/wasm/main.go` registers ops and then blocks forever; returning from `main` tears
down the Go runtime and every registered callback with it:

```go
func main() {
	js.Global().Set("__pdfforge", js.ValueOf(map[string]any{
		"merge":   promisify(ops.MergeJS),
		"rotate":  promisify(ops.RotateJS),
		// …
	}))
	js.Global().Get("__pdfforge_ready").Invoke()
	select {}                                        // ← never return
}
```

### 1.5 Progress

Go calls a JS callback rather than returning incrementally:

```go
progress := js.Global().Get("__pdfforge_progress")
progress.Invoke(id, done, total, stage)
```

The worker forwards it as a `progress` message. Emit progress from the goroutine, never
from a `FuncOf` callback body.

pdfcpu does not expose per-page progress hooks for most operations, so granularity is
per-file for merge and per-image for compress. Say so in the UI rather than faking a
smooth bar.

### 1.6 Cancellation

V1 cancels by **terminating the worker and respawning it**. `context.Context` plumbing
through pdfcpu is not available, and a `SharedArrayBuffer` flag requires
cross-origin-isolation headers (COOP/COEP) that would break bundled third-party assets.
Termination is coarse but honest: it stops immediately and reclaims all memory, which is
what a user pressing Cancel actually wants.

`EngineClient` rejects all in-flight requests with `ERR_CANCELLED` when it terminates.

### 1.7 Error codes

Go errors become stable string codes so the UI never string-matches on messages:

| Code | Meaning | Typical UI |
| --- | --- | --- |
| `ERR_ENCRYPTED` | Input needs a password we don't have | Prompt for password |
| `ERR_BAD_PASSWORD` | Supplied password rejected | Re-prompt, don't clear the file |
| `ERR_CORRUPT` | Malformed xref / unparseable | Offer Repair (Phase 4) |
| `ERR_UNSUPPORTED` | Valid PDF, feature we don't handle | Explain specifically |
| `ERR_TOO_LARGE` | Above the device tier cap | Show the cap and the file size |
| `ERR_OOM` | Allocation failed mid-op | Suggest fewer pages / lower DPI |
| `ERR_CANCELLED` | User cancelled | Silent |
| `ERR_INTERNAL` | Panic or unclassified | Generic, with the code visible for bug reports |

`classify(err)` lives in `internal/bridge` and maps pdfcpu's sentinel errors. Keep it in
one place; scattering the mapping guarantees drift.

---

## 2. Memory

### 2.1 The non-shrinking heap

`WebAssembly.Memory` supports `grow`. There is no `shrink`. Go's GC returns memory to the
Go allocator, never to the browser. After one 150 MB PDF, the worker holds its high-water
mark until it dies.

**Policy:** `EngineClient` tracks bytes processed since the worker started. Above a
watermark *(placeholder: 64 MB — measure in Phase 0)* it terminates and respawns after
the job completes. Respawn is `WebAssembly.instantiateStreaming` against a
service-worker-cached response, estimated ~100 ms.

This must be built in from the start. Retrofitting it means auditing every op for
resumability.

### 2.2 Budget

For a file of size `S`:

```
2S                 (copy in + copy out)
+ pdfcpu object model     ≈ 1.5–2 × S  (estimate — Phase 0 must measure)
+ transient buffers       ≈ 0.5 × S
──────────────────────────────────────
≈ 3.5–4.5 × S peak
```

ihatepdf's JS estimator assumes ~3–4× for rendering. Ours is a different shape: theirs
scales with *page count × DPI²*, ours with *file size*. Two estimators, not one:

```ts
// Structural ops (Go) — scales with bytes
estimateEngineBytes(fileSize) => fileSize * ENGINE_MULTIPLIER   // placeholder 4.0

// Rasterization (JS/pdf.js) — scales with pixels
estimateRenderBytes(pageCount, scale, format) =>
  pageCount * 5MB * scale**2 * (format === 'png' ? 1.5 : 1.0)
```

Apply a 1.5× safety margin and compare against `navigator.deviceMemory * 0.5`. If it
exceeds, degrade automatically where possible (lower DPI, enable batching) and only
prompt when degradation isn't available.

### 2.3 Canvas discipline (JS side)

Inherited from ihatepdf, unchanged, because it is correct:

- Hard clamp at 16,384 px per axis; if `viewport × scale` exceeds it, fall back to
  `min(MAX/w, MAX/h) * 0.95`.
- `canvas.width = canvas.height = 0` after use — this, not nulling the reference, is what
  releases GPU texture memory. A 4000×6000 canvas holds ~96 MB RAM *plus* ~96 MB VRAM,
  and on shared-memory mobile that's 192 MB.
- Batch large jobs; pause ~2 s between batches so Chrome's GC (idle-triggered at roughly
  1–1.5 s) actually runs. `window.gc` is a hint the browser may ignore.
- `getContext('2d', { alpha: false })` and fill white before rendering — transparent
  canvases cost more and produce black backgrounds in JPEG.

---

## 3. Compress pipeline

The hardest tool, and the one that justifies the whole engine choice. `pdf-lib` cannot do
this at all; ihatepdf needs a full Ghostscript build for it.

### 3.1 Three passes

**Pass 1 — structural.** `api.Optimize(rs, w, conf)` with
`conf.WriteObjectStream = true`, `conf.WriteXRefStream = true`. Deduplicates objects,
drops unused ones, writes object/xref streams, Flate-recompresses.

**Pass 2 — imaging** (`internal/ops/compress.go`, ours). It works one level below the
`api` package, on a `model.Context`, for a reason recorded below:

```go
// Enumerate as metadata-only stubs. stub=true is load-bearing: the raw path
// populates Reader and FileType and NOTHING else — no Width, no HasSMask.
stubs, err := pdfcpu.ExtractPageImages(ctx, pageNr, true)
//   model.Image{ ObjNr, PageNr, Name, Width, Height, Bpc, Cs, Comp,
//                IsImgMask, HasImgMask, HasSMask, Thumb, Size, Filter }

// Render one image to bytes (jpg for DCT, png for Flate/LZW/CCITT, jpx, jbig2)
img, err := pdfcpu.ExtractImage(ctx, obj.ImageDict, false, name, objNr, false)

// Swap the XObject, preserving its object number
sd, w, h, err := model.CreateImageStreamDict(ctx.XRefTable, newImageReader)
entry, _ := ctx.FindTableEntry(objNr, 0)
entry.Object = *sd
```

**Why not `api.UpdateImages`.** It is the obvious call and it does not work for us:
pdfcpu v0.15.0 validates that the replacement has *identical pixel dimensions* and errors
with `replacement dimensions 595x842, want 1240x1754`. That rules out downsampling, which
is the entire point of the pass. The three lines above are what `UpdateImages` does
internally minus that check, and dropping the check is safe because a PDF places an image
by the content stream's CTM, not by its pixel count — fewer pixels in the same box is
simply a lower-resolution image. Re-check this if pdfcpu is upgraded.

**Two contexts, not one.** Extraction decodes into the stream dict in place, so a context
used for planning has half-decoded streams in it and must not be written. Plan on a
scratch context, throw it away, then apply the replacements to a pristine one. Only the
encoded JPEGs live across the boundary, so the contexts never overlap in time.

Per image:

1. **Skip cheap cases.** `IsImgMask` (1-bit stencil), `Thumb`, and anything whose
   effective DPI is already at or below target. Effective DPI needs the image's displayed
   size on the page, not just `Width` — derive from the page's content-stream CTM, or
   approximate from page dimensions and accept some imprecision in v1.
2. **Decode by filter.** `DCTDecode` → `image/jpeg`. `FlateDecode` → raw samples,
   reconstructed using `Width`/`Height`/`Bpc`/`Cs`/`Comp`. `JPXDecode` (JPEG2000) → **skip,
   Go has no decoder**; leave the image untouched.
3. **Resample.** `golang.org/x/image/draw` with `draw.CatmullRom` — the closest
   equivalent to Ghostscript's bicubic. Target dimensions from the DPI preset.
4. **Re-encode.** `image/jpeg` at the preset's quality.
5. **Reinsert** by replacing the xref entry with a new image stream dict, preserving
   `objNr`. See the `UpdateImages` note above.

**`/SMask` is the trap.** An image with `HasSMask == true` carries its alpha in a separate
soft-mask XObject. Re-encoding the base image to JPEG (which has no alpha) while silently
dropping or desyncing the mask produces visibly corrupt output — usually black boxes where
transparency was. Two acceptable handlings, and the choice must be explicit per image:

- Downsample the SMask to matching dimensions and update it as its own XObject, or
- Composite the image onto white, drop the SMask reference, and update the image dict.

Never just re-encode the base and leave the mask alone.

`HasImgMask` (`/Mask`, stencil or colour-key masking) has the same hazard. In v1, **skip
compression for any image with a mask** and record it in the result summary. Correct
output beats a better ratio.

**Pass 3 — metadata.** Strip `/Info` entries and XMP that carry author, producer,
software and timestamps. Cheap, and it feeds the future Privacy Scanner.

### 3.2 Presets

Deliberately mapped 1:1 onto Ghostscript's so the Phase-5 benchmark compares like with
like:

| Preset | Ghostscript equivalent | DPI | JPEG quality |
| --- | --- | --- | --- |
| Screen | `/screen` | 72 | 40 |
| eBook | `/ebook` | 150 | 60 |
| Printer | `/printer` | 300 | 80 |
| Prepress | `/prepress` | 300 | 92 |

### 3.3 Target-size mode

ihatepdf walks presets linearly from lightest to heaviest until one fits, re-running the
whole pipeline each time. We **binary-search over a monotonic (DPI, quality) ladder**
instead: fewer full passes, and the result lands closer to the requested size rather than
overshooting to the next preset down.

Cap iterations (4) and always return the best result found, with a
`reachedTarget: boolean` so the UI can be honest when the target was unreachable.

### 3.4 Known gap: font subsetting

Ghostscript trims embedded fonts to only the glyphs actually used — up to 90% off a font,
which dominates the savings on text-heavy documents with no images. **pdfcpu does not do
this, and we will not have it in V1.**

Consequence, stated plainly: on a text-heavy PDF with embedded fonts, our compressor will
lose to ihatepdf's. On image-heavy PDFs we should be competitive or better.

Phase 4 remedy: parse embedded TrueType with `golang.org/x/image/font/sfnt`, collect used
glyph IDs from content streams, rebuild `glyf`/`loca`/`cmap`, rewrite the FontFile2
stream. Non-trivial (CID fonts, Type1/CFF, and subset-name conventions all bite), which is
exactly why it is not V1.

---

## 4. P2P share

Full teardown of ihatepdf's version and our replacement live in
`docs/tools/p2p-share.md`. The load-bearing points:

- Their design has **no signaling server** — `btoa(JSON.stringify(pc.localDescription))`
  in a URL fragment, answer pasted back by hand, 7 s blocking wait for full ICE gathering.
- Ours adds a Go WebSocket relay: 6-char room code, **trickle ICE**, near-instant connect,
  no manual paste-back.
- Transfer mechanics we keep: 64 KB chunks, SHA-256 verification, gzip via
  `CompressionStream` retained only when it actually shrinks, plus explicit
  `bufferedAmountLowThreshold` backpressure.
- **Threat model, stated correctly:** DTLS already encrypts the data channel, so the
  optional PBKDF2/AES-256-GCM layer is not protecting against passive eavesdroppers. It
  defends against *a malicious or compromised signaling server tampering with the SDP
  fingerprints to insert itself as a man in the middle*. Since we are the ones introducing
  a signaling server, that layer earns its place — more so than in ihatepdf's design,
  where it mostly duplicates DTLS.
- **No TURN.** Symmetric NAT and strict corporate firewalls will fail outright, roughly
  10–15% of attempts *(industry figure, not measured)*. Adding TURN is the only fix and it
  would relay bytes through a server, breaking the core promise. Surface a clear failure
  message rather than a hang.

---

## 5. Build pipeline

`scripts/build-wasm.sh`:

```bash
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" \
  -o web/public/wasm/engine.wasm ./engine/cmd/wasm

# NOTE: as of Go 1.24 this moved out of misc/wasm/
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" web/public/wasm/
```

Then content-hash both filenames for immutable caching.

Measured 2026-08-24 with 8 ops linked:

| | Size |
| --- | --- |
| Raw | 17.73 MB |
| gzip -9 | 4.24 MB |
| brotli -q11 | **3.00 MB** |

Cloudflare Pages serves Brotli automatically.

**Measuring this correctly is easy to get wrong.** A probe that references ops as
`_ = ops.Merge` does not defeat dead-code elimination — pdfcpu drops out entirely and you
measure a bare Go runtime (~6 MB raw). Only a real call path linked from `main` gives a
true figure. Our first attempt made exactly this mistake and under-reported by ~3×.

Size bisection, for anyone trying to trim it later:

| Configuration | Raw |
| --- | --- |
| Go runtime + `syscall/js` + bridge, no pdfcpu | 2.46 MB |
| `+ encoding/json` | +0.54 MB |
| `+ pdfcpu` (any single op with a real call path) | ~16.9 MB |
| `+ 7 more ops` | 17.73 MB |

The cliff is pdfcpu itself, and it is nearly all fixed cost — going from one op to eight
added only 0.8 MB. **Adding operations is close to free; the first one is not.** That
makes a per-tool module split pointless: the shared base dominates, so one engine binary
lazily loaded and cached is the right shape.

If the 3 MB ever needs to come down, the target is pdfcpu's `pkg/pdfcpu/sign` package,
which pulls `crypto/x509` and OCSP for signature validation we do not use. Removing it
needs an upstream build tag, so it is an upstream conversation rather than a local fix.

Loading, in `engine.worker.ts`:

```ts
importScripts('/wasm/wasm_exec.js')
const go = new Go()
const { instance } = await WebAssembly.instantiateStreaming(fetch(WASM_URL), go.importObject)
go.run(instance)                    // returns only when main() returns — ours never does
await readySignal                   // __pdfforge_ready fires after ops are registered
```

Never `await go.run(...)`. It resolves only on Go runtime exit, which for us means
something has gone badly wrong.

---

## 6. Testing

- **`internal/ops` tests run natively** (`go test ./...`) against a fixture corpus. This is
  the main safety net and it costs nothing — same code path as Wasm.
- **Bridge tests** need a browser. Playwright, exercising `EngineClient` against the real
  worker: round-trip integrity, progress events, cancellation, worker respawn.
- **Fixture corpus** (`engine/testdata/`): text-only, image-heavy, scanned, form-bearing,
  AES-256 encrypted, RC4 encrypted, deliberately corrupt xref, 0-byte, and a >100 MB file
  (generated, not committed).
- Every `ERR_*` code needs a fixture that provokes it. Error paths in a privacy tool are
  user-facing behaviour, not edge cases.
