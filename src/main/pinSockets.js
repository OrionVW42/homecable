// Pin every socket a process opens to one network interface — the heart of the
// qBittorrent-style "network interface" setting. Required once, at start, by the
// torrent process and the search process: after pin(address) every connection,
// listening socket and UDP socket the process opens is bound to that address
// (peers, trackers, the DHT, web seeds, .torrent downloads, search pages), so
// with a VPN adapter chosen nothing leaks over the normal connection. A caller
// that names an address itself (the media server on 127.0.0.1) is left alone.
const net = require('net');
const dgram = require('dgram');
const os = require('os');

let bound = null; // null = any interface

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (bound) {
    // (options[, cb]), an already-normalized [options, cb] from net.connect(), or (port[, host][, cb])
    const opts = Array.isArray(args[0]) ? args[0][0] : args[0] && typeof args[0] === 'object' ? args[0] : null;
    if (opts) { if (!opts.path && !opts.localAddress) opts.localAddress = bound; }
    else if (typeof args[0] === 'number') {
      const cb = args.find((a) => typeof a === 'function');
      args = [{ port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined, localAddress: bound }, cb].filter((a) => a !== undefined);
    }
  }
  return origConnect.apply(this, args);
};
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (bound) {
    // A port with no host → the bound address. (The media server names 127.0.0.1 itself and is left alone.)
    if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1, 0, bound);
    else if (args[0] && typeof args[0] === 'object' && args[0].port != null && !args[0].host && !args[0].path) args[0] = { ...args[0], host: bound };
  }
  return origListen.apply(this, args);
};
const origBind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  if (bound) {
    // Explicit binds (the DHT) and the implicit bind Node does on a socket's first send() (UDP trackers).
    if (args[0] && typeof args[0] === 'object') { if (!args[0].address) args[0] = { ...args[0], address: bound }; }
    else if (typeof args[1] !== 'string') { const hasPort = typeof args[0] === 'number'; args = [hasPort ? args[0] : 0, bound, ...(hasPort ? args.slice(1) : args)]; }
  }
  return origBind.apply(this, args);
};

// Bind everything from now on to this address (null: any interface). Connections fetch()
// kept open from before are dropped: a request must not slip through on an old socket.
function pin(address) {
  const next = address || null;
  if (next !== bound) { bound = next; dropPooledConnections(); }
  return bound;
}
function dropPooledConnections() {
  try {
    const key = Symbol.for('undici.globalDispatcher.1'); // where Node keeps fetch()'s connection pool
    const old = globalThis[key];
    if (!old || typeof old.destroy !== 'function') return;
    globalThis[key] = new old.constructor();
    Promise.resolve(old.destroy()).catch(() => {});
  } catch {}
}
function pinned() { return bound; }

// The IPv4 address an interface has right now (null: it's down, or has none).
function addressOf(iface) {
  if (!iface) return null;
  const list = os.networkInterfaces()[iface] || [];
  return list.find((a) => a.family === 'IPv4' || a.family === 4)?.address || null;
}

module.exports = { pin, pinned, addressOf };
