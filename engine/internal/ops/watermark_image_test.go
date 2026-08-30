package ops

import (
	"image/color"
	"testing"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

func validImageWatermarkParams() ImageWatermarkParams {
	return ImageWatermarkParams{Scale: 0.3, Position: "br", Rotation: 0, Opacity: 1, OnTop: true}
}

func TestAddImageWatermark(t *testing.T) {
	src := makePDF(t, 3)
	sig := pngBytes(t, 300, 100, color.RGBA{20, 20, 20, 255})

	out, err := AddImageWatermark(src, sig, validImageWatermarkParams(), nil)
	if err != nil {
		t.Fatalf("add image watermark: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 3 {
		t.Fatalf("page count changed: got %d", got)
	}
}

func TestAddImageWatermarkOnSelection(t *testing.T) {
	src := makePDF(t, 5)
	sig := pngBytes(t, 300, 100, color.RGBA{20, 20, 20, 255})

	p := validImageWatermarkParams()
	p.Selection = []string{"5"}
	out, err := AddImageWatermark(src, sig, p, nil)
	if err != nil {
		t.Fatalf("add image watermark: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 5 {
		t.Fatalf("page count changed: got %d", got)
	}
}

func TestAddImageWatermarkProgress(t *testing.T) {
	src := makePDF(t, 1)
	sig := pngBytes(t, 100, 100, color.RGBA{20, 20, 20, 255})

	var calls int
	prog := Progress(func(done, total int, stage string) {
		calls++
		if stage != "stamping" {
			t.Errorf("unexpected stage %q", stage)
		}
	})

	if _, err := AddImageWatermark(src, sig, validImageWatermarkParams(), prog); err != nil {
		t.Fatalf("add image watermark: %v", err)
	}
	if calls == 0 {
		t.Fatal("progress callback never fired")
	}
}

func TestAddImageWatermarkRejectsEmptyImage(t *testing.T) {
	_, err := AddImageWatermark(makePDF(t, 1), nil, validImageWatermarkParams(), nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestAddImageWatermarkRejectsScaleOutOfRange(t *testing.T) {
	sig := pngBytes(t, 100, 100, color.RGBA{20, 20, 20, 255})
	for _, scale := range []float64{0, -0.5, 1.5} {
		p := validImageWatermarkParams()
		p.Scale = scale
		if _, err := AddImageWatermark(makePDF(t, 1), sig, p, nil); bridge.Classify(err) != bridge.CodeInvalid {
			t.Fatalf("scale %v: expected ERR_INVALID_PARAMS, got %v", scale, err)
		}
	}
}

func TestAddImageWatermarkRejectsOpacityOutOfRange(t *testing.T) {
	sig := pngBytes(t, 100, 100, color.RGBA{20, 20, 20, 255})
	for _, opacity := range []float64{0, -0.1, 1.1} {
		p := validImageWatermarkParams()
		p.Opacity = opacity
		if _, err := AddImageWatermark(makePDF(t, 1), sig, p, nil); bridge.Classify(err) != bridge.CodeInvalid {
			t.Fatalf("opacity %v: expected ERR_INVALID_PARAMS, got %v", opacity, err)
		}
	}
}

func TestAddImageWatermarkRejectsRotationOutOfRange(t *testing.T) {
	sig := pngBytes(t, 100, 100, color.RGBA{20, 20, 20, 255})
	p := validImageWatermarkParams()
	p.Rotation = 200
	_, err := AddImageWatermark(makePDF(t, 1), sig, p, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestAddImageWatermarkRejectsSelectionResolvingToZeroPages(t *testing.T) {
	sig := pngBytes(t, 100, 100, color.RGBA{20, 20, 20, 255})
	p := validImageWatermarkParams()
	p.Selection = []string{"99"}
	_, err := AddImageWatermark(makePDF(t, 3), sig, p, nil)
	assertCode(t, err, bridge.CodeUnsupported)
}

func TestAddImageWatermarkOnEncryptedInputRequiresPassword(t *testing.T) {
	sig := pngBytes(t, 100, 100, color.RGBA{20, 20, 20, 255})
	encrypted, err := Encrypt(makePDF(t, 2), EncryptParams{UserPW: "s3cret", OwnerPW: "s3cret", KeyLength: 256}, nil)
	if err != nil {
		t.Fatalf("encrypt fixture: %v", err)
	}

	_, err = AddImageWatermark(encrypted, sig, validImageWatermarkParams(), nil)
	assertCode(t, err, bridge.CodeEncrypted)

	p := validImageWatermarkParams()
	p.Password = "s3cret"
	if _, err := AddImageWatermark(encrypted, sig, p, nil); err != nil {
		t.Fatalf("add image watermark with correct password: %v", err)
	}
}
