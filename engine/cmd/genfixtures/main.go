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
//	go run ./cmd/genfixtures -out ../web/e2e/fixtures -redact
//	go run ./cmd/genfixtures -out ../web/e2e/fixtures -adversarial
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

	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
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

// buildRedactFixture makes a one-page PDF with real vector text (not an
// image) in two known, well-separated corners: "SECRET-9F3A1B47" bottom-left
// and "PUBLIC-KEEP-VISIBLE" top-right. web/e2e/redact.spec.ts draws its
// redaction box over the bottom-left quadrant only, then asserts the raw
// output bytes never contain "9F3A1B47" while the top-right text's presence
// (as pixels, not text — see docs/tools/redact.md) is left alone. Reuses the
// same ops AddWatermark's own tool already calls — this file just chains
// them the way an e2e fixture generator, not a shipped tool, is allowed to.
func buildRedactFixture(path string) error {
	white, err := solidPNG(850, 1100, color.RGBA{255, 255, 255, 255}) // US Letter @ 100dpi
	if err != nil {
		return err
	}
	base, err := ops.ImagesToPDF([][]byte{white}, ops.ImagesToPDFParams{PageSize: "fit"}, nil)
	if err != nil {
		return fmt.Errorf("base page: %w", err)
	}

	stamped, err := ops.AddWatermark(base, ops.WatermarkParams{
		Text: "SECRET-9F3A1B47", FontSize: 28, Color: "#cc0000", Position: "bl", Rotation: 0, Opacity: 1, OnTop: true,
	}, nil)
	if err != nil {
		return fmt.Errorf("secret stamp: %w", err)
	}

	stamped, err = ops.AddWatermark(stamped, ops.WatermarkParams{
		Text: "PUBLIC-KEEP-VISIBLE", FontSize: 28, Color: "#006600", Position: "tr", Rotation: 0, Opacity: 1, OnTop: true,
	}, nil)
	if err != nil {
		return fmt.Errorf("public stamp: %w", err)
	}

	if err := os.WriteFile(path, stamped, 0o644); err != nil {
		return err
	}
	fmt.Printf("%-40s %d bytes\n", path, len(stamped))
	return nil
}

// buildAdversarialFixtures makes the four fixtures `web/e2e/redact-adversarial.spec.ts`
// needs — each one exists to exercise exactly one thing `redact.spec.ts`'s single
// plain fixture can't:
//
//   - adv-rot90.pdf: a /Rotate 90 page with "SECRET-ROT90AA" bottom-left and
//     "PUBLIC-ROT90BB" top-right BEFORE rotation — tests whether a box drawn over the
//     already-rotated preview lands on the same content in the (separately re-rendered,
//     possibly different-DPI) output pass.
//   - adv-multi5.pdf: five pages, each stamped at its own centre with its own page
//     number ("PAGE1SECRET-M1X" … "PAGE5SECRET-M5X") — tests page→box mapping and page
//     ORDER across a real multi-page document, not just page 1.
//   - adv-encrypted.pdf: a password-protected source with a secret — tests that the
//     password → render → redact pipeline actually decodes and rasterizes the real
//     content, rather than failing soft into a blank page that merely looks redacted.
//   - adv-mixed.pdf: two pages of different physical size (Letter, then A5) — the ONLY
//     thing that exercises `imagesToPDF`'s per-page fallback + `merge` branch in
//     Redact's tool.tsx, which otherwise has zero coverage (see docs/tools/redact.md).
//
// Every stamp uses AddWatermark and every page uses ImagesToPDF's "exact" mode — the
// same two ops Redact itself is built on, so these fixtures are provably real vector
// text and provably the right physical page size, not something this generator merely
// asserts.
func buildAdversarialFixtures(dir string) error {
	whiteImg := func(wPt, hPt float64) ([]byte, error) {
		return solidPNG(int(wPt*2), int(hPt*2), color.RGBA{255, 255, 255, 255})
	}
	page := func(wPt, hPt float64) ([]byte, error) {
		img, err := whiteImg(wPt, hPt)
		if err != nil {
			return nil, err
		}
		return ops.ImagesToPDF([][]byte{img}, ops.ImagesToPDFParams{PageSize: "exact", Width: wPt, Height: hPt}, nil)
	}
	stamp := func(in []byte, text, pos string, sel []string) ([]byte, error) {
		return ops.AddWatermark(in, ops.WatermarkParams{
			Text: text, FontSize: 24, Color: "#cc0000", Position: pos,
			Rotation: 0, Opacity: 1, OnTop: true, Selection: sel,
		}, nil)
	}
	write := func(name string, b []byte) error {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			return err
		}
		fmt.Printf("%-40s %d bytes\n", p, len(b))
		return nil
	}

	// 1. Rotated.
	rot, err := page(612, 792)
	if err != nil {
		return err
	}
	if rot, err = stamp(rot, "SECRET-ROT90AA", "bl", nil); err != nil {
		return err
	}
	if rot, err = stamp(rot, "PUBLIC-ROT90BB", "tr", nil); err != nil {
		return err
	}
	if rot, err = ops.Rotate(rot, ops.RotateParams{Rotation: 90}, nil); err != nil {
		return err
	}
	if err := write("adv-rot90.pdf", rot); err != nil {
		return err
	}

	// 2. Five pages, one secret per page.
	multi, err := page(612, 792)
	if err != nil {
		return err
	}
	for range 4 {
		next, err := page(612, 792)
		if err != nil {
			return err
		}
		if multi, err = ops.Merge([][]byte{multi, next}, ops.MergeParams{}, nil); err != nil {
			return err
		}
	}
	for i := 1; i <= 5; i++ {
		if multi, err = stamp(multi, fmt.Sprintf("PAGE%dSECRET-M%dX", i, i), "c", []string{fmt.Sprint(i)}); err != nil {
			return err
		}
	}
	if err := write("adv-multi5.pdf", multi); err != nil {
		return err
	}

	// 3. Encrypted.
	enc, err := page(612, 792)
	if err != nil {
		return err
	}
	if enc, err = stamp(enc, "SECRET-ENC77CC", "bl", nil); err != nil {
		return err
	}
	if enc, err = stamp(enc, "PUBLIC-ENC88DD", "tr", nil); err != nil {
		return err
	}
	if enc, err = ops.Encrypt(enc, ops.EncryptParams{UserPW: "hunter2", KeyLength: 256}, nil); err != nil {
		return err
	}
	if err := write("adv-encrypted.pdf", enc); err != nil {
		return err
	}

	// 4. Mixed page sizes (Letter + A5).
	a, err := page(612, 792)
	if err != nil {
		return err
	}
	if a, err = stamp(a, "SECRET-MIXAA11", "bl", nil); err != nil {
		return err
	}
	b, err := page(420, 595)
	if err != nil {
		return err
	}
	if b, err = stamp(b, "SECRET-MIXBB22", "bl", nil); err != nil {
		return err
	}
	mixed, err := ops.Merge([][]byte{a, b}, ops.MergeParams{}, nil)
	if err != nil {
		return err
	}
	return write("adv-mixed.pdf", mixed)
}

func main() {
	out := flag.String("out", ".", "output directory")
	pages := flag.Int("pages", 0, "if set, generate a single N-page fixture instead of the standard set")
	redact := flag.Bool("redact", false, "generate redact-secret.pdf instead of the standard set")
	adversarial := flag.Bool("adversarial", false, "generate the four adv-*.pdf fixtures redact-adversarial.spec.ts needs")
	flag.Parse()

	if err := os.MkdirAll(*out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	var err error
	switch {
	case *redact:
		err = buildRedactFixture(filepath.Join(*out, "redact-secret.pdf"))
	case *adversarial:
		err = buildAdversarialFixtures(*out)
	case *pages > 0:
		err = build(filepath.Join(*out, fmt.Sprintf("pages-%d.pdf", *pages)), *pages, 600, 800)
	default:
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
