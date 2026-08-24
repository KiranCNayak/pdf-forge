package ops

import (
	"bytes"
	"image"
	"image/draw"
	"image/jpeg"
	_ "image/png" // extracted Flate/LZW images come back as PNG
	"io"
	"math"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
	xdraw "golang.org/x/image/draw"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// Compress shrinks a PDF. See docs/tools/compress.md for the product surface and
// docs/LLD.md §3 for the pipeline.
//
// Three passes, in order:
//
//  1. structural — api.Optimize with object and xref streams: dedupe, drop
//     orphans, Flate-recompress.
//  2. imaging — downsample and re-encode embedded images to JPEG at the
//     preset's DPI and quality. This is where the savings are.
//  3. metadata — drop /Info and XMP.
//
// Deliberately absent: font subsetting. pdfcpu cannot do it, so on text-heavy
// documents with embedded fonts we lose to Ghostscript-based tools. Do not
// "fix" this here — see docs/LLD.md §3.4 for the Phase 4 plan.

// Skip reasons. These are UI copy, not diagnostics: "8 of 12 images compressed,
// 4 skipped (transparency)" is a far better answer than a mysterious 3% saving.
const (
	SkipTransparency = "transparency"    // /SMask or /Mask — re-encoding to JPEG drops alpha
	SkipStencil      = "stencil"         // 1-bit image mask; JPEG would be bigger AND worse
	SkipThumbnail    = "thumbnail"       // page thumbnails are already tiny
	SkipJPEG2000     = "jpeg2000"        // Go has no JPXDecode decoder
	SkipUnsupported  = "unsupportedType" // JBIG2, CCITT, anything image.Decode refuses
	SkipLowDPI       = "alreadyLowDPI"   // recompressing below the target degrades for nothing
	SkipNoGain       = "noGain"          // the re-encode came out larger than the original
)

// maxImagePixels guards the decode step. A 60 MP RGBA image is 240 MB decoded
// regardless of how small it is on disk, and an OOM in Wasm kills the worker
// with no usable error. A variable, not a const, so tests can lower it.
var maxImagePixels = 50_000_000

// maxTargetPasses caps target-size mode. Each pass is a full re-run of the
// imaging pipeline over the structural output.
const maxTargetPasses = 4

// imageSettings is one rung of the quality ladder.
type imageSettings struct {
	dpi     int
	quality int
}

// presets map 1:1 onto Ghostscript's so the Phase 5 benchmark compares like
// with like. See docs/tools/compress.md §Presets.
var presets = map[string]imageSettings{
	"screen":   {dpi: 72, quality: 40},
	"ebook":    {dpi: 150, quality: 60},
	"printer":  {dpi: 300, quality: 80},
	"prepress": {dpi: 300, quality: 92},
}

// ladder is the monotonic (DPI, quality) sequence target-size mode binary
// searches. Index 0 is the least aggressive. Monotonicity is what makes the
// search valid: rung i+1 must never produce a larger file than rung i.
var ladder = []imageSettings{
	{dpi: 300, quality: 92},
	{dpi: 300, quality: 80},
	{dpi: 225, quality: 72},
	{dpi: 150, quality: 60},
	{dpi: 110, quality: 50},
	{dpi: 72, quality: 40},
	{dpi: 72, quality: 28},
}

// CompressParams configures Compress. See docs/tools/compress.md.
type CompressParams struct {
	// Mode is "preset" or "target".
	Mode string `json:"mode"`
	// Preset is screen|ebook|printer|prepress. Used when Mode is "preset".
	Preset string `json:"preset"`
	// TargetBytes is the size to get under. Used when Mode is "target".
	TargetBytes int64 `json:"targetBytes"`
}

// CompressResult carries the output plus everything the UI needs to be honest
// about what happened.
type CompressResult struct {
	// Bytes is the compressed document — or the original, when Fallback is set.
	Bytes []byte `json:"-"`

	OriginalSize int64 `json:"originalSize"`
	ResultSize   int64 `json:"resultSize"`

	// ReachedTarget is meaningful only in target mode. False means "this is the
	// best we managed"; the UI must say so rather than implying success.
	ReachedTarget bool `json:"reachedTarget"`

	// Fallback means compression made the file bigger and we returned the
	// original untouched. Common on already-optimised documents. Shipping a
	// worse file to preserve the illusion of progress would be a bug.
	Fallback bool `json:"fallback"`

	ImagesTouched int `json:"imagesTouched"`
	ImagesSkipped int `json:"imagesSkipped"`

	// SkipReasons counts skips by reason. Keys are the Skip* constants.
	SkipReasons map[string]int `json:"skipReasons"`
}

// Compress runs the pipeline described above.
func Compress(input []byte, p CompressParams, prog Progress) (CompressResult, error) {
	var zero CompressResult

	if err := requireNonEmpty(input, "file"); err != nil {
		return zero, err
	}

	mode := p.Mode
	if mode == "" {
		mode = "preset"
	}

	var (
		setting imageSettings
		target  int64
	)
	switch mode {
	case "preset":
		name := p.Preset
		if name == "" {
			name = "ebook"
		}
		s, ok := presets[strings.ToLower(name)]
		if !ok {
			return zero, bridge.Errf(bridge.CodeInvalid,
				"unknown preset %q — use screen, ebook, printer or prepress", p.Preset)
		}
		setting = s
	case "target":
		if p.TargetBytes <= 0 {
			return zero, bridge.Errf(bridge.CodeInvalid, "target size must be greater than zero")
		}
		target = p.TargetBytes
	default:
		return zero, bridge.Errf(bridge.CodeInvalid, `mode must be "preset" or "target", got %q`, p.Mode)
	}

	original := int64(len(input))

	// Pass 1 — structural. Runs once; target mode re-runs only the imaging pass,
	// and always from this output rather than from the previous lossy result, so
	// repeated passes never stack JPEG artefacts.
	prog.report(0, 1, "optimising")
	base, err := optimizeStructure(input)
	if err != nil {
		return zero, err
	}
	prog.report(1, 1, "optimising")

	var best CompressResult
	if mode == "preset" {
		best, err = compressPass(base, setting, prog)
		if err != nil {
			return zero, err
		}
	} else {
		best, err = searchForTarget(base, target, prog)
		if err != nil {
			return zero, err
		}
	}

	best.OriginalSize = original

	// Compression is neither idempotent nor always a win. Returning a bigger
	// file than we were given is never the right answer.
	if int64(len(best.Bytes)) >= original {
		best.Bytes = input
		best.Fallback = true
		best.ReachedTarget = mode == "target" && original <= target
	}
	best.ResultSize = int64(len(best.Bytes))

	return best, nil
}

// searchForTarget binary-searches the ladder for the least aggressive rung that
// lands under target. Capped at maxTargetPasses full passes; always returns the
// smallest result it saw, with ReachedTarget saying whether that met the ask.
func searchForTarget(base []byte, target int64, prog Progress) (CompressResult, error) {
	var (
		hit      *CompressResult // smallest result that met the target
		smallest *CompressResult // smallest result overall, target met or not
	)

	lo, hi := 0, len(ladder)-1
	for pass := 0; pass < maxTargetPasses && lo <= hi; pass++ {
		mid := (lo + hi) / 2
		prog.report(pass, maxTargetPasses, "searching")

		res, err := compressPass(base, ladder[mid], prog)
		if err != nil {
			return CompressResult{}, err
		}

		if smallest == nil || len(res.Bytes) < len(smallest.Bytes) {
			c := res
			smallest = &c
		}

		if int64(len(res.Bytes)) <= target {
			c := res
			hit = &c
			hi = mid - 1 // try to give back more quality
		} else {
			lo = mid + 1 // need to squeeze harder
		}
	}

	if hit != nil {
		hit.ReachedTarget = true
		return *hit, nil
	}
	if smallest != nil {
		return *smallest, nil
	}
	// Unreachable while the ladder is non-empty, but a nil deref here would be
	// a very confusing crash.
	return compressPass(base, ladder[len(ladder)-1], prog)
}

// compressPass runs the imaging pass, which folds the metadata pass into its
// single write.
func compressPass(base []byte, s imageSettings, prog Progress) (CompressResult, error) {
	out, res, err := compressImages(base, s, prog)
	if err != nil {
		return CompressResult{}, err
	}
	res.Bytes = out
	return res, nil
}

// optimizeStructure is pass 1: dedupe objects, drop orphans, write object and
// xref streams. Lossless, and the only pass a text-only document benefits from.
func optimizeStructure(input []byte) ([]byte, error) {
	c := conf()
	c.WriteObjectStream = true
	c.WriteXRefStream = true

	var out bytes.Buffer
	if err := api.Optimize(bytes.NewReader(input), &out, c); err != nil {
		return nil, bridge.Wrap(classifyAuth(err, ""), err, "could not read document")
	}
	return out.Bytes(), nil
}

// job is an image we decided to try to recompress.
type job struct {
	objNr    int
	name     string      // resource id
	target   image.Point // pixel dimensions to resample to
	origSize int64       // stored stream length, for the "did we actually win" check
}

// compressImages is pass 2 (imaging) plus pass 3 (metadata), which share a write.
//
// Two contexts, deliberately. Extracting an image mutates its stream dict in
// place (pdfcpu decodes into sd.Content), so the context used for planning is
// read-only scratch and is thrown away; a second, pristine context takes the
// replacements and is the one written out. Doing both in one context would mean
// writing stream dicts that extraction had half-decoded — corrupt output for
// exactly the images we chose NOT to touch. The two contexts never overlap in
// time; only the encoded JPEGs survive between them.
//
// Images are handled strictly one at a time and each decoded frame is released
// before the next is read: peak memory is set by the largest decoded image, not
// by the file size. See docs/tools/compress.md §Memory.
func compressImages(input []byte, s imageSettings, prog Progress) ([]byte, CompressResult, error) {
	res := CompressResult{SkipReasons: map[string]int{}}

	replacements, err := planReplacements(input, s, prog, &res)
	if err != nil {
		return nil, res, err
	}

	out, err := applyAndWrite(input, replacements, &res)
	if err != nil {
		return nil, res, err
	}
	return out, res, nil
}

// planReplacements decides what to recompress and produces the new JPEG bytes.
// It writes nothing.
func planReplacements(input []byte, s imageSettings, prog Progress, res *CompressResult) (map[int][]byte, error) {
	c := conf()
	// An image we cannot decode is a skip, not a failed job.
	c.UnsupportedResourcePolicy = model.UnsupportedResourceSkip

	ctx, err := api.ReadValidateAndOptimize(bytes.NewReader(input), c)
	if err != nil {
		return nil, bridge.Wrap(classifyAuth(err, ""), err, "could not read document")
	}

	dims, err := ctx.PageDims()
	if err != nil {
		dims = nil // scaleFor falls back to Letter width
	}

	var jobs []job
	seen := map[int]bool{}
	for pageNr := 1; pageNr <= ctx.PageCount; pageNr++ {
		stubs, err := pdfcpu.ExtractPageImages(ctx, pageNr, true)
		if err != nil {
			continue // a page whose resources we cannot enumerate is left alone
		}
		for objNr, img := range stubs {
			if seen[objNr] {
				continue // one XObject can be used on many pages
			}
			seen[objNr] = true

			reason, target, err := classifyImage(img, dims, s)
			if err != nil {
				return nil, err // only ERR_TOO_LARGE gets here
			}
			if reason != "" {
				res.ImagesSkipped++
				res.SkipReasons[reason]++
				continue
			}
			jobs = append(jobs, job{objNr: objNr, name: img.Name, target: target, origSize: img.Size})
		}
	}

	out := map[int][]byte{}
	for i, j := range jobs {
		prog.report(i+1, len(jobs), "images")

		obj := ctx.Optimize.ImageObjects[j.objNr]
		if obj == nil || obj.ImageDict == nil {
			res.ImagesSkipped++
			res.SkipReasons[SkipUnsupported]++
			continue
		}

		img, err := pdfcpu.ExtractImage(ctx, obj.ImageDict, false, j.name, j.objNr, false)
		if err != nil || img == nil {
			res.ImagesSkipped++
			res.SkipReasons[SkipUnsupported]++
			continue
		}

		encoded, reason := recompress(*img, j, s)
		if reason != "" {
			res.ImagesSkipped++
			res.SkipReasons[reason]++
			continue
		}
		out[j.objNr] = encoded
	}

	return out, nil
}

// applyAndWrite swaps in the replacement images, strips metadata and writes.
//
// pdfcpu's api.UpdateImages refuses a replacement whose pixel dimensions differ
// from the original, which rules it out for downsampling — the whole point of
// the imaging pass. Replacing the xref entry with a fresh image stream dict is
// the same thing UpdateImages does internally, minus that check. Safe here
// because a PDF places an image by the content stream's CTM, not by its pixel
// count: fewer pixels in the same box is simply a lower-resolution image.
func applyAndWrite(input []byte, replacements map[int][]byte, res *CompressResult) ([]byte, error) {
	c := conf()
	c.WriteObjectStream = true
	c.WriteXRefStream = true

	ctx, err := api.ReadValidateAndOptimize(bytes.NewReader(input), c)
	if err != nil {
		return nil, bridge.Wrap(classifyAuth(err, ""), err, "could not read document")
	}

	for objNr, jpg := range replacements {
		sd, _, _, err := model.CreateImageStreamDict(ctx.XRefTable, bytes.NewReader(jpg))
		if err != nil {
			res.ImagesSkipped++
			res.SkipReasons[SkipUnsupported]++
			continue
		}
		entry, ok := ctx.FindTableEntry(objNr, 0)
		if !ok || entry == nil {
			res.ImagesSkipped++
			res.SkipReasons[SkipUnsupported]++
			continue
		}
		entry.Object = *sd
		res.ImagesTouched++
	}

	// Pass 3 — metadata. /Info and the catalog's XMP stream routinely carry the
	// author's name, their employer's software and timestamps. Neither affects
	// rendering, and this is the same data the future Privacy Scanner reports on.
	ctx.XRefTable.Info = nil
	if root, err := ctx.Catalog(); err == nil {
		delete(root, "Metadata")
	}

	var out bytes.Buffer
	if err := api.Write(ctx, &out, c); err != nil {
		return nil, bridge.Wrap(bridge.Classify(err), err, "could not write document")
	}
	return out.Bytes(), nil
}

// classifyImage returns a skip reason, or "" plus the target pixel size.
func classifyImage(img model.Image, dims []types.Dim, s imageSettings) (string, image.Point, error) {
	var none image.Point

	switch {
	case img.Thumb:
		return SkipThumbnail, none, nil
	// Both hazards are the same one: a JPEG has no alpha channel, so re-encoding
	// the base image while leaving its mask alone produces black boxes where the
	// transparency was. V1 skips rather than guesses. docs/LLD.md §3.1.
	case img.HasSMask, img.HasImgMask:
		return SkipTransparency, none, nil
	case img.IsImgMask, img.Bpc == 1:
		return SkipStencil, none, nil
	case strings.Contains(img.Filter, "JPX"):
		return SkipJPEG2000, none, nil
	case strings.Contains(img.Filter, "JBIG2"), strings.Contains(img.Filter, "CCITT"):
		return SkipUnsupported, none, nil
	case img.Width <= 0 || img.Height <= 0:
		return SkipUnsupported, none, nil
	}

	if int64(img.Width)*int64(img.Height) > int64(maxImagePixels) {
		return "", none, bridge.Errf(bridge.CodeTooLarge,
			"an image in this document is %d×%d pixels, which is too large to process on this device",
			img.Width, img.Height)
	}

	scale := scaleFor(img, dims, s.dpi)
	if scale >= 1 {
		// Already at or below the target density. Recompressing degrades the
		// image and usually saves nothing.
		return SkipLowDPI, none, nil
	}

	w := max(1, int(math.Round(float64(img.Width)*scale)))
	h := max(1, int(math.Round(float64(img.Height)*scale)))
	return "", image.Pt(w, h), nil
}

// scaleFor estimates how much to shrink an image, as a ratio ≥ 0.
//
// APPROXIMATION (docs/LLD.md §3.1 sanctions it for v1): effective DPI needs the
// image's displayed size, which lives in the page content stream's CTM. We
// assume instead that the image fills the page width. A half-page image is
// therefore treated as half its real DPI and shrunk less than it could be — a
// conservative error, which is the right direction to be wrong in.
func scaleFor(img model.Image, dims []types.Dim, targetDPI int) float64 {
	pageWidthPt := 612.0 // US Letter, used when the page number is out of range
	if i := img.PageNr - 1; i >= 0 && i < len(dims) && dims[i].Width > 0 {
		pageWidthPt = dims[i].Width
	}
	effectiveDPI := float64(img.Width) / (pageWidthPt / 72.0)
	if effectiveDPI <= float64(targetDPI) {
		return 1
	}
	return float64(targetDPI) / effectiveDPI
}

// recompress decodes, resamples and JPEG-encodes one image. It returns a skip
// reason instead of an error for anything that is merely "not worth it" —
// a document with one weird image should still compress.
func recompress(img model.Image, j job, s imageSettings) ([]byte, string) {
	if img.Reader == nil {
		return nil, SkipUnsupported
	}

	raw, err := io.ReadAll(img.Reader)
	if err != nil || len(raw) == 0 {
		return nil, SkipUnsupported
	}

	src, _, err := image.Decode(bytes.NewReader(raw))
	raw = nil // release the encoded copy before the decoded frame grows
	if err != nil {
		// TIFF (from CMYK sources) and anything else stdlib will not decode.
		return nil, SkipUnsupported
	}

	dst := resample(src, j.target)
	src = nil

	var out bytes.Buffer
	// Pre-size to something plausible so encoding does not repeatedly regrow.
	out.Grow(j.target.X * j.target.Y / 8)
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: s.quality}); err != nil {
		return nil, SkipUnsupported
	}
	dst = nil

	// A larger result is a loss. The original stays.
	if j.origSize > 0 && int64(out.Len()) >= j.origSize {
		return nil, SkipNoGain
	}
	return out.Bytes(), ""
}

// resample scales with Catmull-Rom, the closest equivalent to Ghostscript's
// bicubic. Grey sources stay grey: a grey JPEG is roughly a third the size of
// the same image encoded as colour.
func resample(src image.Image, to image.Point) image.Image {
	r := image.Rect(0, 0, to.X, to.Y)

	if g, ok := src.(*image.Gray); ok {
		dst := image.NewGray(r)
		xdraw.CatmullRom.Scale(dst, r, g, g.Bounds(), draw.Src, nil)
		return dst
	}

	dst := image.NewRGBA(r)
	// JPEG has no alpha. Compositing over white first stops any residual
	// transparency from being encoded as black.
	draw.Draw(dst, r, image.White, image.Point{}, draw.Src)
	xdraw.CatmullRom.Scale(dst, r, src, src.Bounds(), draw.Over, nil)
	return dst
}
