# minimaj

Minimal peer-to-peer 4-player **riichi mahjong** that runs in the browser.

**Create a room → share the code → friends join → play.** You can play with
1, 2 or 3 friends; any empty seat is taken by a computer player. If someone
drops out during a game, a computer takes over their seat, and they get it
back when they rejoin with the same link.

No accounts and no game server. The host's browser runs the game, and
everyone connects to it directly over WebRTC (via [PeerJS](https://peerjs.com)).
The public PeerJS server is only used to set up the connection.

## Play

1. Open the page (see *Hosting* below), enter a name and press **Create room**.
2. Send the 5-letter code or the invite link (**Copy link**) to your friends.
   They open the link (or enter the code) and press **Join**.
3. Pick the length (East round or half game) and press **Start**.

Controls: click a tile to discard it (on touch screens, tap it twice). Buttons
for **Chi / Pon / Kan / Ron / Tsumo / Riichi / Pass** appear when you can use
them. After riichi your drawn tiles are discarded for you. The bar shows your
waits when you are tenpai, and warns you when you are furiten.

The host has to keep their tab open for the whole game.

## Rules implemented

- 136 tiles with one red five per suit, a 14-tile dead wall, kan dora, ura dora and rinshan draws
- Chi, pon, open kan, closed kan, added kan (with chankan), and the kuikae (swap-call) restriction
- Riichi (1000-point deposit, ippatsu, double riichi), tsumo, ron with head-bump (closest player wins)
- Furiten: from your own discards, temporary, and permanent after riichi
- Yaku: riichi, ippatsu, menzen tsumo, pinfu, tanyao, iipeikou, yakuhai (dragons, seat and round wind), haitei, houtei,
  rinshan, chankan, double riichi, chiitoitsu, toitoi, sanankou, sanshoku doujun/doukou, ittsu, chanta, junchan,
  honroutou, shousangen, sankantsu, ryanpeikou, honitsu, chinitsu
- Yakuman: kokushi, suuankou, daisangen, shousuushii, daisuushii, tsuuiisou, chinroutou, ryuuiisou, chuuren,
  suukantsu, tenhou, chiihou
- Full fu calculation, mangan to kazoe-yakuman limits, honba, riichi sticks, 3000-point tenpai payments at an exhaustive draw
- Dealer keeps the seat on a win or when tenpai at a draw; the game ends after East (or South) or when someone drops below zero

Left out to keep it small: abortive draws, nagashi mangan, double ron, pao, and declaring a closed kan after riichi.

## Hosting

It's a static site with no build step. To serve it locally:

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

To let friends join from elsewhere, publish the folder on any static host, for
example GitHub Pages (Settings → Pages → deploy from branch, root folder).
Modules don't load from `file://`, so you do need some kind of web server.

Some strict networks (symmetric NAT or corporate firewalls) block direct
WebRTC connections. If friends can't connect, try another network, such as a
phone hotspot.

## Code

| File | What it does |
| --- | --- |
| `js/tiles.js` | tile ids and types, helpers |
| `js/hand.js` | shanten, waits, hand decomposition, yaku, fu, points |
| `js/game.js` | the authoritative game engine (state machine, claims, scoring, per-seat views) |
| `js/bot.js` | the computer player: efficiency based on shanten and tile acceptance, with basic defense against riichi |
| `js/net.js` | host and client sessions over PeerJS |
| `js/ui.js`, `js/main.js`, `style.css` | rendering and screens |

`npm test` runs scoring unit tests and 30 full bot-only games (≈40 s).
