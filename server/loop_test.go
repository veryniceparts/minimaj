package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func runJS(t *testing.T, src string) string {
	t.Helper()
	l := NewLoop()
	var out []string
	l.Logf = func(f string, a ...any) { out = append(out, strings.TrimSpace(sprintf(f, a...))) }
	if _, err := l.RunScript("test.js", src); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := l.Run(ctx, true); err != nil {
		t.Fatal(err)
	}
	return strings.Join(out, " ")
}

func TestTimerOrder(t *testing.T) {
	got := runJS(t, `
		setTimeout(() => console.log('c30'), 30);
		setTimeout(() => console.log('a10'), 10);
		setTimeout((x, y) => console.log('b' + x + y), 20, 2, 0);
		setTimeout(() => console.log('z0'));
		setTimeout(() => console.log('z1'), 0);
		setTimeout(() => console.log('neg'), -5);
		console.log('sync');`)
	if want := "sync z0 z1 neg a10 b20 c30"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestClearTimeout(t *testing.T) {
	got := runJS(t, `
		const a = setTimeout(() => console.log('no'), 5);
		setTimeout(() => console.log('yes'), 10);
		const c = setTimeout(() => console.log('no2'), 20);
		setTimeout(() => clearTimeout(c), 15);
		clearTimeout(a); clearTimeout(a); clearTimeout(9999); clearTimeout(undefined);`)
	if got != "yes" {
		t.Fatalf("got %q", got)
	}
}

func TestMicrotaskDrain(t *testing.T) {
	got := runJS(t, `
		setTimeout(() => {
			console.log('t1');
			queueMicrotask(() => { console.log('m2'); queueMicrotask(() => console.log('m3')); });
			Promise.resolve().then(() => console.log('p2'));
		}, 0);
		setTimeout(() => console.log('t2'), 0);
		queueMicrotask(() => console.log('m1'));
		Promise.resolve().then(() => console.log('p1'));
		queueMicrotask(() => { throw new Error('boom'); });
		(async () => { await null; console.log('a1'); })();
		console.log('s');`)
	if !strings.HasPrefix(got, "s m1 p1 ") || !strings.Contains(got, "boom") || !strings.HasSuffix(got, "a1 t1 m2 p2 m3 t2") {
		t.Fatalf("got %q", got)
	}
}

func TestTimerRealDelay(t *testing.T) {
	t0 := time.Now()
	runJS(t, `setTimeout(() => {}, 50)`)
	if d := time.Since(t0); d < 45*time.Millisecond {
		t.Fatalf("fired too early: %v", d)
	}
}

func TestWriteQR(t *testing.T) {
	var b strings.Builder
	writeQR(&b, [][]bool{{true, false, true}, {false, true, false}, {true, true, true}}, 1)
	lines := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
	if len(lines) != 3 || !strings.Contains(lines[0], " ▄ ▄ ") || !strings.Contains(lines[1], " ▄█▄ ") {
		t.Fatalf("%q", lines)
	}
}
