package ops

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// ---------------------------------------------------------------- fixtures
//
// docs/tools/compress.md §Fixtures names a corpus; these are the ones that can
// be generated honestly in Go. Missing, and why:
//
//   - jpeg2000.pdf — Go cannot encode JPX either, so we cannot build one.
//     The skip branch is covered by classifyImage's unit test instead.
//   - huge_image_60mp.pdf — 60 MP RGBA is 240 MB of test fixture. The guard is
//     exercised by lowering maxImagePixels instead.

// photoPNG builds an image that does not compress to nothing: flat colour would
// make a Flate stream tiny and every "did it shrink" assertion meaningless.
func photoPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	seed := uint32(1)
	for y := range h {
		for x := range w {
			seed = seed*1664525 + 1013904223
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), uint8(seed >> 24), 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return b.Bytes()
}

// alphaPNG carries a soft mask, which pdfcpu imports as /SMask.
func alphaPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 120, uint8(x % 200)})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return b.Bytes()
}

// bilevelPNG has a two-colour palette, which the PNG encoder writes at 1 bit
// per pixel — the stencil case.
func bilevelPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	pal := color.Palette{color.Black, color.White}
	img := image.NewPaletted(image.Rect(0, 0, w, h), pal)
	for y := range h {
		for x := range w {
			img.SetColorIndex(x, y, uint8((x+y)%2))
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return b.Bytes()
}

// imagePDF puts each image on its own A4 page, scaled to fill it. Page size
// matters: effective DPI is derived from it, and an image imported at its
// natural size would sit at exactly 72 DPI and be skipped by every preset.
func imagePDF(t *testing.T, images ...[]byte) []byte {
	t.Helper()

	imp, err := api.Import("papersize:A4, pos:c, scalefactor:1.0", types.POINTS)
	if err != nil {
		t.Fatalf("import config: %v", err)
	}

	rs := make([]io.Reader, 0, len(images))
	for _, b := range images {
		rs = append(rs, bytes.NewReader(b))
	}

	var out bytes.Buffer
	if err := api.ImportImages(nil, &out, rs, imp, conf()); err != nil {
		t.Fatalf("build image fixture: %v", err)
	}
	return out.Bytes()
}

// textOnlyPDF has no images at all: only the structural pass can help it, and
// the saving is honestly small. This is the shape we lose to Ghostscript on,
// because we do not subset fonts. docs/LLD.md §3.4.
func textOnlyPDF(t *testing.T) []byte {
	t.Helper()

	const spec = `{"pages":{"1":{"content":{"text":[
		{"value":"pdf-forge compress fixture","anchor":"center","font":{"name":"Helvetica","size":24}}
	]}}}}`

	var out bytes.Buffer
	if err := api.Create(nil, strings.NewReader(spec), &out, conf()); err != nil {
		t.Fatalf("build text fixture: %v", err)
	}
	return out.Bytes()
}

// imageStubFor builds the metadata-only view of an image that classifyImage
// sees, with everything but the filter set to "ordinary photo on page 1".
func imageStubFor(filter string) model.Image {
	return model.Image{
		PageNr: 1,
		Width:  1240,
		Height: 1754,
		Bpc:    8,
		Cs:     "DeviceRGB",
		Comp:   3,
		Filter: filter,
		Size:   1 << 20,
	}
}

func mustCompress(t *testing.T, in []byte, p CompressParams) CompressResult {
	t.Helper()
	res, err := Compress(in, p, nil)
	if err != nil {
		t.Fatalf("compress: %v", err)
	}
	if _, err := PageCount(res.Bytes, ""); err != nil {
		t.Fatalf("output is not a readable PDF: %v", err)
	}
	return res
}

// ---------------------------------------------------------------- happy path

func TestCompressShrinksImageHeavyPDF(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 1240, 1754))
	res := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "ebook"})

	if res.Fallback {
		t.Fatalf("expected a real saving, got the fallback: %d → %d", res.OriginalSize, res.ResultSize)
	}
	if res.ResultSize >= res.OriginalSize {
		t.Fatalf("output not smaller: %d → %d", res.OriginalSize, res.ResultSize)
	}
	if res.ImagesTouched != 1 {
		t.Fatalf("images touched = %d, want 1 (skips: %v)", res.ImagesTouched, res.SkipReasons)
	}
	if res.OriginalSize != int64(len(in)) {
		t.Fatalf("originalSize %d, want %d", res.OriginalSize, len(in))
	}
}

func TestCompressPreservesPageCount(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 900, 1200), photoPNG(t, 900, 1200), photoPNG(t, 900, 1200))
	res := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "screen"})

	if got := mustPageCount(t, res.Bytes, ""); got != 3 {
		t.Fatalf("page count %d, want 3", got)
	}
}

func TestCompressMoreAggressivePresetIsSmaller(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 1240, 1754))

	screen := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "screen"})
	prepress := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "prepress"})

	// Monotonicity is not cosmetic: target mode binary-searches the ladder and
	// the search is only correct if more aggressive really means smaller.
	if screen.ResultSize >= prepress.ResultSize {
		t.Fatalf("screen (%d) should be smaller than prepress (%d)", screen.ResultSize, prepress.ResultSize)
	}
}

func TestCompressDefaultsToEbookPreset(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 1240, 1754))

	blank := mustCompress(t, in, CompressParams{})
	ebook := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "ebook"})

	if blank.ResultSize != ebook.ResultSize {
		t.Fatalf("empty params gave %d, ebook gave %d", blank.ResultSize, ebook.ResultSize)
	}
}

func TestCompressReportsProgress(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 900, 1200))

	stages := map[string]bool{}
	_, err := Compress(in, CompressParams{Mode: "preset", Preset: "screen"},
		func(_, _ int, stage string) { stages[stage] = true })
	if err != nil {
		t.Fatalf("compress: %v", err)
	}

	for _, want := range []string{"optimising", "images"} {
		if !stages[want] {
			t.Fatalf("no progress reported for stage %q (saw %v)", want, stages)
		}
	}
}

// ---------------------------------------------------------------- edge cases

func TestCompressTextOnlyDocument(t *testing.T) {
	in := textOnlyPDF(t)
	res := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "ebook"})

	if res.ImagesTouched != 0 || res.ImagesSkipped != 0 {
		t.Fatalf("text-only document reported images: touched=%d skipped=%d",
			res.ImagesTouched, res.ImagesSkipped)
	}
	// No claim about the size: with no images and no font subsetting there may
	// be nothing to win, in which case the fallback is the correct answer.
}

func TestCompressIsEffectivelyIdempotent(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 1240, 1754))
	once := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "screen"})

	twice := mustCompress(t, once.Bytes, CompressParams{Mode: "preset", Preset: "screen"})
	if twice.ImagesTouched != 0 {
		t.Fatalf("re-compressed %d images that were already at the target DPI (%v)",
			twice.ImagesTouched, twice.SkipReasons)
	}
	if twice.SkipReasons[SkipLowDPI] == 0 {
		t.Fatalf("expected the second pass to skip on DPI, got %v", twice.SkipReasons)
	}
	if twice.ResultSize > twice.OriginalSize {
		t.Fatalf("second pass grew the file: %d → %d", twice.OriginalSize, twice.ResultSize)
	}
}

func TestCompressReturnsOriginalWhenItCannotWin(t *testing.T) {
	// A tiny document has nothing to give: object and xref streams cost more
	// than they save. Returning the bigger output would be a bug — ihatepdf
	// flags the same case as wasFallback. docs/tools/compress.md.
	in := textOnlyPDF(t)
	res := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "screen"})

	if !res.Fallback {
		t.Skipf("this fixture compressed after all (%d → %d); fallback untested",
			res.OriginalSize, res.ResultSize)
	}
	if !bytes.Equal(res.Bytes, in) {
		t.Fatal("fallback must return the input bytes untouched")
	}
	if res.ResultSize != res.OriginalSize {
		t.Fatalf("fallback sizes disagree: %d vs %d", res.ResultSize, res.OriginalSize)
	}
}

func TestCompressStripsMetadata(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 900, 1200))

	var withInfo bytes.Buffer
	err := api.AddProperties(bytes.NewReader(in), &withInfo,
		map[string]string{"Author": "Jane Doe", "Department": "Accounts"}, conf())
	if err != nil {
		t.Fatalf("seed properties: %v", err)
	}

	res := mustCompress(t, withInfo.Bytes(), CompressParams{Mode: "preset", Preset: "screen"})
	if res.Fallback {
		t.Skip("fell back to the original, so nothing was stripped")
	}

	props, err := api.Properties(bytes.NewReader(res.Bytes), conf())
	if err != nil {
		t.Fatalf("read properties: %v", err)
	}
	if len(props) != 0 {
		t.Fatalf("metadata survived compression: %v", props)
	}
}

// ---------------------------------------------------------------- skip rules

func TestCompressSkipsTransparency(t *testing.T) {
	in := imagePDF(t, alphaPNG(t, 1240, 1754))
	res := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "screen"})

	// An /SMask image re-encoded as JPEG loses its alpha and renders as black
	// boxes. Skipping is the whole point. docs/LLD.md §3.1.
	if res.SkipReasons[SkipTransparency] == 0 {
		t.Fatalf("expected a transparency skip, got %v", res.SkipReasons)
	}
}

func TestCompressSkipsWhenReencodeWouldBeLarger(t *testing.T) {
	// A dithered two-colour image is the worst case for JPEG: the re-encode
	// comes out bigger than the Flate original. Shipping it would be a loss
	// dressed up as compression.
	in := imagePDF(t, bilevelPNG(t, 1240, 1754))
	res := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "screen"})

	if res.SkipReasons[SkipNoGain] == 0 {
		t.Fatalf("expected a noGain skip, got %v", res.SkipReasons)
	}
	if res.ImagesTouched != 0 {
		t.Fatalf("touched %d images that would have grown", res.ImagesTouched)
	}
}

func TestCompressSkipsImagesAlreadyBelowTargetDPI(t *testing.T) {
	// 300 px across an A4 page is roughly 36 DPI — below every preset.
	in := imagePDF(t, photoPNG(t, 300, 424))
	res := mustCompress(t, in, CompressParams{Mode: "preset", Preset: "printer"})

	if res.SkipReasons[SkipLowDPI] == 0 {
		t.Fatalf("expected an alreadyLowDPI skip, got %v", res.SkipReasons)
	}
}

func TestClassifyImageSkipsUndecodableFilters(t *testing.T) {
	// JPEG 2000 and JBIG2 cannot be built from Go, so the rule is asserted
	// directly rather than through a fixture.
	dims := []types.Dim{{Width: 595, Height: 842}}
	s := presets["screen"]

	for _, tc := range []struct {
		filter string
		want   string
	}{
		{"JPXDecode", SkipJPEG2000},
		{"JBIG2Decode", SkipUnsupported},
		{"CCITTFaxDecode", SkipUnsupported},
		{"FlateDecode", ""}, // the control: a normal image is a candidate
	} {
		img := imageStubFor(tc.filter)
		got, _, err := classifyImage(img, dims, s)
		if err != nil {
			t.Fatalf("%s: unexpected error %v", tc.filter, err)
		}
		if got != tc.want {
			t.Fatalf("%s: skip reason %q, want %q", tc.filter, got, tc.want)
		}
	}
}

// TestClassifyImageSkipRules covers the branches no Go-generated fixture can
// reach: pdfcpu normalises 1-bit and stencil images on import, so the rule is
// asserted against the metadata it would see in the wild.
func TestClassifyImageSkipRules(t *testing.T) {
	dims := []types.Dim{{Width: 595, Height: 842}}
	s := presets["screen"]

	for name, tc := range map[string]struct {
		mutate func(*model.Image)
		want   string
	}{
		"soft mask":     {func(i *model.Image) { i.HasSMask = true }, SkipTransparency},
		"stencil mask":  {func(i *model.Image) { i.HasImgMask = true }, SkipTransparency},
		"image mask":    {func(i *model.Image) { i.IsImgMask = true }, SkipStencil},
		"one bit":       {func(i *model.Image) { i.Bpc = 1 }, SkipStencil},
		"thumbnail":     {func(i *model.Image) { i.Thumb = true }, SkipThumbnail},
		"zero width":    {func(i *model.Image) { i.Width = 0 }, SkipUnsupported},
		"below the dpi": {func(i *model.Image) { i.Width, i.Height = 300, 424 }, SkipLowDPI},
		"ordinary":      {func(*model.Image) {}, ""},
	} {
		img := imageStubFor("FlateDecode")
		tc.mutate(&img)

		got, target, err := classifyImage(img, dims, s)
		if err != nil {
			t.Fatalf("%s: unexpected error %v", name, err)
		}
		if got != tc.want {
			t.Fatalf("%s: skip reason %q, want %q", name, got, tc.want)
		}
		if got == "" && (target.X <= 0 || target.X >= img.Width) {
			t.Fatalf("%s: target width %d makes no sense for a %d px image", name, target.X, img.Width)
		}
	}
}

func TestCompressGuardsHugeImages(t *testing.T) {
	// An OOM inside Wasm kills the worker with no usable error, so the guard
	// fires before the decode rather than after it.
	defer func(v int) { maxImagePixels = v }(maxImagePixels)
	maxImagePixels = 1000

	in := imagePDF(t, photoPNG(t, 1240, 1754))
	_, err := Compress(in, CompressParams{Mode: "preset", Preset: "screen"}, nil)
	assertCode(t, err, bridge.CodeTooLarge)
}

// ---------------------------------------------------------------- target mode

func TestCompressTargetReachable(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 1240, 1754))

	const target = 200 * 1024
	res := mustCompress(t, in, CompressParams{Mode: "target", TargetBytes: target})

	if !res.ReachedTarget {
		t.Fatalf("target %d not reached, got %d", target, res.ResultSize)
	}
	if res.ResultSize > target {
		t.Fatalf("reachedTarget set but result is %d > %d", res.ResultSize, target)
	}
}

func TestCompressTargetUnreachableIsHonest(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 1240, 1754))

	res := mustCompress(t, in, CompressParams{Mode: "target", TargetBytes: 1024})
	if res.ReachedTarget {
		t.Fatal("claimed to reach a 1 KB target")
	}
	if res.ResultSize >= res.OriginalSize {
		t.Fatalf("best effort should still be smaller: %d → %d", res.OriginalSize, res.ResultSize)
	}
}

func TestCompressTargetAlreadyMetReturnsOriginal(t *testing.T) {
	in := textOnlyPDF(t)

	res := mustCompress(t, in, CompressParams{Mode: "target", TargetBytes: int64(len(in)) * 10})
	if !res.ReachedTarget {
		t.Fatalf("a target ten times the file size should always be reached (size %d)", res.ResultSize)
	}
}

// ---------------------------------------------------------------- error codes

func TestCompressRejectsEmptyInput(t *testing.T) {
	_, err := Compress(nil, CompressParams{Mode: "preset", Preset: "ebook"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestCompressRejectsUnknownMode(t *testing.T) {
	_, err := Compress(imagePDF(t, photoPNG(t, 200, 200)), CompressParams{Mode: "magic"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestCompressRejectsUnknownPreset(t *testing.T) {
	_, err := Compress(imagePDF(t, photoPNG(t, 200, 200)),
		CompressParams{Mode: "preset", Preset: "tiny"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestCompressRejectsNonPositiveTarget(t *testing.T) {
	in := imagePDF(t, photoPNG(t, 200, 200))
	for _, target := range []int64{0, -1} {
		_, err := Compress(in, CompressParams{Mode: "target", TargetBytes: target}, nil)
		assertCode(t, err, bridge.CodeInvalid)
	}
}

func TestCompressRejectsGarbage(t *testing.T) {
	_, err := Compress([]byte("this is not a pdf, not even slightly"),
		CompressParams{Mode: "preset", Preset: "ebook"}, nil)
	assertCode(t, err, bridge.CodeCorrupt)
}

func TestCompressRejectsEncryptedInput(t *testing.T) {
	// There is no password parameter: an encrypted file must be unlocked with
	// remove-password first, so the UI can explain why.
	enc, err := Encrypt(imagePDF(t, photoPNG(t, 200, 200)),
		EncryptParams{UserPW: "hunter2", OwnerPW: "hunter2", KeyLength: 256}, nil)
	if err != nil {
		t.Fatalf("encrypt fixture: %v", err)
	}

	_, err = Compress(enc, CompressParams{Mode: "preset", Preset: "ebook"}, nil)
	assertCode(t, err, bridge.CodeEncrypted)
}
