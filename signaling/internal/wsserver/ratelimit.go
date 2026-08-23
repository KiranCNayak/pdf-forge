package wsserver

import (
	"sync"
	"time"
)

// ipLimiter is a small per-IP token bucket. Room creation is the only
// abuse vector this server has (an attacker could otherwise spam rooms to
// exhaust memory or brute-force codes), so it's the only thing rate
// limited — joining and relaying are naturally bounded by room membership.
type ipLimiter struct {
	mu         sync.Mutex
	buckets    map[string]*bucket
	rate       float64 // tokens added per second
	burst      float64 // bucket capacity
	now        func() time.Time
	lastSwept  time.Time
	sweepEvery time.Duration
}

type bucket struct {
	tokens float64
	last   time.Time
}

// newIPLimiter allows burst room-creations immediately, refilling at rate
// tokens/second thereafter.
func newIPLimiter(rate, burst float64) *ipLimiter {
	return &ipLimiter{
		buckets:    make(map[string]*bucket),
		rate:       rate,
		burst:      burst,
		now:        time.Now,
		sweepEvery: 10 * time.Minute,
	}
}

// Allow reports whether ip may create a room right now, consuming a token
// if so.
func (l *ipLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.sweepLocked(now)

	b, ok := l.buckets[ip]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepLocked drops buckets that have been full and idle long enough that
// keeping them costs more than regenerating them would. Caller holds l.mu.
func (l *ipLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSwept) < l.sweepEvery {
		return
	}
	l.lastSwept = now
	for ip, b := range l.buckets {
		if now.Sub(b.last) > l.sweepEvery {
			delete(l.buckets, ip)
		}
	}
}
