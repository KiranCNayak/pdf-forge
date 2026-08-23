package ops

import (
	"bytes"

	"github.com/pdfcpu/pdfcpu/pkg/api"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
)

// MergeParams configures Merge. See docs/tools/merge.md.
type MergeParams struct {
	// DividerPage inserts a blank page between source documents.
	DividerPage bool `json:"dividerPage"`
}

// Merge concatenates inputs in the order given.
//
// Memory: merge holds every source document's object model open simultaneously,
// which makes it the most memory-hungry op relative to input size. Callers must
// enforce device tiers against the SUM of inputs, not the largest one.
func Merge(inputs [][]byte, p MergeParams, prog Progress) ([]byte, error) {
	if len(inputs) < 2 {
		return nil, bridge.Errf(bridge.CodeInvalid, "merge needs at least 2 files, got %d", len(inputs))
	}
	for i, in := range inputs {
		if len(in) == 0 {
			return nil, bridge.Errf(bridge.CodeInvalid, "file %d is empty", i+1)
		}
	}

	prog.report(0, len(inputs), "merging")

	var out bytes.Buffer
	if err := api.MergeRaw(readers(inputs), &out, p.DividerPage, conf()); err != nil {
		return nil, bridge.Wrap(bridge.Classify(err), err, "merge failed")
	}

	prog.report(len(inputs), len(inputs), "merging")
	return out.Bytes(), nil
}
