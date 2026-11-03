package main

import (
	"container/heap"
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/dop251/goja"
)

// Loop is a single-goroutine JavaScript event loop around a goja runtime.
// It provides setTimeout/clearTimeout/queueMicrotask/console. All access to
// the runtime must happen on the loop goroutine: other goroutines hand work
// over with Submit.
type Loop struct {
	vm     *goja.Runtime
	jobs   chan func(vm *goja.Runtime)
	timers timerHeap
	byID   map[int64]*jsTimer
	nextID int64
	seq    int64
	start  time.Time
	// Logf receives console output and uncaught errors.
	Logf func(format string, args ...any)
}

type jsTimer struct {
	id   int64
	when time.Duration // since loop start
	seq  int64
	fn   goja.Callable
	args []goja.Value
	idx  int
}

type timerHeap []*jsTimer

func (h timerHeap) Len() int { return len(h) }
func (h timerHeap) Less(i, j int) bool {
	if h[i].when != h[j].when {
		return h[i].when < h[j].when
	}
	return h[i].seq < h[j].seq
}
func (h timerHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i]; h[i].idx = i; h[j].idx = j }
func (h *timerHeap) Push(x any)   { t := x.(*jsTimer); t.idx = len(*h); *h = append(*h, t) }
func (h *timerHeap) Pop() any {
	old := *h
	t := old[len(old)-1]
	old[len(old)-1] = nil
	*h = old[:len(old)-1]
	t.idx = -1
	return t
}

// queueMicrotask is built on native promise jobs so both share one queue in
// the right order. goja drains promise jobs after every outermost call, i.e.
// after each macrotask.
const loopPrelude = `
globalThis.queueMicrotask = function (fn) {
  if (typeof fn !== 'function') throw new TypeError('queueMicrotask: not a function');
  Promise.resolve().then(function () { try { fn(); } catch (e) { __loopReport(e); } });
};
`

func NewLoop() *Loop {
	l := &Loop{
		vm:    goja.New(),
		jobs:  make(chan func(*goja.Runtime), 1024),
		byID:  map[int64]*jsTimer{},
		start: time.Now(),
		Logf:  log.Printf,
	}
	vm := l.vm
	vm.SetFieldNameMapper(goja.UncapFieldNameMapper())
	must(vm.Set("setTimeout", l.setTimeout))
	must(vm.Set("clearTimeout", l.clearTimeout))
	must(vm.Set("__loopReport", func(v goja.Value) { l.report(v) }))
	con := vm.NewObject()
	for _, name := range []string{"log", "info", "warn", "error", "debug"} {
		prefix := ""
		if name == "warn" || name == "error" {
			prefix = strings.ToUpper(name) + ": "
		}
		must(con.Set(name, func(call goja.FunctionCall) goja.Value {
			parts := make([]string, len(call.Arguments))
			for i, a := range call.Arguments {
				parts[i] = jsString(a)
			}
			l.Logf("%s%s", prefix, strings.Join(parts, " "))
			return goja.Undefined()
		}))
	}
	must(vm.Set("console", con))
	if _, err := vm.RunString(loopPrelude); err != nil {
		panic(err)
	}
	return l
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func jsString(v goja.Value) string {
	if o, ok := v.(*goja.Object); ok {
		if st := o.Get("stack"); st != nil && !goja.IsUndefined(st) {
			return st.String()
		}
	}
	if v == nil {
		return "undefined"
	}
	return v.String()
}

func (l *Loop) report(v goja.Value) { l.Logf("ERROR: uncaught: %s", jsString(v)) }

func (l *Loop) reportErr(err error) {
	if ex, ok := err.(*goja.Exception); ok {
		l.report(ex.Value())
		return
	}
	l.Logf("ERROR: %v", err)
}

// VM returns the runtime. Only use it on the loop goroutine.
func (l *Loop) VM() *goja.Runtime { return l.vm }

func (l *Loop) now() time.Duration { return time.Since(l.start) }

func (l *Loop) setTimeout(call goja.FunctionCall) goja.Value {
	fn, ok := goja.AssertFunction(call.Argument(0))
	if !ok {
		panic(l.vm.NewTypeError("setTimeout: callback is not a function"))
	}
	ms := call.Argument(1).ToFloat()
	if !(ms > 0) { // also NaN
		ms = 0
	}
	var args []goja.Value
	if len(call.Arguments) > 2 {
		args = append(args, call.Arguments[2:]...)
	}
	l.nextID++
	l.seq++
	t := &jsTimer{id: l.nextID, when: l.now() + time.Duration(ms*float64(time.Millisecond)), seq: l.seq, fn: fn, args: args}
	heap.Push(&l.timers, t)
	l.byID[t.id] = t
	return l.vm.ToValue(t.id)
}

func (l *Loop) clearTimeout(call goja.FunctionCall) goja.Value {
	id := call.Argument(0).ToInteger()
	if t, ok := l.byID[id]; ok {
		delete(l.byID, id)
		if t.idx >= 0 {
			heap.Remove(&l.timers, t.idx)
		}
	}
	return goja.Undefined()
}

// Submit schedules fn to run on the loop goroutine as a macrotask. It is safe
// to call from any goroutine. It blocks only if the job queue is full.
func (l *Loop) Submit(fn func(vm *goja.Runtime)) { l.jobs <- fn }

// Do runs fn on the loop goroutine and waits for it to finish.
func (l *Loop) Do(fn func(vm *goja.Runtime) error) error {
	done := make(chan error, 1)
	l.Submit(func(vm *goja.Runtime) { done <- fn(vm) })
	return <-done
}

// RunScript runs source as a macrotask; use only before Run or on the loop.
func (l *Loop) RunScript(name, src string) (goja.Value, error) {
	return l.vm.RunScript(name, src)
}

func (l *Loop) runJob(fn func(*goja.Runtime)) {
	defer func() {
		if r := recover(); r != nil {
			l.Logf("ERROR: panic in loop job: %v", r)
		}
	}()
	fn(l.vm)
}

func (l *Loop) fireDue() {
	for len(l.timers) > 0 && l.timers[0].when <= l.now() {
		t := heap.Pop(&l.timers).(*jsTimer)
		delete(l.byID, t.id)
		if _, err := t.fn(goja.Undefined(), t.args...); err != nil {
			l.reportErr(err)
		}
	}
}

// Pending reports whether timers are scheduled.
func (l *Loop) Pending() int { return len(l.timers) }

// Run processes timers and submitted jobs until ctx is done. If untilIdle is
// set it also returns as soon as no timers are pending and no jobs are queued.
func (l *Loop) Run(ctx context.Context, untilIdle bool) error {
	wake := time.NewTimer(time.Hour)
	defer wake.Stop()
	for {
		l.fireDue()
		select {
		case fn := <-l.jobs:
			l.runJob(fn)
			continue
		default:
		}
		if untilIdle && len(l.timers) == 0 {
			return nil
		}
		wait := time.Hour
		if len(l.timers) > 0 {
			wait = l.timers[0].when - l.now()
			if wait <= 0 {
				continue
			}
		}
		wake.Reset(wait)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case fn := <-l.jobs:
			l.runJob(fn)
		case <-wake.C:
		}
		if !wake.Stop() {
			select {
			case <-wake.C:
			default:
			}
		}
	}
}

// call invokes a global JS function by name with Go arguments (loop only).
func (l *Loop) call(name string, args ...any) error {
	fn, ok := goja.AssertFunction(l.vm.Get(name))
	if !ok {
		return fmt.Errorf("%s is not a function", name)
	}
	vals := make([]goja.Value, len(args))
	for i, a := range args {
		vals[i] = l.vm.ToValue(a)
	}
	_, err := fn(goja.Undefined(), vals...)
	return err
}
