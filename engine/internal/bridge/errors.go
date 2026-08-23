// Package bridge holds everything that crosses the Go/JS boundary: stable error
// codes, buffer conversion, and the Promise wrapper that keeps long operations
// off the Wasm event loop.
//
// Nothing in here imports syscall/js except the files guarded by the js build
// tag, so the whole package compiles for native builds and tests too.
package bridge

import (
	"errors"
	"fmt"
	"strings"
)

// Code is a stable, machine-readable error identifier. The UI switches on these;
// it must never string-match on messages. See docs/LLD.md §1.7.
type Code string

const (
	CodeEncrypted   Code = "ERR_ENCRYPTED"
	CodeBadPassword Code = "ERR_BAD_PASSWORD"
	CodeCorrupt     Code = "ERR_CORRUPT"
	CodeUnsupported Code = "ERR_UNSUPPORTED"
	CodeTooLarge    Code = "ERR_TOO_LARGE"
	CodeOOM         Code = "ERR_OOM"
	CodeCancelled   Code = "ERR_CANCELLED"
	CodeInvalid     Code = "ERR_INVALID_PARAMS"
	CodeInternal    Code = "ERR_INTERNAL"
)

// Error carries a code alongside the underlying cause.
type Error struct {
	Code Code
	Msg  string
	Err  error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Msg, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Msg)
}

func (e *Error) Unwrap() error { return e.Err }

// Errf builds a coded error.
func Errf(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// Wrap attaches a code to an existing error.
func Wrap(code Code, err error, format string, args ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, args...), Err: err}
}

// Classify maps an arbitrary error — usually from pdfcpu — onto a stable Code.
//
// pdfcpu does not export sentinel errors for most failure modes, so this
// inspects messages. That is fragile by nature, which is exactly why it lives in
// one place: when a pdfcpu upgrade changes wording, there is a single function to
// fix rather than a mapping scattered across every op.
func Classify(err error) Code {
	if err == nil {
		return ""
	}

	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}

	msg := strings.ToLower(err.Error())

	switch {
	// Order matters: a wrong password also mentions "encrypt".
	case strings.Contains(msg, "please provide the correct password"),
		strings.Contains(msg, "invalid password"),
		strings.Contains(msg, "wrong password"):
		return CodeBadPassword

	case strings.Contains(msg, "encrypt"),
		strings.Contains(msg, "password"):
		return CodeEncrypted

	case strings.Contains(msg, "xref"),
		strings.Contains(msg, "corrupt"),
		strings.Contains(msg, "malformed"),
		strings.Contains(msg, "not a pdf"),
		strings.Contains(msg, "no pdf header"),
		strings.Contains(msg, "eof"):
		return CodeCorrupt

	case strings.Contains(msg, "unsupported"),
		strings.Contains(msg, "not supported"):
		return CodeUnsupported

	case strings.Contains(msg, "out of memory"),
		strings.Contains(msg, "cannot allocate"):
		return CodeOOM
	}

	return CodeInternal
}

// UserMessage returns copy safe to show a user directly. Ops may override it with
// something more specific; this is the floor, not the ceiling.
func UserMessage(code Code) string {
	switch code {
	case CodeEncrypted:
		return "This PDF is password protected. Enter its password to continue."
	case CodeBadPassword:
		return "That password did not work. Check it and try again."
	case CodeCorrupt:
		return "This file appears to be damaged or is not a valid PDF."
	case CodeUnsupported:
		return "This PDF uses a feature we cannot handle yet."
	case CodeTooLarge:
		return "This file is too large for this device."
	case CodeOOM:
		return "Ran out of memory. Try fewer pages or a lower quality setting."
	case CodeCancelled:
		return "Cancelled."
	case CodeInvalid:
		return "Those settings are not valid."
	default:
		return "Something went wrong."
	}
}
