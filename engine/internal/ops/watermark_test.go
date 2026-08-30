package ops

import (
	"testing"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

func validWatermarkParams(text string) WatermarkParams {
	return WatermarkParams{
		Text:     text,
		FontSize: 24,
		Color:    "gray",
		Position: "c",
		Rotation: 0,
		Opacity:  0.5,
	}
}

func TestAddWatermark(t *testing.T) {
	src := makePDF(t, 3)

	out, err := AddWatermark(src, validWatermarkParams("DRAFT"), nil)
	if err != nil {
		t.Fatalf("add watermark: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 3 {
		t.Fatalf("page count changed: got %d", got)
	}
}

func TestAddWatermarkOnSelection(t *testing.T) {
	src := makePDF(t, 5)

	out, err := AddWatermark(src, WatermarkParams{
		Text: "CONFIDENTIAL", FontSize: 18, Color: "red", Position: "tr", Opacity: 1, Selection: []string{"1-2"},
	}, nil)
	if err != nil {
		t.Fatalf("add watermark: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 5 {
		t.Fatalf("page count changed: got %d", got)
	}
}

func TestAddWatermarkProgress(t *testing.T) {
	src := makePDF(t, 1)

	var calls int
	prog := Progress(func(done, total int, stage string) {
		calls++
		if stage != "watermarking" {
			t.Errorf("unexpected stage %q", stage)
		}
	})

	if _, err := AddWatermark(src, validWatermarkParams("draft"), prog); err != nil {
		t.Fatalf("add watermark: %v", err)
	}
	if calls == 0 {
		t.Fatal("progress callback never fired")
	}
}

func TestAddWatermarkRejectsEmptyText(t *testing.T) {
	p := validWatermarkParams("   ")
	_, err := AddWatermark(makePDF(t, 1), p, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestAddWatermarkRejectsNonPositiveFontSize(t *testing.T) {
	p := validWatermarkParams("draft")
	p.FontSize = 0
	_, err := AddWatermark(makePDF(t, 1), p, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestAddWatermarkRejectsOpacityOutOfRange(t *testing.T) {
	for _, opacity := range []float64{0, -0.1, 1.5} {
		p := validWatermarkParams("draft")
		p.Opacity = opacity
		if _, err := AddWatermark(makePDF(t, 1), p, nil); err == nil {
			t.Fatalf("opacity %v: expected error, got none", opacity)
		} else {
			assertCode(t, err, bridge.CodeInvalid)
		}
	}
}

func TestAddWatermarkRejectsRotationOutOfRange(t *testing.T) {
	p := validWatermarkParams("draft")
	p.Rotation = 181
	_, err := AddWatermark(makePDF(t, 1), p, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestAddWatermarkRejectsBadColor(t *testing.T) {
	p := validWatermarkParams("draft")
	p.Color = "not-a-color"
	_, err := AddWatermark(makePDF(t, 1), p, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestAddWatermarkRejectsSelectionResolvingToZeroPages(t *testing.T) {
	// pdfcpu's own AddWatermarks silently no-ops on this rather than
	// erroring — the op adds its own check so the user gets a reason instead
	// of an unmodified file back. See watermark.go's comment.
	p := validWatermarkParams("draft")
	p.Selection = []string{"99"}
	_, err := AddWatermark(makePDF(t, 3), p, nil)
	assertCode(t, err, bridge.CodeUnsupported)
}

func TestAddWatermarkOnEncryptedInputRequiresPassword(t *testing.T) {
	src := makePDF(t, 2)
	encrypted, err := Encrypt(src, EncryptParams{UserPW: "s3cret", OwnerPW: "s3cret", KeyLength: 256}, nil)
	if err != nil {
		t.Fatalf("encrypt fixture: %v", err)
	}

	p := validWatermarkParams("draft")
	_, err = AddWatermark(encrypted, p, nil)
	assertCode(t, err, bridge.CodeEncrypted)

	p.Password = "s3cret"
	if _, err := AddWatermark(encrypted, p, nil); err != nil {
		t.Fatalf("add watermark with correct password: %v", err)
	}
}

// -------------------------------------------------------- remove watermark

func TestHasWatermarksFalseForPlainFile(t *testing.T) {
	ok, err := HasWatermarks(makePDF(t, 2), "")
	if err != nil {
		t.Fatalf("has watermarks: %v", err)
	}
	if ok {
		t.Fatal("expected no watermarks on a freshly generated fixture")
	}
}

func TestHasWatermarksTrueAfterAddWatermark(t *testing.T) {
	watermarked, err := AddWatermark(makePDF(t, 2), validWatermarkParams("DRAFT"), nil)
	if err != nil {
		t.Fatalf("add watermark: %v", err)
	}

	ok, err := HasWatermarks(watermarked, "")
	if err != nil {
		t.Fatalf("has watermarks: %v", err)
	}
	if !ok {
		t.Fatal("expected HasWatermarks to detect the watermark just added")
	}
}

func TestRemoveWatermarkOnPlainFileIsANoOp(t *testing.T) {
	// Unlike AddWatermark's own zero-pages guard, this is pdfcpu's own
	// behaviour surfacing as an error ("no watermarks found") that
	// RemoveWatermark translates into "hand back the original bytes" — see
	// the comment in watermark.go. Regression test for the real ERR_INTERNAL
	// this used to produce before that translation existed.
	src := makePDF(t, 2)
	out, err := RemoveWatermark(src, RemoveWatermarkParams{}, nil)
	if err != nil {
		t.Fatalf("remove watermark on a plain file: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 2 {
		t.Fatalf("page count changed: got %d", got)
	}
}

func TestRemoveWatermarkRoundTrip(t *testing.T) {
	watermarked, err := AddWatermark(makePDF(t, 3), validWatermarkParams("DRAFT"), nil)
	if err != nil {
		t.Fatalf("add watermark: %v", err)
	}
	if ok, _ := HasWatermarks(watermarked, ""); !ok {
		t.Fatal("fixture setup: expected a watermark before removal")
	}

	out, err := RemoveWatermark(watermarked, RemoveWatermarkParams{}, nil)
	if err != nil {
		t.Fatalf("remove watermark: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 3 {
		t.Fatalf("page count changed: got %d", got)
	}
	if ok, err := HasWatermarks(out, ""); err != nil {
		t.Fatalf("has watermarks after removal: %v", err)
	} else if ok {
		t.Fatal("expected the watermark to be gone after removal")
	}
}

func TestRemoveWatermarkProgress(t *testing.T) {
	watermarked, err := AddWatermark(makePDF(t, 1), validWatermarkParams("draft"), nil)
	if err != nil {
		t.Fatalf("add watermark: %v", err)
	}

	var calls int
	prog := Progress(func(done, total int, stage string) {
		calls++
		if stage != "removing watermark" {
			t.Errorf("unexpected stage %q", stage)
		}
	})

	if _, err := RemoveWatermark(watermarked, RemoveWatermarkParams{}, prog); err != nil {
		t.Fatalf("remove watermark: %v", err)
	}
	if calls == 0 {
		t.Fatal("progress callback never fired")
	}
}

func TestRemoveWatermarkAcceptsEvenOddTokensWithNoSpecialHandling(t *testing.T) {
	// even/odd are recognised by pdfcpu's own page-selection token handler —
	// this test exists to prove that claim in the doc rather than take it on
	// faith, and to catch a regression if a future refactor routes Selection
	// through something that doesn't understand those tokens.
	watermarked, err := AddWatermark(makePDF(t, 4), validWatermarkParams("draft"), nil)
	if err != nil {
		t.Fatalf("add watermark: %v", err)
	}

	out, err := RemoveWatermark(watermarked, RemoveWatermarkParams{Selection: []string{"odd"}}, nil)
	if err != nil {
		t.Fatalf("remove watermark on odd pages: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 4 {
		t.Fatalf("page count changed: got %d", got)
	}
	// Pages 2 and 4 (even) should still carry theirs — a selection that
	// resolved to nothing, or one that (wrongly) cleared every page, would
	// both make this false, so it's the one assertion that actually
	// distinguishes "only the requested pages changed" from either failure.
	if ok, err := HasWatermarks(out, ""); err != nil {
		t.Fatalf("has watermarks: %v", err)
	} else if !ok {
		t.Fatal("expected the even pages' watermark to survive removing only the odd ones")
	}
}

func TestRemoveWatermarkRejectsSelectionResolvingToZeroPages(t *testing.T) {
	p := RemoveWatermarkParams{Selection: []string{"99"}}
	_, err := RemoveWatermark(makePDF(t, 3), p, nil)
	assertCode(t, err, bridge.CodeUnsupported)
}

func TestRemoveWatermarkOnEncryptedInputRequiresPassword(t *testing.T) {
	watermarked, err := AddWatermark(makePDF(t, 2), validWatermarkParams("draft"), nil)
	if err != nil {
		t.Fatalf("add watermark: %v", err)
	}
	encrypted, err := Encrypt(watermarked, EncryptParams{UserPW: "s3cret", OwnerPW: "s3cret", KeyLength: 256}, nil)
	if err != nil {
		t.Fatalf("encrypt fixture: %v", err)
	}

	_, err = RemoveWatermark(encrypted, RemoveWatermarkParams{}, nil)
	assertCode(t, err, bridge.CodeEncrypted)

	if _, err := RemoveWatermark(encrypted, RemoveWatermarkParams{Password: "s3cret"}, nil); err != nil {
		t.Fatalf("remove watermark with correct password: %v", err)
	}
}
