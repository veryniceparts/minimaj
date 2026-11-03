package main

import (
	"io"
	"strings"

	"github.com/dop251/goja"
)

// qrMatrix calls the bundled qr.js qrMatrix (loop goroutine only).
// It returns nil when qr.js is not in the bundle.
func qrMatrix(vm *goja.Runtime, text string) ([][]bool, error) {
	mj := vm.Get("minimaj")
	if mj == nil {
		return nil, nil
	}
	fn, ok := goja.AssertFunction(mj.ToObject(vm).Get("qrMatrix"))
	if !ok {
		return nil, nil
	}
	v, err := fn(goja.Undefined(), vm.ToValue(text))
	if err != nil {
		return nil, err
	}
	var m [][]bool
	if err := vm.ExportTo(v, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// writeQR draws the matrix with half-block characters, two module rows per
// text line, in explicit black on white so it scans on dark terminals too.
func writeQR(w io.Writer, m [][]bool, border int) {
	n := len(m)
	at := func(y, x int) bool {
		y, x = y-border, x-border
		return y >= 0 && y < n && x >= 0 && x < len(m[y]) && m[y][x]
	}
	size := n + 2*border
	var b strings.Builder
	for y := 0; y < size; y += 2 {
		b.WriteString("  \x1b[30;107m")
		for x := 0; x < size; x++ {
			top, bot := at(y, x), at(y+1, x)
			switch {
			case top && bot:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bot:
				b.WriteString("▄")
			default:
				b.WriteString(" ")
			}
		}
		b.WriteString("\x1b[0m\n")
	}
	_, _ = io.WriteString(w, b.String())
}
