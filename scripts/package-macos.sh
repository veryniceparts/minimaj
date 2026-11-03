#!/bin/sh
# Build minimaj.app (universal) and a zip from the two darwin binaries.
# Runs on Linux or macOS; needs lipo or llvm-lipo, and zip.
# usage: scripts/package-macos.sh <darwin-amd64-bin> <darwin-arm64-bin> <version> <outdir>
set -eu
amd64=$1 arm64=$2 ver=$3 out=$4
lipo=$(command -v lipo || command -v llvm-lipo || ls /usr/bin/llvm-lipo* 2>/dev/null | sort -V | tail -1)
[ -n "$lipo" ] || { echo "no lipo/llvm-lipo found" >&2; exit 1; }
work=$(mktemp -d)
app="$work/minimaj.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$out"
"$lipo" -create -output "$app/Contents/MacOS/minimaj-server" "$amd64" "$arm64"
"$lipo" -info "$app/Contents/MacOS/minimaj-server"
chmod +x "$app/Contents/MacOS/minimaj-server"

# A double-clicked app has no terminal, so log to a file.
# The server opens the browser itself; "Stop server" in the lobby quits it.
cat > "$app/Contents/MacOS/minimaj" <<'SH'
#!/bin/sh
dir="$(cd "$(dirname "$0")" && pwd)"
log="$HOME/Library/Logs/minimaj.log"
mkdir -p "$(dirname "$log")"
exec "$dir/minimaj-server" >>"$log" 2>&1
SH
chmod +x "$app/Contents/MacOS/minimaj"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>minimaj</string>
  <key>CFBundleDisplayName</key><string>minimaj</string>
  <key>CFBundleIdentifier</key><string>app.minimaj</string>
  <key>CFBundleExecutable</key><string>minimaj</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${ver}</string>
  <key>CFBundleShortVersionString</key><string>${ver}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# zip keeps the executable bits; Finder's Archive Utility restores them.
(cd "$work" && zip -qry "minimaj-macos.zip" minimaj.app)
mv "$work/minimaj-macos.zip" "$out/"
# Plain universal binary for terminal use.
cp "$app/Contents/MacOS/minimaj-server" "$work/minimaj"
tar -C "$work" -czf "$out/minimaj-macos-universal.tar.gz" minimaj
rm -rf "$work"
ls -l "$out"
