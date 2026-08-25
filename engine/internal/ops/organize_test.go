package ops

import (
	"testing"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

func TestOrganizeReorderDeleteDuplicate(t *testing.T) {
	src := makePDF(t, 5)

	// Take page 3, then page 1 twice, drop pages 2, 4 and 5.
	out, err := Organize(src, OrganizeParams{
		Pages: []PageOp{{Source: 3}, {Source: 1}, {Source: 1}},
	}, nil)
	if err != nil {
		t.Fatalf("organize: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 3 {
		t.Fatalf("expected 3 pages, got %d", got)
	}
}

func TestOrganizeRotation(t *testing.T) {
	src := makePDF(t, 3)

	out, err := Organize(src, OrganizeParams{
		Pages: []PageOp{{Source: 1, Rotation: 90}, {Source: 2}, {Source: 3, Rotation: 180}},
	}, nil)
	if err != nil {
		t.Fatalf("organize: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 3 {
		t.Fatalf("page count changed: got %d", got)
	}
}

func TestOrganizeProgress(t *testing.T) {
	src := makePDF(t, 2)

	var stages []string
	prog := Progress(func(done, total int, stage string) {
		if total != 2 {
			t.Errorf("expected total 2, got %d", total)
		}
		stages = append(stages, stage)
	})

	if _, err := Organize(src, OrganizeParams{Pages: []PageOp{{Source: 2}, {Source: 1}}}, prog); err != nil {
		t.Fatalf("organize: %v", err)
	}
	if len(stages) == 0 {
		t.Fatal("expected at least one progress report")
	}
}

func TestOrganizeRejectsEmptyPages(t *testing.T) {
	// The "delete every page" case — a 0-page PDF is invalid, so this is
	// refused rather than producing one.
	_, err := Organize(makePDF(t, 3), OrganizeParams{}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestOrganizeRejectsOutOfRangeSource(t *testing.T) {
	_, err := Organize(makePDF(t, 2), OrganizeParams{Pages: []PageOp{{Source: 5}}}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestOrganizeRejectsNonRightAngleRotation(t *testing.T) {
	_, err := Organize(makePDF(t, 1), OrganizeParams{Pages: []PageOp{{Source: 1, Rotation: 45}}}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestOrganizeNormalisesNegativeRotation(t *testing.T) {
	// -90 must normalise to 270 rather than being rejected, same as Rotate.
	_, err := Organize(makePDF(t, 1), OrganizeParams{Pages: []PageOp{{Source: 1, Rotation: -90}}}, nil)
	if err != nil {
		t.Fatalf("organize: %v", err)
	}
}

func TestOrganizeRejectsEncryptedInput(t *testing.T) {
	enc, err := Encrypt(makePDF(t, 2), EncryptParams{UserPW: "x", OwnerPW: "x"}, nil)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	_, err = Organize(enc, OrganizeParams{Pages: []PageOp{{Source: 1}}}, nil)
	assertCode(t, err, bridge.CodeEncrypted)
}

func TestOrganizeAllPagesRotatedSameDelta(t *testing.T) {
	// Every page in one rotation group — exercises the single-pass path in
	// applyRotationGroups, as distinct from the multi-group path above.
	src := makePDF(t, 4)
	out, err := Organize(src, OrganizeParams{
		Pages: []PageOp{{Source: 1, Rotation: 90}, {Source: 2, Rotation: 90}, {Source: 3, Rotation: 90}, {Source: 4, Rotation: 90}},
	}, nil)
	if err != nil {
		t.Fatalf("organize: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 4 {
		t.Fatalf("page count changed: got %d", got)
	}
}
