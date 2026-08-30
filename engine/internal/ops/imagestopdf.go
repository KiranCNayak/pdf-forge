package ops

import (
	"bytes"
	"io"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// ImagesToPDFParams configures ImagesToPDF. See docs/tools/images-to-pdf.md.
type ImagesToPDFParams struct {
	// "A4" | "Letter" | "fit" | "exact". "fit" sizes each page to match its
	// own image exactly in PIXEL units treated as points — no scaling, no
	// distortion, no shared page size across a mixed batch, but NOT
	// physically accurate if the image came from rendering a real page at a
	// given DPI (see "exact" below, which is). "exact" sizes the page to
	// Width/Height in POINTS regardless of the image's own pixel dimensions
	// — for a caller (Redact) that already knows the true physical page size
	// and is handing over a raster of it. See docs/tools/redact.md.
	PageSize string `json:"pageSize"`
	// "portrait" | "landscape". Ignored when PageSize is "fit" or "exact"
	// (the image's own orientation IS the page's orientation there). No
	// "auto" in V1 — see the doc comment on Import below for why.
	Orientation string `json:"orientation"`
	// Points. Only used when PageSize is "exact"; applied to every image in
	// the batch (same shared-config limitation as A4/Letter — see the doc
	// comment on Import below).
	Width  float64 `json:"width,omitempty"`
	Height float64 `json:"height,omitempty"`
}

// ImagesToPDF combines JPEG/PNG/TIFF/WebP images into one PDF, one image per
// page, in the order given.
//
// V1 departures from docs/tools/images-to-pdf.md, documented rather than cut
// silently:
//   - No "auto" orientation. The doc's default recommendation is per-image
//     auto-orientation, but that needs each image's own pixel dimensions
//     decoded up front, and pdfcpu's Import config is shared across an
//     entire ImportImages call — auto would mean one API call per image
//     (chaining output as input) instead of one call for the whole batch.
//     "fit" gets auto-orientation for free (see below) and covers the same
//     need for a mixed-orientation batch; "portrait"/"landscape" pick one
//     fixed orientation for A4/Letter. Revisit if real usage wants shared
//     paper size AND per-image orientation together.
//   - No margin or scale controls. Images fill as much of the page as their
//     aspect ratio allows (Scale: 1.0, Center-anchored) with no separate
//     margin knob.
//   - No >50MP guard before decoding (the doc's ERR_TOO_LARGE case) — would
//     need the same up-front pixel-dimension read the auto-orientation cut
//     avoids. pdfcpu will simply take longer and use more memory on a huge
//     image rather than refusing it cleanly.
//
// "fit" is genuinely free, not a workaround: pdfcpu's own NewPagesForImage
// sizes the PAGE to the image's own pixel dimensions whenever imp.Pos is its
// default, types.Full — see importImage.go in the vendored source. Anything
// other than Full switches to a fixed imp.PageDim, aspect-ratio-preserved
// and scaled by imp.Scale within it. That's the one paragraph of pdfcpu
// internals worth knowing before touching this file.
func ImagesToPDF(images [][]byte, p ImagesToPDFParams, prog Progress) ([]byte, error) {
	if len(images) == 0 {
		return nil, bridge.Errf(bridge.CodeInvalid, "no images provided")
	}
	for i, img := range images {
		if len(img) == 0 {
			return nil, bridge.Errf(bridge.CodeInvalid, "image %d is empty", i+1)
		}
		if looksLikeHEIC(img) {
			return nil, bridge.Errf(bridge.CodeUnsupported,
				"image %d looks like HEIC, which isn't supported yet — convert it to JPEG first", i+1)
		}
	}

	imp := api.DefaultImportConfig() // Pos: types.Full — see the doc comment above.
	switch p.PageSize {
	case "", "fit":
		// Leave imp as the untouched default: Pos stays Full, so each page
		// is sized to its own image.
	case "A4", "Letter":
		dim := *types.PaperSize[p.PageSize] // copy — PaperSize entries are shared pointers
		if p.Orientation == "landscape" {
			dim.Width, dim.Height = dim.Height, dim.Width
		} else if p.Orientation != "" && p.Orientation != "portrait" {
			return nil, bridge.Errf(bridge.CodeInvalid, "orientation must be \"portrait\" or \"landscape\", got %q", p.Orientation)
		}
		imp.PageDim = &dim
		imp.PageSize = p.PageSize
		imp.Pos = types.Center
		imp.Scale = 1.0
	case "exact":
		if p.Width <= 0 || p.Height <= 0 {
			return nil, bridge.Errf(bridge.CodeInvalid, "exact page size requires positive width and height, got %gx%g", p.Width, p.Height)
		}
		// Deliberately leave imp.PageSize ("") unset — nothing in the import
		// path reads that string (unlike model.Resize.EnforceOrientation,
		// which docs/tools/crop-resize.md already documents getting bitten
		// by exactly this kind of "set the string too" requirement).
		// importImagePDFBytes only ever reads PageDim/Pos/Scale.
		imp.PageDim = &types.Dim{Width: p.Width, Height: p.Height}
		imp.Pos = types.Center
		imp.Scale = 1.0
	default:
		return nil, bridge.Errf(bridge.CodeInvalid, "unknown page size %q", p.PageSize)
	}

	readers := make([]io.Reader, len(images))
	for i, b := range images {
		readers[i] = bytes.NewReader(b)
	}

	prog.report(0, 1, "importing")

	var out bytes.Buffer
	if err := api.ImportImages(nil, &out, readers, imp, conf()); err != nil {
		return nil, bridge.Wrap(bridge.Classify(err), err, "images to pdf failed")
	}

	prog.report(1, 1, "importing")
	return out.Bytes(), nil
}

// looksLikeHEIC sniffs the ISO base media file format's "ftyp" box for a
// HEIC/HEIF brand, without pulling in a real container parser — we only
// need to say "not supported" clearly, not decode it.
func looksLikeHEIC(b []byte) bool {
	if len(b) < 12 || string(b[4:8]) != "ftyp" {
		return false
	}
	switch string(b[8:12]) {
	case "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1":
		return true
	}
	return false
}
