// Package protocol defines the wire format exchanged between browsers and the
// signaling server. The server relays SDP offers/answers and ICE candidates
// without ever parsing them — see Envelope.Data.
package protocol

import "encoding/json"

// Message types. The server only branches on Type; Code and Data are opaque
// payloads it passes through.
const (
	TypeCreate     = "create"      // sender -> server: start a new room
	TypeCreated    = "created"     // server -> sender: room code assigned
	TypeJoin       = "join"        // receiver -> server: join an existing room
	TypeJoined     = "joined"      // server -> receiver: join succeeded
	TypePeerJoined = "peer-joined" // server -> sender: the other side arrived
	TypeOffer      = "offer"       // relayed verbatim
	TypeAnswer     = "answer"      // relayed verbatim
	TypeICE        = "ice"         // relayed verbatim, trickled
	TypeBye        = "bye"         // either side -> server -> other side: leaving
	TypeError      = "error"       // server -> client: something went wrong
)

// Known error codes carried in an Envelope of Type TypeError.
const (
	ErrRoomNotFound   = "room_not_found"
	ErrRoomFull       = "room_full"
	ErrRoomExpired    = "room_expired"
	ErrInvalidCode    = "invalid_code"
	ErrRateLimited    = "rate_limited"
	ErrInvalidMessage = "invalid_message"
	ErrInternal       = "internal_error"
)

// Envelope is the sole message shape on the wire in both directions.
//
// Data is kept as json.RawMessage deliberately: the server relays SDP and
// ICE payloads between peers without ever understanding them. That is both
// a privacy property (the server cannot log or inspect transfer contents or
// connection details beyond room bookkeeping) and a maintenance one —
// WebRTC's payload shapes can change without touching this server.
type Envelope struct {
	Type string          `json:"type"`
	Code string          `json:"code,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// NewError builds an Envelope of Type TypeError carrying code as Data's
// "code" field, e.g. {"type":"error","data":{"code":"room_full"}}.
func NewError(code string) Envelope {
	data, _ := json.Marshal(struct {
		Code string `json:"code"`
	}{Code: code})
	return Envelope{Type: TypeError, Data: data}
}
