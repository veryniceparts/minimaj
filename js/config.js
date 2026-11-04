// Network settings for online rooms (PeerJS / WebRTC). Edit this file, or set
// window.MINIMAJ_NET = { ... } in a <script> before the game loads; fields
// given there replace the ones below.
//
// Why TURN matters: WebRTC first tries a direct path between the two
// browsers (with STUN to learn the public address). That fails when either
// side is behind a symmetric NAT or a strict firewall — common on mobile data
// (carrier-grade NAT), office/school/hotel Wi-Fi and some home routers. Only a
// TURN relay gets those players in. PeerJS used to ship a free TURN server,
// but it was shut down in December 2023, so the default here is STUN only.
//
// To add TURN (any one of):
//   - iceServers: static credentials, e.g. from ExpressTURN or your own coturn:
//       { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:443?transport=tcp'],
//         username: 'user', credential: 'secret' }
//   - iceUrl: an endpoint that returns ICE servers as JSON, either an array of
//     RTCIceServer objects or { iceServers: [...] } (an object or an array).
//     Metered (free plan available) gives one directly:
//       'https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY'
//     Cloudflare Realtime TURN needs a secret token, so put a tiny worker in
//     front of its generate-ice-servers API and point iceUrl at the worker.
//   The ICE servers from iceUrl are used together with iceServers below.
//
// peer: PeerJS signaling server options ({ host, port, path, key, secure }).
// Empty means the free public server 0.peerjs.com. Run your own PeerServer
// (npm "peer") if that one is down or blocked on your players' networks.
// Every player in a room must use the same signaling server.
export const NET_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
  iceUrl: '',
  peer: {},
};
