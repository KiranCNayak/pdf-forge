package wsserver

import (
	"testing"
	"time"
)

func TestIPLimiterAllowsUpToBurstThenBlocks(t *testing.T) {
	l := newIPLimiter(1, 3) // 1 token/sec, burst of 3
	fakeNow := time.Now()
	l.now = func() time.Time { return fakeNow }

	for i := 0; i < 3; i++ {
		if !l.Allow("1.2.3.4") {
			t.Fatalf("Allow() call %d: want true within burst", i)
		}
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("Allow(): want false once burst is exhausted")
	}
}

func TestIPLimiterRefillsOverTime(t *testing.T) {
	l := newIPLimiter(1, 1) // 1 token/sec, burst of 1
	fakeNow := time.Now()
	l.now = func() time.Time { return fakeNow }

	if !l.Allow("1.2.3.4") {
		t.Fatal("Allow(): want true on first call")
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("Allow(): want false immediately after exhausting the bucket")
	}

	fakeNow = fakeNow.Add(1100 * time.Millisecond)
	if !l.Allow("1.2.3.4") {
		t.Fatal("Allow(): want true after refill interval elapses")
	}
}

func TestIPLimiterTracksIPsIndependently(t *testing.T) {
	l := newIPLimiter(1, 1)
	fakeNow := time.Now()
	l.now = func() time.Time { return fakeNow }

	if !l.Allow("1.2.3.4") {
		t.Fatal("Allow() for first IP: want true")
	}
	if !l.Allow("5.6.7.8") {
		t.Fatal("Allow() for second IP: want true — buckets must not be shared")
	}
}
