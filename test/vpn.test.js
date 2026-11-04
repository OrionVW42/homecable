// Finding a VPN among the network adapters: the real ones count, private-network tools never do.
const test = require('node:test');
const assert = require('node:assert');
const { pickVpn } = require('../src/main/vpn');

const eth = { name: 'Ethernet', address: '192.168.0.50', internal: false, description: 'Realtek PCIe GbE Family Controller' };
const lo = { name: 'Loopback Pseudo-Interface 1', address: '127.0.0.1', internal: true };

test('a known VPN is found by its adapter name or description', () => {
  assert.equal(pickVpn([eth, { name: 'ProtonVPN', address: '10.2.0.2', description: 'WireGuard Tunnel' }]).provider, 'Proton VPN');
  assert.equal(pickVpn([eth, { name: 'NordLynx', address: '10.5.0.2' }]).provider, 'NordVPN');
  assert.equal(pickVpn([eth, { name: 'Malwarebytes Privacy', address: '10.6.0.2' }]).provider, 'Malwarebytes Privacy VPN');
  assert.equal(pickVpn([{ name: 'Local Area Connection 3', address: '10.8.0.2', description: 'Windscribe VPN' }, eth]).provider, 'Windscribe');
});

test('an unknown tunnel counts as a VPN; a normal connection never does', () => {
  assert.equal(pickVpn([eth, { name: 'wg0', address: '10.0.0.2' }]).name, 'wg0');
  assert.equal(pickVpn([eth, { name: 'Work', address: '10.0.0.3', description: 'OpenVPN Wintun' }]).name, 'Work');
  assert.equal(pickVpn([eth, lo]), null);
  assert.equal(pickVpn([]), null);
});

test('private-network tools are not privacy VPNs, whatever they are called', () => {
  assert.equal(pickVpn([eth, { name: 'Radmin VPN', address: '26.225.20.55', description: 'Famatech Radmin VPN Ethernet Adapter' }]), null);
  assert.equal(pickVpn([eth, { name: 'Tailscale', address: '100.101.1.2', description: 'Tailscale Tunnel' }]), null);
  assert.equal(pickVpn([{ name: 'My VPN', address: '100.64.0.9' }, { name: 'Other VPN', address: '26.1.1.1' }]), null, 'by address too');
  assert.equal(pickVpn([{ name: 'ZeroTier One', address: '10.147.17.5' }]), null);
  assert.equal(pickVpn([{ name: 'ProtonVPN', address: null }]), null, 'an adapter with no address is off');
});

test('a chosen provider is preferred over the others', () => {
  const both = [{ name: 'ProtonVPN', address: '10.2.0.2' }, { name: 'Mullvad', address: '10.64.0.2' }];
  assert.equal(pickVpn(both, 'mullvad').name, 'Mullvad');
  assert.equal(pickVpn(both).name, 'ProtonVPN');
  assert.equal(pickVpn([eth, { name: 'ProtonVPN', address: '10.2.0.2' }], 'nord'), null);
});
