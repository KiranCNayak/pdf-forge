package wsserver

import (
	"encoding/json"
	"log"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"pdf-forge/signaling/internal/hub"
	"pdf-forge/signaling/internal/protocol"
)

func testLogger(t *testing.T) Logger {
	return log.New(testWriter{t}, "", 0)
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

func newTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	h := hub.New(10 * time.Minute)
	s := New(h, Options{Logger: testLogger(t)})
	srv := httptest.NewServer(s.Mux())
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	t.Cleanup(srv.Close)
	return srv, wsURL
}

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func readEnvelope(t *testing.T, c *websocket.Conn) protocol.Envelope {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var env protocol.Envelope
	if err := c.ReadJSON(&env); err != nil {
		t.Fatalf("read envelope: %v", err)
	}
	return env
}

func TestEndToEndCreateJoinRelay(t *testing.T) {
	_, wsURL := newTestServer(t)

	sender := dial(t, wsURL)
	receiver := dial(t, wsURL)

	if err := sender.WriteJSON(protocol.Envelope{Type: protocol.TypeCreate}); err != nil {
		t.Fatalf("send create: %v", err)
	}
	created := readEnvelope(t, sender)
	if created.Type != protocol.TypeCreated || created.Code == "" {
		t.Fatalf("got %+v, want created with a code", created)
	}
	code := created.Code

	if err := receiver.WriteJSON(protocol.Envelope{Type: protocol.TypeJoin, Code: code}); err != nil {
		t.Fatalf("send join: %v", err)
	}
	joined := readEnvelope(t, receiver)
	if joined.Type != protocol.TypeJoined {
		t.Fatalf("receiver got %+v, want joined", joined)
	}
	peerJoined := readEnvelope(t, sender)
	if peerJoined.Type != protocol.TypePeerJoined {
		t.Fatalf("sender got %+v, want peer-joined", peerJoined)
	}

	offerData := json.RawMessage(`{"sdp":"v=0 fake offer"}`)
	if err := sender.WriteJSON(protocol.Envelope{Type: protocol.TypeOffer, Code: code, Data: offerData}); err != nil {
		t.Fatalf("send offer: %v", err)
	}
	offer := readEnvelope(t, receiver)
	if offer.Type != protocol.TypeOffer || string(offer.Data) != string(offerData) {
		t.Fatalf("receiver got %+v, want the offer relayed verbatim", offer)
	}

	answerData := json.RawMessage(`{"sdp":"v=0 fake answer"}`)
	if err := receiver.WriteJSON(protocol.Envelope{Type: protocol.TypeAnswer, Code: code, Data: answerData}); err != nil {
		t.Fatalf("send answer: %v", err)
	}
	answer := readEnvelope(t, sender)
	if answer.Type != protocol.TypeAnswer || string(answer.Data) != string(answerData) {
		t.Fatalf("sender got %+v, want the answer relayed verbatim", answer)
	}

	iceData := json.RawMessage(`{"candidate":"fake"}`)
	if err := sender.WriteJSON(protocol.Envelope{Type: protocol.TypeICE, Code: code, Data: iceData}); err != nil {
		t.Fatalf("send ice: %v", err)
	}
	ice := readEnvelope(t, receiver)
	if ice.Type != protocol.TypeICE {
		t.Fatalf("receiver got %+v, want ice", ice)
	}
}

func TestJoinUnknownRoomOverWebSocket(t *testing.T) {
	_, wsURL := newTestServer(t)
	receiver := dial(t, wsURL)

	if err := receiver.WriteJSON(protocol.Envelope{Type: protocol.TypeJoin, Code: "ZZZZZZ"}); err != nil {
		t.Fatalf("send join: %v", err)
	}
	env := readEnvelope(t, receiver)
	if env.Type != protocol.TypeError {
		t.Fatalf("got %+v, want an error envelope", env)
	}
}

func TestUnknownMessageTypeGetsInvalidMessageError(t *testing.T) {
	_, wsURL := newTestServer(t)
	c := dial(t, wsURL)

	if err := c.WriteJSON(protocol.Envelope{Type: "not-a-real-type"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	env := readEnvelope(t, c)
	if env.Type != protocol.TypeError {
		t.Fatalf("got %+v, want an error envelope", env)
	}
}

func TestRoomCreationIsRateLimited(t *testing.T) {
	h := hub.New(10 * time.Minute)
	s := New(h, Options{CreateRoomsPerMinute: 60, CreateBurst: 2, Logger: testLogger(t)})
	srv := httptest.NewServer(s.Mux())
	t.Cleanup(srv.Close)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	c := dial(t, wsURL)

	for i := 0; i < 2; i++ {
		if err := c.WriteJSON(protocol.Envelope{Type: protocol.TypeCreate}); err != nil {
			t.Fatalf("send create %d: %v", i, err)
		}
		env := readEnvelope(t, c)
		if env.Type != protocol.TypeCreated {
			t.Fatalf("create %d got %+v, want created", i, env)
		}
	}

	if err := c.WriteJSON(protocol.Envelope{Type: protocol.TypeCreate}); err != nil {
		t.Fatalf("send create 3: %v", err)
	}
	env := readEnvelope(t, c)
	if env.Type != protocol.TypeError {
		t.Fatalf("got %+v, want rate_limited error after exhausting burst", env)
	}
}
