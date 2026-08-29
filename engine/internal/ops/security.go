package ops

import (
	"bytes"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"golang.org/x/text/secure/precis"
	"golang.org/x/text/unicode/norm"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// pdfcpu v0.15.0 prepares PDF 2.0 passwords with precis.NewIdentifier(...)
// (crypto.go processInput). Its comment says SASLprep, but SASLprep is the
// FreeformClass (precis.OpaqueString) — NewIdentifier builds an IdentifierClass
// profile, which DISALLOWS spaces and most punctuation-adjacent runes.
//
// The consequence is severe and asymmetric: encrypting with a space-containing
// password SUCCEEDS, and decrypting the result then fails forever with
// "precis: disallowed rune encountered". The user is left with a file they can
// never open, and nothing warned them.
//
// So we run pdfcpu's own profile at ENCRYPT time and refuse up front, while the
// user can still pick a different password. Keep this in lockstep with pdfcpu:
// if a future version switches to OpaqueString, relax this and add a test.
var pdfcpuPasswordProfile = precis.NewIdentifier(
	precis.BidiRule,
	precis.Norm(norm.NFKC),
)

// validatePassword rejects passwords pdfcpu would later refuse to accept.
func validatePassword(pw, role string) error {
	if pw == "" {
		return nil // absence is handled by the caller; empty is not invalid here
	}
	if _, err := pdfcpuPasswordProfile.String(pw); err != nil {
		return bridge.Errf(bridge.CodeInvalid,
			"the %s password contains a character this PDF encryption standard does not allow "+
				"(spaces and tabs are the usual cause) — choose a password without them", role)
	}
	return nil
}

// EncryptParams configures Encrypt. See docs/tools/encrypt.md.
//
// Passwords in this struct exist in memory for the duration of one call. They
// must never be logged, persisted, or placed in a URL.
type EncryptParams struct {
	// UserPW is required to OPEN the document. This is real protection.
	UserPW string `json:"userPW"`
	// OwnerPW governs permissions only. Readers may ignore permission flags
	// entirely, and many do — an owner password with no user password is
	// advisory, not security. The UI must say so.
	OwnerPW string `json:"ownerPW"`
	// KeyLength is 256 (default), 128, or 40. Anything below 256 is a
	// compatibility escape hatch for ancient readers, not a real choice.
	KeyLength int `json:"keyLength"`
	// Permissions is an ISO-32000 Table 22 bitfield. Several of the reserved
	// bits (ISO-32000 Table 22's own "must be 1") push the base "no
	// permissions" value (PERMISSIONS_NONE in the UI) past int16's range —
	// this was int16 until an e2e test caught every real encrypt call
	// failing json.Unmarshal with "cannot unmarshal number 61635 into ...
	// int16". model.PermissionFlags itself is a plain `int`; match it here
	// rather than re-narrowing.
	Permissions int32 `json:"permissions"`
}

// Encrypt applies AES password protection.
func Encrypt(input []byte, p EncryptParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}
	if p.UserPW == "" && p.OwnerPW == "" {
		return nil, bridge.Errf(bridge.CodeInvalid, "set at least one password")
	}
	// Refuse now rather than hand back a file that can never be opened again.
	if err := validatePassword(p.UserPW, "open"); err != nil {
		return nil, err
	}
	if err := validatePassword(p.OwnerPW, "permissions"); err != nil {
		return nil, err
	}

	keyLen := p.KeyLength
	if keyLen == 0 {
		keyLen = 256
	}
	switch keyLen {
	case 40, 128, 256:
	default:
		return nil, bridge.Errf(bridge.CodeInvalid, "key length must be 40, 128 or 256, got %d", keyLen)
	}

	// pdfcpu requires an owner password outright — encrypting with only a user
	// password fails with "please provide owner password and optional user
	// password", a pdfcpu error whose message happens to contain "password"
	// and so gets misclassified as ERR_ENCRYPTED (bridge.Classify) instead of
	// surfacing as the real cause. The UI's own placeholder text promises
	// "leave blank to reuse the open password" (Encrypt/tool.tsx) — honor
	// that here rather than in JS, so every caller of this op gets it free.
	ownerPW := p.OwnerPW
	if ownerPW == "" {
		ownerPW = p.UserPW
	}

	c := conf()
	c.UserPW = p.UserPW
	c.OwnerPW = ownerPW
	// Always AES. pdfcpu can emit RC4 when this is false; RC4 is broken and we
	// never expose it.
	c.EncryptUsingAES = true
	c.EncryptKeyLength = keyLen
	c.Permissions = model.PermissionFlags(p.Permissions)

	prog.report(0, 1, "encrypting")

	var out bytes.Buffer
	if err := api.Encrypt(bytes.NewReader(input), &out, c); err != nil {
		return nil, bridge.Wrap(bridge.Classify(err), err, "encrypt failed")
	}

	prog.report(1, 1, "encrypting")
	return out.Bytes(), nil
}

// DecryptParams configures Decrypt. See docs/tools/remove-password.md.
type DecryptParams struct {
	// Password is tried as both user and owner password: users know "the
	// password", not which of PDF's two roles it fills.
	Password string `json:"password"`
}

// Decrypt removes password protection from a document whose password is known.
//
// This is NOT password recovery. pdfcpu decrypts with a supplied password; it
// does not crack. The UI must state that before the user invests time.
func Decrypt(input []byte, p DecryptParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}

	prog.report(0, 1, "decrypting")

	var out bytes.Buffer
	if err := api.Decrypt(bytes.NewReader(input), &out, confWithPassword(p.Password)); err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "decrypt failed")
	}

	prog.report(1, 1, "decrypting")
	return out.Bytes(), nil
}

// IsEncrypted reports whether a document needs a password, so the UI can prompt
// before the user presses a button rather than after.
func IsEncrypted(input []byte) (bool, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return false, err
	}

	_, err := api.ReadAndValidate(bytes.NewReader(input), conf())
	if err == nil {
		return false, nil
	}

	switch bridge.Classify(err) {
	case bridge.CodeEncrypted, bridge.CodeBadPassword:
		return true, nil
	default:
		return false, bridge.Wrap(bridge.Classify(err), err, "could not read file")
	}
}
