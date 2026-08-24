# Extract Pages

**Route** `/extract-pages` · **Phase** 1 · **Engine** Go

## Purpose

Pull a selection of pages out of a PDF into **one** new document. The complement of
[split](split.md), which produces many.

Separate route because the user intent and the SEO intent both differ — "extract pages
from PDF" and "split PDF" are distinct searches with distinct expectations.

## Status

**Shipped** (`web/src/tools/ExtractPages/tool.tsx`): typed page selection
(`1-3, 5, 8-12`), extract → download.

**Deferred:**

- Click-to-select page thumbnails — needs the render worker, same as Rotate. Selection
  is text-only for now.

## User flow

1. Pick a file.
2. Type a selection (`1-3, 5, 8-12`) or click page thumbnails.
3. Extract → download one PDF.

## Engine op

```go
// internal/ops/extract.go
type ExtractParams struct {
    Selection string `json:"selection"` // pdfcpu page-selection syntax
}

func ExtractPages(input []byte, p ExtractParams) ([]byte, error)
```

```go
pages, err := api.ParsePageSelection(p.Selection)
if err != nil { return nil, err }
var out bytes.Buffer
err = api.Collect(bytes.NewReader(input), &out, pages, conf)
```

`api.Collect` preserves the **order given in the selection**, not document order — so
`5,1,3` yields pages in that sequence. That is a feature; expose it ("keep my order" vs
"sort ascending") rather than hiding it.

## Params

| Field       | Type   | Notes                                                                                     |
| ----------- | ------ | ----------------------------------------------------------------------------------------- |
| `selection` | string | Validated by `api.ParsePageSelection`. Supports `even`, `odd`, `!` exclusion, open ranges |

## Memory

Cheapest of the page ops. Peak ≈ input copy + object model + output. No per-page
multiplication.

If the tool offers a thumbnail picker, note the thumbnails are rendered by the **render
worker** (pdf.js), not the engine — two independent memory budgets, per `docs/LLD.md` §2.2.

## Edge cases

| Case                             | Behaviour                                                                  |
| -------------------------------- | -------------------------------------------------------------------------- |
| Selection resolves to zero pages | `ERR_UNSUPPORTED` with a plain message; a 0-page PDF is not a valid output |
| Selection is every page          | Allowed; returns a copy. Mention it rather than erroring                   |
| Duplicate page in selection      | Allowed — `1,1,2` gives three pages                                        |
| Out-of-range page                | Validation error before the op runs                                        |
| Encrypted input                  | `ERR_ENCRYPTED`                                                            |
| Links pointing to omitted pages  | Become dangling. pdfcpu's behaviour here needs a fixture check             |

## UI states

Idle → loaded (thumbnail grid + selection field, kept in sync both ways) → extracting →
done → error.

## Fixtures

`pages_50.pdf`, `internal_links.pdf`, `encrypted_aes256.pdf`.
