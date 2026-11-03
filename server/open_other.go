//go:build !(linux && !android) && !(darwin && !ios) && !windows

package main

import "errors"

func openBrowser(string) error { return errors.New("opening a browser is not supported here") }
