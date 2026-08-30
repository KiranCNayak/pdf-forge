# Add Watermark

**Route** `/add-watermark` · **Phase** 4 · **Engine** Go

## Purpose

Stamp text onto every page (or a selection), for draft/confidential marking, branding, or
provenance. First Phase 4 tool — everything in Phase 1–3 was core page ops, security, and
render/convert; this is the first of the larger "edit, annotate & organize" bucket in
`docs/TOOL_CATALOG.md`.

Text only in V1. Image and PDF-stamp watermarks use the same underlying pdfcpu mechanism
(`api.ImageWatermarkForReader` / `api.PDFWatermark`) and are a small follow-on, not a
different design — deferred here to keep the first Phase 4 tool's scope tight.

See [remove-watermark](remove-watermark.md) for the inverse operation — same file,
`engine/internal/ops/watermark.go`, separate route and doc, same reasoning
[remove-password](remove-password.md) has its own doc apart from
[encrypt](encrypt.md). See [page-numbers](page-numbers.md) and
[headers-footers](headers-footers.md) for two tools that reuse this exact op with no new
engine code at all — pdfcpu's own `%p`/`%P` page-number tokens work inside the plain
`text` field already.

## Status

**Shipped** (`web/src/tools/AddWatermark/tool.tsx`, `engine/internal/ops/watermark.go`):
text, font size, color, anchor position, rotation, opacity, on-top-or-behind-content
toggle, apply to all pages or a typed selection.

**Deferred:**

- Image and PDF watermarks — `api.ImageWatermarkForReader`/`api.PDFWatermark` exist in
  pdfcpu; only `api.TextWatermark` is wired up.
- Page-number and date tokens inside the watermark text (pdfcpu supports `%p`/`%d`-style
  substitution for its own page-numbers use case) — plain static text only for now. See
  `docs/TOOL_CATALOG.md`'s separate Page Numbers / Headers & Footers entries, which are
  the natural place for that.
- Diagonal placement — pdfcpu's own default (no explicit `rotation:` key) draws the
  watermark along the page diagonal. This tool always sends an explicit rotation
  (0 by default), so the classic "diagonal DRAFT stamp" look needs the user to dial in an
  angle by hand rather than getting it as a preset. A "diagonal" checkbox is a fast
  follow-on if this turns out to matter.

## User flow

1. Pick a file.
2. Type the watermark text.
3. Configure font size, color, anchor position (9-point grid: corners, edges, center),
   rotation (-180°..180°), opacity, and whether it draws on top of page content or behind
   it (a true watermark sits behind; a "stamp" sits on top — pdfcpu calls this `onTop`).
4. Apply to all pages or a typed page selection (same syntax as
   [extract-pages](extract-pages.md)).
5. Watermark → download.

## Engine op

```go
// internal/ops/watermark.go
type WatermarkParams struct {
    Text      string   `json:"text"`
    Selection []string `json:"selection,omitempty"` // nil/empty = all pages
    FontSize  int      `json:"fontSize"`            // points
    Color     string   `json:"color"`               // name, "#RRGGBB", or "r g b" (0..1 each)
    Position  string   `json:"position"`            // tl|tc|tr|l|c|r|bl|bc|br
    Rotation  float64  `json:"rotation"`            // degrees, -180..180
    Opacity   float64  `json:"opacity"`             // 0 (exclusive) .. 1
    OnTop     bool     `json:"onTop"`
    Password  string   `json:"password,omitempty"`
}

func AddWatermark(input []byte, p WatermarkParams, prog Progress) ([]byte, error)
```

```go
desc := fmt.Sprintf("points:%d, position:%s, rotation:%g, opacity:%g, color:%s",
    p.FontSize, p.Position, p.Rotation, p.Opacity, p.Color)
wm, err := api.TextWatermark(p.Text, desc, p.OnTop, false, types.POINTS)
// ...
err = api.AddWatermarks(bytes.NewReader(input), &out, p.Selection, wm, conf)
```

`api.TextWatermark` parses a comma-separated `key:value` description string — the same
syntax pdfcpu's own CLI uses (`points`, `position`, `rotation`, `opacity`, `color`,
`fontname`, `scalefactor`, `diagonal`, ...; see
`pdfcpu/pkg/pdfcpu/stamp.go`'s `wmParamMap`). Always sending an explicit `rotation:` key
(rather than omitting it to fall back to pdfcpu's own diagonal default) is a deliberate
choice, not an oversight — see Deferred above.

`api.AddWatermarks(rs io.ReadSeeker, w io.Writer, selectedPages []string, wm *model.Watermark, conf) error`
— fully in memory, same shape as every other op here.

## Params

| Field       | Notes                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `text`      | Required, non-empty                                                                                                       |
| `fontSize`  | Points. Must be positive                                                                                                  |
| `color`     | Anything `pdfcpu/pkg/pdfcpu/color.ParseColor` accepts: a name, `#RRGGBB`, or `r g b`                                      |
| `position`  | 9-point anchor: `tl tc tr l c r bl bc br` (top/bottom/left/right/center combinations)                                     |
| `rotation`  | -180..180 degrees. 0 means horizontal, not "unset"                                                                        |
| `opacity`   | (0, 1]. 0 would be invisible, which is never a useful watermark                                                           |
| `onTop`     | `true` draws over page content (a "stamp"); `false` draws behind it (a true watermark, can be obscured by opaque content) |
| `selection` | pdfcpu page-selection syntax, same as extract-pages/rotate. Empty means every page                                        |

## Memory

Cheap — same profile as rotate. Watermarking adds one small XObject/form per distinct
page dimension plus a content-stream reference per page; no image decoding, no
per-page multiplication of the input's own size.

## Edge cases

| Case                             | Behaviour                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty watermark text             | `ERR_INVALID_PARAMS` before the op runs                                                                                                                   |
| Font size ≤ 0                    | `ERR_INVALID_PARAMS`                                                                                                                                      |
| Opacity 0 or outside (0, 1]      | `ERR_INVALID_PARAMS` — 0 is rejected rather than silently producing an invisible watermark                                                                |
| Rotation outside -180..180       | `ERR_INVALID_PARAMS`, mirroring pdfcpu's own `parseRotation` bound                                                                                        |
| Unknown/malformed color string   | `ERR_INVALID_PARAMS`, surfacing pdfcpu's own parse error                                                                                                  |
| Selection resolves to zero pages | `ERR_UNSUPPORTED`, same as extract-pages                                                                                                                  |
| Encrypted input                  | `ERR_ENCRYPTED`                                                                                                                                           |
| Running twice with `onTop:false` | Both watermarks stack (pdfcpu appends rather than replacing) — expected, not a bug. `update-watermark` mode exists in pdfcpu but isn't exposed here in V1 |

## UI states

Idle → loaded (text field, style controls, position grid, selection field) → applying →
done → error.

## Fixtures

`plain.pdf`, `pages_10.pdf` (for selection testing), `encrypted_aes256.pdf`.
