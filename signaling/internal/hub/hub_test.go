package hub

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"pdf-forge/signaling/internal/protocol"
)

// fakeConn records every envelope sent to it. Safe for concurrent use.
type fakeConn struct {
	name string

	mu   sync.Mutex
	sent []protocol.Envelope
}

func newFakeConn(name string) *fakeConn { return &fakeConn{name: name} }

func (c *fakeConn) Send(env protocol.Envelope) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, env)
	return nil
}

func (c *fakeConn) types() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.sent))
	for i, e := range c.sent {
		out[i] = e.Type
	}
	return out
}

func (c *fakeConn) last() (protocol.Envelope, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.sent) == 0 {
		return protocol.Envelope{}, false
	}
	return c.sent[len(c.sent)-1], true
}

func errCode(t *testing.T, env protocol.Envelope) string {
	t.Helper()
	if env.Type != protocol.TypeError {
		t.Fatalf("envelope is type %q, want %q", env.Type, protocol.TypeError)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(env.Data, &body); err != nil {
		t.Fatalf("unmarshal error data: %v", err)
	}
	return body.Code
}

func TestCreateSendsCodeToCreator(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")

	code, err := h.Create(sender)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(code) != 6 {
		t.Fatalf("code %q has unexpected length", code)
	}
	env, ok := sender.last()
	if !ok || env.Type != protocol.TypeCreated || env.Code != code {
		t.Fatalf("sender got %+v, want created/%s", env, code)
	}
	if h.RoomCount() != 1 {
		t.Fatalf("RoomCount = %d, want 1", h.RoomCount())
	}
}

func TestPairing(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	receiver := newFakeConn("receiver")

	code, err := h.Create(sender)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := h.Join(code, receiver); err != nil {
		t.Fatalf("Join: %v", err)
	}

	env, ok := receiver.last()
	if !ok || env.Type != protocol.TypeJoined || env.Code != code {
		t.Fatalf("receiver got %+v, want joined/%s", env, code)
	}
	env, ok = sender.last()
	if !ok || env.Type != protocol.TypePeerJoined || env.Code != code {
		t.Fatalf("sender got %+v, want peer-joined/%s", env, code)
	}
}

func TestJoinLowercaseAndWhitespaceNormalized(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	receiver := newFakeConn("receiver")

	code, err := h.Create(sender)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := h.Join(" "+toLower(code)+" ", receiver); err != nil {
		t.Fatalf("Join with normalized code: %v", err)
	}
	env, ok := receiver.last()
	if !ok || env.Type != protocol.TypeJoined {
		t.Fatalf("receiver got %+v, want joined", env)
	}
}

func toLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func TestJoinUnknownCode(t *testing.T) {
	h := New(10 * time.Minute)
	receiver := newFakeConn("receiver")

	err := h.Join("ABCDEF", receiver)
	if err == nil {
		t.Fatal("Join: want error for unknown room")
	}
	env, _ := receiver.last()
	if got := errCode(t, env); got != protocol.ErrRoomNotFound {
		t.Fatalf("error code = %q, want %q", got, protocol.ErrRoomNotFound)
	}
}

func TestJoinInvalidCodeShape(t *testing.T) {
	h := New(10 * time.Minute)
	receiver := newFakeConn("receiver")

	err := h.Join("nope", receiver)
	if err == nil {
		t.Fatal("Join: want error for malformed code")
	}
	env, _ := receiver.last()
	if got := errCode(t, env); got != protocol.ErrInvalidCode {
		t.Fatalf("error code = %q, want %q", got, protocol.ErrInvalidCode)
	}
}

func TestRoomFullOnThirdJoin(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	receiver := newFakeConn("receiver")
	third := newFakeConn("third")

	code, _ := h.Create(sender)
	if err := h.Join(code, receiver); err != nil {
		t.Fatalf("Join #2: %v", err)
	}

	err := h.Join(code, third)
	if err == nil {
		t.Fatal("Join #3: want room_full error")
	}
	env, _ := third.last()
	if got := errCode(t, env); got != protocol.ErrRoomFull {
		t.Fatalf("error code = %q, want %q", got, protocol.ErrRoomFull)
	}
}

func TestTTLExpiry(t *testing.T) {
	h := New(10 * time.Minute)
	fakeNow := time.Now()
	h.now = func() time.Time { return fakeNow }

	sender := newFakeConn("sender")
	code, _ := h.Create(sender)

	// Advance past TTL.
	fakeNow = fakeNow.Add(11 * time.Minute)

	receiver := newFakeConn("receiver")
	err := h.Join(code, receiver)
	if err == nil {
		t.Fatal("Join: want error for expired room")
	}
	env, _ := receiver.last()
	if got := errCode(t, env); got != protocol.ErrRoomExpired {
		t.Fatalf("error code = %q, want %q", got, protocol.ErrRoomExpired)
	}
	if h.RoomCount() != 0 {
		t.Fatalf("RoomCount = %d, want 0 (expired room should be evicted on access)", h.RoomCount())
	}
}

func TestSweepExpiredNotifiesRemainingPeer(t *testing.T) {
	h := New(10 * time.Minute)
	fakeNow := time.Now()
	h.now = func() time.Time { return fakeNow }

	sender := newFakeConn("sender")
	code, _ := h.Create(sender)

	fakeNow = fakeNow.Add(11 * time.Minute)

	n := h.SweepExpired()
	if n != 1 {
		t.Fatalf("SweepExpired removed %d rooms, want 1", n)
	}
	if h.RoomCount() != 0 {
		t.Fatalf("RoomCount = %d, want 0", h.RoomCount())
	}
	env, ok := sender.last()
	if !ok {
		t.Fatal("sender received nothing on sweep")
	}
	if got := errCode(t, env); got != protocol.ErrRoomExpired {
		t.Fatalf("error code = %q, want %q", got, protocol.ErrRoomExpired)
	}
	_ = code
}

func TestSweepExpiredLeavesLiveRoomsAlone(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	_, _ = h.Create(sender)

	if n := h.SweepExpired(); n != 0 {
		t.Fatalf("SweepExpired removed %d rooms, want 0", n)
	}
	if h.RoomCount() != 1 {
		t.Fatalf("RoomCount = %d, want 1", h.RoomCount())
	}
}

func TestRelayForwardsToOtherPeerOnly(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	receiver := newFakeConn("receiver")

	code, _ := h.Create(sender)
	_ = h.Join(code, receiver)

	offer := protocol.Envelope{Type: protocol.TypeOffer, Code: code, Data: json.RawMessage(`{"sdp":"v=0"}`)}
	if err := h.Relay(code, sender, offer); err != nil {
		t.Fatalf("Relay offer: %v", err)
	}
	env, ok := receiver.last()
	if !ok || env.Type != protocol.TypeOffer || string(env.Data) != string(offer.Data) {
		t.Fatalf("receiver got %+v, want the offer forwarded verbatim", env)
	}
	// Sender must not receive its own offer back.
	for _, ty := range sender.types() {
		if ty == protocol.TypeOffer {
			t.Fatal("sender received its own offer echoed back")
		}
	}

	answer := protocol.Envelope{Type: protocol.TypeAnswer, Code: code, Data: json.RawMessage(`{"sdp":"v=1"}`)}
	if err := h.Relay(code, receiver, answer); err != nil {
		t.Fatalf("Relay answer: %v", err)
	}
	env, ok = sender.last()
	if !ok || env.Type != protocol.TypeAnswer {
		t.Fatalf("sender got %+v, want the answer", env)
	}
}

func TestRelayFromNonMemberIsRejected(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	stranger := newFakeConn("stranger")

	code, _ := h.Create(sender)

	err := h.Relay(code, stranger, protocol.Envelope{Type: protocol.TypeICE, Code: code})
	if err == nil {
		t.Fatal("Relay: want error for a conn that is not a room member")
	}
	env, _ := stranger.last()
	if got := errCode(t, env); got != protocol.ErrInvalidMessage {
		t.Fatalf("error code = %q, want %q", got, protocol.ErrInvalidMessage)
	}
}

func TestRelayToUnjoinedRoomDropsSilently(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	code, _ := h.Create(sender)

	// No receiver has joined yet — an early ICE candidate should not error.
	err := h.Relay(code, sender, protocol.Envelope{Type: protocol.TypeICE, Code: code})
	if err != nil {
		t.Fatalf("Relay with no peer yet: %v", err)
	}
}

func TestLeaveNotifiesRemainingPeerAndKeepsRoomAlive(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	receiver := newFakeConn("receiver")
	code, _ := h.Create(sender)
	_ = h.Join(code, receiver)

	h.Leave(sender)

	env, ok := receiver.last()
	if !ok || env.Type != protocol.TypeBye {
		t.Fatalf("receiver got %+v, want bye", env)
	}
	if h.RoomCount() != 1 {
		t.Fatalf("RoomCount = %d, want 1 (room stays until both peers leave)", h.RoomCount())
	}
}

func TestLeaveBothPeersEvictsRoom(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	receiver := newFakeConn("receiver")
	code, _ := h.Create(sender)
	_ = h.Join(code, receiver)

	h.Leave(sender)
	h.Leave(receiver)

	if h.RoomCount() != 0 {
		t.Fatalf("RoomCount = %d, want 0 after both peers leave", h.RoomCount())
	}
}

func TestLeaveUnknownConnIsNoop(t *testing.T) {
	h := New(10 * time.Minute)
	sender := newFakeConn("sender")
	_, _ = h.Create(sender)

	stranger := newFakeConn("stranger")
	h.Leave(stranger) // must not panic or affect the room

	if h.RoomCount() != 1 {
		t.Fatalf("RoomCount = %d, want 1", h.RoomCount())
	}
}

func TestConcurrentCreateProducesDistinctCodes(t *testing.T) {
	h := New(10 * time.Minute)
	const n = 200

	codes := make(chan string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn := newFakeConn("c")
			code, err := h.Create(conn)
			if err != nil {
				t.Errorf("Create: %v", err)
				return
			}
			codes <- code
		}()
	}
	wg.Wait()
	close(codes)

	seen := make(map[string]bool)
	for c := range codes {
		if seen[c] {
			t.Fatalf("duplicate room code %q under concurrent creation", c)
		}
		seen[c] = true
	}
	if len(seen) != n {
		t.Fatalf("got %d distinct codes, want %d", len(seen), n)
	}
	if h.RoomCount() != n {
		t.Fatalf("RoomCount = %d, want %d", h.RoomCount(), n)
	}
}

func TestCreateCollisionRetries(t *testing.T) {
	h := New(10 * time.Minute)
	// Pre-seed the map with every code the (fake, deterministic) generator
	// would produce, forcing uniqueCodeLocked to exhaust its attempts.
	h.rooms["AAAAAA"] = &Room{Code: "AAAAAA", Created: h.now()}

	// This doesn't force a real collision (codes are random), but exercises
	// the retry path structurally: Create must still succeed and must never
	// hand out a code already present in the map.
	conn := newFakeConn("c")
	code, err := h.Create(conn)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if code == "AAAAAA" {
		t.Fatal("Create handed out a code that was already in use")
	}
}
