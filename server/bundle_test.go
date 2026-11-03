package main

import (
	"context"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"minimaj"
)

func TestBundleTransform(t *testing.T) {
	fsys := fstest.MapFS{
		"js/tiles.js": {Data: []byte("export const A = 1;\nexport function f() { return A + 1; }\nexport class K {}\nconst hidden = 3;\n")},
		"js/hand.js":  {Data: []byte("import {\n  A,\n  f as g,\n} from './tiles.js';\nexport let B = A + g();\n")},
	}
	b, err := Bundle(fsys, map[string]string{"room": "export function createRoom() { return 'stub'; }"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(b.Modules, ",") != "tiles,hand,room" {
		t.Fatalf("modules %v", b.Modules)
	}
	l := NewLoop()
	if _, err := l.RunScript("b.js", b.Source); err != nil {
		t.Fatal(err, b.Source)
	}
	v, err := l.RunScript("x.js", `[minimaj.A, minimaj.B, typeof minimaj.K, minimaj.createRoom(), typeof hidden, typeof minimaj.hidden].join()`)
	if err != nil {
		t.Fatal(err)
	}
	if v.String() != "1,3,function,stub,undefined,undefined" {
		t.Fatalf("got %s", v)
	}
}

func TestBundleRejects(t *testing.T) {
	for _, src := range []string{"export default 1;", "export { a };", "import x from './tiles.js';", "import { nope } from './tiles.js';"} {
		_, err := Bundle(fstest.MapFS{"js/hand.js": {Data: []byte(src)}}, nil)
		if err == nil {
			t.Errorf("accepted %q", src)
		}
	}
}

// Bundles the real engine and plays bot-only games to the end.
func TestBotGame(t *testing.T) {
	b, err := Bundle(minimaj.Web, map[string]string{"room": stubRoom})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("bundled modules: %v (%d bytes)", b.Modules, len(b.Source))
	l := NewLoop()
	l.Logf = t.Logf
	if _, err := l.RunScript("bundle.js", b.Source); err != nil {
		t.Fatal(err)
	}
	const games = 1 // one East+South game, ~15 s with the current hand.js
	_, err = l.RunScript("game.js", `
	var stats = { done: 0, turns: 0, rounds: 0, err: null };
	for (let i = 1; i <= `+sprintf("%d", games)+`; i++) {
	  let s = i * 7919;
	  const rng = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
	  const g = new minimaj.Game([0, 1, 2, 3].map((k) => ({ name: 'B' + k, kind: 'bot' })), {
	    length: 2, botDelay: 0, rng,
	    onChange: (gg) => {
	      for (let k = 0; k < 4; k++) JSON.stringify(gg.view(k));
	      const tot = gg.players.reduce((a, p) => a + p.score, 0) + gg.sticks * 1000;
	      if (tot !== 100000 && !stats.err) stats.err = 'score sum ' + tot;
	      if (gg.phase === 'end' && gg.__counted !== gg.log.length) {
	        gg.__counted = gg.log.length; stats.rounds++;
	        stats.turns += gg.players.reduce((a, p) => a + p.discards.length, 0);
	      }
	      if (gg.phase === 'over') stats.done++;
	    } });
	  g.start();
	}`)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	t0 := time.Now()
	done := make(chan error, 1)
	go func() { done <- l.Run(ctx, true) }()
	if err := <-done; err != nil {
		t.Fatal("game did not finish:", err)
	}
	el := time.Since(t0)
	v, _ := l.RunScript("s.js", "JSON.stringify(stats)")
	t.Logf("stats %s in %v", v, el)
	st := l.VM().Get("stats").ToObject(l.VM())
	if e := st.Get("err"); e != nil && !isNullish(e.Export()) {
		t.Fatal(e)
	}
	if st.Get("done").ToInteger() != int64(games) {
		t.Fatalf("only %v of %d games reached 'over'", st.Get("done"), games)
	}
	turns := st.Get("turns").ToInteger()
	t.Logf("bot turns/sec: %.0f (%d turns, %d rounds)", float64(turns)/el.Seconds(), turns, st.Get("rounds").ToInteger())
}

func isNullish(v any) bool { return v == nil }
