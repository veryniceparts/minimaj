// Package minimaj embeds the browser game so the native server can serve it.
package minimaj

import "embed"

// Web holds the static site: index.html, style.css, js/ and assets/.
//
//go:embed index.html style.css js assets
var Web embed.FS
