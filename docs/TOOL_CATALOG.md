# pdf-forge — Tool Catalog

Every tool observed on ihatepdf.cv (56 routes, scraped from its sidebar 2026-08-23),
each either assigned a phase or explicitly deferred with a reason. Nothing is silently
dropped — the point of this document is that the scope boundary is recorded rather than
rediscovered in an argument six months from now.

**Engine column:** `Go` = pdfcpu/our Go code in Wasm · `JS` = pdf.js or another bundled
JS library · `Hybrid` = both, per the boundary rule in `docs/HLD.md` §4.

---

## Phase 1 — V1a: Core page ops

Pure page-tree surgery. No rendering, no rasterization, smallest possible dependency
surface. These are also the highest-traffic tools on every competitor's site.

| Tool           | Route             | Engine | pdfcpu API                        | Doc                                       |
| -------------- | ----------------- | ------ | --------------------------------- | ----------------------------------------- |
| Merge PDFs     | `/merge-pdf`      | Go     | `api.MergeRaw`                    | [merge](tools/merge.md)                   |
| Split PDF      | `/split-pdf`      | Go     | `api.ExtractPage` / `api.Trim`    | [split](tools/split.md)                   |
| Extract pages  | `/extract-pages`  | Go     | `api.Collect`                     | [extract-pages](tools/extract-pages.md)   |
| Rotate PDF     | `/rotate-pdf`     | Go     | `api.Rotate`                      | [rotate](tools/rotate.md)                 |
| Organize pages | `/organize-pages` | Hybrid | `api.Collect` + `api.RemovePages` | [organize-pages](tools/organize-pages.md) |

> Deviation from ihatepdf: they fold "extract pages" into split. We give it its own
> route because the user intent is different — split means _divide this document_,
> extract means _give me these pages_. Organize is Hybrid only because its thumbnail grid
> needs pdf.js for previews; the actual reordering is Go.

## Phase 1 — V1b: Security

| Tool            | Route              | Engine | pdfcpu API                                                    | Doc                                         |
| --------------- | ------------------ | ------ | ------------------------------------------------------------- | ------------------------------------------- |
| Encrypt PDF     | `/encrypt-pdf`     | Go     | `api.Encrypt`, `EncryptUsingAES=true`, `EncryptKeyLength=256` | [encrypt](tools/encrypt.md)                 |
| Remove password | `/remove-password` | Go     | `api.Decrypt`                                                 | [remove-password](tools/remove-password.md) |

> **Remove password requires knowing the password.** pdfcpu decrypts with a supplied
> `UserPW`/`OwnerPW`; it does not crack. The UI must say this plainly rather than let
> users arrive expecting recovery. ihatepdf ships both `/remove-password` and
> `/unlock-pdf` — two routes for what is functionally one operation, likely SEO-driven.
> We ship one and let the copy handle both intents.

## Phase 2 — Compress

| Tool         | Route           | Engine | Notes                                                              | Doc                           |
| ------------ | --------------- | ------ | ------------------------------------------------------------------ | ----------------------------- |
| Compress PDF | `/compress-pdf` | Go     | `api.Optimize` + our imaging pass. Presets mapped to Ghostscript's | [compress](tools/compress.md) |

The tool that justifies the engine choice, and the one with a known gap against
Ghostscript (font subsetting — see `docs/LLD.md` §3.4).

## Phase 2 — Render & convert

| Tool          | Route            | Engine | Notes                                                              | Doc                                     |
| ------------- | ---------------- | ------ | ------------------------------------------------------------------ | --------------------------------------- |
| PDF → JPG/PNG | `/pdf-to-jpg`    | JS     | pdf.js canvas, 72–600 DPI, device-tier capped                      | [pdf-to-image](tools/pdf-to-image.md)   |
| Images → PDF  | `/images-to-pdf` | Go     | `api.ImportImages` takes `[]io.Reader`                             | [images-to-pdf](tools/images-to-pdf.md) |
| Extract text  | `/extract-text`  | JS     | pdf.js `getTextContent` — better layout reconstruction than pdfcpu | [extract-text](tools/extract-text.md)   |
| PDF → ZIP     | `/pdf-to-zip`    | JS     | Rasterize then zip; Go adds nothing                                | [pdf-to-zip](tools/pdf-to-zip.md)       |

## Phase 3 — Collaborate & share

| Tool                     | Route                | Engine         | Notes                                                                                                                | Doc                             |
| ------------------------ | -------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| P2P file share           | `/p2p-share`         | JS + Go server | WebRTC data channel, Go signaling relay                                                                              | [p2p-share](tools/p2p-share.md) |
| Collaborative whiteboard | `/collab-whiteboard` | JS + Go server | Reuses the same signaling server. Unrelated to PDF; include only if the signaling infrastructure is already paid for | —                               |

## Phase 4 — Edit, annotate & organize

Everything pdfcpu can do that we didn't need for V1, plus the annotation surface.

| Tool              | Route               | Engine | pdfcpu API / approach                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add watermark     | `/add-watermark`    | Go     | `api.AddWatermarks`, `api.TextWatermark`, `api.ImageWatermarkForReader`                                                                                                                                                                                                                                                                                                                                                                            |
| Remove watermark  | `/remove-watermark` | Go     | `api.RemoveWatermarks`, `api.HasWatermarks` for pre-flight detection. Not in ihatepdf's own catalog — added because a watermark someone else stamped onto a PDF is exactly the kind of thing this tool otherwise handles (encrypt has a remove-password counterpart; watermark deserves the same symmetry)                                                                                                                                         |
| Page numbers      | `/page-numbers`     | Go     | `api.AddWatermarks` with positioned text                                                                                                                                                                                                                                                                                                                                                                                                           |
| Headers & footers | `/headers-footers`  | Go     | same mechanism as page numbers                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Crop & resize     | `/crop-resize-pdf`  | Go     | `api.Crop`, `api.Resize`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Flatten PDF       | `/flatten-pdf`      | Go     | `api.RemoveFormFields` + annotation flattening                                                                                                                                                                                                                                                                                                                                                                                                     |
| Fill PDF form     | `/fill-pdf-form`    | Hybrid | pdfcpu form API; pdf.js to render field positions                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sign PDF          | `/sign-pdf`         | Hybrid | **Shipped**, as spec'd — new `AddImageWatermark` Go op (`api.ImageWatermarkForReader`). Its own e2e test surfaced and fixed a real Worker-compat bug in the shared render pipeline (a `document.createElement` call inside pdf.js's own image-scaling path). See `docs/tools/sign.md`                                                                                                                                                              |
| Edit PDF text     | `/edit-pdf-text`    | Hybrid | Hardest tool on the list. Requires content-stream rewriting plus font matching. Treat as its own project                                                                                                                                                                                                                                                                                                                                           |
| Redact PDF        | `/redact-pdf`       | Hybrid | **Shipped**, deliberately not as spec'd here: pdfcpu has no content-stream editor, so instead of surgically removing text under a box, every page is rasterized and the whole document rebuilt from images — stronger than "remove the boxed text" (nothing anywhere survives, not just the box) at the cost of losing text search/selection everywhere, not just the redacted area. See `docs/tools/redact.md`'s "A deliberate deviation" section |
| Invert colours    | `/invert-pdf`       | Hybrid | **Shipped**, same deviation as Redact and for the same reason: pdfcpu has no content-stream colour-operator rewriter. Full-page rasterize + per-channel pixel invert + rebuild, reusing Redact's architecture directly. See `docs/tools/invert-colours.md`                                                                                                                                                                                         |
| Repair PDF        | `/repair-pdf`       | Go     | pdfcpu's validation/xref-reconstruction is already strong. **Not an AI tool** despite ihatepdf's grouping                                                                                                                                                                                                                                                                                                                                          |
| Compare PDFs      | `/compare-pdfs`     | JS     | Synced side-by-side rendering + text diff. **Also not an AI tool**                                                                                                                                                                                                                                                                                                                                                                                 |
| Privacy scanner   | `/privacy-scanner`  | Go     | Enumerate `/Info`, XMP, annotations, embedded files, JS actions                                                                                                                                                                                                                                                                                                                                                                                    |
| Fingerprint PDF   | `/fingerprint-pdf`  | Go     | **Shipped.** Four faint, pale, corner-placed `AddWatermarks` calls chained (no new engine code) rather than true steganographic embedding — real vector text, unobtrusive at reading size, not literally invisible. See `docs/tools/fingerprint.md`                                                                                                                                                                                                |

> ihatepdf files Repair and Compare under "AI Tools". Neither uses AI. Repair is xref
> reconstruction; Compare is rendering plus text diff. We categorise them by what they
> actually do, and both are well inside our engine's strengths.

## Phase 4 — Office format conversion

The largest single block and the one users ask for most. Fidelity is the hard part;
plumbing is not.

| Tool             | Route              | Engine | Approach                                                                                                                                        |
| ---------------- | ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Word → PDF       | `/word-to-pdf`     | JS     | `mammoth` (docx→HTML) → layout → PDF                                                                                                            |
| PDF → Word       | `/pdf-to-word`     | JS     | pdf.js text + position → OOXML via `jszip`                                                                                                      |
| Excel → PDF      | `/excel-to-pdf`    | JS     | `sheetjs` → table layout → PDF                                                                                                                  |
| PDF → Excel      | `/pdf-to-excel`    | JS     | Table detection from pdf.js text positions. Genuinely hard                                                                                      |
| PowerPoint → PDF | `/pptx-to-pdf`     | JS     | OOXML parse → per-slide render                                                                                                                  |
| PDF → PowerPoint | `/pdf-to-pptx`     | JS     | Page raster per slide                                                                                                                           |
| HTML → PDF       | `/html-to-pdf`     | JS     | Bundled renderer, no CDN                                                                                                                        |
| Markdown → PDF   | `/markdown-to-pdf` | JS     | `marked` → HTML → PDF                                                                                                                           |
| CSV ↔ PDF        | `/csv-to-pdf`      | JS     | Table layout with pagination                                                                                                                    |
| PDF → HTML       | `/pdf-to-html`     | JS     | Positioned text, selectable                                                                                                                     |
| Create PDF       | `/create-pdf`      | JS     | Rich-text editor → PDF                                                                                                                          |
| eBook → PDF      | `/ebook-to-pdf`    | JS     | EPUB/MOBI/AZW3 parse                                                                                                                            |
| PDF → EPUB       | `/pdf-to-epub`     | JS     | Reflowable text extraction                                                                                                                      |
| Scan to PDF      | `/scan-to-pdf`     | JS     | `getUserMedia` + deskew/crop → Go `ImportImages`                                                                                                |
| Workflow builder | `/workflow`        | Hybrid | Chain ops in one pass — cheap for us, since all Go ops are already `io.ReadSeeker → io.Writer` and can compose without intermediate round-trips |

> `/workflow` is worth flagging as an _advantage_ rather than a chore. ihatepdf must
> serialise to a Blob between every step. Our ops compose inside a single Wasm call, so a
> merge → compress → encrypt chain costs one bridge crossing instead of three.

## Phase 5 — Benchmarking

Not a user-facing tool. See [BENCHMARKING.md](BENCHMARKING.md).

---

## Deferred / not planned

Recorded with reasons so the boundary holds.

### AI tools — needs an external LLM API

| Tool          | Route            | Why deferred                                                                                                                                                                                                          |
| ------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat with PDF | `/chat-with-pdf` | ihatepdf extracts text locally and posts it to Gemini. The _binary_ never uploads, but **the document's contents do**. That is a materially weaker promise than ours, and their marketing doesn't distinguish the two |
| AI summarizer | `/summarize-pdf` | Same                                                                                                                                                                                                                  |

Revisit only with a clear answer to: bring-your-own-key or proxied? and an unambiguous UI
disclosure at the moment text leaves the device.

### Local ML — genuinely private, but heavy

| Tool                 | Route                 | Why deferred                                                                              |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| OCR / searchable PDF | `/ocr-pdf`            | Tesseract-Wasm plus language models, 20–100 MB per language on first use                  |
| PDF → Audio          | `/pdf-to-audio`       | Neural TTS (`kokoro-js`), large model download                                            |
| Audio → PDF          | `/audio-to-pdf`       | Speech-to-text model                                                                      |
| PDF → Handwriting    | `/pdf-to-handwriting` | Novelty; no engine synergy                                                                |
| Handwriting → PDF    | `/handwriting-to-pdf` | Same                                                                                      |
| Auto-redact PII      | `/auto-redact-pii`    | Needs NER. A regex version (emails, phones, card numbers) is cheap and could join Phase 4 |

No privacy objection to any of these — the objection is bundle weight against value.
OCR is the most likely to be promoted, since "edit a scanned PDF" is a real recurring need.

### India business tools — unrelated to the engine

| Tool                  | Route              | Why deferred                                                         |
| --------------------- | ------------------ | -------------------------------------------------------------------- |
| GST invoice generator | `/gst-invoice`     | A local-market wedge, not a PDF tool. Shares nothing with the engine |
| POS billing           | `/pos-billing`     | Same                                                                 |
| GST filing prep       | `/gst-filing-prep` | Same                                                                 |

These are plainly the author's distribution strategy for the Indian market rather than
part of the product. Include only if that market becomes a deliberate target.

### Non-tools

| Route         | Note                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/`           | Dashboard / tool index                                                                                                                    |
| `/resources`  | Blog index. ihatepdf runs ~90 SEO articles against these tools — worth noting as a _distribution_ lesson even though it isn't engineering |
| `/unlock-pdf` | Duplicate of `/remove-password`, kept by them for SEO. We ship one                                                                        |

---

## Counts

| Bucket              | Tools |
| ------------------- | ----- |
| Phase 1 (V1a + V1b) | 7     |
| Phase 2             | 5     |
| Phase 3             | 2     |
| Phase 4             | 30    |
| Deferred            | 11    |
| Non-tools           | 3     |

V1 ships 12 tools. The full in-scope target is 44 — Remove Watermark was added after this
table was first written (see its own row above for why), one more than the count this
doc originally shipped with.
