// Finding older TVs (DLNA), with a VPN on and with it off. Fake TVs on this PC's loopback
// addresses; nothing here touches the real network.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const dlna = require('../src/main/dlna');
const { homeNetworks } = require('../src/main/vpn');
const { localAddressFor } = require('../src/main/cast');

const ethernet = [{ family: 'IPv4', address: '192.168.0.96', netmask: '255.255.255.0', internal: false }];
const proton = [{ family: 'IPv4', address: '10.2.0.2', netmask: '255.255.255.255', internal: false }];
const loop = [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }];
const withVpn = { ProtonVPN: proton, Ethernet: ethernet, Loopback: loop };
const withoutVpn = { Ethernet: ethernet, Loopback: loop };
const homeOnly = [{ name: 'Ethernet', address: '192.168.0.96', netmask: '255.255.255.0' }];

test('the home network is the same with the VPN on and off', () => {
  assert.deepStrictEqual(homeNetworks(withVpn, {}), homeOnly);
  assert.deepStrictEqual(homeNetworks(withoutVpn, {}), homeOnly);
});

test('VPNs and private-network tools are never the home network', () => {
  const v = (address, netmask = '255.255.255.0') => [{ family: 'IPv4', address, netmask, internal: false }];
  // A VPN named plainly is recognised by its description, or by its one-address mask.
  assert.deepStrictEqual(homeNetworks({ 'Local Area Connection 3': v('10.8.0.2') }, { 'Local Area Connection 3': 'WireGuard Tunnel' }), []);
  assert.deepStrictEqual(homeNetworks({ 'Local Area Connection 4': v('10.8.0.2', '255.255.255.255') }, {}), []);
  assert.deepStrictEqual(homeNetworks({ NordLynx: v('10.5.0.2') }, {}), []);
  assert.deepStrictEqual(homeNetworks({ Tailscale: v('100.64.1.2', '255.192.0.0'), Radmin: v('26.1.2.3', '255.0.0.0'), 'vEthernet (WSL)': v('172.20.0.1') }, {}), []);
  assert.deepStrictEqual(homeNetworks({ 'Wi-Fi': v('8.8.8.8') }, {}), [], 'public addresses are never swept');
});

test('a TV is always told this PC’s home address, never the VPN’s', () => {
  const real = os.networkInterfaces;
  try {
    for (const nets of [withVpn, withoutVpn]) {
      os.networkInterfaces = () => nets;
      assert.strictEqual(localAddressFor('192.168.0.173'), '192.168.0.96', 'same network');
      assert.strictEqual(localAddressFor('192.168.5.20'), '192.168.0.96', 'a TV on another subnet');
    }
  } finally { os.networkInterfaces = real; }
});

test('the addresses to ask are every neighbour, without this PC', () => {
  const hosts = dlna.hostsOn({ address: '192.168.0.96', netmask: '255.255.255.0' });
  assert.strictEqual(hosts.length, 253);
  assert.ok(hosts.includes('192.168.0.173') && hosts.includes('192.168.0.1') && hosts.includes('192.168.0.254'));
  assert.ok(!hosts.includes('192.168.0.96') && !hosts.includes('192.168.0.0') && !hosts.includes('192.168.0.255'));
  // A huge office network: only the nearest 254, not 65,000.
  const big = dlna.hostsOn({ address: '10.1.2.3', netmask: '255.0.0.0' });
  assert.strictEqual(big.length, 253);
  assert.ok(big.includes('10.1.2.200') && !big.includes('10.1.3.1'));
});

const RENDERER_XML = (uuid) => `<?xml version="1.0"?><root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>[TV]Old TV</friendlyName><manufacturer>Samsung Electronics</manufacturer><modelName>UN55D6050</modelName><UDN>uuid:${uuid}</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>`;
const serve = (host, port, onReq) => new Promise((ok) => { const s = http.createServer(onReq); s.listen(port, host, () => ok(s)); });

test('the direct check finds a TV that never answers the broadcast, and only real TVs', async () => {
  const probe = await serve('127.0.0.3', 0, (req, res) => res.end(req.url === '/dmr' ? RENDERER_XML('tv-1') : ''));
  const port = probe.address().port;
  const printer = await serve('127.0.0.4', port, (req, res) => res.end('<root><device><deviceType>Printer</deviceType></device></root>'));
  try {
    const found = await dlna.sweep({ networks: [{ address: '127.0.0.1', netmask: '255.255.255.248' }], ports: [[port, '/dmr']], ms: 300 });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].id, 'dlna:tv-1');
    assert.strictEqual(found[0].name, 'Old TV');
    assert.strictEqual(found[0].host, '127.0.0.3');
    assert.strictEqual(found[0].year, 2011);
    assert.ok(found[0].avt.endsWith('/ctl'));
  } finally { probe.close(); printer.close(); }
});

test('nothing to ask when there is no home network', async () => {
  assert.deepStrictEqual(await dlna.sweep({ networks: [] }), []);
});
