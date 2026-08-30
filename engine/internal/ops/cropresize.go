package ops

import (
	"bytes"
	"fmt"
	"math"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// ---------------------------------------------------------------------- crop

// CropParams configures Crop. See docs/tools/crop-resize.md.
type CropParams struct {
	// Margins in points. Positive trims that edge in; negative enlarges the
	// page instead — both are pdfcpu's own native margin-box behaviour, not
	// something added here.
	Top    float64 `json:"top"`
	Right  float64 `json:"right"`
	Bottom float64 `json:"bottom"`
	Left   float64 `json:"left"`
	// Selection is nil or empty for every page.
	Selection []string `json:"selection,omitempty"`
	Password  string   `json:"password,omitempty"`
}

// Crop sets /CropBox on selected pages (or all of them) via a margin
// definition relative to the existing media box. It does not touch page
// content — text/images outside the new crop box still exist in the file,
// just outside the area most readers respect.
func Crop(input []byte, p CropParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}
	if err := requireSelectionResolvesToPages(input, p.Selection, p.Password); err != nil {
		return nil, err
	}
	if err := validateCropMargins(input, p); err != nil {
		return nil, err
	}

	desc := fmt.Sprintf("%g %g %g %g", p.Top, p.Right, p.Bottom, p.Left)
	box, err := api.Box(desc, types.POINTS)
	if err != nil {
		return nil, bridge.Wrap(bridge.CodeInvalid, err, "invalid crop margins")
	}

	prog.report(0, 1, "cropping")

	var out bytes.Buffer
	if err := api.Crop(bytes.NewReader(input), &out, p.Selection, box, confWithPassword(p.Password)); err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "crop failed")
	}

	prog.report(1, 1, "cropping")
	return out.Bytes(), nil
}

// validateCropMargins guards against a real pdfcpu footgun: api.Crop happily
// accepts margins that add up to more than a page's own media box, producing
// a /CropBox with negative width/height rather than erroring. Confirmed
// directly against pdfcpu v0.15.0 — margins summing past a 60×80pt fixture
// silently wrote a (-140, -120) crop box with no error at all. Checked per
// selected page rather than once globally, since mixed page sizes (allowed
// throughout this codebase, e.g. merge.md's own edge case) could make a
// margin valid for one page and degenerate for another.
func validateCropMargins(input []byte, p CropParams) error {
	dims, err := api.PageDims(bytes.NewReader(input), confWithPassword(p.Password))
	if err != nil {
		return bridge.Wrap(classifyAuth(err, p.Password), err, "could not read page dimensions")
	}
	pages, err := api.PagesForPageSelection(len(dims), p.Selection, true, false)
	if err != nil {
		return bridge.Wrap(bridge.CodeInvalid, err, "invalid page selection")
	}
	for pageNr, want := range pages {
		if !want {
			continue
		}
		d := dims[pageNr-1]
		if d.Width-(p.Left+p.Right) <= 0 || d.Height-(p.Top+p.Bottom) <= 0 {
			return bridge.Errf(bridge.CodeInvalid,
				"crop margins leave nothing on page %d (%.0f×%.0fpt page, %.0fpt total horizontal margin, %.0fpt total vertical margin)",
				pageNr, d.Width, d.Height, p.Left+p.Right, p.Top+p.Bottom)
		}
	}
	return nil
}

// -------------------------------------------------------------------- resize

// ResizeParams configures Resize. See docs/tools/crop-resize.md.
type ResizeParams struct {
	// Mode selects which of Scale, PageSize, or Width+Height applies.
	Mode string `json:"mode"` // "scale" | "pageSize" | "dimensions"
	// Scale > 0 and != 1. 1 is a no-op pdfcpu itself rejects.
	Scale float64 `json:"scale,omitempty"`
	// PageSize is a pdfcpu paper-size name ("A4", "Letter", ...), optionally
	// suffixed L/P for landscape/portrait ("A4L").
	PageSize string `json:"pageSize,omitempty"`
	// Width/Height in points, "dimensions" mode only. Both must be positive.
	Width     float64  `json:"width,omitempty"`
	Height    float64  `json:"height,omitempty"`
	Selection []string `json:"selection,omitempty"`
	Password  string   `json:"password,omitempty"`
}

// Resize scales /MediaBox and page content on selected pages (or all of
// them) — an actual reflow of page geometry, unlike Crop's viewport-only
// change.
func Resize(input []byte, p ResizeParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}
	if err := requireSelectionResolvesToPages(input, p.Selection, p.Password); err != nil {
		return nil, err
	}

	resize, err := buildResizeConfig(p)
	if err != nil {
		return nil, err
	}

	prog.report(0, 1, "resizing")

	var out bytes.Buffer
	if err := api.Resize(bytes.NewReader(input), &out, p.Selection, resize, confWithPassword(p.Password)); err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "resize failed")
	}

	prog.report(1, 1, "resizing")
	return out.Bytes(), nil
}

func buildResizeConfig(p ResizeParams) (*model.Resize, error) {
	switch p.Mode {
	case "scale":
		if p.Scale <= 0 || math.IsNaN(p.Scale) || math.IsInf(p.Scale, 0) {
			return nil, bridge.Errf(bridge.CodeInvalid, "scale must be a positive, finite number, got %v", p.Scale)
		}
		if p.Scale == 1 {
			return nil, bridge.Errf(bridge.CodeInvalid, "scale of 1 has no effect")
		}
		return &model.Resize{Scale: p.Scale}, nil

	case "pageSize":
		dim, _, err := types.ParsePageFormat(p.PageSize)
		if err != nil {
			return nil, bridge.Wrap(bridge.CodeInvalid, err, "invalid page size %q", p.PageSize)
		}
		// PageSize (not just PageDim) must be set: model.Resize.EnforceOrientation()
		// checks for a trailing L/P suffix on THIS field to decide whether an
		// explicit landscape/portrait request overrides auto-orientation-matching
		// against the source page. Leaving it unset silently undid "A4L" back to
		// portrait in testing — confirmed directly, not a guess.
		return &model.Resize{PageDim: dim, PageSize: p.PageSize}, nil

	case "dimensions":
		if p.Width <= 0 || p.Height <= 0 {
			return nil, bridge.Errf(bridge.CodeInvalid, "width and height must both be positive")
		}
		return &model.Resize{PageDim: &types.Dim{Width: p.Width, Height: p.Height}}, nil

	default:
		return nil, bridge.Errf(bridge.CodeInvalid, "unknown resize mode %q", p.Mode)
	}
}
