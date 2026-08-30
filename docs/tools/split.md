# Split PDF

**Route** `/split-pdf` · **Phase** 1 · **Engine** Go

## Purpose

Divide one PDF into several. Distinct from [extract-pages](extract-pages.md): split means
_cut this document up_, extract means _give me these pages as one file_.

## Status

**Shipped** (`web/src/tools/Split/tool.tsx`): every-page, every-N-pages, and by-ranges
modes; per-part downloads plus a "Download All" that zips the whole result with `jszip`.
The zip dependency this doc originally deferred adding is no longer a fresh decision —
`PdfToZip` added it first (with direct user go-ahead), so Split just reuses what's already
in the bundle rather than re-litigating the choice.

**Deferred:**

- "At page numbers" mode (cut before pages 5, 12, 30) — not implemented; only
  each/span/ranges exist today.

## User flow

1. Pick a file. Show page count.
2. Choose a mode:
   - **Every page** — N single-page PDFs
   - **Every N pages** — fixed-size chunks
   - **At page numbers** — cut before pages 5, 12, 30
   - **By ranges** — `1-3, 5, 7-10` → one file per range
3. Split → download as a ZIP (or individually when there are few outputs).

## Engine op

```go
// internal/ops/split.go
type SplitParams struct {
    Mode   string   `json:"mode"`   // "each" | "span" | "at" | "ranges"
    Span   int      `json:"span"`
    At     []int    `json:"at"`
    Ranges []string `json:"ranges"` // pdfcpu page-selection syntax
}

func Split(input []byte, p SplitParams) ([][]byte, []string, error) // parts, names, err
```

**Do not use `api.Split` / `api.SplitByPageNr`** — both require an output _directory_,
which would drag a filesystem shim into the build for no benefit. Instead:

```go
ctx, err := api.ReadValidateAndOptimize(bytes.NewReader(input), conf)
// "each" mode:
r, err := api.ExtractPage(ctx, pageNr)   // → io.Reader, in memory
```

For range and span modes, `api.Collect(rs, w, selectedPages, conf)` produces one document
from a page selection — call it once per output part.

`api.ParsePageSelection(s string) ([]string, error)` validates user-typed ranges. Use it
for live input validation rather than writing our own parser; it already understands
pdfcpu's syntax including `even`, `odd`, `!` exclusions and `-` open ranges.

## Memory

Reading the context once and calling `ExtractPage` per page is far cheaper than
re-parsing per output. Parse once, emit many.

Peak ≈ input copy + object model + the largest single output. Zipping happens in JS after
the buffers come back, so the ZIP itself never occupies the Go heap.

## Edge cases

| Case                           | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Range beyond page count        | Reject at input validation, showing the actual count                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Empty / malformed range string | Inline validation error, never `ERR_INTERNAL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Ranges overlap                 | Allowed — a page may appear in several outputs                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Result is one part             | Still valid; return it directly rather than zipping                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 500-page "every page" split    | **As shipped, not as originally designed here:** `engine.split()` is one RPC call that returns all `SplitPart`s at once (`EngineClient.split`), not a batched/streamed transfer — so a 500-page split holds all 500 output buffers in the Wasm heap, then in JS, then again inside JSZip before `generateAsync()`. Fine at realistic sizes (same "measure before optimizing" stance as the rest of this doc's memory sections); revisit with a real batching pass if a large real-world split turns out to matter |
| Encrypted input                | `ERR_ENCRYPTED`, prompt for password                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Bookmarks/outlines             | Split parts lose the global outline. Note it in the UI                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## UI states

Idle → file loaded (page count, mode selector, live range validation) → splitting
(per-part progress) → done (part list with sizes, download all / individually).

## Fixtures

`pages_50.pdf`, `pages_1.pdf`, `bookmarks.pdf`, `encrypted_aes256.pdf`, plus a generated
500-page file for the batching path.
