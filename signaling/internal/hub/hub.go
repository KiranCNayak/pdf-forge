// Package hub implements the pairing and relay logic for p2p-share rooms.
// It knows nothing about WebSockets or HTTP — Conn is a small interface so
// the logic can be unit tested with a fake, and the real transport lives in
// package wsserver.
package hub

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"pdf-forge/signaling/internal/protocol"
	"pdf-forge/signaling/internal/roomcode"
)

// Conn is anything that can receive an Envelope. The real implementation
// (wsserver) wraps a WebSocket connection; tests use a fake that records
// what was sent.
type Conn interface {
	Send(protocol.Envelope) error
}

// Room pairs at most two peers under one code. Peers[0] is whoever called
// Create (the "sender" in the UI); Peers[1] is whoever called Join (the
// "receiver"). Either slot may be nil — a peer that has left, or one that
// hasn't arrived yet.
type Room struct {
	Code    string
	Peers   [2]Conn
	Created time.Time
}

// Hub owns all live rooms. Zero value is not usable; construct with New.
type Hub struct {
	mu          sync.Mutex
	rooms       map[string]*Room
	ttl         time.Duration
	now         func() time.Time
	maxAttempts int
}

// New returns a Hub whose rooms expire ttl after creation.
func New(ttl time.Duration) *Hub {
	return &Hub{
		rooms:       make(map[string]*Room),
		ttl:         ttl,
		now:         time.Now,
		maxAttempts: 10,
	}
}

// Create allocates a fresh room, assigns conn as its first peer, sends conn
// a "created" envelope carrying the new code, and returns that code.
func (h *Hub) Create(conn Conn) (string, error) {
	h.mu.Lock()
	code, err := h.uniqueCodeLocked()
	if err != nil {
		h.mu.Unlock()
		return "", err
	}
	h.rooms[code] = &Room{Code: code, Created: h.now(), Peers: [2]Conn{conn, nil}}
	h.mu.Unlock()

	_ = conn.Send(protocol.Envelope{Type: protocol.TypeCreated, Code: code})
	return code, nil
}

// uniqueCodeLocked must be called with h.mu held.
func (h *Hub) uniqueCodeLocked() (string, error) {
	for i := 0; i < h.maxAttempts; i++ {
		c, err := roomcode.Generate()
		if err != nil {
			return "", err
		}
		if _, exists := h.rooms[c]; !exists {
			return c, nil
		}
	}
	return "", errors.New("hub: exhausted attempts generating a unique room code")
}

// Join pairs conn into the room identified by code as the second peer. On
// success it sends conn a "joined" envelope and the existing peer (if
// still connected) a "peer-joined" envelope. On failure it sends conn an
// "error" envelope describing why and returns a non-nil error.
func (h *Hub) Join(code string, conn Conn) error {
	code = normalizeCode(code)
	if !roomcode.Valid(code) {
		_ = conn.Send(protocol.NewError(protocol.ErrInvalidCode))
		return fmt.Errorf("hub: invalid code %q", code)
	}

	h.mu.Lock()
	room, ok := h.rooms[code]
	if !ok {
		h.mu.Unlock()
		_ = conn.Send(protocol.NewError(protocol.ErrRoomNotFound))
		return fmt.Errorf("hub: room %q not found", code)
	}
	if h.expiredLocked(room) {
		delete(h.rooms, code)
		h.mu.Unlock()
		_ = conn.Send(protocol.NewError(protocol.ErrRoomExpired))
		return fmt.Errorf("hub: room %q expired", code)
	}
	if room.Peers[1] != nil {
		h.mu.Unlock()
		_ = conn.Send(protocol.NewError(protocol.ErrRoomFull))
		return fmt.Errorf("hub: room %q is full", code)
	}
	room.Peers[1] = conn
	peer := room.Peers[0]
	h.mu.Unlock()

	_ = conn.Send(protocol.Envelope{Type: protocol.TypeJoined, Code: code})
	if peer != nil {
		_ = peer.Send(protocol.Envelope{Type: protocol.TypePeerJoined, Code: code})
	}
	return nil
}

// Relay forwards env — an offer, answer, ice or bye payload — from conn to
// the other peer in the room named by env's code. The server never parses
// env.Data; it only routes on conn identity and room membership.
func (h *Hub) Relay(code string, from Conn, env protocol.Envelope) error {
	code = normalizeCode(code)

	h.mu.Lock()
	room, ok := h.rooms[code]
	if !ok {
		h.mu.Unlock()
		_ = from.Send(protocol.NewError(protocol.ErrRoomNotFound))
		return fmt.Errorf("hub: room %q not found", code)
	}

	var peer Conn
	switch from {
	case room.Peers[0]:
		peer = room.Peers[1]
	case room.Peers[1]:
		peer = room.Peers[0]
	default:
		h.mu.Unlock()
		_ = from.Send(protocol.NewError(protocol.ErrInvalidMessage))
		return fmt.Errorf("hub: conn is not a member of room %q", code)
	}
	h.mu.Unlock()

	if peer == nil {
		// The other side hasn't joined yet, or has already left. Drop
		// silently — this is routine (e.g. early ICE candidates) rather
		// than an error condition.
		return nil
	}
	return peer.Send(env)
}

// Leave removes conn from whichever room it occupies, if any, and tells
// the remaining peer (if there is one) that it left. A room is deleted as
// soon as both of its slots are empty — eviction does not wait for TTL.
func (h *Hub) Leave(conn Conn) {
	h.mu.Lock()
	var (
		peer     Conn
		code     string
		found    bool
		nowEmpty bool
	)
	for c, room := range h.rooms {
		switch conn {
		case room.Peers[0]:
			room.Peers[0] = nil
			peer, code, found = room.Peers[1], c, true
		case room.Peers[1]:
			room.Peers[1] = nil
			peer, code, found = room.Peers[0], c, true
		default:
			continue
		}
		if found {
			if room.Peers[0] == nil && room.Peers[1] == nil {
				delete(h.rooms, c)
				nowEmpty = true
			}
			break
		}
	}
	h.mu.Unlock()

	if found && !nowEmpty && peer != nil {
		_ = peer.Send(protocol.Envelope{Type: protocol.TypeBye, Code: code})
	}
}

// SweepExpired deletes every room whose TTL has elapsed, notifying any
// still-connected peers with a room_expired error first. It returns the
// number of rooms removed. Call it periodically — see RunJanitor.
func (h *Hub) SweepExpired() int {
	h.mu.Lock()
	var expired []*Room
	for code, room := range h.rooms {
		if h.expiredLocked(room) {
			expired = append(expired, room)
			delete(h.rooms, code)
		}
	}
	h.mu.Unlock()

	for _, room := range expired {
		for _, p := range room.Peers {
			if p != nil {
				_ = p.Send(protocol.NewError(protocol.ErrRoomExpired))
			}
		}
	}
	return len(expired)
}

// RunJanitor sweeps expired rooms every interval until ctx is done. Run it
// in its own goroutine.
func (h *Hub) RunJanitor(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.SweepExpired()
		}
	}
}

// RoomCount returns the number of live rooms. Safe to log — it names no
// code, no file, no peer.
func (h *Hub) RoomCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

func (h *Hub) expiredLocked(r *Room) bool {
	return h.now().Sub(r.Created) > h.ttl
}

func normalizeCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}
