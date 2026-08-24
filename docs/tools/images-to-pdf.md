# Images → PDF

**Route** `/images-to-pdf` · **Phase** 2 · **Engine** Go

## Purpose

Combine JPG/PNG/WebP/TIFF images into a single PDF. Goes to **Go**, not JS, because
`api.ImportImages` accepts `[]io.Reader` directly and handles page sizing, orientation and
format detection — work that JS libraries do worse and slower.

## User flow

1. Drop images (batch).
2. Drag to reorder, remove individually, rotate.
3. Choose page size (A4 / Letter / fit-to-image), orientation, margin.
4. Create → download.

## Engine op

```go
// internal/ops/importimages.go
type ImagesToPDFParams struct {
    PageSize    string `json:"pageSize"`    // "A4" | "Letter" | "fit"
    Orientation string `json:"orientation"` // "portrait" | "landscape" | "auto"
    Margin      int    `json:"margin"`      // points
    Scale       string `json:"scale"`       // pdfcpu import scale descriptor
}

func ImagesToPDF(images [][]byte, p ImagesToPDFParams) ([]byte, error)
```

```go
readers := make([]io.Reader, len(images))
for i, b := range images { readers[i] = bytes.NewReader(b) }

imp := api.DefaultImportConfig()
// configure via api.Import(descriptor, unit) for size/pos/scale, e.g. "f:A4, pos:c, s:1.0"

var out bytes.Buffer
err := api.ImportImages(nil, &out, readers, imp, conf)
```

`api.ImportImages(rs io.ReadSeeker, w io.Writer, imgs []io.Reader, imp *pdfcpu.Import, conf) error`
— passing `nil` as `rs` creates a new document; passing an existing one appends. That
second form gives us "append images to an existing PDF" for free, which is worth exposing.

`api.Import(s string, u types.DisplayUnit) (*pdfcpu.Import, error)` parses pdfcpu's
descriptor syntax. Use it rather than constructing the struct by hand — the descriptor
grammar is what pdfcpu's own tests cover.

## Supported input formats

pdfcpu v0.15.0 links JPEG, PNG, TIFF (`github.com/hhrutter/tiff`) and WebP
(`golang.org/x/image/webp`). All four are already in the 6.3 MB Wasm binary — no
additional cost to supporting them.

HEIC is **not** supported and matters for iPhone users. The browser can often decode HEIC
via `createImageBitmap` and re-encode to JPEG on the JS side before handing bytes to Go.
Worth doing in Phase 4; detect and give a clear message in V1.

## Memory

Scales with the _decoded_ size of the images, not their file size. A 12 MP JPEG is 3 MB on
disk and 36 MB decoded.

- Guard total decoded size against the device tier before starting.
- pdfcpu embeds JPEGs without re-encoding where possible, which keeps peak lower than
  a naive decode-all approach.
- PNG with alpha becomes an SMask in the PDF — larger output, and a case the compress tool
  will later skip. Mention the size implication when alpha is present.

## Edge cases

| Case                      | Behaviour                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed orientations        | `orientation: "auto"` picks per image. Default to it                                                                                   |
| Very large image (>50 MP) | Guard before decode; `ERR_TOO_LARGE`                                                                                                   |
| Animated GIF / WebP       | Use the first frame; say so                                                                                                            |
| HEIC input                | V1: clear "not supported, convert to JPEG first". Phase 4: browser-side transcode                                                      |
| CMYK JPEG                 | pdfcpu handles it; verify colours against a fixture — CMYK round-trips are a classic source of wrong colours                           |
| Zero images               | Disable the button                                                                                                                     |
| Image with EXIF rotation  | **Check this explicitly.** If pdfcpu ignores EXIF orientation, phone photos land sideways — a very visible bug with a very quiet cause |
| Transparent PNG           | Becomes an SMask; warn about file size                                                                                                 |

## UI states

Idle → images staged (reorderable thumbnails, per-image rotate) → configuring (page size,
orientation, margin, live preview) → creating → done → error.

## Fixtures

`photo_exif_rotated.jpg`, `alpha.png`, `cmyk.jpg`, `animated.webp`, `scan.tiff`,
`huge_60mp.jpg`, plus a mixed-orientation set.
