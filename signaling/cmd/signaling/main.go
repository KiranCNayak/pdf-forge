// Command signaling runs the p2p-share WebSocket signaling server: it
// relays SDP offers/answers and ICE candidates between two browsers and
// never touches file bytes. See docs/tools/p2p-share.md §2 in the main
// repo for the design.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pdf-forge/signaling/internal/hub"
	"pdf-forge/signaling/internal/wsserver"
)

const (
	roomTTL         = 10 * time.Minute
	janitorInterval = time.Minute
)

func main() {
	addr := ":" + envOr("PORT", "8080")

	logger := log.New(os.Stdout, "", log.LstdFlags)

	h := hub.New(roomTTL)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.RunJanitor(ctx, janitorInterval)

	s := wsserver.New(h, wsserver.Options{Logger: logger})

	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Mux(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Printf("signaling server listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Printf("listen: %v", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Printf("shutting down (rooms live: %d)", h.RoomCount())
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Printf("shutdown: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
