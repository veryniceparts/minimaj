# minimaj

Minimal 4-player **riichi mahjong** with a cute dark pastel look. Play with
1–3 friends; every empty seat is taken by a computer player.

There are two ways to play:

- **minimaj app (Windows, macOS, Android, Linux).** One person runs the app and
  it becomes the table. Friends on the same Wi-Fi scan the QR code, or open the
  link, in any browser. Nobody else needs to install anything, and it works
  without internet.
- **Online room (any browser).** Open the static web version, press **Create
  room** and send the 5-letter code or link. Players connect peer-to-peer over
  WebRTC. The public PeerJS server is only used to set up the connection.

If someone drops out, a computer takes over their seat. They get it back by
opening the link again, or just by reloading the page.

## Download

Every push builds the apps in GitHub Actions (**Actions → build → Artifacts**).
Pushing a `v*` tag also attaches them to a GitHub release.

| Platform | File | First launch |
| --- | --- | --- |
| Windows | `minimaj-windows-amd64.zip` → `minimaj.exe` | SmartScreen: *More info → Run anyway*. Allow *Private networks* in the firewall prompt. |
| macOS | `minimaj-macos.zip` → `minimaj.app` (universal) | Not notarized: right-click the app → *Open*. Allow incoming connections. |
| Android | `minimaj-android-arm64.apk` | Allow installing from your browser or file manager. Allow notifications so the table keeps running. |
| Linux | `minimaj-linux-amd64.tar.gz` / `arm64` | Run `./minimaj`. |

## Play

**With the app.** Start minimaj. On a computer it opens your browser at
`http://localhost:7777`; on Android it opens its own window. Enter your name and
press **Join table**. You are the host, so you choose the length and press
**Start**. To invite friends, show them the QR code in the lobby, or send them
the `http://192.168.x.x:7777` link. They must be on the same Wi-Fi, or on your
phone's hotspot. **Stop server** in the lobby shuts the table down.

**Online room.** Host the folder as a static site (see below), open it, press
**Create room**, and share the code or link. The host's tab runs the game, so
the host should keep it open.

**Controls.** Click a tile to discard it. On touch screens, tap to lift and tap
again to discard. Buttons for **Chi / Pon / Kan / Ron / Tsumo / Riichi** appear
when you can use them. After riichi your draws are discarded for you. The bar
shows your waits when you are tenpai and warns you when you are furiten. The
**•••** menu has sound, vibration, and *auto-pass* (skips call prompts, but
never Ron).

## Rules implemented

- 136 tiles with one red five per suit, a 14-tile dead wall, kan dora, ura dora and rinshan draws
- Chi, pon, open kan, closed kan, added kan (with chankan), and the kuikae (swap-call) restriction
- Riichi (1000-point deposit, ippatsu, double riichi), tsumo, ron with head-bump (closest player wins)
- Furiten: from your own discards, temporary, and permanent after riichi
- Yaku: riichi, ippatsu, menzen tsumo, pinfu, tanyao, iipeikou, yakuhai, haitei, houtei, rinshan, chankan,
  double riichi, chiitoitsu, toitoi, sanankou, sanshoku doujun/doukou, ittsu, chanta, junchan, honroutou,
  shousangen, sankantsu, ryanpeikou, honitsu, chinitsu
- Yakuman: kokushi, suuankou, daisangen, shousuushii, daisuushii, tsuuiisou, chinroutou, ryuuiisou, chuuren,
  suukantsu, tenhou, chiihou
- Full fu calculation, mangan to kazoe-yakuman limits, honba, riichi sticks, and 3000-point tenpai payments at an exhaustive draw
- East round or half game (East + South); the game also ends when someone drops below zero

Left out to keep it small: abortive draws, nagashi mangan, double ron, pao, and declaring a closed kan after riichi.

## How it works

```
                 ┌──────────── minimaj app (Go, one binary) ────────────┐
 browser ──ws──▶ │ HTTP: serves index.html, style.css, js/ (embedded)   │
 browser ──ws──▶ │ /ws → one goroutine running goja, a JS engine in Go  │
                 │       room.js + game.js (the same JS the browser uses)│
                 └──────────────────────────────────────────────────────┘
```

The game engine and room logic are plain JavaScript with no DOM access. The
same files run in three places: inside the native app (via
[goja](https://github.com/dop251/goja)), in the host's browser tab for online
rooms, and in Node for the tests. The client is plain HTML, CSS and JS, with no
framework and no build step.

Dependencies: Go, `goja` and `coder/websocket`. The web client vendors one
library, PeerJS, which is only loaded for online rooms. The QR encoder is a
small vendored port of lean-qr (MIT). Android uses no libraries at all: a plain
`Activity` + `Service` + `WebView`.

| Path | What it does |
| --- | --- |
| `js/tiles.js`, `js/hand.js` | tiles; shanten (table-driven), waits, yaku, fu, points |
| `js/game.js`, `js/bot.js` | the authoritative engine, and the computer player |
| `js/room.js` | lobby, seats, host rules, rejoin, heartbeat; independent of the transport |
| `js/net.js` | client sessions: WebSocket (app) or PeerJS (online), with auto-reconnect |
| `js/ui.js`, `js/main.js`, `style.css` | rendering (keyed tile nodes and FLIP animations), screens, sound |
| `js/qr.js`, `js/vendor/peerjs.min.js` | vendored QR encoder and PeerJS |
| `server/` | the Go app: event loop, JS bundler, HTTP/WebSocket, LAN detection, terminal QR |
| `android/` | Android shell: a foreground service runs the Go binary; a WebView shows the table |
| `.github/workflows/build.yml` | tests and builds for every platform |

## Develop

```sh
node test/run.js           # engine, scoring, room, transport and QR tests (~4 s)
go test ./...              # Go event loop, bundler, a full bot game in goja, WebSocket
go run ./server            # run the app from source (flags: -port, -no-browser)
python3 -m http.server     # static/online version at http://localhost:8000
```

Open `http://localhost:8000/?fake` to play a local game against bots without any
networking. It is useful for UI work. `scripts/package-macos.sh` builds the macOS `.app` from the two darwin binaries (works on Linux).

Cross-compile (no cgo):

```sh
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o minimaj.exe ./server
```

To build the Android app locally (requires the Android SDK, JDK 17 and Gradle 8.11):
put the `GOOS=android GOARCH=arm64` binary at
`android/app/src/main/jniLibs/arm64-v8a/libminimaj.so`, then run
`gradle -p android assembleDebug`.

## Network notes

- LAN play needs all devices on the same network. Guest Wi-Fi that isolates
  clients blocks it. A phone hotspot works.
- The app's pages are plain `http://`, which browsers allow for local addresses.
  Use the link or QR code the app shows. A copy of the site on GitHub Pages
  cannot reach a LAN app because browsers block that mix.
- Online rooms need WebRTC. Some strict networks block it; try another network.
