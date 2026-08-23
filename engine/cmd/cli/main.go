// Command pdf-forge runs the engine natively.
//
// This exists for three reasons, in order of importance:
//   - it is the self-hostable binary, for users who want the tools without a browser
//   - it is the native baseline for the Phase 5 benchmark harness (docs/BENCHMARKING.md),
//     which is free precisely because it links the same internal/ops package
//   - it makes ops debuggable with a real debugger and a real profiler
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kirancnayak/pdf-forge/engine/internal/bridge"
	"github.com/kirancnayak/pdf-forge/engine/internal/ops"
)

const usage = `pdf-forge — client-side PDF engine

Usage:
  pdf-forge merge    -o out.pdf in1.pdf in2.pdf [...]
  pdf-forge split    -mode each|span|ranges [-span N] [-ranges 1-3,5] -o outdir in.pdf
  pdf-forge extract  -pages 1-3,5 -o out.pdf in.pdf
  pdf-forge rotate   -deg 90 [-pages 1-3] -o out.pdf in.pdf
  pdf-forge encrypt  -pw SECRET [-owner SECRET] [-bits 256] -o out.pdf in.pdf
  pdf-forge decrypt  -pw SECRET -o out.pdf in.pdf
  pdf-forge info     in.pdf

Rotation is relative: it adds to each page's existing /Rotate value.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "merge":
		err = cmdMerge(os.Args[2:])
	case "split":
		err = cmdSplit(os.Args[2:])
	case "extract":
		err = cmdExtract(os.Args[2:])
	case "rotate":
		err = cmdRotate(os.Args[2:])
	case "encrypt":
		err = cmdEncrypt(os.Args[2:])
	case "decrypt":
		err = cmdDecrypt(os.Args[2:])
	case "info":
		err = cmdInfo(os.Args[2:])
	case "-h", "--help", "help":
		fmt.Print(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}

	if err != nil {
		fail(err)
	}
}

// fail prints the stable error code alongside the message, so CLI output and
// browser errors are diagnosable the same way.
func fail(err error) {
	var e *bridge.Error
	if errors.As(err, &e) {
		fmt.Fprintf(os.Stderr, "error [%s]: %s\n", e.Code, bridge.UserMessage(e.Code))
		fmt.Fprintf(os.Stderr, "  detail: %v\n", err)
	} else {
		fmt.Fprintf(os.Stderr, "error [%s]: %v\n", bridge.Classify(err), err)
	}
	os.Exit(1)
}

// progress prints to stderr so stdout stays clean for piping.
func progress(verbose bool) ops.Progress {
	if !verbose {
		return nil
	}
	return func(done, total int, stage string) {
		if total > 0 {
			fmt.Fprintf(os.Stderr, "\r%s %d/%d", stage, done, total)
			if done == total {
				fmt.Fprintln(os.Stderr)
			}
		}
	}
}

func read(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, bridge.Wrap(bridge.CodeInvalid, err, "could not read %s", path)
	}
	return b, nil
}

func write(path string, b []byte) error {
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return bridge.Wrap(bridge.CodeInternal, err, "could not write %s", path)
	}
	fmt.Fprintf(os.Stderr, "wrote %s (%s)\n", path, humanBytes(len(b)))
	return nil
}

func humanBytes(n int) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.2f MB", float64(n)/(1024*1024))
	}
}

func cmdMerge(argv []string) error {
	fs := flag.NewFlagSet("merge", flag.ExitOnError)
	out := fs.String("o", "merged.pdf", "output file")
	divider := fs.Bool("divider", false, "insert a blank page between documents")
	v := fs.Bool("v", false, "verbose progress")
	fs.Parse(argv)

	if fs.NArg() < 2 {
		return bridge.Errf(bridge.CodeInvalid, "merge needs at least 2 input files")
	}

	inputs := make([][]byte, 0, fs.NArg())
	for _, p := range fs.Args() {
		b, err := read(p)
		if err != nil {
			return err
		}
		inputs = append(inputs, b)
	}

	res, err := ops.Merge(inputs, ops.MergeParams{DividerPage: *divider}, progress(*v))
	if err != nil {
		return err
	}
	return write(*out, res)
}

func cmdSplit(argv []string) error {
	fs := flag.NewFlagSet("split", flag.ExitOnError)
	mode := fs.String("mode", "each", "each | span | ranges")
	span := fs.Int("span", 1, "pages per part (span mode)")
	ranges := fs.String("ranges", "", "comma-separated ranges, e.g. 1-3,5,8-10 (ranges mode)")
	outDir := fs.String("o", ".", "output directory")
	pw := fs.String("pw", "", "password, if the file is protected")
	v := fs.Bool("v", false, "verbose progress")
	fs.Parse(argv)

	if fs.NArg() != 1 {
		return bridge.Errf(bridge.CodeInvalid, "split needs exactly 1 input file")
	}
	in, err := read(fs.Arg(0))
	if err != nil {
		return err
	}

	p := ops.SplitParams{Mode: *mode, Span: *span, Password: *pw}
	if *ranges != "" {
		p.Ranges = strings.Split(*ranges, ",")
	}

	parts, err := ops.Split(in, p, progress(*v))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return bridge.Wrap(bridge.CodeInternal, err, "could not create %s", *outDir)
	}
	for _, part := range parts {
		if err := write(filepath.Join(*outDir, part.Name), part.Bytes); err != nil {
			return err
		}
	}
	return nil
}

func cmdExtract(argv []string) error {
	fs := flag.NewFlagSet("extract", flag.ExitOnError)
	pages := fs.String("pages", "", "page selection, e.g. 1-3,5,8-12")
	out := fs.String("o", "extracted.pdf", "output file")
	pw := fs.String("pw", "", "password, if the file is protected")
	v := fs.Bool("v", false, "verbose progress")
	fs.Parse(argv)

	if fs.NArg() != 1 {
		return bridge.Errf(bridge.CodeInvalid, "extract needs exactly 1 input file")
	}
	in, err := read(fs.Arg(0))
	if err != nil {
		return err
	}

	res, err := ops.ExtractPages(in, ops.ExtractParams{Selection: *pages, Password: *pw}, progress(*v))
	if err != nil {
		return err
	}
	return write(*out, res)
}

func cmdRotate(argv []string) error {
	fs := flag.NewFlagSet("rotate", flag.ExitOnError)
	deg := fs.Int("deg", 90, "degrees, a multiple of 90 (relative to existing rotation)")
	pages := fs.String("pages", "", "page selection; empty means all pages")
	out := fs.String("o", "rotated.pdf", "output file")
	pw := fs.String("pw", "", "password, if the file is protected")
	v := fs.Bool("v", false, "verbose progress")
	fs.Parse(argv)

	if fs.NArg() != 1 {
		return bridge.Errf(bridge.CodeInvalid, "rotate needs exactly 1 input file")
	}
	in, err := read(fs.Arg(0))
	if err != nil {
		return err
	}

	p := ops.RotateParams{Rotation: *deg, Password: *pw}
	if *pages != "" {
		p.Selection = strings.Split(*pages, ",")
	}

	res, err := ops.Rotate(in, p, progress(*v))
	if err != nil {
		return err
	}
	return write(*out, res)
}

func cmdEncrypt(argv []string) error {
	fs := flag.NewFlagSet("encrypt", flag.ExitOnError)
	pw := fs.String("pw", "", "open (user) password")
	owner := fs.String("owner", "", "permissions (owner) password; defaults to -pw")
	bits := fs.Int("bits", 256, "AES key length: 256, 128 or 40")
	out := fs.String("o", "encrypted.pdf", "output file")
	v := fs.Bool("v", false, "verbose progress")
	fs.Parse(argv)

	if fs.NArg() != 1 {
		return bridge.Errf(bridge.CodeInvalid, "encrypt needs exactly 1 input file")
	}
	if *pw == "" && *owner == "" {
		return bridge.Errf(bridge.CodeInvalid, "set -pw or -owner")
	}
	in, err := read(fs.Arg(0))
	if err != nil {
		return err
	}

	ownerPW := *owner
	if ownerPW == "" {
		ownerPW = *pw
	}

	res, err := ops.Encrypt(in, ops.EncryptParams{
		UserPW: *pw, OwnerPW: ownerPW, KeyLength: *bits,
	}, progress(*v))
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "note: there is no password recovery — if you lose it, the file is unreadable")
	return write(*out, res)
}

func cmdDecrypt(argv []string) error {
	fs := flag.NewFlagSet("decrypt", flag.ExitOnError)
	pw := fs.String("pw", "", "the password you already know")
	out := fs.String("o", "decrypted.pdf", "output file")
	v := fs.Bool("v", false, "verbose progress")
	fs.Parse(argv)

	if fs.NArg() != 1 {
		return bridge.Errf(bridge.CodeInvalid, "decrypt needs exactly 1 input file")
	}
	in, err := read(fs.Arg(0))
	if err != nil {
		return err
	}

	res, err := ops.Decrypt(in, ops.DecryptParams{Password: *pw}, progress(*v))
	if err != nil {
		return err
	}
	return write(*out, res)
}

func cmdInfo(argv []string) error {
	fs := flag.NewFlagSet("info", flag.ExitOnError)
	pw := fs.String("pw", "", "password, if the file is protected")
	fs.Parse(argv)

	if fs.NArg() != 1 {
		return bridge.Errf(bridge.CodeInvalid, "info needs exactly 1 input file")
	}
	path := fs.Arg(0)
	in, err := read(path)
	if err != nil {
		return err
	}

	encrypted, err := ops.IsEncrypted(in)
	if err != nil {
		return err
	}

	fmt.Printf("file:      %s\n", path)
	fmt.Printf("size:      %s\n", humanBytes(len(in)))
	fmt.Printf("encrypted: %t\n", encrypted)

	if encrypted && *pw == "" {
		fmt.Println("pages:     unknown (pass -pw to read)")
		return nil
	}
	n, err := ops.PageCount(in, *pw)
	if err != nil {
		return err
	}
	fmt.Printf("pages:     %d\n", n)
	return nil
}
