package ops

import (
	"bytes"
	"strconv"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// PageOp is one page in the FINAL document. Source refers to a page number in
// the ORIGINAL input; the same Source may appear more than once (duplicate) or
// not at all (delete). See docs/tools/organize-pages.md.
type PageOp struct {
	Source int `json:"source"`
	// Rotation is a RELATIVE delta, same convention as RotateParams — added to
	// the page's existing /Rotate, not an absolute orientation. Zero means
	// "leave as is".
	Rotation int `json:"rotation"`
}

// OrganizeParams configures Organize. Pages gives the final page order —
// omitted source pages are deleted, repeated ones are duplicated.
type OrganizeParams struct {
	Pages    []PageOp `json:"pages"`
	Password string   `json:"password,omitempty"`
}

// Organize reorders, deletes, duplicates and rotates pages in one call.
//
// Implementation is two passes, not one: api.Collect handles reorder/delete/
// duplicate by building a selection string from Pages in the requested order
// (pdfcpu preserves selection order, same trick ExtractPages relies on), then
// grouped api.Rotate passes apply rotation deltas. api.RemovePages exists but
// would need a second, different code path for delete versus reorder/
// duplicate — routing everything through Collect keeps one path for all
// three.
//
// Indexing is the sharp edge here: PageOp.Source is a position in the
// ORIGINAL document, but rotation must be applied against the POST-Collect
// document, where the Nth entry of Pages becomes page N regardless of what
// Source it names. Getting this backwards rotates the wrong page silently —
// the output is still a valid PDF, so nothing errors, it's just wrong.
func Organize(input []byte, p OrganizeParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}
	if len(p.Pages) == 0 {
		// A 0-page PDF is invalid — this is "every page deleted" from the UI's
		// staged-edit model, caught here too since the UI isn't the only caller.
		return nil, bridge.Errf(bridge.CodeInvalid, "no pages selected")
	}

	c := confWithPassword(p.Password)
	total, err := api.PageCount(bytes.NewReader(input), c)
	if err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "could not read page count")
	}

	selection := make([]string, len(p.Pages))
	for i, op := range p.Pages {
		if op.Source < 1 || op.Source > total {
			return nil, bridge.Errf(bridge.CodeInvalid, "page %d is out of range 1-%d", op.Source, total)
		}
		if r := ((op.Rotation % 360) + 360) % 360; r%90 != 0 {
			return nil, bridge.Errf(bridge.CodeInvalid, "rotation must be a multiple of 90, got %d", op.Rotation)
		}
		selection[i] = strconv.Itoa(op.Source)
	}

	prog.report(0, 2, "collecting")

	var collected bytes.Buffer
	if err := api.Collect(bytes.NewReader(input), &collected, selection, c); err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "organize failed")
	}

	prog.report(1, 2, "rotating")

	out, err := applyRotationGroups(collected.Bytes(), p.Pages, c)
	if err != nil {
		return nil, err
	}

	prog.report(2, 2, "rotating")
	return out, nil
}

// applyRotationGroups chains one api.Rotate pass per distinct nonzero
// rotation delta, each against POST-Collect page positions (index+1 into
// pages, not PageOp.Source). Grouping by delta rather than rotating one page
// at a time keeps this to a handful of passes even on a large document.
func applyRotationGroups(collected []byte, pages []PageOp, c *model.Configuration) ([]byte, error) {
	groups := map[int][]string{}
	for i, op := range pages {
		r := ((op.Rotation % 360) + 360) % 360
		if r == 0 {
			continue
		}
		groups[r] = append(groups[r], strconv.Itoa(i+1))
	}
	if len(groups) == 0 {
		return collected, nil
	}

	current := collected
	for r, sel := range groups {
		var out bytes.Buffer
		if err := api.Rotate(bytes.NewReader(current), &out, r, sel, c); err != nil {
			return nil, bridge.Wrap(bridge.Classify(err), err, "rotate failed")
		}
		current = out.Bytes()
	}
	return current, nil
}
