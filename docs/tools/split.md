# Split PDF

**Route** `/split-pdf` · **Phase** 1 · **Engine** Go

## Purpose

Divide one PDF into several. Distinct from [extract-pages](extract-pages.md): split means
*cut this document up*, extract means *give me these pages as one file*.

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

**Do not use `api.Split` / `api.SplitByPageNr`** — both require an output *directory*,
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

| Case | Behaviour |
| --- | --- |
| Range beyond page count | Reject at input validation, showing the actual count |
| Empty / malformed range string | Inline validation error, never `ERR_INTERNAL` |
| Ranges overlap | Allowed — a page may appear in several outputs |
| Result is one part | Still valid; return it directly rather than zipping |
| 500-page "every page" split | 500 buffers. Batch the transfer back and stream into the ZIP; do not hold all in memory at once |
| Encrypted input | `ERR_ENCRYPTED`, prompt for password |
| Bookmarks/outlines | Split parts lose the global outline. Note it in the UI |

## UI states

Idle → file loaded (page count, mode selector, live range validation) → splitting
(per-part progress) → done (part list with sizes, download all / individually).

## Fixtures

`pages_50.pdf`, `pages_1.pdf`, `bookmarks.pdf`, `encrypted_aes256.pdf`, plus a generated
500-page file for the batching path.
