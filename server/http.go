package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/dop251/goja"
)

const (
	wsReadLimit = 64 << 10
	wsOutBuffer = 64
)

// roomPrelude connects the bundled room to the Go side (runs on the loop).
const roomPrelude = `
(function () {
  if (!globalThis.minimaj || typeof minimaj.createRoom !== 'function') throw new Error('bundle has no createRoom');
  var env = {
    send: function (id, m) { __host.sendText(id, JSON.stringify(m)); },
    close: function (id) { __host.close(id); },
    now: function () { return __host.now(); },
    log: function () { console.log.apply(console, arguments); },
  };
  var room = minimaj.createRoom(env);
  globalThis.__roomOpen = function (id, hostOk) { room.open(id, { hostOk: hostOk }); };
  globalThis.__roomMessage = function (id, text) {
    var m;
    try { m = JSON.parse(text); } catch (e) { return; }
    room.message(id, m);
  };
  globalThis.__roomClosed = function (id) { room.closed(id); };
  globalThis.__roomSummary = function () {
    return JSON.stringify(typeof room.summary === 'function' ? room.summary() : {});
  };
})();
`

// Server owns the HTTP side and bridges websocket connections into the room.
type Server struct {
	loop     *Loop
	static   http.Handler
	etags    map[string]string
	version  string
	port     int
	lanURLs  []string // as found at startup (printed to the terminal)
	extraIPs []string // from -lan-ip (Android passes its own addresses)
	quit     func()

	mu     sync.Mutex
	conns  map[string]*wsConn
	nextID atomic.Int64
}

type wsConn struct {
	id         string
	out        chan string
	done       chan struct{}
	once       sync.Once
	closedByJS atomic.Bool
}

func (c *wsConn) shut() { c.once.Do(func() { close(c.done) }) }

// NewServer installs the __host bridge into the loop's runtime and creates
// the room. Call before loop.Run.
func NewServer(loop *Loop, web fs.FS, version string) (*Server, error) {
	s := &Server{loop: loop, version: version, conns: map[string]*wsConn{}, etags: map[string]string{}}
	s.static = http.FileServerFS(web)
	_ = fs.WalkDir(web, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if data, err := fs.ReadFile(web, p); err == nil {
				sum := sha256.Sum256(data)
				s.etags["/"+p] = `"` + hex.EncodeToString(sum[:8]) + `"`
			}
		}
		return nil
	})
	if t, ok := s.etags["/index.html"]; ok {
		s.etags["/"] = t
	}
	vm := loop.VM()
	host := vm.NewObject()
	must(host.Set("sendText", func(id, text string) { s.send(id, text) }))
	must(host.Set("close", func(id string) { s.closeConn(id) }))
	must(host.Set("now", func() float64 { return float64(time.Now().UnixNano()) / 1e6 }))
	must(vm.Set("__host", host))
	if _, err := vm.RunString(roomPrelude); err != nil {
		return nil, fmt.Errorf("starting room: %w", err)
	}
	return s, nil
}

// send is called on the loop goroutine.
func (s *Server) send(id, text string) {
	s.mu.Lock()
	c := s.conns[id]
	s.mu.Unlock()
	if c == nil {
		return
	}
	select {
	case c.out <- text:
	default:
		// The client is not keeping up: drop it; it reconnects and resyncs.
		s.loop.Logf("conn %s: send buffer full, closing", id)
		s.closeConn(id)
	}
}

// closeConn is requested by the room: the room runs its own close logic, so
// we must not report this connection as closed back to it.
func (s *Server) closeConn(id string) {
	s.mu.Lock()
	c := s.conns[id]
	s.mu.Unlock()
	if c != nil {
		c.closedByJS.Store(true)
		c.shut()
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.HandleFunc("GET /info.json", s.handleInfo)
	mux.HandleFunc("POST /api/quit", s.handleQuit)
	mux.HandleFunc("GET /", s.handleStatic)
	return mux
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	if t, ok := s.etags[r.URL.Path]; ok {
		h.Set("ETag", t)
	}
	s.static.ServeHTTP(w, r)
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// sameOrigin rejects cross-site requests (a page elsewhere POSTing to us).
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && u.Host == r.Host
}

// currentLANURLs lists join URLs for the machine's current private addresses.
func (s *Server) currentLANURLs() []string {
	ips := lanIPs()
	for _, ip := range s.extraIPs {
		if !contains(ips, ip) {
			ips = append(ips, ip)
		}
	}
	urls := []string{}
	for _, ip := range ips {
		urls = append(urls, fmt.Sprintf("http://%s:%d", ip, s.port))
	}
	return urls
}

// roomSummary asks the JS room (on the loop goroutine) for its public summary.
func (s *Server) roomSummary() map[string]any {
	ch := make(chan map[string]any, 1)
	s.loop.Submit(func(vm *goja.Runtime) {
		out := map[string]any{}
		if fn, ok := goja.AssertFunction(vm.Get("__roomSummary")); ok {
			if v, err := fn(goja.Undefined()); err == nil {
				_ = json.Unmarshal([]byte(v.String()), &out)
			}
		}
		ch <- out
	})
	select {
	case m := <-ch:
		return m
	case <-time.After(500 * time.Millisecond):
		return map[string]any{}
	}
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	// Readable cross-origin so other minimaj pages on the LAN can find this
	// table ("tables nearby"). It only exposes public, non-secret fields.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"server":  true,
		"version": s.version,
		"port":    s.port,
		"lanUrls": s.currentLANURLs(), // re-read: Wi-Fi may have connected since startup
		"hostOk":  isLoopback(r),
		"table":   s.roomSummary(),
	})
}

func (s *Server) handleQuit(w http.ResponseWriter, r *http.Request) {
	if !isLoopback(r) || !sameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
	if s.quit != nil {
		go func() { time.Sleep(200 * time.Millisecond); s.quit() }()
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil) // default origin check: same host only
	if err != nil {
		return
	}
	c.SetReadLimit(wsReadLimit)
	id := "ws" + strconv.FormatInt(s.nextID.Add(1), 10)
	wc := &wsConn{id: id, out: make(chan string, wsOutBuffer), done: make(chan struct{})}
	s.mu.Lock()
	s.conns[id] = wc
	s.mu.Unlock()
	hostOk := isLoopback(r)
	s.loop.Submit(func(*goja.Runtime) {
		if err := s.loop.call("__roomOpen", id, hostOk); err != nil {
			s.loop.reportErr(err)
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// writer
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for {
			select {
			case m := <-wc.out:
				wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				err := c.Write(wctx, websocket.MessageText, []byte(m))
				wcancel()
				if err != nil {
					wc.shut()
					return
				}
			case <-wc.done:
				// flush what is queued (e.g. a fatal error before a close)
				for {
					select {
					case m := <-wc.out:
						wctx, wcancel := context.WithTimeout(ctx, time.Second)
						err := c.Write(wctx, websocket.MessageText, []byte(m))
						wcancel()
						if err != nil {
							return
						}
					default:
						return
					}
				}
			}
		}
	}()
	// reader
	go func() {
		defer wc.shut()
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			text := string(data)
			s.loop.Submit(func(*goja.Runtime) {
				if err := s.loop.call("__roomMessage", id, text); err != nil {
					s.loop.reportErr(err)
				}
			})
		}
	}()
	<-wc.done
	<-writerDone
	c.Close(websocket.StatusNormalClosure, "")
	cancel()
	s.mu.Lock()
	delete(s.conns, id)
	s.mu.Unlock()
	if !wc.closedByJS.Load() {
		s.loop.Submit(func(*goja.Runtime) {
			if err := s.loop.call("__roomClosed", id); err != nil {
				s.loop.reportErr(err)
			}
		})
	}
}

// Listen tries port, then (for the default port) the fallback range.
func Listen(port int) (net.Listener, int, error) {
	ports := []int{port}
	if port == defaultPort {
		for p := defaultPort + 1; p <= lastFallbackPort; p++ {
			ports = append(ports, p)
		}
	}
	var lastErr error
	for _, p := range ports {
		ln, err := net.Listen("tcp", ":"+strconv.Itoa(p))
		if err == nil {
			return ln, ln.Addr().(*net.TCPAddr).Port, nil
		}
		lastErr = err
	}
	return nil, 0, errors.Join(fmt.Errorf("no free port"), lastErr)
}
