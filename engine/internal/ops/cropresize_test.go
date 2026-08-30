package ops

import (
	"bytes"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

func pageBoxes(t *testing.T, b []byte) []model.PageBoundaries {
	t.Helper()
	boxes, err := api.Boxes(bytes.NewReader(b), nil, conf())
	if err != nil {
		t.Fatalf("boxes: %v", err)
	}
	return boxes
}

// ---------------------------------------------------------------------- crop

func TestCropShrinksCropBox(t *testing.T) {
	src := makePDF(t, 2) // 60x80pt fixture pages

	out, err := Crop(src, CropParams{Top: 5, Right: 5, Bottom: 5, Left: 5}, nil)
	if err != nil {
		t.Fatalf("crop: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 2 {
		t.Fatalf("page count changed: got %d", got)
	}

	boxes := pageBoxes(t, out)
	cb := boxes[0].CropBox()
	if cb.Width() != 50 || cb.Height() != 70 {
		t.Fatalf("expected a 50x70 crop box, got %vx%v", cb.Width(), cb.Height())
	}
}

func TestCropNegativeMarginEnlargesPage(t *testing.T) {
	src := makePDF(t, 1)

	out, err := Crop(src, CropParams{Top: -10, Right: -10, Bottom: -10, Left: -10}, nil)
	if err != nil {
		t.Fatalf("crop: %v", err)
	}
	cb := pageBoxes(t, out)[0].CropBox()
	if cb.Width() != 80 || cb.Height() != 100 {
		t.Fatalf("expected an enlarged 80x100 crop box, got %vx%v", cb.Width(), cb.Height())
	}
}

func TestCropRejectsMarginsExceedingThePage(t *testing.T) {
	// Confirmed directly against pdfcpu v0.15.0: without this guard, api.Crop
	// happily writes a negative-area crop box with no error at all. See
	// validateCropMargins's own comment.
	src := makePDF(t, 1) // 60x80pt
	_, err := Crop(src, CropParams{Top: 100, Right: 100, Bottom: 100, Left: 100}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestCropOnSelection(t *testing.T) {
	src := makePDF(t, 3)
	out, err := Crop(src, CropParams{Top: 5, Right: 5, Bottom: 5, Left: 5, Selection: []string{"1"}}, nil)
	if err != nil {
		t.Fatalf("crop: %v", err)
	}
	boxes := pageBoxes(t, out)
	if boxes[0].CropBox().Width() != 50 {
		t.Fatalf("expected page 1 cropped, got width %v", boxes[0].CropBox().Width())
	}
	if boxes[1].CropBox().Width() != 60 {
		t.Fatalf("expected page 2 untouched, got width %v", boxes[1].CropBox().Width())
	}
}

func TestCropProgress(t *testing.T) {
	src := makePDF(t, 1)
	var calls int
	prog := Progress(func(done, total int, stage string) {
		calls++
		if stage != "cropping" {
			t.Errorf("unexpected stage %q", stage)
		}
	})
	if _, err := Crop(src, CropParams{Top: 1, Right: 1, Bottom: 1, Left: 1}, prog); err != nil {
		t.Fatalf("crop: %v", err)
	}
	if calls == 0 {
		t.Fatal("progress callback never fired")
	}
}

func TestCropRejectsSelectionResolvingToZeroPages(t *testing.T) {
	_, err := Crop(makePDF(t, 2), CropParams{Selection: []string{"99"}}, nil)
	assertCode(t, err, bridge.CodeUnsupported)
}

func TestCropOnEncryptedInputRequiresPassword(t *testing.T) {
	encrypted, err := Encrypt(makePDF(t, 1), EncryptParams{UserPW: "s3cret", OwnerPW: "s3cret", KeyLength: 256}, nil)
	if err != nil {
		t.Fatalf("encrypt fixture: %v", err)
	}
	_, err = Crop(encrypted, CropParams{Top: 1, Right: 1, Bottom: 1, Left: 1}, nil)
	assertCode(t, err, bridge.CodeEncrypted)

	if _, err := Crop(encrypted, CropParams{Top: 1, Right: 1, Bottom: 1, Left: 1, Password: "s3cret"}, nil); err != nil {
		t.Fatalf("crop with correct password: %v", err)
	}
}

// -------------------------------------------------------------------- resize

func TestResizeByScale(t *testing.T) {
	src := makePDF(t, 2) // 60x80

	out, err := Resize(src, ResizeParams{Mode: "scale", Scale: 2}, nil)
	if err != nil {
		t.Fatalf("resize: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 2 {
		t.Fatalf("page count changed: got %d", got)
	}
	mb := pageBoxes(t, out)[0].MediaBox()
	if mb.Width() != 120 || mb.Height() != 160 {
		t.Fatalf("expected a doubled 120x160 page, got %vx%v", mb.Width(), mb.Height())
	}
}

func TestResizeByPageSize(t *testing.T) {
	src := makePDF(t, 1)
	out, err := Resize(src, ResizeParams{Mode: "pageSize", PageSize: "A4"}, nil)
	if err != nil {
		t.Fatalf("resize: %v", err)
	}
	mb := pageBoxes(t, out)[0].MediaBox()
	if mb.Width() != 595 || mb.Height() != 842 {
		t.Fatalf("expected A4 (595x842), got %vx%v", mb.Width(), mb.Height())
	}
}

func TestResizeByPageSizeLandscape(t *testing.T) {
	src := makePDF(t, 1)
	out, err := Resize(src, ResizeParams{Mode: "pageSize", PageSize: "A4L"}, nil)
	if err != nil {
		t.Fatalf("resize: %v", err)
	}
	mb := pageBoxes(t, out)[0].MediaBox()
	if mb.Width() != 842 || mb.Height() != 595 {
		t.Fatalf("expected landscape A4 (842x595), got %vx%v", mb.Width(), mb.Height())
	}
}

func TestResizeByDimensions(t *testing.T) {
	src := makePDF(t, 1)
	out, err := Resize(src, ResizeParams{Mode: "dimensions", Width: 300, Height: 400}, nil)
	if err != nil {
		t.Fatalf("resize: %v", err)
	}
	mb := pageBoxes(t, out)[0].MediaBox()
	if mb.Width() != 300 || mb.Height() != 400 {
		t.Fatalf("expected 300x400, got %vx%v", mb.Width(), mb.Height())
	}
}

func TestResizeRejectsScaleOfOne(t *testing.T) {
	_, err := Resize(makePDF(t, 1), ResizeParams{Mode: "scale", Scale: 1}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestResizeRejectsNonPositiveScale(t *testing.T) {
	for _, scale := range []float64{0, -1} {
		_, err := Resize(makePDF(t, 1), ResizeParams{Mode: "scale", Scale: scale}, nil)
		assertCode(t, err, bridge.CodeInvalid)
	}
}

func TestResizeRejectsUnknownPageSize(t *testing.T) {
	_, err := Resize(makePDF(t, 1), ResizeParams{Mode: "pageSize", PageSize: "not-a-size"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestResizeRejectsNonPositiveDimensions(t *testing.T) {
	_, err := Resize(makePDF(t, 1), ResizeParams{Mode: "dimensions", Width: 0, Height: 400}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestResizeRejectsUnknownMode(t *testing.T) {
	_, err := Resize(makePDF(t, 1), ResizeParams{Mode: "banana"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestResizeProgress(t *testing.T) {
	src := makePDF(t, 1)
	var calls int
	prog := Progress(func(done, total int, stage string) {
		calls++
		if stage != "resizing" {
			t.Errorf("unexpected stage %q", stage)
		}
	})
	if _, err := Resize(src, ResizeParams{Mode: "scale", Scale: 2}, prog); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if calls == 0 {
		t.Fatal("progress callback never fired")
	}
}

func TestResizeRejectsSelectionResolvingToZeroPages(t *testing.T) {
	_, err := Resize(makePDF(t, 2), ResizeParams{Mode: "scale", Scale: 2, Selection: []string{"99"}}, nil)
	assertCode(t, err, bridge.CodeUnsupported)
}

func TestResizeOnEncryptedInputRequiresPassword(t *testing.T) {
	encrypted, err := Encrypt(makePDF(t, 1), EncryptParams{UserPW: "s3cret", OwnerPW: "s3cret", KeyLength: 256}, nil)
	if err != nil {
		t.Fatalf("encrypt fixture: %v", err)
	}
	_, err = Resize(encrypted, ResizeParams{Mode: "scale", Scale: 2}, nil)
	assertCode(t, err, bridge.CodeEncrypted)

	if _, err := Resize(encrypted, ResizeParams{Mode: "scale", Scale: 2, Password: "s3cret"}, nil); err != nil {
		t.Fatalf("resize with correct password: %v", err)
	}
}
