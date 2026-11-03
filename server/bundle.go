package main

import (
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
)

// Zero-dependency bundler for the game's ES modules.
//
// Rules the bundled modules (js/tiles.js, hand.js, bot.js, game.js, room.js,
// qr.js) must follow:
//   - imports only at the top level, at the start of a line, in the form
//     import { a, b } from './x.js';   (may span lines; no default/namespace imports)
//   - exports only as  export function|async function|class|const|let|var NAME
//     at the start of a line (one name per export const/let/var statement)
//   - no export default, no export { ... } lists, no re-exports
//   - only modules earlier in bundleOrder may be imported
//
// Each module runs in its own function scope; its exports are copied onto a
// shared object which ends up as globalThis.minimaj.

var bundleOrder = []string{"tiles", "hand", "bot", "game", "room", "qr"}

var (
	importRe     = regexp.MustCompile(`(?m)^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?`)
	bareImportRe = regexp.MustCompile(`(?m)^import\s*['"][^'"]+['"]\s*;?`)
	exportRe     = regexp.MustCompile(`(?m)^export\s+((?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))`)
	leftoverRe   = regexp.MustCompile(`(?m)^\s*(export|import)\b[^(.]`)
	asRe         = regexp.MustCompile(`\s+as\s+`)
)

// BundleResult is the bundled source plus the module names that went in.
type BundleResult struct {
	Source  string
	Modules []string
}

// Bundle reads js/<name>.js from fsys for every module in bundleOrder. A
// missing module is taken from fallback (if present) or skipped.
func Bundle(fsys fs.FS, fallback map[string]string) (BundleResult, error) {
	var b strings.Builder
	var res BundleResult
	known := map[string]bool{}
	b.WriteString("var __m = {};\n")
	for _, name := range bundleOrder {
		path := "js/" + name + ".js"
		data, err := fs.ReadFile(fsys, path)
		src := string(data)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				return res, err
			}
			fb, ok := fallback[name]
			if !ok {
				continue
			}
			path, src = "fallback:"+name, fb
		}
		mod, err := transformModule(path, src, known)
		if err != nil {
			return res, err
		}
		b.WriteString(mod)
		res.Modules = append(res.Modules, name)
	}
	b.WriteString("globalThis.minimaj = __m;\n")
	res.Source = b.String()
	return res, nil
}

func transformModule(path, src string, known map[string]bool) (string, error) {
	src = strings.TrimPrefix(src, "\ufeff")
	var missing []string
	src = importRe.ReplaceAllStringFunc(src, func(m string) string {
		names := importRe.FindStringSubmatch(m)[1]
		for _, n := range strings.Split(names, ",") {
			if f := strings.Fields(n); len(f) > 0 && !known[f[0]] {
				missing = append(missing, f[0])
			}
		}
		names = asRe.ReplaceAllString(names, ": ")
		// keep the line count so error line numbers stay close
		nl := strings.Count(m, "\n")
		return "const {" + strings.Join(strings.Fields(strings.ReplaceAll(names, "\n", " ")), " ") + "} = __m;" + strings.Repeat("\n", nl)
	})
	src = bareImportRe.ReplaceAllString(src, "")
	var names []string
	src = exportRe.ReplaceAllStringFunc(src, func(m string) string {
		sm := exportRe.FindStringSubmatch(m)
		for _, n := range sm[2:] {
			if n != "" {
				names = append(names, n)
			}
		}
		return sm[1]
	})
	if len(missing) > 0 {
		return "", fmt.Errorf("bundle %s: imports %s, which no earlier module exports", path, strings.Join(missing, ", "))
	}
	for _, n := range names {
		known[n] = true
	}
	if loc := leftoverRe.FindStringIndex(src); loc != nil {
		line := strings.Count(src[:loc[0]], "\n") + 1
		end := strings.IndexByte(src[loc[0]:], '\n')
		if end < 0 {
			end = len(src) - loc[0]
		}
		return "", fmt.Errorf("bundle %s:%d: unsupported import/export: %q", path, line, strings.TrimSpace(src[loc[0]:loc[0]+end]))
	}
	var b strings.Builder
	fmt.Fprintf(&b, ";(function (__m) { // %s\n", path)
	b.WriteString(src)
	fmt.Fprintf(&b, "\nObject.assign(__m, { %s });\n})(__m);\n", strings.Join(names, ", "))
	return b.String(), nil
}
