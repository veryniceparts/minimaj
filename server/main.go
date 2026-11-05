// Command minimaj serves the browser game on the local network and runs the
// shared game room (js/room.js) in an embedded JavaScript engine.
package main

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"minimaj"
)

const (
	defaultPort      = 7777
	lastFallbackPort = 7791
)

// version is set at build time: -ldflags "-X main.version=v1.2.3"
var version = "dev"

//go:embed testdata/stub-room.js
var stubRoom string

func main() {
	port := flag.Int("port", defaultPort, "port to listen on (the default falls back to 7778-7791 when taken)")
	noBrowser := flag.Bool("no-browser", false, "do not open a browser")
	lanIP := flag.String("lan-ip", "", "comma-separated LAN addresses to advertise in addition to the detected ones")
	exitOnEOF := flag.Bool("exit-on-eof", false, "exit when stdin is closed (for a parent process such as the Android app)")
	flag.Parse()
	log.SetFlags(log.Ltime)
	log.SetOutput(os.Stderr)

	if !*noBrowser && *port == defaultPort && alreadyRunning(defaultPort) {
		fmt.Println("minimaj is already running on port", defaultPort)
		if err := openBrowser(fmt.Sprintf("http://localhost:%d/", defaultPort)); err != nil {
			log.Println("open browser:", err)
		}
		return
	}

	loop, srv, err := setup(minimaj.Web)
	if err != nil {
		log.Fatal(err)
	}

	ln, p, err := Listen(*port)
	if err != nil {
		log.Fatal(err)
	}
	// The first stdout line is machine-read (Android app): keep it first.
	fmt.Printf("LISTEN %d\n", p)

	for _, s := range strings.Split(*lanIP, ",") {
		if ip := net.ParseIP(strings.TrimSpace(s)); ip != nil && ip.To4() != nil {
			srv.extraIPs = append(srv.extraIPs, ip.String())
		}
	}
	srv.port = p
	srv.lanURLs = srv.currentLANURLs()
	local := fmt.Sprintf("http://localhost:%d", p)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv.quit = stop
	if *exitOnEOF {
		go func() {
			_, _ = bufio.NewReader(os.Stdin).ReadString(0) // returns at EOF
			stop()
		}()
	}

	enableVT()
	fmt.Printf("\nminimaj %s is running.\n\n  On this computer:  %s\n", version, local)
	for _, u := range srv.lanURLs {
		fmt.Printf("  On your network:   %s\n", u)
	}
	if len(srv.lanURLs) == 0 {
		fmt.Println("  (no local network address found; other devices cannot join)")
	} else {
		fmt.Println("\n  Friends' devices must be on the same Wi-Fi (not a guest network) and")
		fmt.Println("  your firewall must allow minimaj. When a device opens the page, a")
		fmt.Println("  \"device ... opened the table page\" line appears below; if none")
		fmt.Println("  does, the network or the firewall is blocking it.")
		if runtime.GOOS == "windows" {
			fmt.Println("  Windows: if your Wi-Fi is set to \"Public\", allow minimaj on public")
			fmt.Println("  networks too (Windows Security > Firewall > Allow an app).")
		}
	}
	if len(srv.lanURLs) > 0 && isTerminal(os.Stdout) {
		// The loop is not running yet, so the runtime can be used directly.
		m, err := qrMatrix(loop.VM(), srv.lanURLs[0])
		if err != nil {
			log.Println("qr:", err)
		} else if m != nil {
			fmt.Printf("\n  Scan to join (%s):\n\n", srv.lanURLs[0])
			writeQR(os.Stdout, m, 3)
		}
	}
	fmt.Println("\nPress Ctrl+C to stop.")

	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := hs.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	if !*noBrowser {
		if err := openBrowser(local + "/"); err != nil {
			log.Println("open browser:", err)
		}
	}
	_ = loop.Run(ctx, false)
	sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = hs.Shutdown(sctx)
	fmt.Println("stopped")
}

// setup bundles the JS, starts the room and returns the (not yet running) loop.
func setup(web fs.FS) (*Loop, *Server, error) {
	b, err := Bundle(web, map[string]string{"room": stubRoom})
	if err != nil {
		return nil, nil, err
	}
	loop := NewLoop()
	if _, err := loop.RunScript("bundle.js", b.Source); err != nil {
		return nil, nil, fmt.Errorf("running bundle: %w", err)
	}
	srv, err := NewServer(loop, web, version)
	if err != nil {
		return nil, nil, err
	}
	return loop, srv, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

func alreadyRunning(port int) bool {
	c := http.Client{Timeout: 700 * time.Millisecond}
	resp, err := c.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/info.json")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	// Decode the whole (small) body: one Read may return only part of it, and
	// "server" comes after the lanUrls list, which can be long.
	var info struct {
		Server bool `json:"server"`
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&info)
	return err == nil && resp.StatusCode == 200 && info.Server
}
