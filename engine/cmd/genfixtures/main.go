// Command genfixtures produces test PDFs.
//
// Fixtures are generated rather than committed wholesale: a repo carrying large
// binary PDFs is its own maintenance problem, and a generator documents exactly
// what makes each fixture interesting. The two small samples under
// web/public/fixtures/ are committed so the browser smoke test works straight
// after a clone; anything large is generated on demand.
//
//	go run ./cmd/genfixtures -out ../web/public/fixtures
//	go run ./cmd/genfixtures -out /tmp/big -pages 500
package main

import (
	"bytes"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func conf() *model.Configuration {
	c := model.NewDefaultConfiguration()
	c.ValidationMode = model.ValidationRelaxed
	c.CheckFileNameExt = false
	return c
}

func solidPNG(w, h int, c color.Color) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	err := png.Encode(&buf, img)
	return buf.Bytes(), err
}

// build makes a PDF with the requested number of pages by importing images.
// imgW/imgH control how heavy the embedded images are, which is what makes a
// fixture useful for compression testing later.
func build(path string, pages, imgW, imgH int) error {
	shades := []color.Color{
		color.RGBA{200, 40, 40, 255},
		color.RGBA{40, 160, 90, 255},
		color.RGBA{50, 90, 200, 255},
	}

	imgs := make([]io.Reader, 0, pages)
	for i := range pages {
		b, err := solidPNG(imgW, imgH, shades[i%len(shades)])
		if err != nil {
			return err
		}
		imgs = append(imgs, bytes.NewReader(b))
	}

	var out bytes.Buffer
	if err := api.ImportImages(nil, &out, imgs, api.DefaultImportConfig(), conf()); err != nil {
		return err
	}
	if err := os.WriteFile(path, out.Bytes(), 0o644); err != nil {
		return err
	}
	fmt.Printf("%-40s %4d pages  %d bytes\n", path, pages, out.Len())
	return nil
}

func main() {
	out := flag.String("out", ".", "output directory")
	pages := flag.Int("pages", 0, "if set, generate a single N-page fixture instead of the standard set")
	flag.Parse()

	if err := os.MkdirAll(*out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	var err error
	if *pages > 0 {
		err = build(filepath.Join(*out, fmt.Sprintf("pages-%d.pdf", *pages)), *pages, 600, 800)
	} else {
		// The standard pair used by the browser smoke test. Deliberately tiny.
		if err = build(filepath.Join(*out, "sample-a.pdf"), 3, 120, 160); err == nil {
			err = build(filepath.Join(*out, "sample-b.pdf"), 2, 120, 160)
		}
	}

	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
