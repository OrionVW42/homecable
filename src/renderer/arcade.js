// HomeCable Arcade: small original retro-style games for the couch.
// Low-res canvas (320×180) scaled up with crisp pixels; controller or keyboard.
import { html } from 'htm/preact';
import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks';
import { tv, Icon } from './util.js';

const W = 320, H = 180;
const BARS = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
const rnd = (a, b) => a + Math.random() * (b - a);
const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// ---------- input: keyboard + any controller ----------
function makeInput() {
  const keys = new Set();
  const taps = new Set(); // keys that went down since the last frame (catches very quick taps)
  const down = (e) => { const k = e.key.toLowerCase(); keys.add(k); taps.add(k); if (/^arrow/.test(k) || k === ' ') e.preventDefault(); };
  const up = (e) => keys.delete(e.key.toLowerCase());
  addEventListener('keydown', down, true);
  addEventListener('keyup', up, true);
  let prev = {};
  return {
    read() {
      const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      const b = (i) => pads.some((p) => p.buttons[i]?.pressed);
      const key = (k) => keys.has(k) || taps.has(k);
      const ax = (i, s) => pads.some((p) => (p.axes[i] || 0) * s > 0.5);
      const s = {
        left: key('arrowleft') || key('a') || b(14) || ax(0, -1),
        right: key('arrowright') || key('d') || b(15) || ax(0, 1),
        up: key('arrowup') || key('w') || b(12) || ax(1, -1),
        down: key('arrowdown') || key('s') || b(13) || ax(1, 1),
        fire: key(' ') || key('enter') || key('z') || b(0) || b(7),
        alt: key('x') || b(2) || b(6),
        back: key('escape') || key('backspace') || b(1),
        pause: key('p') || b(9),
      };
      const pressed = {};
      for (const k in s) pressed[k] = s[k] && !prev[k];
      prev = s;
      taps.clear();
      return { ...s, pressed };
    },
    stop() { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); },
  };
}

// ---------- tiny sound effects ----------
let actx = null;
function blip(freq = 440, dur = 0.06, type = 'square', vol = 0.05) {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch {}
}

const text = (c, s, x, y, size = 8, color = '#fff', align = 'center') => {
  c.fillStyle = color; c.font = `bold ${size}px "Segoe UI", system-ui, sans-serif`; c.textAlign = align; c.textBaseline = 'middle'; c.fillText(s, x, y);
};
const noise = (c, x, y, w, h, a = 1) => {
  for (let i = 0; i < (w * h) / 6; i++) { const v = (Math.random() * 255) | 0; c.fillStyle = `rgba(${v},${v},${v},${a})`; c.fillRect(x + Math.random() * w, y + Math.random() * h, 1.5, 1.5); }
};

// ---------- Game 1: Static Storm (shooter) ----------
function staticStorm() {
  const g = { score: 0, lives: 3, over: false, wave: 0, t: 0 };
  const ship = { x: W / 2 - 7, y: H - 22, w: 14, h: 10, cool: 0, power: 0, inv: 0 };
  let shots = [], foes = [], bolts = [], ups = [], sparks = [];
  const spawnWave = () => {
    g.wave++;
    const n = 6 + g.wave * 2;
    for (let i = 0; i < n; i++) foes.push({ x: 20 + (i % 8) * 36, y: -20 - Math.floor(i / 8) * 22, w: 14, h: 12, hp: 1 + Math.floor(g.wave / 3), ph: rnd(0, 6), vx: rnd(-0.4, 0.4), shoot: rnd(60, 220) });
  };
  spawnWave();
  g.update = (dt, k) => {
    g.t += dt;
    if (k.left) ship.x -= 2.2 * dt; if (k.right) ship.x += 2.2 * dt;
    if (k.up) ship.y -= 1.6 * dt; if (k.down) ship.y += 1.6 * dt;
    ship.x = Math.max(2, Math.min(W - ship.w - 2, ship.x)); ship.y = Math.max(H * 0.45, Math.min(H - ship.h - 4, ship.y));
    ship.cool -= dt; ship.inv -= dt; ship.power -= dt;
    if (k.fire && ship.cool <= 0) {
      ship.cool = 9;
      const sp = ship.power > 0 ? [-1.2, 0, 1.2] : [0];
      for (const vx of sp) shots.push({ x: ship.x + 6, y: ship.y - 4, w: 2, h: 6, vx });
      blip(880, 0.04, 'square', 0.025);
    }
    for (const s of shots) { s.y -= 5 * dt; s.x += s.vx * dt; }
    shots = shots.filter((s) => s.y > -10);
    for (const f of foes) {
      f.y += (0.35 + g.wave * 0.04) * dt; f.x += Math.sin(g.t / 30 + f.ph) * 0.6 * dt + f.vx * dt;
      if (f.x < 2 || f.x > W - 16) f.vx *= -1;
      f.shoot -= dt;
      if (f.shoot <= 0 && f.y > 0) { f.shoot = rnd(120, 260) / (1 + g.wave * 0.1); bolts.push({ x: f.x + 6, y: f.y + 12, w: 3, h: 3, vx: (ship.x - f.x) / 120, vy: 1.4 }); }
      for (const s of shots) if (s.y > -5 && hit(s, f)) { s.y = -99; f.hp--; if (f.hp <= 0) { f.dead = true; g.score += 10 * g.wave; blip(220, 0.08, 'sawtooth', 0.04); for (let i = 0; i < 8; i++) sparks.push({ x: f.x + 7, y: f.y + 6, vx: rnd(-2, 2), vy: rnd(-2, 2), life: 20 }); if (Math.random() < 0.08) ups.push({ x: f.x, y: f.y, w: 8, h: 8 }); } }
      if (f.y > H) { f.dead = true; if (ship.inv <= 0) { g.lives--; ship.inv = 90; blip(110, 0.3, 'triangle', 0.06); } }
      if (ship.inv <= 0 && hit(f, ship)) { f.dead = true; g.lives--; ship.inv = 90; blip(110, 0.3, 'triangle', 0.06); }
    }
    foes = foes.filter((f) => !f.dead);
    for (const b of bolts) { b.x += b.vx * dt; b.y += b.vy * dt; if (ship.inv <= 0 && hit(b, ship)) { b.y = H + 9; g.lives--; ship.inv = 90; blip(110, 0.3, 'triangle', 0.06); } }
    bolts = bolts.filter((b) => b.y < H + 5);
    for (const u of ups) { u.y += 0.8 * dt; if (hit(u, ship)) { u.y = H + 9; ship.power = 600; blip(1320, 0.15, 'sine', 0.05); } }
    ups = ups.filter((u) => u.y < H + 5);
    for (const p of sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    sparks = sparks.filter((p) => p.life > 0);
    if (!foes.length) spawnWave();
    if (g.lives <= 0) g.over = true;
  };
  g.draw = (c) => {
    c.fillStyle = '#05060a'; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) { c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect((i * 97) % W, (i * 53 + g.t * (0.3 + (i % 3) * 0.3)) % H, 1, 1); }
    for (const f of foes) { noise(c, f.x, f.y, f.w, f.h); c.strokeStyle = '#9aa0b2'; c.strokeRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1); }
    for (const s of shots) { c.fillStyle = '#8fa5ff'; c.fillRect(s.x, s.y, s.w, s.h); }
    for (const b of bolts) { c.fillStyle = '#ff5d6c'; c.fillRect(b.x, b.y, b.w, b.h); }
    for (const u of ups) { c.fillStyle = BARS[(g.t / 4 | 0) % 7]; c.fillRect(u.x, u.y, u.w, u.h); }
    for (const p of sparks) { c.fillStyle = `rgba(255,255,255,${p.life / 20})`; c.fillRect(p.x, p.y, 2, 2); }
    if (ship.inv <= 0 || (g.t / 4 | 0) % 2) {
      c.fillStyle = '#fff'; c.fillRect(ship.x, ship.y + 2, ship.w, ship.h - 2);
      c.fillStyle = '#1c2040'; c.fillRect(ship.x + 2, ship.y + 4, ship.w - 4, ship.h - 6);
      c.strokeStyle = '#fff'; c.beginPath(); c.moveTo(ship.x + 7, ship.y + 2); c.lineTo(ship.x + 2, ship.y - 4); c.moveTo(ship.x + 7, ship.y + 2); c.lineTo(ship.x + 12, ship.y - 4); c.stroke();
    }
    text(c, `SCORE ${g.score}`, 6, 8, 8, '#fff', 'left'); text(c, `WAVE ${g.wave}`, W / 2, 8, 8, '#8fa5ff'); text(c, '♥'.repeat(Math.max(0, g.lives)), W - 6, 8, 8, '#ff5d6c', 'right');
  };
  return g;
}

// ---------- Game 2: Signal Breaker (paddle & bricks) ----------
function signalBreaker() {
  const g = { score: 0, lives: 3, over: false, level: 0, t: 0 };
  const pad = { x: W / 2 - 22, y: H - 12, w: 44, h: 5 };
  let ball, bricks = [], held = true, wide = 0;
  const newBall = () => { ball = { x: pad.x + pad.w / 2, y: pad.y - 4, w: 4, h: 4, vx: 1.4, vy: -2 }; held = true; };
  const level = () => {
    g.level++; bricks = [];
    const rows = Math.min(7, 3 + g.level);
    for (let r = 0; r < rows; r++) for (let i = 0; i < 14; i++) {
      if (g.level % 2 === 0 && (i + r) % 4 === 0) continue; // patterns on even levels
      bricks.push({ x: 6 + i * 22, y: 20 + r * 9, w: 20, h: 7, color: BARS[r % 7], hp: r === 0 && g.level > 2 ? 2 : 1 });
    }
    newBall();
  };
  level();
  g.update = (dt, k) => {
    g.t += dt; wide -= dt;
    pad.w = wide > 0 ? 66 : 44;
    if (k.left) pad.x -= 3.2 * dt; if (k.right) pad.x += 3.2 * dt;
    pad.x = Math.max(0, Math.min(W - pad.w, pad.x));
    if (held) { ball.x = pad.x + pad.w / 2 - 2; ball.y = pad.y - 5; if (k.pressed.fire || k.pressed.up) { held = false; blip(660); } return; }
    const sp = 1 + g.level * 0.08;
    ball.x += ball.vx * dt * sp; ball.y += ball.vy * dt * sp;
    if (ball.x < 0 || ball.x > W - 4) { ball.vx *= -1; ball.x = Math.max(0, Math.min(W - 4, ball.x)); blip(300, 0.03); }
    if (ball.y < 12) { ball.vy = Math.abs(ball.vy); blip(300, 0.03); }
    if (hit(ball, pad) && ball.vy > 0) { const rel = (ball.x + 2 - (pad.x + pad.w / 2)) / (pad.w / 2); ball.vx = rel * 2.4; ball.vy = -Math.max(1.6, 2.6 - Math.abs(rel)); blip(520, 0.04); }
    for (const b of bricks) if (!b.dead && hit(ball, b)) {
      b.hp--; if (b.hp <= 0) { b.dead = true; g.score += 10; if (Math.random() < 0.07) wide = 600; }
      const fromSide = ball.x + 2 < b.x || ball.x + 2 > b.x + b.w; if (fromSide) ball.vx *= -1; else ball.vy *= -1;
      blip(700 + Math.random() * 200, 0.04, 'square', 0.03); break;
    }
    bricks = bricks.filter((b) => !b.dead);
    if (ball.y > H) { g.lives--; blip(110, 0.3, 'triangle', 0.06); if (g.lives <= 0) g.over = true; else newBall(); }
    if (!bricks.length) { g.score += 100; level(); }
  };
  g.draw = (c) => {
    c.fillStyle = '#07080b'; c.fillRect(0, 0, W, H);
    for (const b of bricks) { c.fillStyle = b.color; c.fillRect(b.x, b.y, b.w, b.h); if (b.hp > 1) { c.fillStyle = 'rgba(255,255,255,.4)'; c.fillRect(b.x, b.y, b.w, 2); } }
    c.fillStyle = wide > 0 ? '#ffb547' : '#fff'; c.fillRect(pad.x, pad.y, pad.w, pad.h);
    c.fillStyle = '#8fa5ff'; c.fillRect(ball.x, ball.y, 4, 4);
    text(c, `SCORE ${g.score}`, 6, 6, 8, '#fff', 'left'); text(c, `LEVEL ${g.level}`, W / 2, 6, 8, '#8fa5ff'); text(c, '♥'.repeat(Math.max(0, g.lives)), W - 6, 6, 8, '#ff5d6c', 'right');
    if (held) text(c, 'A / SPACE TO LAUNCH', W / 2, H / 2 + 30, 8, '#9aa0b2');
  };
  return g;
}

// ---------- Game 3: Cable Tangle (grow-your-line) ----------
function cableTangle() {
  const CS = 8, GW = W / CS, GH = (H - 12) / CS;
  const g = { score: 0, over: false, t: 0 };
  let body = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }], dir = { x: 1, y: 0 }, next = dir, step = 0, plug, speed = 7;
  const place = () => { do { plug = { x: Math.floor(rnd(1, GW - 1)), y: Math.floor(rnd(1, GH - 1)) }; } while (body.some((b) => b.x === plug.x && b.y === plug.y)); };
  place();
  g.update = (dt, k) => {
    g.t += dt;
    if (k.left && dir.x === 0) next = { x: -1, y: 0 }; else if (k.right && dir.x === 0) next = { x: 1, y: 0 };
    else if (k.up && dir.y === 0) next = { x: 0, y: -1 }; else if (k.down && dir.y === 0) next = { x: 0, y: 1 };
    step += dt;
    if (step < speed) return;
    step = 0; dir = next;
    const head = { x: body[0].x + dir.x, y: body[0].y + dir.y };
    if (head.x < 0 || head.y < 0 || head.x >= GW || head.y >= GH || body.some((b) => b.x === head.x && b.y === head.y)) { g.over = true; blip(110, 0.4, 'triangle', 0.07); return; }
    body.unshift(head);
    if (head.x === plug.x && head.y === plug.y) { g.score += 10; speed = Math.max(3, speed - 0.15); place(); blip(990, 0.06, 'square', 0.04); }
    else body.pop();
  };
  g.draw = (c) => {
    c.fillStyle = '#0a0b10'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#11131b'; for (let x = 0; x < GW; x++) for (let y = 0; y < GH; y++) if ((x + y) % 2) c.fillRect(x * CS, 12 + y * CS, CS, CS);
    c.fillStyle = '#ffb547'; c.fillRect(plug.x * CS + 2, 12 + plug.y * CS + 1, 4, 5); c.fillStyle = '#c0c0c0'; c.fillRect(plug.x * CS + 2, 12 + plug.y * CS - 1, 1, 2); c.fillRect(plug.x * CS + 5, 12 + plug.y * CS - 1, 1, 2);
    body.forEach((b, i) => { c.fillStyle = i === 0 ? '#fff' : i % 2 ? '#6c8cff' : '#8f6cff'; c.fillRect(b.x * CS + 1, 12 + b.y * CS + 1, CS - 2, CS - 2); });
    text(c, `PLUGS ${g.score / 10}`, 6, 6, 8, '#fff', 'left'); text(c, `LENGTH ${body.length}`, W - 6, 6, 8, '#8fa5ff', 'right');
  };
  return g;
}

// ---------- Game 4: Channel Surfer (runner) ----------
function channelSurfer() {
  const g = { score: 0, over: false, t: 0 };
  const ground = H - 30;
  const p = { x: 40, y: ground - 14, w: 12, h: 14, vy: 0, duck: false };
  let obs = [], coins = [], speed = 2.2, gap = 60;
  g.update = (dt, k) => {
    g.t += dt; speed += 0.0012 * dt; g.score += speed * dt * 0.1;
    p.duck = k.down && p.y >= ground - 14;
    p.h = p.duck ? 8 : 14;
    if ((k.pressed.fire || k.pressed.up) && p.y >= ground - 14) { p.vy = -4.4; blip(600, 0.06, 'square', 0.03); }
    p.vy += 0.22 * dt; p.y = Math.min(ground - p.h, p.y + p.vy * dt);
    gap -= dt * speed;
    if (gap <= 0) {
      gap = rnd(90, 170);
      if (Math.random() < 0.65) obs.push({ x: W, y: ground - 14, w: 12, h: 14, kind: 'static' });
      else obs.push({ x: W, y: ground - 34, w: 22, h: 18, kind: 'antenna' });
      if (Math.random() < 0.5) coins.push({ x: W + 40, y: ground - rnd(30, 50), w: 7, h: 7 });
    }
    for (const o of obs) { o.x -= speed * dt; const box = { x: p.x + 2, y: p.y + 1, w: p.w - 4, h: p.h - 2 }; if (hit(box, o)) { g.over = true; blip(110, 0.4, 'triangle', 0.07); } }
    for (const cn of coins) { cn.x -= speed * dt; if (hit(p, cn)) { cn.got = true; g.score += 25; blip(1320, 0.06, 'sine', 0.04); } }
    obs = obs.filter((o) => o.x > -30); coins = coins.filter((c2) => c2.x > -10 && !c2.got);
  };
  g.draw = (c) => {
    const sky = c.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#1c2040'); sky.addColorStop(1, '#3a2a5c'); c.fillStyle = sky; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 7; i++) { c.fillStyle = BARS[i]; c.globalAlpha = 0.12; c.fillRect(((i * 60 - g.t * 0.3) % (W + 60) + W + 60) % (W + 60) - 30, 30, 30, ground - 30); } c.globalAlpha = 1;
    c.fillStyle = '#2d9cdb'; for (let x = 0; x < W; x += 4) c.fillRect(x, ground + Math.sin((x + g.t * speed * 3) / 12) * 2, 4, H - ground);
    for (const o of obs) {
      if (o.kind === 'static') noise(c, o.x, o.y, o.w, o.h);
      else { c.strokeStyle = '#c0c0c0'; c.lineWidth = 2; c.beginPath(); c.moveTo(o.x + 11, o.y + 18); c.lineTo(o.x, o.y); c.moveTo(o.x + 11, o.y + 18); c.lineTo(o.x + 22, o.y); c.stroke(); c.lineWidth = 1; c.fillStyle = '#555'; c.fillRect(o.x + 6, o.y + 14, 10, 4); }
    }
    for (const cn of coins) { c.fillStyle = '#ffb547'; c.fillRect(cn.x, cn.y, 7, 7); c.fillStyle = '#7a4d00'; c.fillRect(cn.x + 2, cn.y + 2, 3, 3); }
    c.fillStyle = '#ff5a5f'; c.fillRect(p.x - 3, p.y + p.h - 2, p.w + 6, 3);
    c.fillStyle = '#fff'; c.fillRect(p.x + 2, p.y, p.w - 4, p.h - 3); c.fillStyle = '#1c2040'; c.fillRect(p.x + 4, p.y + 2, p.w - 8, Math.max(2, p.h - 8));
    text(c, `${Math.floor(g.score)}`, W - 8, 10, 10, '#fff', 'right'); text(c, 'JUMP: A / SPACE · DUCK: DOWN', 8, 10, 7, '#9aa0b2', 'left');
  };
  return g;
}

export const GAMES = [
  { id: 'storm', name: 'Static Storm', icon: '⚡', color: '#6c8cff', desc: 'Blast the waves of static before they hit the screen.', make: staticStorm, help: 'Move: D-pad / arrows · Fire: A / Space · grab color bars for triple shot' },
  { id: 'breaker', name: 'Signal Breaker', icon: '🧱', color: '#ff5a5f', desc: 'Bounce the signal and break the color-bar wall.', make: signalBreaker, help: 'Move: D-pad / arrows · Launch: A / Space' },
  { id: 'tangle', name: 'Cable Tangle', icon: '🔌', color: '#ffb400', desc: 'Grab every plug without tangling your own cable.', make: cableTangle, help: 'Steer: D-pad / arrows' },
  { id: 'surfer', name: 'Channel Surfer', icon: '🏄', color: '#00a699', desc: 'Surf the airwaves — jump the static, duck the antennas.', make: channelSurfer, help: 'Jump: A / Space / Up · Duck: Down' },
];

function GameScreen({ game, best, onScore, onExit }) {
  const ref = useRef();
  const [state, setState] = useState('play'); // play | paused | over
  const [score, setScore] = useState(0);
  // Layout effect: set up and torn down in the same moment the screen changes, so a
  // key pressed right as you leave a game can't fall between the game and the menu.
  useLayoutEffect(() => {
    document.body.classList.add('in-game');
    const c = ref.current.getContext('2d');
    c.imageSmoothingEnabled = false;
    const input = makeInput();
    let g = game.make(), raf, last = performance.now(), mode = 'play';
    const loop = (now) => {
      const dt = Math.min(3, (now - last) / 16.67); last = now;
      const k = input.read();
      if (k.pressed.back) { onExit(); return; }
      if (mode === 'over') { if (k.pressed.fire) { g = game.make(); mode = 'play'; setState('play'); } }
      else if (k.pressed.pause) { mode = mode === 'paused' ? 'play' : 'paused'; setState(mode); }
      else if (mode === 'play') { g.update(dt, k); if (g.over) { mode = 'over'; setState('over'); setScore(Math.floor(g.score)); onScore(Math.floor(g.score)); } }
      g.draw(c);
      if (mode !== 'play') { c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(0, 0, W, H); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); input.stop(); document.body.classList.remove('in-game'); };
  }, [game]);
  return html`<div class="game-screen">
    <canvas ref=${ref} width=${W} height=${H}></canvas>
    ${state !== 'play' && html`<div class="game-msg">
      <h2>${state === 'over' ? 'Game over' : 'Paused'}</h2>
      ${state === 'over' && html`<p>Score <b>${score}</b>${score >= best && score > 0 ? ' — new high score! 🏆' : ` · best ${best}`}</p>`}
      <p class="muted">${state === 'over' ? 'A / Space to play again · B / Esc to leave' : 'Menu / P to resume · B / Esc to leave'}</p></div>`}
    <div class="game-help">${game.help} · Pause: Menu / P · Leave: B / Esc</div>
  </div>`;
}

export function Arcade({ settings, setSettings, onClose }) {
  const [playing, setPlaying] = useState(null);
  const scores = settings.arcadeScores || {};
  const saveScore = (id, s) => { if (s > (scores[id] || 0)) setSettings({ arcadeScores: { ...scores, [id]: s } }); };
  // Esc on the game menu goes back to TV (handled here so it can't race a game closing;
  // a layout effect so it's listening the instant the menu is back on screen).
  useLayoutEffect(() => {
    if (playing) return;
    const key = (e) => { if ((e.key === 'Escape' || e.key === 'Backspace') && !document.body.classList.contains('in-game')) { e.preventDefault(); e.stopPropagation(); onClose(); } };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [playing]);
  if (playing) return html`<div class="overlay arcade-play"><${GameScreen} game=${playing} best=${scores[playing.id] || 0} onScore=${(s) => saveScore(playing.id, s)} onExit=${() => setPlaying(null)} /></div>`;
  return html`<div class="overlay">
    <div class="overlay-head"><h2>Arcade</h2><span class="muted" style="margin-bottom:6px">Retro games for the couch — controller or keyboard</span></div>
    <div class="overlay-body">
      <div class="arcade-grid">${GAMES.map((g) => html`<button class="arcade-card" style=${`--c:${g.color}`} onClick=${() => setPlaying(g)}>
        <div class="arcade-art"><span>${g.icon}</span></div>
        <div class="arcade-meta"><b>${g.name}</b><span>${g.desc}</span><small>${scores[g.id] ? `🏆 Best: ${scores[g.id]}` : 'No high score yet'}</small></div>
        <span class="arcade-play-btn"><${Icon.play} /> Play</span></button>`)}</div>
    </div>
  </div>`;
}
