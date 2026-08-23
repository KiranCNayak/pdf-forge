package ops

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"io"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// Fixtures are generated rather than committed. A repo carrying binary PDFs is
// its own maintenance problem, and generated fixtures document exactly what
// makes each one interesting.

// pngBytes builds a small solid-colour PNG.
func pngBytes(t *testing.T, w, h int, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// makePDF builds a valid n-page PDF by importing n images.
func makePDF(t *testing.T, pages int) []byte {
	t.Helper()

	shades := []color.Color{
		color.RGBA{200, 40, 40, 255},
		color.RGBA{40, 160, 90, 255},
		color.RGBA{50, 90, 200, 255},
	}

	imgs := make([]io.Reader, 0, pages)
	for i := range pages {
		imgs = append(imgs, bytes.NewReader(pngBytes(t, 60, 80, shades[i%len(shades)])))
	}

	var out bytes.Buffer
	if err := api.ImportImages(nil, &out, imgs, api.DefaultImportConfig(), conf()); err != nil {
		t.Fatalf("build %d-page fixture: %v", pages, err)
	}
	return out.Bytes()
}

// mustPageCount fails the test if the document cannot be read.
func mustPageCount(t *testing.T, b []byte, password string) int {
	t.Helper()
	n, err := PageCount(b, password)
	if err != nil {
		t.Fatalf("page count: %v", err)
	}
	return n
}
