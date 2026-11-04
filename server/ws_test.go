package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"minimaj"
)

func startTestServer(t *testing.T) (*httptest.Server, context.Context) {
	t.Helper()
	loop, srv, err := setup(minimaj.Web)
	if err != nil {
		t.Fatal(err)
	}
	loop.Logf = t.Logf
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = loop.Run(ctx, false); close(done) }()
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { ts.Close(); cancel(); <-done })
	return ts, ctx
}

func TestWebSocketRoom(t *testing.T) {
	ts, _ := startTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	send := func(m map[string]any) {
		b, _ := json.Marshal(m)
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
	recv := func(want string) map[string]any {
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %s: %v", want, err)
			}
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
			if m["t"] == want {
				return m
			}
		}
	}
	send(map[string]any{"t": "hello", "name": "Ann", "cid": "test-cid-1", "ver": 1, "host": true})
	lobby := recv("lobby")["lobby"].(map[string]any)
	if lobby["isHost"] != true {
		t.Fatalf("loopback client should be host: %v", lobby)
	}
	send(map[string]any{"t": "ping", "n": 7})
	if p := recv("pong"); p["n"] != float64(7) {
		t.Fatalf("pong %v", p)
	}
}

func TestHTTP(t *testing.T) {
	ts, _ := startTestServer(t)
	get := func(path string) (*http.Response, string) {
		r, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return r, string(b)
	}
	r, body := get("/")
	if r.StatusCode != 200 || !strings.Contains(body, "<html") || r.Header.Get("Cache-Control") != "no-cache" || r.Header.Get("ETag") == "" {
		t.Fatalf("index: %d %q %v", r.StatusCode, body[:min(len(body), 80)], r.Header)
	}
	r, _ = get("/js/game.js")
	if r.StatusCode != 200 || !strings.Contains(r.Header.Get("Content-Type"), "javascript") {
		t.Fatalf("game.js: %d %v", r.StatusCode, r.Header)
	}
	_, body = get("/info.json")
	var info map[string]any
	if err := json.Unmarshal([]byte(body), &info); err != nil || info["server"] != true || info["hostOk"] != true {
		t.Fatalf("info %q %v", body, err)
	}
	req, _ := http.NewRequest("POST", ts.URL+"/api/quit", nil)
	req.Header.Set("Origin", "http://evil.example")
	r, err := http.DefaultClient.Do(req)
	if err != nil || r.StatusCode != 403 {
		t.Fatalf("cross-origin quit should be refused: %v %v", r, err)
	}
	r.Body.Close()
}

func TestInfoPreflight(t *testing.T) {
	ts, _ := startTestServer(t)
	req, _ := http.NewRequest("OPTIONS", ts.URL+"/info.json", nil)
	req.Header.Set("Origin", "http://192.168.1.9:7777")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 204 || r.Header.Get("Access-Control-Allow-Origin") != "*" || r.Header.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("preflight: %d %v", r.StatusCode, r.Header)
	}
	r, err = http.Get(ts.URL + "/info.json")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.Header.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("info headers %v", r.Header)
	}
}

// Two tabs of one browser share a client id. The newer one wins and the older
// one is told why (a fatal error), so it does not reconnect and kick the newer
// one back: they used to take turns kicking each other.
func TestDuplicateTabIsToldWhy(t *testing.T) {
	ts, _ := startTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", nil)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	hello := func(c *websocket.Conn) {
		b, _ := json.Marshal(map[string]any{"t": "hello", "name": "Ann", "cid": "same", "ver": 1, "host": false})
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
	}
	recv := func(c *websocket.Conn, want string) map[string]any {
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %s: %v", want, err)
			}
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			if m["t"] == want {
				return m
			}
		}
	}
	a := dial()
	defer a.CloseNow()
	hello(a)
	recv(a, "lobby")
	b := dial()
	defer b.CloseNow()
	hello(b)
	recv(b, "lobby")
	e := recv(a, "error")
	if e["fatal"] != true || e["code"] != "replaced" {
		t.Fatalf("old tab: %v", e)
	}
	// and the old socket is closed by the server shortly after
	for {
		if _, _, err := a.Read(ctx); err != nil {
			break
		}
	}
}

func TestWebSocketWrongOriginRefused(t *testing.T) {
	ts, _ := startTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{}
	h.Set("Origin", "https://evil.example")
	if c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h}); err == nil {
		c.CloseNow()
		t.Fatal("cross-site websocket should be refused")
	}
}
