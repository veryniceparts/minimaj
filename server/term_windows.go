//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// enableVT turns on ANSI escape processing for the console (Windows 10+).
func enableVT() {
	k := syscall.NewLazyDLL("kernel32.dll")
	get, set := k.NewProc("GetConsoleMode"), k.NewProc("SetConsoleMode")
	h := syscall.Handle(os.Stdout.Fd())
	var mode uint32
	if r, _, _ := get.Call(uintptr(h), uintptr(unsafe.Pointer(&mode))); r == 0 {
		return
	}
	const enableVirtualTerminalProcessing = 0x0004
	set.Call(uintptr(h), uintptr(mode|enableVirtualTerminalProcessing))
}
