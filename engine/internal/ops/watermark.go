package ops

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// WatermarkParams configures AddWatermark. See docs/tools/add-watermark.md.
type WatermarkParams struct {
	Text string `json:"text"`
	// Selection is nil or empty for every page.
	Selection []string `json:"selection,omitempty"`
	// FontSize in points. Must be positive.
	FontSize int `json:"fontSize"`
	// Color is anything pdfcpu's color.ParseColor accepts: a name ("gray"),
	// a hex code ("#808080"), or "r g b" floats 0..1 each.
	Color string `json:"color"`
	// Position is a 9-point anchor keyword: tl, tc, tr, l, c, r, bl, bc, br.
	Position string `json:"position"`
	// Rotation in degrees, -180..180. Always sent explicitly — see the doc's
	// "Deferred" section on why this means no diagonal-by-default placement.
	Rotation float64 `json:"rotation"`
	// Opacity in (0, 1]. 0 is rejected rather than silently producing an
	// invisible watermark.
	Opacity float64 `json:"opacity"`
	// OnTop draws over page content (a "stamp") when true, behind it (a true
	// watermark) when false.
	OnTop    bool   `json:"onTop"`
	Password string `json:"password,omitempty"`
}

// AddWatermark stamps text onto selected pages (or all of them).
//
// api.TextWatermark parses a comma-separated "key:value" description string
// — the same syntax pdfcpu's own CLI uses. Always including an explicit
// rotation key (rather than omitting it to fall back to pdfcpu's own
// diagonal default) is deliberate: see the doc's Deferred section.
func AddWatermark(input []byte, p WatermarkParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Text) == "" {
		return nil, bridge.Errf(bridge.CodeInvalid, "watermark text is empty")
	}
	if p.FontSize <= 0 {
		return nil, bridge.Errf(bridge.CodeInvalid, "font size must be positive, got %d", p.FontSize)
	}
	if p.Opacity <= 0 || p.Opacity > 1 {
		return nil, bridge.Errf(bridge.CodeInvalid, "opacity must be between 0 (exclusive) and 1, got %v", p.Opacity)
	}
	if p.Rotation < -180 || p.Rotation > 180 {
		return nil, bridge.Errf(bridge.CodeInvalid, "rotation must be between -180 and 180 degrees, got %v", p.Rotation)
	}

	if err := requireSelectionResolvesToPages(input, p.Selection, p.Password); err != nil {
		return nil, err
	}

	position := p.Position
	if position == "" {
		position = "c"
	}
	color := p.Color
	if color == "" {
		color = "gray"
	}
	desc := fmt.Sprintf("points:%d, position:%s, rotation:%g, opacity:%g, color:%s",
		p.FontSize, position, p.Rotation, p.Opacity, color)

	wm, err := api.TextWatermark(p.Text, desc, p.OnTop, false, types.POINTS)
	if err != nil {
		return nil, bridge.Wrap(bridge.CodeInvalid, err, "invalid watermark configuration")
	}

	prog.report(0, 1, "watermarking")

	var out bytes.Buffer
	if err := api.AddWatermarks(bytes.NewReader(input), &out, p.Selection, wm, confWithPassword(p.Password)); err != nil {
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "add watermark failed")
	}

	prog.report(1, 1, "watermarking")
	return out.Bytes(), nil
}

// ------------------------------------------------------------- remove watermark

// RemoveWatermarkParams configures RemoveWatermark. See docs/tools/remove-watermark.md.
type RemoveWatermarkParams struct {
	// Selection is nil or empty for every page. Same raw pdfcpu token syntax
	// as WatermarkParams.Selection — "even"/"odd" work with no special
	// handling here, see the doc.
	Selection []string `json:"selection,omitempty"`
	Password  string   `json:"password,omitempty"`
}

// RemoveWatermark strips watermarks pdfcpu itself (or anything using the same
// /Artifact-tagged form-XObject mechanism) can recognise. It cannot remove
// text burned into a page's own content stream with no watermark tag — see
// the doc's "This only removes..." note.
func RemoveWatermark(input []byte, p RemoveWatermarkParams, prog Progress) ([]byte, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return nil, err
	}
	if err := requireSelectionResolvesToPages(input, p.Selection, p.Password); err != nil {
		return nil, err
	}

	prog.report(0, 1, "removing watermark")

	var out bytes.Buffer
	if err := api.RemoveWatermarks(bytes.NewReader(input), &out, p.Selection, confWithPassword(p.Password)); err != nil {
		// Unlike AddWatermarks on a selection resolving to zero pages,
		// RemoveWatermarks does NOT silently no-op when there's nothing to
		// remove — it errors ("no watermarks found"). The doc promises this
		// is a harmless no-op, not a failure, so this is where that promise
		// actually gets kept: hand back the original bytes unchanged rather
		// than surfacing pdfcpu's internal wording as ERR_INTERNAL.
		if strings.Contains(err.Error(), "no watermarks found") {
			prog.report(1, 1, "removing watermark")
			return input, nil
		}
		return nil, bridge.Wrap(classifyAuth(err, p.Password), err, "remove watermark failed")
	}

	prog.report(1, 1, "removing watermark")
	return out.Bytes(), nil
}

// HasWatermarks is a cheap pre-flight check — same role isEncrypted/pageCount
// play for other tools: answer a question before the user commits to running
// an operation. "No watermark" is a real, useful answer, not an error.
func HasWatermarks(input []byte, password string) (bool, error) {
	if err := requireNonEmpty(input, "file"); err != nil {
		return false, err
	}
	ok, err := api.HasWatermarks(bytes.NewReader(input), confWithPassword(password))
	if err != nil {
		return false, bridge.Wrap(classifyAuth(err, password), err, "could not inspect file for watermarks")
	}
	return ok, nil
}
