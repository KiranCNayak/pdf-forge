package ops

import (
	"bytes"
	"image/color"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

func TestImagesToPDFFitSizesPageToImage(t *testing.T) {
	img := pngBytes(t, 300, 450, color.RGBA{200, 40, 40, 255})

	out, err := ImagesToPDF([][]byte{img}, ImagesToPDFParams{PageSize: "fit"}, nil)
	if err != nil {
		t.Fatalf("images to pdf: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 1 {
		t.Fatalf("expected 1 page, got %d", got)
	}

	dims, err := api.PageDims(bytes.NewReader(out), conf())
	if err != nil {
		t.Fatalf("page dims: %v", err)
	}
	// "fit" sizes the page to the image's own pixel dimensions — a 300x450
	// image should produce a 300x450pt page, not A4.
	if got := dims[0]; got.Width != 300 || got.Height != 450 {
		t.Fatalf("expected page 300x450, got %.0fx%.0f", got.Width, got.Height)
	}
}

func TestImagesToPDFExactSizesPageToGivenPoints(t *testing.T) {
	// A page rendered at, say, 200 DPI has a pixel size wildly different from
	// its point size (2550x3300 vs 612x792 for US Letter) — "exact" must use
	// the given Width/Height verbatim and ignore the image's own pixel
	// dimensions entirely, unlike "fit". Same aspect ratio here (both 3:4)
	// so the fill-exactly math (Scale: 1.0, Center) doesn't need cropping.
	img := pngBytes(t, 1700, 2200, color.RGBA{200, 40, 40, 255})

	out, err := ImagesToPDF([][]byte{img}, ImagesToPDFParams{PageSize: "exact", Width: 612, Height: 792}, nil)
	if err != nil {
		t.Fatalf("images to pdf: %v", err)
	}
	dims, err := api.PageDims(bytes.NewReader(out), conf())
	if err != nil {
		t.Fatalf("page dims: %v", err)
	}
	if got := dims[0]; got.Width != 612 || got.Height != 792 {
		t.Fatalf("expected page 612x792pt, got %.0fx%.0f", got.Width, got.Height)
	}
}

func TestImagesToPDFExactAppliesToEveryImageInBatch(t *testing.T) {
	a := pngBytes(t, 850, 1100, color.RGBA{200, 40, 40, 255})
	b := pngBytes(t, 850, 1100, color.RGBA{40, 160, 90, 255})

	out, err := ImagesToPDF([][]byte{a, b}, ImagesToPDFParams{PageSize: "exact", Width: 612, Height: 792}, nil)
	if err != nil {
		t.Fatalf("images to pdf: %v", err)
	}
	dims, err := api.PageDims(bytes.NewReader(out), conf())
	if err != nil {
		t.Fatalf("page dims: %v", err)
	}
	for i, d := range dims {
		if d.Width != 612 || d.Height != 792 {
			t.Fatalf("page %d: expected 612x792pt, got %.0fx%.0f", i+1, d.Width, d.Height)
		}
	}
}

func TestImagesToPDFExactRejectsNonPositiveDimensions(t *testing.T) {
	img := pngBytes(t, 100, 100, color.RGBA{200, 40, 40, 255})

	for _, p := range []ImagesToPDFParams{
		{PageSize: "exact", Width: 0, Height: 792},
		{PageSize: "exact", Width: 612, Height: 0},
		{PageSize: "exact", Width: -612, Height: 792},
		{PageSize: "exact", Width: 612, Height: -792},
	} {
		if _, err := ImagesToPDF([][]byte{img}, p, nil); bridge.Classify(err) != bridge.CodeInvalid {
			t.Fatalf("params %+v: expected ERR_INVALID_PARAMS, got %v", p, err)
		}
	}
}

func TestImagesToPDFMultiplePages(t *testing.T) {
	a := pngBytes(t, 100, 100, color.RGBA{200, 40, 40, 255})
	b := pngBytes(t, 100, 100, color.RGBA{40, 160, 90, 255})
	c := pngBytes(t, 100, 100, color.RGBA{50, 90, 200, 255})

	out, err := ImagesToPDF([][]byte{a, b, c}, ImagesToPDFParams{PageSize: "fit"}, nil)
	if err != nil {
		t.Fatalf("images to pdf: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 3 {
		t.Fatalf("expected 3 pages, got %d", got)
	}
}

func TestImagesToPDFA4Portrait(t *testing.T) {
	img := pngBytes(t, 600, 400, color.RGBA{50, 90, 200, 255}) // landscape image, portrait page

	out, err := ImagesToPDF([][]byte{img}, ImagesToPDFParams{PageSize: "A4", Orientation: "portrait"}, nil)
	if err != nil {
		t.Fatalf("images to pdf: %v", err)
	}
	dims, err := api.PageDims(bytes.NewReader(out), conf())
	if err != nil {
		t.Fatalf("page dims: %v", err)
	}
	if got := dims[0]; got.Width >= got.Height {
		t.Fatalf("expected a taller-than-wide A4 portrait page, got %.0fx%.0f", got.Width, got.Height)
	}
}

func TestImagesToPDFA4Landscape(t *testing.T) {
	img := pngBytes(t, 100, 100, color.RGBA{220, 190, 50, 255})

	out, err := ImagesToPDF([][]byte{img}, ImagesToPDFParams{PageSize: "A4", Orientation: "landscape"}, nil)
	if err != nil {
		t.Fatalf("images to pdf: %v", err)
	}
	dims, err := api.PageDims(bytes.NewReader(out), conf())
	if err != nil {
		t.Fatalf("page dims: %v", err)
	}
	if got := dims[0]; got.Width <= got.Height {
		t.Fatalf("expected a wider-than-tall landscape page, got %.0fx%.0f", got.Width, got.Height)
	}
}

func TestImagesToPDFDefaultsToFit(t *testing.T) {
	img := pngBytes(t, 200, 150, color.RGBA{180, 50, 220, 255})

	if _, err := ImagesToPDF([][]byte{img}, ImagesToPDFParams{}, nil); err != nil {
		t.Fatalf("images to pdf with zero-value params: %v", err)
	}
}

func TestImagesToPDFProgress(t *testing.T) {
	img := pngBytes(t, 50, 50, color.RGBA{200, 40, 40, 255})

	var calls int
	prog := Progress(func(done, total int, stage string) {
		calls++
		if stage != "importing" {
			t.Errorf("unexpected stage %q", stage)
		}
	})

	if _, err := ImagesToPDF([][]byte{img}, ImagesToPDFParams{PageSize: "fit"}, prog); err != nil {
		t.Fatalf("images to pdf: %v", err)
	}
	if calls == 0 {
		t.Fatal("expected at least one progress report")
	}
}

func TestImagesToPDFRejectsEmptyList(t *testing.T) {
	_, err := ImagesToPDF(nil, ImagesToPDFParams{PageSize: "fit"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestImagesToPDFRejectsEmptyImage(t *testing.T) {
	_, err := ImagesToPDF([][]byte{{}}, ImagesToPDFParams{PageSize: "fit"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestImagesToPDFRejectsUnknownPageSize(t *testing.T) {
	img := pngBytes(t, 50, 50, color.RGBA{200, 40, 40, 255})
	_, err := ImagesToPDF([][]byte{img}, ImagesToPDFParams{PageSize: "poster"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestImagesToPDFRejectsBadOrientation(t *testing.T) {
	img := pngBytes(t, 50, 50, color.RGBA{200, 40, 40, 255})
	_, err := ImagesToPDF([][]byte{img}, ImagesToPDFParams{PageSize: "A4", Orientation: "sideways"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestImagesToPDFRejectsHEIC(t *testing.T) {
	// Minimal ISO-BMFF "ftyp" box with a HEIC brand — enough for the sniff,
	// not a real decodable HEIC file.
	heic := append([]byte{0, 0, 0, 24}, []byte("ftypheic")...)
	heic = append(heic, make([]byte, 8)...)

	_, err := ImagesToPDF([][]byte{heic}, ImagesToPDFParams{PageSize: "fit"}, nil)
	assertCode(t, err, bridge.CodeUnsupported)
}
