// Package roomcode generates and validates the 6-character room codes used
// to pair a sender and a receiver.
package roomcode

import (
	"crypto/rand"
)

// alphabet is Crockford base32 with I, L, O, U removed — unambiguous when
// read aloud or typed by hand. 32 symbols, so it still packs 5 bits/char.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// Length is the number of characters in a room code. 32^6 ≈ 1.07 billion
// possibilities; combined with a short room TTL the live set is tiny, so
// collisions are negligible and guessing is impractical.
const Length = 6

// Generate returns a random room code. It reads from crypto/rand and never
// returns an error under normal operation; the error return exists because
// crypto/rand.Read can fail, in which case the caller should treat it as an
// internal error and retry or fail closed — never fall back to a weaker RNG.
func Generate() (string, error) {
	buf := make([]byte, Length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	code := make([]byte, Length)
	for i, b := range buf {
		code[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(code), nil
}

// Valid reports whether s has the shape of a room code: the right length
// and every character drawn from the alphabet. It does not check whether
// the room exists.
func Valid(s string) bool {
	if len(s) != Length {
		return false
	}
	for _, r := range s {
		if !contains(r) {
			return false
		}
	}
	return true
}

func contains(r rune) bool {
	for _, a := range alphabet {
		if a == r {
			return true
		}
	}
	return false
}
