// Finding a VPN on this PC, so torrents and torrent search can be pinned to it. Nothing
// is installed or changed and nothing leaves the PC: it only reads the network adapters.
// Private-network tools (Radmin, Tailscale, ZeroTier…) look like VPNs but don't hide your
// address from the internet, so they never count.
const os = require('os');
const { execFile } = require('child_process');

const PROVIDERS = [
  ['proton', 'Proton VPN', /proton/i], ['nord', 'NordVPN', /nord(vpn|lynx)/i], ['malwarebytes', 'Malwarebytes Privacy VPN', /malwarebytes|mb ?privacy/i], ['mullvad', 'Mullvad', /mullvad/i],
  ['express', 'ExpressVPN', /express ?vpn/i], ['surfshark', 'Surfshark', /surfshark/i], ['cyberghost', 'CyberGhost', /cyberghost/i],
  ['pia', 'Private Internet Access', /private internet access|\bpia\b|^wgpia/i], ['windscribe', 'Windscribe', /windscribe/i],
  ['hideme', 'hide.me', /hide\.?me/i], ['privado', 'PrivadoVPN', /privado/i], ['ipvanish', 'IPVanish', /ipvanish/i],
  ['tunnelbear', 'TunnelBear', /tunnelbear/i], ['hotspot', 'Hotspot Shield', /hotspot ?shield/i], ['torguard', 'TorGuard', /torguard/i],
  ['vypr', 'VyprVPN', /vypr/i], ['purevpn', 'PureVPN', /pure ?vpn/i], ['airvpn', 'AirVPN', /airvpn|eddie/i],
];
const NOT_PRIVACY = /tailscale|radmin|zerotier|hamachi|loopback|teredo|isatap|vethernet|hyper-v|vmware|virtualbox|wsl|bluetooth|npcap|wan miniport|cloudflare ?warp/i;
const GENERIC = /wireguard|wintun|openvpn|tap-windows|\bvpn\b|^wg\d*$|^tun\d*$|^utun\d*$|^ppp\d*$/i;
// Radmin (26/8) and Tailscale (100.64/10) by address too, however the adapter is named.
const privateMesh = (ip) => /^26\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

// adapters: [{ name, address, internal, description }]; choice: 'auto' or a provider id.
function pickVpn(adapters, choice = 'auto') {
  const usable = (adapters || []).filter((a) => a.address && !a.internal && !privateMesh(a.address) && !NOT_PRIVACY.test(`${a.name} ${a.description || ''}`));
  const label = (a) => `${a.name} ${a.description || ''}`.trim();
  for (const [id, name, re] of PROVIDERS) {
    if (choice !== 'auto' && choice !== id) continue;
    const a = usable.find((x) => re.test(label(x)));
    if (a) return { name: a.name, address: a.address, provider: name, id };
  }
  const g = usable.find((x) => GENERIC.test(label(x)));
  return g ? { name: g.name, address: g.address, provider: choice === 'auto' ? 'A VPN' : (PROVIDERS.find((p) => p[0] === choice)?.[1] || 'A VPN'), id: 'generic' } : null;
}

const adaptersNow = (descriptions = {}) => Object.entries(os.networkInterfaces()).map(([name, list]) => {
  const a = (list || []).find((x) => x.family === 'IPv4' || x.family === 4);
  return { name, address: a?.address || null, internal: !!a?.internal, description: descriptions[name] || '' };
});

// Windows names some VPN adapters plainly ("Local Area Connection 3"); their description says what they are.
let described = {}, describedFor = '';
function readDescriptions() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({});
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapter -IncludeHidden | Select-Object Name,InterfaceDescription | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 8000 }, (err, out) => {
      if (err) return resolve({});
      try { const j = JSON.parse(out); resolve(Object.fromEntries((Array.isArray(j) ? j : [j]).map((x) => [x.Name, x.InterfaceDescription || '']))); } catch { resolve({}); }
    });
  });
}
const detectNow = (choice) => (process.env.HOMECABLE_NO_VPN ? null : pickVpn(adaptersNow(described), choice));
async function detect(choice) {
  if (process.env.HOMECABLE_NO_VPN) return null;
  const names = Object.keys(os.networkInterfaces()).sort().join('|');
  if (names !== describedFor) { described = await readDescriptions(); describedFor = names; } // only when the adapters changed
  return detectNow(choice);
}

module.exports = { pickVpn, detect, detectNow, PROVIDERS: PROVIDERS.map(([id, name]) => ({ id, name })) };
