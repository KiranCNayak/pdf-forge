// Package wsserver is the WebSocket transport around package hub. It knows
// how to upgrade connections, read/write Envelopes and rate-limit room
// creation; all pairing and relay logic lives in hub, which it never
// duplicates.
package wsserver

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"pdf-forge/signaling/internal/hub"
	"pdf-forge/signaling/internal/protocol"
)

// Logger is the minimal logging surface the server needs. It exists so
// tests and callers can swap in log.Default() or anything compatible.
//
// Deliberately never fed a room code, an IP address, a filename or a
// message payload — this server relays connection metadata for a file
// transfer tool, and none of that belongs in logs any more than it would
// in the browser engine. See CLAUDE.md's "no telemetry that names a file
// or a tool" — the same posture applies here even though it's a separate
// service.
type Logger interface {
	Printf(format string, v ...any)
}

// Server adapts hub.Hub to net/http.
type Server struct {
	hub      *hub.Hub
	limiter  *ipLimiter
	upgrader websocket.Upgrader
	logger   Logger
}

// Options configures New. Zero value is a reasonable default.
type Options struct {
	// CreateRoomsPerMinute and CreateBurst bound how often a single IP may
	// create rooms. Room creation is the only unauthenticated write this
	// server accepts, so it's the only thing throttled.
	CreateRoomsPerMinute float64
	CreateBurst          float64
	Logger               Logger
}

func (o Options) withDefaults() Options {
	if o.CreateRoomsPerMinute <= 0 {
		o.CreateRoomsPerMinute = 6 // one every 10s sustained
	}
	if o.CreateBurst <= 0 {
		o.CreateBurst = 10
	}
	if o.Logger == nil {
		o.Logger = log.Default()
	}
	return o
}

// New builds a Server around an existing Hub.
func New(h *hub.Hub, opts Options) *Server {
	opts = opts.withDefaults()
	return &Server{
		hub:     h,
		limiter: newIPLimiter(opts.CreateRoomsPerMinute/60, opts.CreateBurst),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			// The web app and this server are typically deployed on
			// different origins (SPA on a static host, this on Fly.io).
			// There's no cookie/session to protect and no payload the
			// server can act on beyond relaying, so any origin is fine.
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		logger: opts.Logger,
	}
}

// Mux returns the server's HTTP routes: /ws for signaling and /healthz for
// platform health checks.
func (s *Server) Mux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.serveWS)
	mux.HandleFunc("/healthz", s.serveHealthz)
	return mux
}

func (s *Server) serveHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Printf("ws upgrade failed: %v", err)
		return
	}
	wc := &wsConn{ws: conn}
	ip := clientIP(r)

	defer func() {
		s.hub.Leave(wc)
		_ = conn.Close()
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return // normal close or network error; nothing to log per-connection
		}

		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			_ = wc.Send(protocol.NewError(protocol.ErrInvalidMessage))
			continue
		}

		s.dispatch(wc, ip, env)
	}
}

func (s *Server) dispatch(wc *wsConn, ip string, env protocol.Envelope) {
	switch env.Type {
	case protocol.TypeCreate:
		if !s.limiter.Allow(ip) {
			_ = wc.Send(protocol.NewError(protocol.ErrRateLimited))
			return
		}
		if _, err := s.hub.Create(wc); err != nil {
			s.logger.Printf("room create failed: %v", err)
			_ = wc.Send(protocol.NewError(protocol.ErrInternal))
		}

	case protocol.TypeJoin:
		_ = s.hub.Join(env.Code, wc) // Join sends its own success/error envelopes

	case protocol.TypeOffer, protocol.TypeAnswer, protocol.TypeICE, protocol.TypeBye:
		_ = s.hub.Relay(env.Code, wc, env) // Relay sends its own error envelope on failure

	default:
		_ = wc.Send(protocol.NewError(protocol.ErrInvalidMessage))
	}
}

// wsConn adapts a *websocket.Conn to hub.Conn. Gorilla's Conn permits only
// one concurrent writer, so writes are serialized with a mutex — the hub
// can call Send from a different goroutine than the one reading this
// connection (e.g. relaying a message that arrived on the peer's socket).
type wsConn struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (c *wsConn) Send(env protocol.Envelope) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.ws.WriteJSON(env)
}

// clientIP extracts the caller's address for rate limiting only — it is
// never logged or persisted. Fly.io (the intended deployment target) sets
// Fly-Client-IP; fall back to the first X-Forwarded-For hop, then to the
// raw remote address.
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("Fly-Client-IP"); ip != "" {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
