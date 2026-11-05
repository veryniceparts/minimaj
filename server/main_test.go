package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

// The second launch detects a running table even when /info.json lists many
// LAN addresses ("server" then comes after the first few hundred bytes).
func TestAlreadyRunning(t *testing.T) {
	urls := make([]string, 20)
	for i := range urls {
		urls[i] = `"http://192.168.100.` + strconv.Itoa(100+i) + `:7777"`
	}
	body := `{"hostOk":true,"lanUrls":[` + strings.Join(urls, ",") + `],"port":7777,"server":true}`
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/info.json" {
			_, _ = w.Write([]byte(body))
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()
	u, _ := url.Parse(ts.URL)
	port, _ := strconv.Atoi(u.Port())
	if !alreadyRunning(port) {
		t.Fatal("running minimaj not detected")
	}
	body = `{"server":false}`
	if alreadyRunning(port) {
		t.Fatal("not a minimaj server")
	}
}
