package ops

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// assertCode fails unless err carries the expected stable error code. Every
// ERR_* the UI can display needs a test that provokes it — error paths in a
// privacy tool are user-facing behaviour, not edge cases.
func assertCode(t *testing.T, err error, want bridge.Code) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error %s, got nil", want)
	}
	if got := bridge.Classify(err); got != want {
		t.Fatalf("expected %s, got %s (%v)", want, got, err)
	}
}

func TestMerge(t *testing.T) {
	a, b := makePDF(t, 3), makePDF(t, 2)

	out, err := Merge([][]byte{a, b}, MergeParams{}, nil)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 5 {
		t.Fatalf("expected 5 pages, got %d", got)
	}
}

func TestMergeProgress(t *testing.T) {
	a, b := makePDF(t, 1), makePDF(t, 1)

	var calls int
	prog := Progress(func(done, total int, stage string) {
		calls++
		if total != 2 {
			t.Errorf("expected total 2, got %d", total)
		}
		if stage != "merging" {
			t.Errorf("unexpected stage %q", stage)
		}
	})

	if _, err := Merge([][]byte{a, b}, MergeParams{}, prog); err != nil {
		t.Fatalf("merge: %v", err)
	}
	if calls == 0 {
		t.Fatal("progress callback never fired")
	}
}

func TestMergeRejectsSingleFile(t *testing.T) {
	_, err := Merge([][]byte{makePDF(t, 1)}, MergeParams{}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestMergeRejectsGarbage(t *testing.T) {
	_, err := Merge([][]byte{makePDF(t, 1), []byte("not a pdf at all")}, MergeParams{}, nil)
	assertCode(t, err, bridge.CodeCorrupt)
}

func TestExtractPages(t *testing.T) {
	src := makePDF(t, 10)

	out, err := ExtractPages(src, ExtractParams{Selection: "2-4,8"}, nil)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 4 {
		t.Fatalf("expected 4 pages, got %d", got)
	}
}

func TestExtractRejectsBadSelection(t *testing.T) {
	_, err := ExtractPages(makePDF(t, 3), ExtractParams{Selection: "banana"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestRotate(t *testing.T) {
	src := makePDF(t, 2)

	out, err := Rotate(src, RotateParams{Rotation: 90}, nil)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if got := mustPageCount(t, out, ""); got != 2 {
		t.Fatalf("page count changed: got %d", got)
	}
}

func TestRotateNormalisesNegative(t *testing.T) {
	// -90 must normalise to 270 rather than being rejected.
	if _, err := Rotate(makePDF(t, 1), RotateParams{Rotation: -90}, nil); err != nil {
		t.Fatalf("rotate -90: %v", err)
	}
}

func TestRotateRejectsNonRightAngle(t *testing.T) {
	_, err := Rotate(makePDF(t, 1), RotateParams{Rotation: 45}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestRotateRejectsNoOp(t *testing.T) {
	_, err := Rotate(makePDF(t, 1), RotateParams{Rotation: 360}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestSplitEach(t *testing.T) {
	parts, err := Split(makePDF(t, 4), SplitParams{Mode: "each"}, nil)
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	if len(parts) != 4 {
		t.Fatalf("expected 4 parts, got %d", len(parts))
	}
	for _, p := range parts {
		if got := mustPageCount(t, p.Bytes, ""); got != 1 {
			t.Fatalf("part %s has %d pages, want 1", p.Name, got)
		}
	}
	// Zero-padded so parts sort correctly in a file manager.
	if parts[0].Name != "page-1.pdf" {
		t.Fatalf("unexpected name %q", parts[0].Name)
	}
}

func TestSplitEachPadsPageNumbers(t *testing.T) {
	parts, err := Split(makePDF(t, 12), SplitParams{Mode: "each"}, nil)
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	if parts[0].Name != "page-01.pdf" {
		t.Fatalf("expected zero-padded name, got %q", parts[0].Name)
	}
}

func TestSplitSpan(t *testing.T) {
	parts, err := Split(makePDF(t, 7), SplitParams{Mode: "span", Span: 3}, nil)
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	if len(parts) != 3 {
		t.Fatalf("expected 3 parts, got %d", len(parts))
	}
	// 7 pages in spans of 3 leaves a remainder of 1.
	if got := mustPageCount(t, parts[2].Bytes, ""); got != 1 {
		t.Fatalf("final part has %d pages, want 1", got)
	}
}

func TestSplitRejectsUnknownMode(t *testing.T) {
	_, err := Split(makePDF(t, 2), SplitParams{Mode: "sideways"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	src := makePDF(t, 3)
	const pw = "correct-horse-battery-staple"

	enc, err := Encrypt(src, EncryptParams{UserPW: pw, OwnerPW: pw}, nil)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	// Encrypted documents must not be readable without the password.
	if _, err := PageCount(enc, ""); err == nil {
		t.Fatal("encrypted document was readable with no password")
	}

	locked, err := IsEncrypted(enc)
	if err != nil {
		t.Fatalf("IsEncrypted: %v", err)
	}
	if !locked {
		t.Fatal("IsEncrypted returned false for an encrypted document")
	}

	dec, err := Decrypt(enc, DecryptParams{Password: pw}, nil)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if got := mustPageCount(t, dec, ""); got != 3 {
		t.Fatalf("expected 3 pages after decrypt, got %d", got)
	}
}

func TestDecryptWrongPassword(t *testing.T) {
	enc, err := Encrypt(makePDF(t, 1), EncryptParams{UserPW: "right", OwnerPW: "right"}, nil)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	_, err = Decrypt(enc, DecryptParams{Password: "wrong"}, nil)
	if err == nil {
		t.Fatal("decrypt accepted the wrong password")
	}
	// Must be distinguishable from "file is corrupt" — the UI re-prompts on one
	// and offers repair on the other.
	if code := bridge.Classify(err); code != bridge.CodeBadPassword && code != bridge.CodeEncrypted {
		t.Fatalf("expected a password-related code, got %s (%v)", code, err)
	}
}

func TestEncryptRejectsEmptyPasswords(t *testing.T) {
	_, err := Encrypt(makePDF(t, 1), EncryptParams{}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

func TestEncryptRejectsBadKeyLength(t *testing.T) {
	_, err := Encrypt(makePDF(t, 1), EncryptParams{UserPW: "x", KeyLength: 512}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

// Guards against a pdfcpu v0.15.0 bug where encrypting with a space-containing
// password succeeds but decrypting the result fails forever. See the comment on
// pdfcpuPasswordProfile in security.go. If this test starts failing because
// pdfcpu fixed its PRECIS profile, relax validatePassword — do not delete the
// test, invert it.
func TestEncryptRejectsPasswordsPdfcpuCannotDecrypt(t *testing.T) {
	for _, pw := range []string{"with space", "tab\there"} {
		t.Run(pw, func(t *testing.T) {
			_, err := Encrypt(makePDF(t, 1), EncryptParams{UserPW: pw, OwnerPW: pw}, nil)
			assertCode(t, err, bridge.CodeInvalid)
		})
	}
}

func TestEncryptAcceptsUnicodePasswords(t *testing.T) {
	// Accented and non-Latin passwords are fine; only the disallowed classes
	// are rejected. Verify the round trip actually works so the guard is not
	// quietly over-broad.
	for _, pw := range []string{"café", "日本語パス", "p@ssw0rd!"} {
		t.Run(pw, func(t *testing.T) {
			enc, err := Encrypt(makePDF(t, 1), EncryptParams{UserPW: pw, OwnerPW: pw}, nil)
			if err != nil {
				t.Fatalf("encrypt: %v", err)
			}
			if _, err := Decrypt(enc, DecryptParams{Password: pw}, nil); err != nil {
				t.Fatalf("decrypt: %v", err)
			}
		})
	}
}

// TestEncryptParamsPermissionsSurvivesJSONRoundTrip catches a bug an e2e test
// found and every native test here missed: every other test in this file
// constructs EncryptParams as a Go struct literal, bypassing the JSON layer
// entirely. The real UI's PERMISSIONS_NONE base value (0xf0c3 = 61635, with
// several ISO-32000 Table 22 reserved bits forced to 1) exceeds int16's
// range, so json.Unmarshal silently failed on every real encrypt call once
// the UI shipped — Permissions was int16 until this test.
func TestEncryptParamsPermissionsSurvivesJSONRoundTrip(t *testing.T) {
	const uiPermissionsNone = 0xf0c3 // web/src/tools/Encrypt/tool.tsx's PERMISSIONS_NONE
	raw := fmt.Sprintf(`{"userPW":"x","ownerPW":"x","keyLength":256,"permissions":%d}`, uiPermissionsNone)
	var p EncryptParams
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if p.Permissions != uiPermissionsNone {
		t.Fatalf("permissions = %d, want %d", p.Permissions, uiPermissionsNone)
	}
}

// TestEncryptWithOnlyUserPasswordSucceeds is the exact scenario the UI's own
// placeholder text invites ("Leave blank to reuse the open password" on the
// owner-password field) and the exact one an e2e test caught failing:
// pdfcpu refuses to encrypt with an empty owner password outright, and the
// resulting error message contains "password", which bridge.Classify then
// misreads as ERR_ENCRYPTED rather than a real failure. Encrypt must fall
// back OwnerPW to UserPW when OwnerPW is blank.
func TestEncryptWithOnlyUserPasswordSucceeds(t *testing.T) {
	enc, err := Encrypt(makePDF(t, 1), EncryptParams{UserPW: "openme", Permissions: 0xf0c3}, nil)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if _, err := Decrypt(enc, DecryptParams{Password: "openme"}, nil); err != nil {
		t.Fatalf("decrypt with the user password: %v", err)
	}
}

func TestEncryptDistinctUserAndOwnerPasswords(t *testing.T) {
	enc, err := Encrypt(makePDF(t, 1), EncryptParams{UserPW: "openme", OwnerPW: "adminpw"}, nil)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	// Either password must open it — users know "the password", not which role
	// it fills, which is why Decrypt tries both.
	for _, pw := range []string{"openme", "adminpw"} {
		if _, err := Decrypt(enc, DecryptParams{Password: pw}, nil); err != nil {
			t.Errorf("decrypt with %q: %v", pw, err)
		}
	}
}

func TestIsEncryptedFalseForPlainFile(t *testing.T) {
	locked, err := IsEncrypted(makePDF(t, 1))
	if err != nil {
		t.Fatalf("IsEncrypted: %v", err)
	}
	if locked {
		t.Fatal("plain document reported as encrypted")
	}
}

func TestEmptyInputIsInvalidNotCorrupt(t *testing.T) {
	// An empty upload is a UI problem, not a damaged file. Users should be told
	// to pick a file, not that their file is broken.
	_, err := ExtractPages(nil, ExtractParams{Selection: "1"}, nil)
	assertCode(t, err, bridge.CodeInvalid)
}

// pdfcpu reports "please provide the correct password" both when no password was
// supplied and when the wrong one was. Only the caller knows which happened, and
// the UI behaves differently for each: ERR_ENCRYPTED opens a prompt,
// ERR_BAD_PASSWORD re-prompts while keeping the file staged.
func TestMissingVsWrongPasswordAreDistinct(t *testing.T) {
	enc, err := Encrypt(makePDF(t, 2), EncryptParams{UserPW: "right", OwnerPW: "right"}, nil)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	_, err = PageCount(enc, "")
	assertCode(t, err, bridge.CodeEncrypted)

	_, err = PageCount(enc, "wrong")
	assertCode(t, err, bridge.CodeBadPassword)

	// And the same distinction must hold on the decrypt path.
	_, err = Decrypt(enc, DecryptParams{Password: ""}, nil)
	assertCode(t, err, bridge.CodeEncrypted)

	_, err = Decrypt(enc, DecryptParams{Password: "wrong"}, nil)
	assertCode(t, err, bridge.CodeBadPassword)
}
