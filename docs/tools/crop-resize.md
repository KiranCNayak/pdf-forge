# Crop & Resize

**Route** `/crop-resize-pdf` · **Phase** 4 · **Engine** Go

## Purpose

Two related page-geometry operations sharing one route, per `docs/TOOL_CATALOG.md`:
**crop** trims margins off the visible area (sets `/CropBox`, leaves page content
untouched), **resize** scales the whole page (media box and content together — a bigger
or smaller sheet of paper, not a viewport change). Both are thin wrappers over pdfcpu
APIs that already do the real work; this tool's job is turning a handful of number
fields into the margin/dimension strings those APIs expect.

## Status

**Shipped** (`web/src/tools/CropResize/tool.tsx`, `engine/internal/ops/cropresize.go`):
one mode toggle between Crop and Resize, apply to all pages or a typed selection.

- **Crop**: four independent margin fields (top/right/bottom/left, in points). A positive
  margin trims that much off the edge; a negative margin enlarges the page instead — both
  are pdfcpu's own native behaviour for a margin-based box definition, not something this
  tool added.
- **Resize**: either a scale factor (0.5 = half size, 2 = double) or a target page size —
  a named paper size (`A4`, `A4L` for landscape, `Letter`, `Legal`, ...) or explicit
  width/height in points.

## Engine op

```go
// internal/ops/cropresize.go
type CropParams struct {
    Top, Right, Bottom, Left float64  // points; each has its own `json:"..."` tag
    Selection                []string `json:"selection,omitempty"` // nil/empty = all pages
    Password                 string   `json:"password,omitempty"`
}

func Crop(input []byte, p CropParams, prog Progress) ([]byte, error)

type ResizeParams struct {
    Mode      string   `json:"mode"` // "scale" | "pageSize" | "dimensions"
    Scale     float64  `json:"scale,omitempty"`     // mode=scale
    PageSize  string   `json:"pageSize,omitempty"`  // mode=pageSize, e.g. "A4", "A4L"
    Width     float64  `json:"width,omitempty"`     // mode=dimensions, points
    Height    float64  `json:"height,omitempty"`    // mode=dimensions, points
    Selection []string `json:"selection,omitempty"`
    Password  string   `json:"password,omitempty"`
}

func Resize(input []byte, p ResizeParams, prog Progress) ([]byte, error)
```

```go
// Crop: build a margin-based box definition string and hand it to api.Box.
desc := fmt.Sprintf("%g %g %g %g", p.Top, p.Right, p.Bottom, p.Left) // top right bottom left
box, err := api.Box(desc, types.POINTS)
err = api.Crop(bytes.NewReader(input), &out, p.Selection, box, conf)
```

```go
// Resize (scale mode):
resize := &model.Resize{Scale: p.Scale}
err = api.Resize(bytes.NewReader(input), &out, p.Selection, resize, conf)

// Resize (page-size mode):
dim, _, err := types.ParsePageFormat(p.PageSize) // "A4" -> {595, 842}, "A4L" -> landscape
resize := &model.Resize{PageDim: dim, PageSize: p.PageSize} // PageSize, not just PageDim
```

`api.Box(s string, u types.DisplayUnit) (*model.Box, error)` parses pdfcpu's own
margin-string syntax — `"T R B L"` (CSS shorthand order), all in the given unit, an
optional trailing `abs`/`rel` (this tool always uses `abs`, i.e. absolute point values,
never percentages). `api.Crop` sets `/CropBox` relative to `/MediaBox` using that box;
it does not touch page content, so text/images outside the new crop box still exist in
the file, just outside the visible area most readers respect.

`api.Resize` is the opposite: it scales `/MediaBox` (and content) by `Scale`, or fits it
to `PageDim` — an actual reflow of the page geometry, not a viewport change.
`types.ParsePageFormat` handles the `L`/`P` landscape/portrait suffix pdfcpu's paper-size
names support (`"A4L"` = A4 landscape) and looks the base name up in
`types.PaperSize`, the same map `docs/tools/images-to-pdf.md`'s A4/Letter presets use.

**`model.Resize.PageSize` must be set alongside `PageDim`, not left as the empty
string.** `model.Resize.EnforceOrientation()` — which decides whether an explicit
landscape/portrait request overrides pdfcpu auto-matching the source page's own
orientation — checks for a trailing `L`/`P` suffix on `PageSize` specifically, not on
`PageDim`'s own width/height. Setting only `PageDim` and leaving `PageSize` empty
silently discarded `"A4L"`'s landscape intent back to portrait in testing (confirmed
directly against pdfcpu v0.15.0, not a guess) — `TestResizeByPageSizeLandscape` catches
a regression here.

Both share the same page-selection zero-pages guard `AddWatermark`/`RemoveWatermark`
already established (`requireSelectionResolvesToPages`, moved to `ops.go` once a third
op needed it rather than staying watermark-specific) — pdfcpu's `PagesForPageSelection`
doesn't error on an
out-of-range selection either, for the same underlying reason.

## Params

| Field (Crop)                  | Notes                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `top`/`right`/`bottom`/`left` | Points. Positive trims that edge in; negative enlarges the page instead       |
| `selection`                   | pdfcpu page-selection tokens (ranges, `even`, `odd`, `!`). Empty = every page |

| Field (Resize)   | Notes                                                  |
| ---------------- | ------------------------------------------------------ |
| `mode`           | `scale`, `pageSize`, or `dimensions`                   |
| `scale`          | > 0, ≠ 1 (1 would be a no-op pdfcpu itself rejects)    |
| `pageSize`       | A pdfcpu paper-size name, optionally suffixed `L`/`P`  |
| `width`/`height` | Points, `dimensions` mode only — both must be positive |
| `selection`      | Same as Crop                                           |

## Memory

Cheap for crop (a box-dictionary edit, no content-stream rewriting). Resize is slightly
more involved — pdfcpu recomputes and re-embeds a scaled content stream reference per
page — but still nowhere near compress's image-decoding cost. Peak ≈ input copy + object
model + output for both.

## Edge cases

| Case                                                  | Behaviour                                                                                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crop margin larger than the page itself               | pdfcpu produces a degenerate (zero or negative area) crop box; validated the same way `ERR_INVALID_PARAMS` guards other geometry inputs — rejected before the call rather than producing an unreadable page |
| Resize scale of exactly 1                             | `ERR_INVALID_PARAMS` — pdfcpu's own `validateResizeConfiguration` rejects it as a no-op                                                                                                                     |
| Resize scale ≤ 0, NaN, or Inf                         | `ERR_INVALID_PARAMS`                                                                                                                                                                                        |
| Resize dimensions mode, width or height ≤ 0           | `ERR_INVALID_PARAMS`                                                                                                                                                                                        |
| Unknown paper size name                               | `ERR_INVALID_PARAMS`, surfacing pdfcpu's own "page format unsupported" message                                                                                                                              |
| Selection resolves to zero pages                      | `ERR_UNSUPPORTED`, same posture as add-watermark/remove-watermark                                                                                                                                           |
| Encrypted input                                       | `ERR_ENCRYPTED`                                                                                                                                                                                             |
| Crop leaves the crop box smaller than visible content | Expected pdfcpu behaviour — content outside the crop box is clipped by readers, not deleted. Not something this tool can or should "fix"                                                                    |

## UI states

Idle → loaded (Crop/Resize mode toggle, mode-specific fields, selection field) → applying
→ done → error.

## Fixtures

`plain.pdf`, `pages_10.pdf`, `encrypted_aes256.pdf`.
