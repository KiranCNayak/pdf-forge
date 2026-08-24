package roomcode

import "testing"

func TestGenerateShapeAndAlphabet(t *testing.T) {
	for i := 0; i < 1000; i++ {
		code, err := Generate()
		if err != nil {
			t.Fatalf("Generate: %v", err)
		}
		if len(code) != Length {
			t.Fatalf("code %q has length %d, want %d", code, len(code), Length)
		}
		if !Valid(code) {
			t.Fatalf("generated code %q fails Valid", code)
		}
		for _, r := range code {
			if r == 'I' || r == 'L' || r == 'O' || r == 'U' {
				t.Fatalf("code %q contains excluded ambiguous character %q", code, r)
			}
		}
	}
}

func TestGenerateUniqueEnough(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 5000; i++ {
		code, err := Generate()
		if err != nil {
			t.Fatalf("Generate: %v", err)
		}
		if seen[code] {
			// Not impossible, but 5000 draws from a 1B+ space colliding
			// would be extraordinarily unlucky and worth investigating.
			t.Fatalf("unexpected collision on code %q after %d draws", code, i)
		}
		seen[code] = true
	}
}

func TestValid(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"", false},
		{"ABC", false},
		{"ABCDEF", true},
		{"abcdef", false}, // lowercase not accepted; callers normalize first
		{"ABCDEI", false}, // I excluded
		{"ABCDEL", false}, // L excluded
		{"ABCDEO", false}, // O excluded
		{"ABCDEU", false}, // U excluded
		{"ABCDE!", false},
		{"ABCDEFG", false}, // too long
	}
	for _, c := range cases {
		if got := Valid(c.in); got != c.want {
			t.Errorf("Valid(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
