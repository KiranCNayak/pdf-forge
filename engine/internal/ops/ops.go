// Package ops holds every PDF operation the engine exposes.
//
// Nothing here imports syscall/js. That is deliberate and load-bearing: these
// functions run identically in the browser (via cmd/wasm), in the CLI (via
// cmd/cli), and under `go test`. Native tests are the main safety net precisely
// because they exercise the same code path as Wasm.
//
// Signature convention: ops take and return []byte and a params struct. Buffer
// conversion, promises and error mapping live in package bridge.
package ops

import (
	"bytes"
	"io"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// Progress reports how far along an operation is. total may be 0 when the op
// cannot know the count up front — the UI should show an indeterminate state
// rather than inventing a percentage.
type Progress func(done, total int, stage string)

func (p Progress) report(done, total int, stage string) {
	if p != nil {
		p(done, total, stage)
	}
}

// conf returns a default pdfcpu configuration.
//
// ValidationRelaxed matters in a browser tool: real-world PDFs from real-world
// producers routinely violate the spec in ways no reader cares about, and strict
// validation would reject files that open fine everywhere else.
func conf() *model.Configuration {
	c := model.NewDefaultConfiguration()
	c.ValidationMode = model.ValidationRelaxed
	// We never touch a filesystem, so extension checks are meaningless.
	c.CheckFileNameExt = false
	return c
}

// confWithPassword returns a configuration that will open a protected document.
// The same value is tried as both user and owner password because users know
// "the password", not which of PDF's two roles it fills.
func confWithPassword(pw string) *model.Configuration {
	c := conf()
	if pw != "" {
		c.UserPW = pw
		c.OwnerPW = pw
	}
	return c
}

// readers adapts byte slices to the io.ReadSeeker slice pdfcpu wants.
func readers(inputs [][]byte) []io.ReadSeeker {
	rs := make([]io.ReadSeeker, len(inputs))
	for i, b := range inputs {
		rs[i] = bytes.NewReader(b)
	}
	return rs
}

// requireNonEmpty guards the common "user submitted nothing" case before pdfcpu
// produces a confusing parse error.
func requireNonEmpty(input []byte, what string) error {
	if len(input) == 0 {
		return bridge.Errf(bridge.CodeInvalid, "%s is empty", what)
	}
	return nil
}

// requireSelectionResolvesToPages guards against several pdfcpu APIs
// (AddWatermarks, RemoveWatermarks, and by extension anything else built on
// PagesForPageSelection) silently no-oping when a selection resolves to zero
// pages — e.g. every token out of range — rather than erroring. Fine for a
// CLI, confusing here: a user who asked for a change and got an unmodified
// file back deserves a reason, not silence. Same posture as ExtractPages'
// own "resolves to zero pages" check, generalised once a second and third op
// (Crop, Resize) needed the identical guard. A no-op selection (nil/empty,
// meaning "all pages") always passes — there's nothing to resolve.
func requireSelectionResolvesToPages(input []byte, selection []string, password string) error {
	if len(selection) == 0 {
		return nil
	}
	total, err := api.PageCount(bytes.NewReader(input), confWithPassword(password))
	if err != nil {
		return bridge.Wrap(classifyAuth(err, password), err, "could not read page count")
	}
	pages, err := api.PagesForPageSelection(total, selection, true, false)
	if err != nil {
		return bridge.Wrap(bridge.CodeInvalid, err, "invalid page selection")
	}
	if len(pages) == 0 {
		return bridge.Errf(bridge.CodeUnsupported, "page selection resolves to no pages")
	}
	return nil
}

// classifyAuth distinguishes "this file needs a password" from "that password was
// wrong". pdfcpu reports both as "please provide the correct password", so the
// message alone cannot tell them apart — only the caller knows whether a password
// was actually supplied.
//
// The distinction drives real UI behaviour: ERR_ENCRYPTED opens a password
// prompt, while ERR_BAD_PASSWORD re-prompts and keeps the file staged. Collapsing
// them makes a typo look like the user picked the wrong file.
func classifyAuth(err error, suppliedPassword string) bridge.Code {
	code := bridge.Classify(err)
	if code == bridge.CodeBadPassword && suppliedPassword == "" {
		return bridge.CodeEncrypted
	}
	return code
}
