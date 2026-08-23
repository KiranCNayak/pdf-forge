package ops

import (
	"bytes"
	"fmt"

	"github.com/pdfcpu/pdfcpu/pkg/api"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// ---------------------------------------------------------------- page count

// PageCount returns the number of pages, for cheap UI display before any real work.
func PageCount(input []byte, password string) (int, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return 0, err
	}
	n, err := api.PageCount(bytes.NewReader(input), confWithPassword(password))
	if err != nil {
		return 0, bridge.Wrap(classifyAuth(err, password), err, "could not read page count")
	}
	return n, nil
}

// ------------------------------------------------------------ extract pages

// ExtractParams configures ExtractPages. See docs/tools/extract-pages.md.
type ExtractParams struct {
	// Selection uses pdfcpu's page-selection syntax: "1-3,5,8-12", "even", "!7".
	Selection string `json:"selection"`
	Password  string `json:"password,omitempty"`
}

// ExtractPages pulls a selection of pages into one new document.
//
// api.Collect preserves the order given in the selection rather than document
// order, so "5,1,3" yields pages in that sequence. That is a feature worth
// exposing in the UI, not a quirk to normalise away.
func ExtractPages(input []byte, p ExtractParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}

	pages, err := api.ParsePageSelection(p.Selection)
	if err != nil {
		return nil, bridge.Wrap(bridge.CodeInvalid, err, "invalid page selection %q", p.Selection)
	}
	if len(pages) == 0 {
		return nil, bridge.Errf(bridge.CodeInvalid, "page selection is empty")
	}

	prog.report(0, 1, "extracting")

	var out bytes.Buffer
	if err := api.Collect(bytes.NewReader(input), &out, pages, confWithPassword(p.Password)); err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "extract failed")
	}

	prog.report(1, 1, "extracting")
	return out.Bytes(), nil
}

// ------------------------------------------------------------------- rotate

// RotateParams configures Rotate. See docs/tools/rotate.md.
type RotateParams struct {
	// Rotation is a RELATIVE delta added to each page's existing /Rotate value,
	// not an absolute orientation. Two calls of 90 give 180. Getting this
	// backwards produces a tool that appears to fail randomly on scans, which
	// usually already carry a /Rotate entry.
	Rotation int `json:"rotation"`
	// Selection is nil or empty for all pages.
	Selection []string `json:"selection,omitempty"`
	Password  string   `json:"password,omitempty"`
}

// Rotate turns pages by a multiple of 90 degrees.
func Rotate(input []byte, p RotateParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}

	r := ((p.Rotation % 360) + 360) % 360
	if r%90 != 0 {
		return nil, bridge.Errf(bridge.CodeInvalid, "rotation must be a multiple of 90, got %d", p.Rotation)
	}
	if r == 0 {
		// A no-op rewrite would still produce a subtly different file. Refuse
		// rather than hand back something that looks changed but is not.
		return nil, bridge.Errf(bridge.CodeInvalid, "rotation of 0 has no effect")
	}

	prog.report(0, 1, "rotating")

	var out bytes.Buffer
	if err := api.Rotate(bytes.NewReader(input), &out, r, p.Selection, confWithPassword(p.Password)); err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "rotate failed")
	}

	prog.report(1, 1, "rotating")
	return out.Bytes(), nil
}

// -------------------------------------------------------------------- split

// SplitParams configures Split. See docs/tools/split.md.
type SplitParams struct {
	// Mode: "each" (one file per page) | "span" (fixed chunks) | "ranges".
	Mode     string   `json:"mode"`
	Span     int      `json:"span,omitempty"`
	Ranges   []string `json:"ranges,omitempty"`
	Password string   `json:"password,omitempty"`
}

// SplitPart is one output document.
type SplitPart struct {
	Name  string `json:"name"`
	Bytes []byte `json:"-"`
}

// Split divides one document into several.
//
// Deliberately avoids api.Split / api.SplitByPageNr: both require an output
// DIRECTORY, which would drag a filesystem shim into the Wasm build for no
// benefit. api.Collect over page selections does the same job in memory.
func Split(input []byte, p SplitParams, prog Progress) ([]SplitPart, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}

	c := confWithPassword(p.Password)
	total, err := api.PageCount(bytes.NewReader(input), c)
	if err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "could not read page count")
	}

	selections, names, err := splitPlan(p, total)
	if err != nil {
		return nil, err
	}

	parts := make([]SplitPart, 0, len(selections))
	for i, sel := range selections {
		prog.report(i, len(selections), "splitting")

		var out bytes.Buffer
		if err := api.Collect(bytes.NewReader(input), &out, sel, c); err != nil {
			return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "split failed on part %d", i+1)
		}
		parts = append(parts, SplitPart{Name: names[i], Bytes: out.Bytes()})
	}

	prog.report(len(selections), len(selections), "splitting")
	return parts, nil
}

// splitPlan turns the requested mode into concrete page selections plus output
// filenames. Page numbers are zero-padded so parts sort correctly in every file
// manager — "page-2" sorting after "page-10" is a small thing that makes output
// feel broken.
func splitPlan(p SplitParams, total int) ([][]string, []string, error) {
	width := len(fmt.Sprint(total))
	pad := func(n int) string { return fmt.Sprintf("%0*d", width, n) }

	switch p.Mode {
	case "each":
		sels := make([][]string, 0, total)
		names := make([]string, 0, total)
		for i := 1; i <= total; i++ {
			sels = append(sels, []string{fmt.Sprint(i)})
			names = append(names, fmt.Sprintf("page-%s.pdf", pad(i)))
		}
		return sels, names, nil

	case "span":
		if p.Span < 1 {
			return nil, nil, bridge.Errf(bridge.CodeInvalid, "span must be at least 1, got %d", p.Span)
		}
		var sels [][]string
		var names []string
		for start := 1; start <= total; start += p.Span {
			end := min(start+p.Span-1, total)
			sels = append(sels, []string{fmt.Sprintf("%d-%d", start, end)})
			names = append(names, fmt.Sprintf("pages-%s-%s.pdf", pad(start), pad(end)))
		}
		return sels, names, nil

	case "ranges":
		if len(p.Ranges) == 0 {
			return nil, nil, bridge.Errf(bridge.CodeInvalid, "no ranges given")
		}
		var sels [][]string
		var names []string
		for i, r := range p.Ranges {
			sel, err := api.ParsePageSelection(r)
			if err != nil {
				return nil, nil, bridge.Wrap(bridge.CodeInvalid, err, "invalid range %q", r)
			}
			sels = append(sels, sel)
			names = append(names, fmt.Sprintf("part-%s.pdf", pad(i+1)))
		}
		return sels, names, nil

	default:
		return nil, nil, bridge.Errf(bridge.CodeInvalid, "unknown split mode %q", p.Mode)
	}
}
