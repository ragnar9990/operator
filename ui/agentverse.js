/* ── the Agent Verse ────────────────────────────────────────────────────
 * The Employees tab as a place: an office on a grid, floating in a galaxy.
 * Every section is a row of desks, every employee is a little robot wearing
 * its own face (avatar.js), and what it is doing is what you see it doing:
 * typing at its desk on shift, waving by it when it needs your answer,
 * dozing in its chair when it is off. Everyone is always at their own desk,
 * so coming back you find them where you left them. Crew bots, drones and
 * cleaners keep the place moving.
 *
 * Click a computer and you sit down at it: the camera flies in and the desk
 * from employees.js (conversation, to-do, work log) opens as its screen.
 * Click an empty desk to hire someone into that section.
 *
 * Nothing here owns any state. The list comes from employees.js
 * ('staff:people'), and all the work still happens in the main process.
 */

import * as THREE from './vendor/three.module.min.js';
import { EffectComposer } from './vendor/EffectComposer.js';
import { RenderPass } from './vendor/RenderPass.js';
import { UnrealBloomPass } from './vendor/UnrealBloomPass.js';
import { OutputPass } from './vendor/OutputPass.js';

const view = document.getElementById('staffView');
const root = document.getElementById('verse');
if (view && root) start();

function start() {
  const $ = (id) => document.getElementById(id);
  const canvas = $('verseCanvas');
  const tagsEl = $('verseTags');
  const tip = $('verseTip');
  const hint = $('verseHint');
  const statsEl = $('verseStats');
  const pop = $('versePop');

  const OFF = 'operator.verse.off';
  const SECTIONS = 'operator.verse.sections';
  const read = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } };

  /* ── on and off ─────────────────────────────────────────────────── */

  function setVerse(on) {
    view.classList.toggle('verse-on', on);
    if (!on) closeScreen(true);
    write(OFF, !on);
    wake();
  }
  $('verseList').addEventListener('click', () => setVerse(false));
  $('staffVerse').addEventListener('click', () => setVerse(true));

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    // No WebGL on this machine: the plain list is still all there.
    view.classList.remove('verse-on');
    $('staffVerse').hidden = true;
    return;
  }
  view.classList.toggle('verse-on', !read(OFF, false));

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03040b);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 4000);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.78);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ── little helpers ─────────────────────────────────────────────── */

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const hsl = (h, s, l) => new THREE.Color().setHSL(((h % 360) + 360) % 360 / 360, s, l);
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, ...o });
  const glow = (color, k = 1) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: false });
  const HUES = [199, 262, 152, 24, 341, 44, 288, 174];
  const hueOf = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function mesh(geo, mat, x = 0, y = 0, z = 0, shadow = true) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (shadow) { m.castShadow = true; m.receiveShadow = true; }
    return m;
  }

  function dotTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, inner);
    gr.addColorStop(0.25, inner.replace(/[\d.]+\)$/, '0.55)'));
    gr.addColorStop(1, outer);
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const DOT = dotTexture();

  // Anything built for the office is thrown away whole when the layout changes.
  function dispose(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) { if (m.map && m.map !== DOT) m.map.dispose(); m.dispose(); }
    });
  }

  /* ── space ──────────────────────────────────────────────────────── */

  const sky = new THREE.Group();
  scene.add(sky);

  // The galaxy: a spiral of stars below and behind the platform, turning slowly.
  const galaxy = (() => {
    const N = 32000, R = 420, ARMS = 4;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const inner = new THREE.Color(0xffd6a0), mid = new THREE.Color(0xff7ad9), outer = new THREE.Color(0x5b7bff);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const r = Math.pow(Math.random(), 1.7) * R;
      const a = (i % ARMS) / ARMS * Math.PI * 2 + r * 0.011;
      const spread = (k) => Math.pow(Math.random(), 2.6) * (Math.random() < 0.5 ? 1 : -1) * (10 + r * 0.22) * k;
      pos[i * 3] = Math.cos(a) * r + spread(1);
      pos[i * 3 + 1] = spread(0.22);
      pos[i * 3 + 2] = Math.sin(a) * r + spread(1);
      const t = r / R;
      if (t < 0.35) c.copy(inner).lerp(mid, t / 0.35); else c.copy(mid).lerp(outer, (t - 0.35) / 0.65);
      c.multiplyScalar(0.55 + Math.random() * 0.6);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
      size: 2.4, map: DOT, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const grp = new THREE.Group();
    grp.add(pts);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture('rgba(255,214,170,1)'), color: 0xffc58a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }));
    core.scale.set(160, 160, 1);
    grp.add(core);
    grp.position.set(40, -170, -260);
    grp.rotation.set(0.42, 0, 0.12);
    sky.add(grp);
    return grp;
  })();

  // Far stars all round, and a few clouds of colour.
  (() => {
    const N = 6000;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const v = V(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(900, 1500));
      pos.set([v.x, v.y, v.z], i * 3);
      c.setHSL(rand(0.55, 0.7), rand(0.2, 0.6), rand(0.55, 0.95));
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    sky.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 5, map: DOT, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));

    const clouds = [['rgba(140,90,255,0.5)', V(-700, 160, -800), 900], ['rgba(40,190,255,0.4)', V(800, 60, -600), 800],
      ['rgba(255,80,170,0.35)', V(200, -300, 900), 1000], ['rgba(70,120,255,0.35)', V(-900, -120, 500), 900]];
    for (const [rgba, p, s] of clouds) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(rgba, 'rgba(0,0,0,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
      sp.position.copy(p);
      sp.scale.set(s, s, 1);
      sky.add(sp);
    }

    // A ringed planet off to one side.
    const pc = document.createElement('canvas');
    pc.width = 256; pc.height = 128;
    const pg = pc.getContext('2d');
    for (let y = 0; y < 128; y++) {
      pg.fillStyle = `hsl(${250 + Math.sin(y * 0.19) * 18}, 45%, ${28 + Math.sin(y * 0.07) * 10 + Math.random() * 4}%)`;
      pg.fillRect(0, y, 256, 1);
    }
    const tex = new THREE.CanvasTexture(pc);
    tex.colorSpace = THREE.SRGBColorSpace;
    const planet = new THREE.Mesh(new THREE.SphereGeometry(70, 48, 32), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 }));
    planet.position.set(-520, 150, 220);
    const ring = new THREE.Mesh(new THREE.RingGeometry(95, 150, 96), new THREE.MeshBasicMaterial({ color: 0xb9a8ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = Math.PI / 2.4;
    planet.add(ring);
    sky.add(planet);
  })();

  // Shooting stars, now and then.
  const meteors = [];
  function meteor() {
    const from = V(rand(-600, 600), rand(80, 260), rand(-700, -300));
    const dir = V(rand(-1, 1), rand(-0.5, -0.2), rand(-0.2, 0.4)).normalize();
    const g = new THREE.BufferGeometry().setFromPoints([V(0, 0, 0), dir.clone().multiplyScalar(-40)]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xcfe3ff, transparent: true, opacity: 1 }));
    l.position.copy(from);
    sky.add(l);
    meteors.push({ l, dir, life: 1.4 });
  }

  /* ── light ──────────────────────────────────────────────────────── */

  scene.add(new THREE.HemisphereLight(0x8fa8ff, 0x24103a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1e0, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const rim = new THREE.DirectionalLight(0x7a5cff, 0.9);
  rim.position.set(-60, 20, 80);
  scene.add(rim);

  /* ── the grid floor shader ──────────────────────────────────────── */

  const gridMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x3a8dff) }, uCenter: { value: new THREE.Vector2() } },
    vertexShader: `
      varying vec2 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uColor; uniform vec2 uCenter;
      varying vec2 vW;
      float grid(vec2 p, float cell) {
        vec2 q = p / cell;
        vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = grid(vW, 1.0);
        float major = grid(vW, 5.0);
        float d = length(vW - uCenter);
        float wave = exp(-pow(d - mod(uTime * 9.0, 90.0), 2.0) / 10.0);
        float a = minor * 0.13 + major * 0.32 + wave * (minor + major) * 0.55;
        gl_FragColor = vec4(uColor * (0.8 + wave * 1.6), a);
      }`,
  });

  /* ── robots ─────────────────────────────────────────────────────── */

  function roundedRect(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  const extrude = (shape, depth, bevel) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 10 });
    g.center();
    return g;
  };

  const HEADS = {
    squircle: () => extrude(roundedRect(0.5, 0.46, 0.16), 0.32, 0.08),
    round: () => new THREE.SphereGeometry(0.31, 28, 20),
    dome: () => {
      const pts = [];
      for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI / 2; pts.push(new THREE.Vector2(Math.cos(a) * 0.32, 0.02 + Math.sin(a) * 0.3)); }
      pts.unshift(new THREE.Vector2(0.3, -0.24), new THREE.Vector2(0.32, -0.2));
      pts.unshift(new THREE.Vector2(0, -0.24));
      const g = new THREE.LatheGeometry(pts.reverse(), 28);
      g.translate(0, -0.03, 0);
      return g;
    },
    shield: () => {
      const s = new THREE.Shape();
      s.moveTo(0, 0.3); s.lineTo(0.27, 0.2); s.lineTo(0.27, 0.0);
      s.quadraticCurveTo(0.26, -0.22, 0, -0.32); s.quadraticCurveTo(-0.26, -0.22, -0.27, 0.0);
      s.lineTo(-0.27, 0.2); s.closePath();
      return extrude(s, 0.3, 0.07);
    },
  };

  // One robot, built from an avatar face ({ hue, shape, accessory }).
  function makeBot(face, o = {}) {
    const f = face || { hue: 199, shape: 'squircle', accessory: 'none' };
    const crew = Boolean(o.crew);
    const body = crew ? std(0xdfe4ee, { metalness: 0.35, roughness: 0.35 }) : std(hsl(f.hue, 0.5, 0.62), { roughness: 0.38, metalness: 0.2 });
    const dark = std(crew ? 0x3a4150 : hsl(f.hue, 0.28, 0.2), { metalness: 0.5, roughness: 0.45 });
    const eyeMat = glow(0xffffff, 1.6);
    const bot = new THREE.Group();

    const hips = new THREE.Group();
    hips.position.y = 0.5;
    bot.add(hips);
    const legGeo = new THREE.CapsuleGeometry(0.075, 0.34, 4, 8);
    legGeo.translate(0, -0.24, 0);
    const legL = mesh(legGeo, dark, -0.12, 0, 0);
    const legR = mesh(legGeo, dark, 0.12, 0, 0);
    hips.add(legL, legR);

    const torso = new THREE.Group();
    hips.add(torso);
    torso.add(mesh(new THREE.CapsuleGeometry(0.24, 0.28, 6, 14), crew ? dark : body, 0, 0.34, 0));
    const chest = mesh(new THREE.CircleGeometry(0.07, 18), glow(crew ? 0x6fd3ff : hsl(f.hue, 0.9, 0.6), 1.8), 0, 0.4, 0.245, false);
    torso.add(chest);

    const armGeo = new THREE.CapsuleGeometry(0.06, 0.3, 4, 8);
    armGeo.translate(0, -0.2, 0);
    const armL = mesh(armGeo, dark, -0.32, 0.56, 0);
    const armR = mesh(armGeo, dark, 0.32, 0.56, 0);
    torso.add(armL, armR);

    const head = new THREE.Group();
    head.position.y = 0.98;
    torso.add(head);
    const skull = mesh((HEADS[f.shape] || HEADS.squircle)(), crew ? body : body, 0, 0, 0);
    head.add(skull);
    const plate = mesh(new THREE.ShapeGeometry(roundedRect(0.38, 0.22, 0.09)), std(0x0a0d18, { roughness: 0.25, metalness: 0.6 }), 0, -0.01, 0.245, false);
    head.add(plate);
    const eyeGeo = new THREE.CapsuleGeometry(0.028, 0.05, 4, 8);
    const eyeL = mesh(eyeGeo, eyeMat, -0.08, -0.01, 0.255, false);
    const eyeR = mesh(eyeGeo, eyeMat, 0.08, -0.01, 0.255, false);
    head.add(eyeL, eyeR);
    // Sphere and dome heads are rounder at the front.
    if (f.shape === 'round' || f.shape === 'dome') { plate.position.z = 0.27; eyeL.position.z = eyeR.position.z = 0.28; }

    const acc = hsl(f.hue, 0.9, 0.6);
    switch (crew ? 'visor' : f.accessory) {
      case 'antenna': {
        head.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2), dark, 0, 0.36, 0));
        head.add(mesh(new THREE.SphereGeometry(0.045, 12, 10), glow(acc, 2), 0, 0.48, 0, false));
        break;
      }
      case 'visor': {
        const v = mesh(new THREE.BoxGeometry(0.42, 0.07, 0.04), glow(crew ? 0x6fd3ff : acc, 1.6), 0, 0.03, 0.27, false);
        head.add(v);
        eyeL.visible = eyeR.visible = false;
        break;
      }
      case 'bolt': {
        const s = new THREE.Shape();
        s.moveTo(0.02, 0.09); s.lineTo(-0.05, 0); s.lineTo(0.0, 0); s.lineTo(-0.02, -0.09); s.lineTo(0.05, 0.01); s.lineTo(0.0, 0.01); s.closePath();
        head.add(mesh(new THREE.ShapeGeometry(s), glow(0xffd24a, 2), 0, 0.16, 0.26, false));
        break;
      }
      case 'sprout': {
        head.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16), std(0x3f9a4e), 0, 0.36, 0));
        const leaf = mesh(new THREE.SphereGeometry(0.07, 12, 8), std(0x57d06a, { emissive: 0x1d5a26 }), 0.06, 0.45, 0);
        leaf.scale.set(1.3, 0.5, 0.8);
        head.add(leaf);
        break;
      }
      case 'halo': {
        const h = mesh(new THREE.TorusGeometry(0.2, 0.018, 8, 32), glow(0xffe08a, 2), 0, 0.42, 0, false);
        h.rotation.x = Math.PI / 2;
        head.add(h);
        break;
      }
      case 'ears': {
        head.add(mesh(new THREE.SphereGeometry(0.075, 14, 10), dark, -0.33, 0, 0));
        head.add(mesh(new THREE.SphereGeometry(0.075, 14, 10), dark, 0.33, 0, 0));
        break;
      }
      default: break;
    }

    // A soft shadow-ish disc so it sits on the floor even out of the sun.
    const foot = mesh(new THREE.CircleGeometry(0.34, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }), 0, 0.015, 0, false);
    foot.rotation.x = -Math.PI / 2;
    bot.add(foot);

    // What clicks land on: one plain box, not every part.
    const hit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.9, 0.8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.95;
    bot.add(hit);

    bot.userData.parts = { hips, legL, legR, torso, armL, armR, head, eyeL, eyeR, eyeMat, chest };
    bot.userData.hit = hit;
    bot.scale.setScalar(o.scale || 1);
    return bot;
  }

  // Poses. `t` is time, `a` the actor's own phase so nobody moves in lockstep.
  function pose(actor, dt, t) {
    const p = actor.obj.userData.parts;
    const ph = t * 1 + actor.phase;
    const mix = (cur, want, k = 10) => cur + (want - cur) * Math.min(1, dt * k);
    let legs = 0, armL = 0, armR = 0, lean = 0, hipsY = 0.5, headTilt = 0, headTurn = 0, bob = 0, armSpread = 0;
    switch (actor.anim) {
      case 'walk': {
        const s = Math.sin(t * 9 + actor.phase);
        legs = s * 0.65; armL = -s * 0.55; armR = s * 0.55; bob = Math.abs(Math.cos(t * 9 + actor.phase)) * 0.05;
        break;
      }
      case 'type': case 'type-slow': {
        const fast = actor.anim === 'type';
        legs = -1.45; hipsY = 0.5; lean = 0.12;
        armL = -1.15 + Math.sin(t * (fast ? 22 : 6) + actor.phase) * (fast ? 0.12 : 0.05);
        armR = -1.15 + Math.sin(t * (fast ? 19 : 5) + actor.phase + 1.3) * (fast ? 0.12 : 0.05);
        headTilt = 0.1 + (fast ? Math.sin(t * 2.3 + actor.phase) * 0.03 : Math.sin(t * 0.7 + actor.phase) * 0.06);
        headTurn = fast ? 0 : Math.sin(t * 0.4 + actor.phase) * 0.35;
        break;
      }
      case 'rest': { // off shift: leaned back in the chair, nodding off
        legs = -1.45; lean = -0.22; armL = -0.5; armR = -0.5;
        headTilt = 0.38 + Math.sin(ph * 0.5) * 0.06; headTurn = 0.15;
        break;
      }
      case 'sofa': {
        legs = -1.45; hipsY = 0.44; lean = -0.2; armL = -0.35; armR = -0.35;
        headTilt = -0.12 + Math.sin(ph * 0.5) * 0.05; headTurn = Math.sin(ph * 0.25) * 0.5;
        break;
      }
      case 'wave': {
        armR = -2.7 + Math.sin(t * 8 + actor.phase) * 0.35; armSpread = 0.35;
        headTilt = -0.15; bob = Math.abs(Math.sin(t * 4)) * 0.04;
        break;
      }
      case 'coffee': {
        armR = -1.3 + Math.sin(ph * 0.8) * 0.15; headTurn = Math.sin(ph * 0.3) * 0.4; headTilt = Math.sin(ph * 0.6) * 0.05;
        break;
      }
      default: { // idle: breathe, look about
        headTurn = Math.sin(ph * 0.4) * 0.5; headTilt = Math.sin(ph * 0.3) * 0.06; bob = Math.sin(ph * 1.6) * 0.01;
      }
    }
    // Walking swings the legs in turn; sitting bends both forward.
    p.legL.rotation.x = mix(p.legL.rotation.x, legs);
    p.legR.rotation.x = mix(p.legR.rotation.x, actor.anim === 'walk' ? -legs : legs);
    p.armL.rotation.x = mix(p.armL.rotation.x, armL);
    p.armR.rotation.x = mix(p.armR.rotation.x, armR);
    p.armR.rotation.z = mix(p.armR.rotation.z, armSpread);
    p.torso.rotation.x = mix(p.torso.rotation.x, lean, 6);
    p.hips.position.y = mix(p.hips.position.y, hipsY + bob, 12);
    p.head.rotation.x = mix(p.head.rotation.x, headTilt, 5);
    p.head.rotation.y = mix(p.head.rotation.y, headTurn, 3);
    // Blink.
    const blink = (Math.sin(t * 0.9 + actor.phase * 3) > 0.985) ? 0.15 : 1;
    p.eyeL.scale.y = p.eyeR.scale.y = mix(p.eyeL.scale.y, blink, 30);
  }

  /* ── the office ─────────────────────────────────────────────────── */

  const W = 13;          // a section's width
  const ROW = 3.6;       // desk row spacing
  const LANE = 3.2;      // half the corridor's width
  const COLS = [-4.2, 0, 4.2];
  const AISLES = [-2.1, 2.1];
  const GAP = 2.2;       // between sections

  let office = null;     // THREE.Group for everything below
  let layoutKey = '';
  let sections = [];     // [{ name, hue, group, desks: [...], sign, ... }]
  let spots = {};        // named places: lounge seats, coffee, hub points
  let pickables = [];    // hit boxes: { mesh.userData.pick = {...} }
  let bounds = { x0: 0, x1: 0, z0: 0, z1: 0 };
  let solidMeshes = [];  // what you can't walk through: desks, walls, furniture
  let solids = [];       // …as flat boxes on the floor, { x0, x1, z0, z1 }
  const screens = [];    // desks with a screen to redraw
  const world = new THREE.Group();   // floats gently; everything on the platform lives in here
  scene.add(world);

  function sectionNames(people) {
    const saved = read(SECTIONS, null) || ['General', 'Inbox', 'Research', 'Sales'];
    const out = [];
    const add = (n) => { const k = String(n || '').trim() || 'General'; if (!out.some((x) => x.toLowerCase() === k.toLowerCase())) out.push(k); };
    saved.forEach(add);
    people.forEach((p) => add(p.section));
    return out;
  }
  const sectionOf = (p) => (sections.find((s) => s.name.toLowerCase() === (String(p.section || '').trim() || 'General').toLowerCase()));

  // Where each section goes: two rows either side of one long corridor.
  function plan(people) {
    const names = sectionNames(people);
    const byName = {};
    for (const p of people) {
      const k = (String(p.section || '').trim() || 'General').toLowerCase();
      byName[k] = (byName[k] || 0) + 1;
    }
    return names.map((name, i) => {
      const n = byName[name.toLowerCase()] || 0;
      const rows = Math.max(2, Math.ceil((n + 1) / COLS.length));
      return { name, i, rows, depth: rows * ROW + 1.6, col: Math.floor(i / 2), north: i % 2 === 0 };
    });
  }

  function build(people) {
    const p = plan(people);
    const key = p.map((s) => s.name + ':' + s.rows).join('|');
    if (key === layoutKey && office) return false;
    layoutKey = key;
    if (office) { world.remove(office); dispose(office); }
    office = new THREE.Group();
    world.add(office);
    sections = [];
    pickables = [];
    screens.length = 0;
    spots = {};
    solidMeshes = [];

    const cols = Math.max(1, Math.ceil(p.length / 2));
    const HUB = 16;                         // the lobby at the west end
    const LOUNGE = 16;                      // the lounge at the east end
    const x0 = -HUB;
    const secX = (c) => c * (W + GAP) + W / 2;
    const x1 = cols * (W + GAP) - GAP + LOUNGE;
    const maxDepth = Math.max(...p.map((s) => s.depth), 9);
    bounds = { x0: x0 - 2, x1: x1 + 2, z0: -(LANE + maxDepth + 2), z1: LANE + maxDepth + 2 };

    // The platform itself.
    const pw = bounds.x1 - bounds.x0, pd = bounds.z1 - bounds.z0;
    const cx = (bounds.x0 + bounds.x1) / 2;
    const slab = mesh(new THREE.BoxGeometry(pw, 0.8, pd), std(0x0b1020, { metalness: 0.7, roughness: 0.32 }), cx, -0.4, 0);
    slab.castShadow = false;
    office.add(slab);
    const gridPlane = new THREE.Mesh(new THREE.PlaneGeometry(pw, pd), gridMat);
    gridPlane.rotation.x = -Math.PI / 2;
    gridPlane.position.set(cx, 0.012, 0);
    office.add(gridPlane);
    gridMat.uniforms.uCenter.value.set(cx, 0);

    // Glowing edges, and the hull and engine underneath.
    const edge = glow(0x4aa8ff, 2.2);
    for (const [w, d, x, z] of [[pw, 0.12, cx, bounds.z0], [pw, 0.12, cx, bounds.z1], [0.12, pd, bounds.x0, 0], [0.12, pd, bounds.x1, 0]]) {
      office.add(mesh(new THREE.BoxGeometry(w, 0.12, d), edge, x, 0.02, z, false));
      office.add(mesh(new THREE.BoxGeometry(w, 0.05, d), glow(0x7a5cff, 1.6), x, -0.78, z, false));
    }
    // A square frustum: turned in the geometry, so the scale stretches it along the platform's own sides.
    const hull = mesh(new THREE.CylinderGeometry(1, 0.28, 1, 4, 1).rotateY(Math.PI / 4), std(0x1a2140, { metalness: 0.7, roughness: 0.45, emissive: 0x0c1230 }), cx, -3.8, 0);
    hull.scale.set(pw * 0.68, 6, pd * 0.68);
    hull.castShadow = false;
    office.add(hull);
    const engine = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture('rgba(120,170,255,1)'), color: 0x88b4ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    engine.position.set(cx, -8, 0);
    engine.scale.set(22, 22, 1);
    office.add(engine);
    office.add(mesh(new THREE.SphereGeometry(1.4, 24, 16), glow(0x9cc4ff, 3), cx, -7.4, 0, false));
    const orbit = mesh(new THREE.TorusGeometry(Math.max(pw, pd) * 0.42, 0.08, 8, 128), glow(0x5f7dff, 1.4), cx, -5.5, 0, false);
    orbit.rotation.x = Math.PI / 2;
    orbit.userData.spin = 0.05;
    office.add(orbit);

    // Corridor: a lit runway down the middle.
    const run = mesh(new THREE.PlaneGeometry(x1 - x0, LANE * 2 - 0.6), new THREE.MeshStandardMaterial({ color: 0x121a33, roughness: 0.6, metalness: 0.4, transparent: true, opacity: 0.7 }), (x0 + x1) / 2, 0.02, 0, false);
    run.rotation.x = -Math.PI / 2;
    run.receiveShadow = true;
    office.add(run);
    for (let x = x0 + 2; x < x1 - 1; x += 2.5) {
      for (const z of [-LANE + 0.5, LANE - 0.5]) {
        const l = mesh(new THREE.PlaneGeometry(0.9, 0.08), glow(0x4aa8ff, 1.4), x, 0.03, z, false);
        l.rotation.x = -Math.PI / 2;
        office.add(l);
      }
    }

    p.forEach((s) => buildSection(s, secX(s.col)));
    buildHub(x0 + HUB / 2 - 1);
    buildLounge(x1 - LOUNGE / 2 + 1);
    buildRocks(cx, Math.max(pw, pd));

    // The sun follows the size of the place so shadows stay sharp.
    sun.position.set(cx + 30, 60, 40);
    sun.target.position.set(cx, 0, 0);
    const half = Math.max(pw, pd) * 0.62;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 200 });
    sun.shadow.camera.updateProjectionMatrix();

    office.updateMatrixWorld(true);
    const box = new THREE.Box3();
    solids = solidMeshes.map((m) => {
      box.setFromObject(m);
      const pad = 0.06 - (m.userData.shrink || 0);
      return { x0: box.min.x - pad, x1: box.max.x + pad, z0: box.min.z - pad, z1: box.max.z + pad };
    });
    return true;
  }

  // Section `s` centred at x `sx`. Local +z points at the corridor; the north
  // row faces south and the south row is turned round to face north.
  function buildSection(s, sx) {
    const hue = hueOf(s.name);
    const tint = hsl(hue, 0.75, 0.55);
    const g = new THREE.Group();
    g.position.set(sx, 0, s.north ? -LANE : LANE);
    g.rotation.y = s.north ? 0 : Math.PI;
    office.add(g);
    const D = s.depth;

    // Floor pad and low glass walls on three sides.
    const pad = mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: hsl(hue, 0.35, 0.1), roughness: 0.5, metalness: 0.5, transparent: true, opacity: 0.85 }), 0, 0.02, -D / 2, false);
    pad.rotation.x = -Math.PI / 2;
    pad.receiveShadow = true;
    g.add(pad);
    const glass = new THREE.MeshStandardMaterial({ color: tint, transparent: true, opacity: 0.12, roughness: 0.1, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide });
    const trim = glow(tint, 1.8);
    for (const [w, x, z, ry] of [[W, 0, -D, 0], [D, -W / 2, -D / 2, Math.PI / 2], [D, W / 2, -D / 2, Math.PI / 2]]) {
      const pane = mesh(new THREE.PlaneGeometry(w, 1.1), glass, x, 0.55, z, false);
      pane.rotation.y = ry;
      g.add(pane);
      solidMeshes.push(pane);
      const t = mesh(new THREE.BoxGeometry(w, 0.05, 0.05), trim, x, 1.1, z, false);
      t.rotation.y = ry;
      g.add(t);
    }
    // Front corners: a lit post each side of the way in.
    for (const x of [-W / 2, W / 2]) g.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.2, 10), trim, x, 0.6, 0, false));

    // The sign: a hologram over the back wall.
    const sign = holoSign(s.name, tint);
    sign.position.set(0, 3.3, -D + 0.2);
    g.add(sign);
    const signHit = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.6), new THREE.MeshBasicMaterial({ visible: false }));
    signHit.userData.pick = { type: 'sign', section: s.name };
    sign.add(signHit);
    pickables.push(signHit);

    const sec = { name: s.name, hue, tint, group: g, desks: [], north: s.north, sx, sign, depth: D };
    const mats = {
      top: std(0xe6e9f2, { roughness: 0.35, metalness: 0.1 }),
      leg: std(0x1a2033, { metalness: 0.6, roughness: 0.35 }),
      chair: std(hsl(hue, 0.4, 0.22), { roughness: 0.6 }),
      bezel: std(0x0b0e18, { metalness: 0.6, roughness: 0.3 }),
      strip: glow(tint, 2),
    };
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < COLS.length; c++) sec.desks.push(buildDesk(sec, g, COLS[c], -2.6 - r * ROW, mats, sec.desks.length));
    }
    sections.push(sec);
  }

  function holoSign(text, tint) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const x = c.getContext('2d');
    x.font = '600 64px Inter, "Segoe UI", sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.shadowColor = '#' + tint.getHexString();
    x.shadowBlur = 18;
    x.fillStyle = '#ffffff';
    x.fillText(text.toUpperCase(), 256, 58, 480);
    x.fillStyle = '#' + tint.getHexString();
    x.fillRect(96, 104, 320, 4);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, opacity: 0.95 }));
    return m;
  }

  function buildDesk(sec, g, x, z, mats, index) {
    const d = new THREE.Group();
    d.position.set(x, 0, z);
    g.add(d);
    // Table.
    d.add(mesh(new THREE.BoxGeometry(1.8, 0.06, 0.9), mats.top, 0, 0.78, 0));
    for (const lx of [-0.84, 0.84]) d.add(mesh(new THREE.BoxGeometry(0.06, 0.76, 0.8), mats.leg, lx, 0.38, 0));
    d.add(mesh(new THREE.BoxGeometry(1.7, 0.03, 0.03), mats.strip, 0, 0.74, 0.45, false));
    // Monitor, facing the chair (+z).
    d.add(mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.28), mats.leg, 0, 0.94, -0.28));
    d.add(mesh(new THREE.BoxGeometry(0.34, 0.02, 0.2), mats.leg, 0, 0.815, -0.28));
    const bezel = mesh(new THREE.BoxGeometry(1.02, 0.62, 0.05), mats.bezel, 0, 1.36, -0.3);
    d.add(bezel);
    const sc = document.createElement('canvas');
    sc.width = 320; sc.height = 192;
    const tex = new THREE.CanvasTexture(sc);
    tex.colorSpace = THREE.SRGBColorSpace;
    const screen = mesh(new THREE.PlaneGeometry(0.94, 0.55), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), 0, 1.36, -0.272, false);
    d.add(screen);
    const light = mesh(new THREE.PlaneGeometry(1.4, 0.9), new THREE.MeshBasicMaterial({ map: DOT, color: sec.tint, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending }), 0, 0.8, 0.1, false);
    light.rotation.x = -Math.PI / 2;
    d.add(light);
    // Keyboard, and a mug or a plant on some.
    d.add(mesh(new THREE.BoxGeometry(0.52, 0.025, 0.17), mats.bezel, 0, 0.825, 0.12));
    if (index % 3 === 1) d.add(mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.1, 14), std(pick([0xf2f2f2, 0xff8a5c, 0x6fc3ff])), 0.62, 0.86, 0.1));
    if (index % 4 === 2) plant(d, -0.7, 0.81, -0.2, 0.55);

    // Chair, behind the desk.
    const chair = new THREE.Group();
    chair.position.set(0, 0, 0.85);
    chair.add(mesh(new THREE.BoxGeometry(0.52, 0.08, 0.5), mats.chair, 0, 0.47, 0));
    chair.add(mesh(new THREE.BoxGeometry(0.52, 0.6, 0.07), mats.chair, 0, 0.82, 0.25));
    chair.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.4), mats.leg, 0, 0.23, 0));
    chair.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 12), mats.leg, 0, 0.03, 0));
    d.add(chair);

    // The empty-desk marker: a turning ring with a plus, over the chair.
    const vacant = new THREE.Group();
    vacant.position.set(0, 1.25, 0.85);
    const ring = mesh(new THREE.TorusGeometry(0.28, 0.02, 8, 40), glow(sec.tint, 2.2), 0, 0, 0, false);
    vacant.add(ring);
    vacant.add(mesh(new THREE.BoxGeometry(0.28, 0.04, 0.02), glow(sec.tint, 2.2), 0, 0, 0, false));
    vacant.add(mesh(new THREE.BoxGeometry(0.04, 0.28, 0.02), glow(sec.tint, 2.2), 0, 0, 0, false));
    d.add(vacant);

    const hit = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.8, 2.1), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(0, 0.9, 0.35);
    d.add(hit);
    // The click box is roomier than the desk and chair; walking round it, less so.
    hit.userData.shrink = 0.25;
    solidMeshes.push(hit);
    const desk = { sec, group: d, screen, tex, canvas: sc, light, vacant, hit, who: null, drawn: '', index };
    hit.userData.pick = { type: 'desk', desk };
    pickables.push(hit);
    screens.push(desk);
    return desk;
  }

  function plant(parent, x, y, z, s = 1) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.scale.setScalar(s);
    g.add(mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.36, 14), std(0xe8e2d8), 0, 0.18, 0));
    const leaf = std(0x3fb86a, { roughness: 0.7, emissive: 0x0b2a14 });
    for (let i = 0; i < 5; i++) {
      const l = mesh(new THREE.IcosahedronGeometry(0.2, 0), leaf, rand(-0.12, 0.12), 0.5 + i * 0.12, rand(-0.12, 0.12));
      l.scale.set(1, 1.4, 1);
      l.rotation.set(rand(0, 3), rand(0, 3), 0);
      g.add(l);
    }
    parent.add(g);
    return g;
  }

  // The lobby, west: a holo-globe, the teleporter new hires beam in on, and an
  // ops desk the crew keeps.
  function buildHub(hx) {
    const g = new THREE.Group();
    g.position.set(hx, 0, 0);
    office.add(g);
    const pad = mesh(new THREE.CircleGeometry(7.5, 64), new THREE.MeshStandardMaterial({ color: 0x101a36, roughness: 0.4, metalness: 0.6, transparent: true, opacity: 0.8 }), 0, 0.025, 0, false);
    pad.rotation.x = -Math.PI / 2;
    pad.receiveShadow = true;
    g.add(pad);
    const rim = mesh(new THREE.TorusGeometry(7.5, 0.05, 8, 96), glow(0x6f8cff, 2), 0, 0.03, 0, false);
    rim.rotation.x = Math.PI / 2;
    g.add(rim);

    // Holo-globe.
    const pedestal = mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.9, 24), std(0x1a2240, { metalness: 0.7, roughness: 0.3 }), 0, 0.45, 0);
    g.add(pedestal);
    solidMeshes.push(pedestal);
    g.add(mesh(new THREE.TorusGeometry(0.95, 0.04, 8, 48), glow(0x4aa8ff, 2), 0, 0.9, 0, false).rotateX(Math.PI / 2));
    const globe = new THREE.Group();
    globe.position.y = 2.4;
    globe.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5fb8ff).multiplyScalar(1.6), wireframe: true, transparent: true, opacity: 0.55, toneMapped: false })));
    globe.add(new THREE.Mesh(new THREE.SphereGeometry(0.7, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x8a6bff).multiplyScalar(1.2), transparent: true, opacity: 0.35, toneMapped: false })));
    const band = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.02, 6, 64), glow(0xff7ad9, 2));
    band.rotation.x = 1.2;
    globe.add(band);
    globe.userData.spin = 0.4;
    g.add(globe);
    const beamUp = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 2.4, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    beamUp.position.y = 2.1;
    g.add(beamUp);

    // Teleporter.
    const tp = new THREE.Group();
    tp.position.set(-3.6, 0, 3.4);
    tp.add(mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.14, 32), std(0x1a2240, { metalness: 0.8, roughness: 0.25 }), 0, 0.07, 0));
    const tpRing = mesh(new THREE.TorusGeometry(0.95, 0.05, 8, 48), glow(0x6fffd8, 2.4), 0, 0.16, 0, false);
    tpRing.rotation.x = Math.PI / 2;
    tp.add(tpRing);
    const tpBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 3.4, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x6fffd8, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    tpBeam.position.y = 1.8;
    tp.add(tpBeam);
    g.add(tp);
    spots.teleport = { p: V(hx - 3.6, 0, 3.4) };
    spots.teleBeam = tpBeam;

    // Ops desk: three crew bots always at it.
    spots.ops = [];
    const mats = { top: std(0xe6e9f2, { roughness: 0.35 }), leg: std(0x1a2033, { metalness: 0.6 }), chair: std(0x2a3350), bezel: std(0x0b0e18, { metalness: 0.6 }), strip: glow(0x6fffd8, 2) };
    const fake = { tint: new THREE.Color(0x6fffd8), name: 'Ops' };
    for (let i = 0; i < 3; i++) {
      const a = -0.5 + i * 0.5;
      const dg = new THREE.Group();
      dg.position.set(Math.sin(a) * 4.8 + 1.2, 0, -Math.cos(a) * 4.8);
      dg.rotation.y = -a + Math.PI;
      g.add(dg);
      const desk = buildDesk(fake, dg, 0, 0, mats, i);
      desk.vacant.visible = false;
      desk.npc = true;
      pickables.splice(pickables.indexOf(desk.hit), 1);
      const seat = new THREE.Vector3(0, 0, 0.85).applyMatrix4(new THREE.Matrix4().makeRotationY(dg.rotation.y)).add(dg.position).add(g.position);
      spots.ops.push({ p: seat, face: dg.rotation.y + Math.PI, desk });
    }

    buildBoard(g, hx);

    spots.hub = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      spots.hub.push({ p: V(hx + Math.cos(a) * 3.2, 0, Math.sin(a) * 3.2), face: a + Math.PI / 2 });
    }
    spots.hubX = hx;
  }

  // The board over the ops desks: what everyone is doing, live. It turns to
  // face you like the section signs do.
  function buildBoard(g, hx) {
    const stand = new THREE.Group();
    stand.position.set(1.2, 0, -6.7);
    g.add(stand);
    const postMat = std(0x1a2240, { metalness: 0.8, roughness: 0.3 });
    for (const x of [-2.6, 2.6]) {
      const post = mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.6, 10), postMat, x, 1.3, 0);
      stand.add(post);
      solidMeshes.push(post);
    }
    stand.add(mesh(new THREE.BoxGeometry(5.4, 0.06, 0.06), glow(0x6fffd8, 2), 0, 2.55, 0, false));
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 640;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(7, 4.375), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false }));
    face.position.set(0, 4.8, 0);
    stand.add(face);
    const hit = new THREE.Mesh(new THREE.PlaneGeometry(7, 4.375), new THREE.MeshBasicMaterial({ visible: false }));
    hit.userData.pick = { type: 'board' };
    face.add(hit);
    pickables.push(hit);
    spots.board = { face, canvas: c, tex, drawn: '' };
  }

  // What each person is up to, in two short lines.
  function doing(p) {
    const a = actors.get(p.id);
    const mode = a ? a.mode : want(p);
    const open = (p.tasks || []).filter((x) => !x.done);
    const last = (p.log || [])[p.log && p.log.length - 1];
    const state = statusText(p) || (mode === 'rest' ? 'Off shift' : 'On shift');
    let detail;
    if (mode === 'type') detail = open.length ? 'On: ' + open[0].text : 'Doing a check-in';
    else if (mode === 'type-slow') detail = 'About to answer your message';
    else if (mode === 'wave') detail = 'Asked you something — go and see';
    else if (last && last.summary) detail = 'Last: ' + last.summary;
    else if (open.length) detail = 'Next up: ' + open[0].text;
    else detail = 'Nothing on the list yet';
    const kind = mode === 'type' || mode === 'type-slow' ? 'busy' : mode === 'wave' ? 'ask' : mode === 'desk' ? 'on' : 'off';
    return { state, detail, kind };
  }

  const KIND_COLOR = { busy: '#299fff', ask: '#f0a12e', on: '#46d17f', off: '#6f7697' };
  function fit(c, text, w) {
    let t = String(text || '');
    if (c.measureText(t).width <= w) return t;
    while (t.length > 1 && c.measureText(t + '…').width > w) t = t.slice(0, -1);
    return t + '…';
  }

  function drawBoard(t) {
    const b = spots.board;
    if (!b) return;
    const rows = people.map((p) => ({ p, ...doing(p) }));
    // Busy and waiting first: that is what you look at the board for.
    const order = { ask: 0, busy: 1, on: 2, off: 3 };
    rows.sort((x, y) => order[x.kind] - order[y.kind]);
    const key = rows.map((r) => r.p.name + r.state + r.detail + r.kind + (r.p.unread || 0)).join('|') + Math.floor(t * 2) % 2;
    if (key === b.drawn) return;
    b.drawn = key;
    const c = b.canvas.getContext('2d');
    const W = b.canvas.width, H = b.canvas.height;
    c.clearRect(0, 0, W, H);
    // Glass panel.
    c.fillStyle = 'rgba(6, 12, 28, 0.86)';
    c.beginPath(); c.roundRect(8, 8, W - 16, H - 16, 28); c.fill();
    c.strokeStyle = 'rgba(111, 255, 216, 0.55)'; c.lineWidth = 3; c.stroke();
    // Header.
    c.fillStyle = '#6fffd8';
    c.font = '700 40px Inter, "Segoe UI", sans-serif';
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.fillText("WHAT EVERYONE'S DOING", 44, 62);
    c.textAlign = 'right';
    c.fillStyle = Math.floor(t * 2) % 2 ? '#ff5c7a' : '#8a2b3c';
    c.beginPath(); c.arc(W - 150, 62, 9, 0, 7); c.fill();
    c.fillStyle = '#a9b3d6'; c.font = '600 26px Inter, sans-serif';
    c.fillText('LIVE', W - 44, 63);
    c.fillStyle = 'rgba(111, 255, 216, 0.25)'; c.fillRect(44, 100, W - 88, 2);

    if (!rows.length) {
      c.textAlign = 'center'; c.fillStyle = '#c6cde8'; c.font = '500 32px Inter, sans-serif';
      c.fillText('Nobody hired yet.', W / 2, H / 2 - 10);
      c.fillStyle = '#8f99bd'; c.font = '400 26px Inter, sans-serif';
      c.fillText('Walk up to a glowing + desk and press E to hire.', W / 2, H / 2 + 36);
    }
    const MAX = 6, ROWH = 84;
    rows.slice(0, MAX).forEach((r, i) => {
      const y = 126 + i * ROWH;
      c.textAlign = 'left';
      c.fillStyle = KIND_COLOR[r.kind];
      c.beginPath(); c.arc(58, y + 22, 10, 0, 7); c.fill();
      c.fillStyle = '#ffffff'; c.font = '700 32px Inter, sans-serif';
      const name = fit(c, r.p.name, 230);
      c.fillText(name, 84, y + 22);
      const nameW = c.measureText(name).width;
      c.fillStyle = '#8f99bd'; c.font = '500 22px Inter, sans-serif';
      c.fillText(fit(c, r.p.section || 'General', 160), 84 + nameW + 14, y + 24);
      c.textAlign = 'right';
      c.fillStyle = KIND_COLOR[r.kind]; c.font = '600 24px Inter, sans-serif';
      c.fillText(fit(c, r.state, 420), W - 44, y + 22);
      c.textAlign = 'left';
      c.fillStyle = '#b8c0dc'; c.font = '400 24px Inter, sans-serif';
      c.fillText(fit(c, r.detail, W - 84 - 44), 84, y + 56);
      if (i < Math.min(rows.length, MAX) - 1) { c.fillStyle = 'rgba(140, 170, 255, 0.1)'; c.fillRect(44, y + ROWH - 6, W - 88, 1); }
    });
    if (rows.length > MAX) {
      c.textAlign = 'center'; c.fillStyle = '#8f99bd'; c.font = '500 24px Inter, sans-serif';
      c.fillText(`+ ${rows.length - MAX} more — see the roster, top left`, W / 2, H - 36);
    }
    b.tex.needsUpdate = true;
  }

  // The lounge, east: sofas, a coffee bar, plants. Off shift, this is where
  // people are.
  function buildLounge(lx) {
    const g = new THREE.Group();
    g.position.set(lx, 0, 0);
    office.add(g);
    const pad = mesh(new THREE.PlaneGeometry(14, 16), new THREE.MeshStandardMaterial({ color: 0x1b1430, roughness: 0.7, metalness: 0.2, transparent: true, opacity: 0.85 }), 0, 0.022, 0, false);
    pad.rotation.x = -Math.PI / 2;
    pad.receiveShadow = true;
    g.add(pad);
    const sign = holoSign('Lounge', new THREE.Color(0xff7ad9));
    sign.position.set(4, 3.2, 0);
    sign.rotation.y = -Math.PI / 2;
    g.add(sign);
    // A rug.
    const rug = mesh(new THREE.CircleGeometry(3.4, 48), std(0x3a2466, { roughness: 1 }), -0.5, 0.03, 0, false);
    rug.rotation.x = -Math.PI / 2;
    rug.receiveShadow = true;
    g.add(rug);

    spots.sofa = [];
    const sofaMat = std(0x6b4bd6, { roughness: 0.8 });
    const cushion = std(0x8a6cf0, { roughness: 0.9 });
    const sofas = [[-0.5, -3.6, 0], [-0.5, 3.6, Math.PI], [-4.1, 0, Math.PI / 2]];
    for (const [x, z, ry] of sofas) {
      const s = new THREE.Group();
      s.position.set(x, 0, z);
      s.rotation.y = ry;
      s.add(mesh(new THREE.BoxGeometry(3.2, 0.42, 0.95), sofaMat, 0, 0.21, 0));
      s.add(mesh(new THREE.BoxGeometry(3.2, 0.7, 0.25), sofaMat, 0, 0.6, -0.42));
      for (const ax of [-1.62, 1.62]) s.add(mesh(new THREE.BoxGeometry(0.22, 0.6, 0.95), sofaMat, ax, 0.3, 0));
      for (const cx of [-0.9, 0, 0.9]) s.add(mesh(new THREE.BoxGeometry(0.85, 0.1, 0.75), cushion, cx, 0.47, 0.05));
      g.add(s);
      solidMeshes.push(s);
      for (const cx of [-0.9, 0, 0.9]) {
        const seat = V(cx, 0, 0.12).applyAxisAngle(V(0, 1, 0), ry).add(V(lx + x, 0, z));
        spots.sofa.push({ p: seat, face: ry, taken: null });
      }
    }
    // Coffee table with a glowing top.
    g.add(mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.06, 32), glow(0x3b2d6b, 1.2), -0.5, 0.42, 0, false));
    g.add(mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.4, 12), std(0x1a2033), -0.5, 0.2, 0));

    // Coffee bar along the east edge.
    const bar = new THREE.Group();
    bar.position.set(5.3, 0, -1);
    bar.add(mesh(new THREE.BoxGeometry(1.0, 1.05, 4.6), std(0x1b2138, { metalness: 0.5 }), 0, 0.52, 0));
    bar.add(mesh(new THREE.BoxGeometry(1.1, 0.06, 4.7), std(0xe6e9f2, { roughness: 0.3 }), 0, 1.07, 0));
    bar.add(mesh(new THREE.BoxGeometry(0.04, 0.05, 4.6), glow(0xff7ad9, 2), -0.52, 0.9, 0, false));
    const machine = mesh(new THREE.BoxGeometry(0.6, 0.7, 0.5), std(0x2b2f3a, { metalness: 0.7, roughness: 0.3 }), 0, 1.45, -1.2);
    bar.add(machine);
    bar.add(mesh(new THREE.CircleGeometry(0.06, 12), glow(0x6fffd8, 3), -0.31, 1.6, -1.2, false).rotateY(-Math.PI / 2));
    bar.add(mesh(new THREE.CircleGeometry(0.06, 12), glow(0xff5c7a, 3), -0.31, 1.6, -1.05, false).rotateY(-Math.PI / 2));
    g.add(bar);
    solidMeshes.push(bar);
    spots.coffee = [V(lx + 4.3, 0, -2.2), V(lx + 4.3, 0, -0.8), V(lx + 4.3, 0, 0.6)].map((p) => ({ p, face: Math.PI / 2 }));

    // Vending machine and plants.
    const vend = mesh(new THREE.BoxGeometry(1.1, 2.1, 0.8), std(0x201a3a, { metalness: 0.4 }), 5.2, 1.05, 4.6);
    g.add(vend);
    solidMeshes.push(vend);
    const vf = mesh(new THREE.PlaneGeometry(0.8, 1.5), glow(0x4aa8ff, 1.1), 4.64, 1.15, 4.6, false);
    vf.rotation.y = -Math.PI / 2;
    g.add(vf);
    for (const [x, z] of [[5.6, -5.6], [-5.6, -6.2], [-5.6, 6.2], [5.6, 2.4]]) plant(g, x, 0, z, 1.3);

    spots.lounge = [];
    for (let i = 0; i < 8; i++) spots.lounge.push({ p: V(lx + rand(-2.8, 3.4), 0, rand(-2.2, 2.2)), face: rand(0, 6.28) });
    spots.loungeX = lx;
  }

  // Rocks drifting round the platform.
  const rocks = [];
  function buildRocks(cx, size) {
    rocks.length = 0;
    const mat = std(0x2a2638, { roughness: 0.95, metalness: 0.05, flatShading: true });
    for (let i = 0; i < 22; i++) {
      const r = mesh(new THREE.IcosahedronGeometry(rand(0.4, 2.2), 0), mat, 0, 0, 0, false);
      const o = { m: r, a: rand(0, Math.PI * 2), rad: size * 0.62 + rand(4, 30), y: rand(-14, 8), sp: rand(0.01, 0.04) * (Math.random() < 0.5 ? 1 : -1), cx, spin: V(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.3) };
      rocks.push(o);
      office.add(r);
    }
  }

  /* ── paths ──────────────────────────────────────────────────────── */

  // Every place is a point plus the way in from the corridor. A route runs
  // out of where you are, along the corridor, and into where you are going.
  const toWorld = (sec, x, z) => V(x, 0, z).applyAxisAngle(V(0, 1, 0), sec.group.rotation.y).add(sec.group.position);

  function deskSpot(desk) {
    const s = desk.sec;
    const dx = desk.group.position.x, dz = desk.group.position.z;
    const ax = dx < 0 ? AISLES[0] : dx > 0 ? AISLES[1] : AISLES[desk.index % 2];
    const stand = dz + 1.75;
    const via = [toWorld(s, ax, LANE * 0.35), toWorld(s, ax, stand), toWorld(s, dx, stand)];
    via[0].z = (s.north ? -1 : 1) * rand(0.3, 1.2);
    return {
      p: toWorld(s, dx, dz + 0.85),
      stand: toWorld(s, dx + 0.75, dz + 1.3),
      via,
      face: s.group.rotation.y + Math.PI,
    };
  }
  const openSpot = (p) => ({ p, via: [V(p.x, 0, rand(-1.2, 1.2))] });

  function route(from, to) {
    const out = [];
    if (from && from.via) for (let i = from.via.length - 1; i >= 0; i--) out.push(from.via[i].clone());
    const a = out.length ? out[out.length - 1] : null;
    const b = to.via[0];
    if (a && Math.abs(a.x - b.x) > 0.5) out.push(V(b.x, 0, a.z));
    for (const v of to.via) out.push(v.clone());
    out.push(to.p.clone());
    return out;
  }

  /* ── actors ─────────────────────────────────────────────────────── */

  const actors = new Map();   // employee id → actor
  const crew = [];            // NPCs: walkers, drones, cleaners
  const actorGroup = new THREE.Group();
  world.add(actorGroup);

  function newActor(obj, extra) {
    actorGroup.add(obj);
    return { obj, path: [], speed: 1.9, anim: 'idle', heading: 0, phase: rand(0, 10), at: null, goal: null, ...extra };
  }

  function place(actor, spot, anim, face) {
    actor.obj.position.copy(spot.p);
    actor.path = [];
    actor.at = spot;
    actor.anim = anim;
    if (face != null) actor.heading = face;
  }
  function walkTo(actor, spot, anim, face) {
    actor.path = route(actor.at, spot);
    actor.at = spot;
    actor.arrive = { anim, face };
    actor.anim = 'walk';
  }

  function step(actor, dt) {
    const o = actor.obj;
    if (actor.path.length) {
      const next = actor.path[0];
      const d = V(next.x - o.position.x, 0, next.z - o.position.z);
      const dist = d.length();
      const move = actor.speed * dt;
      if (dist <= move) {
        o.position.x = next.x; o.position.z = next.z;
        actor.path.shift();
        if (!actor.path.length && actor.arrive) {
          actor.anim = actor.arrive.anim;
          if (actor.arrive.face != null) actor.heading = actor.arrive.face;
          actor.arrive = null;
          if (actor.onArrive) { const f = actor.onArrive; actor.onArrive = null; f(); }
        }
      } else {
        d.multiplyScalar(move / dist);
        o.position.add(d);
        actor.heading = Math.atan2(d.x, d.z);
      }
    }
    // Turn smoothly the short way round.
    let diff = actor.heading - o.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    o.rotation.y += diff * Math.min(1, dt * 8);
  }

  /* ── employees in the world ─────────────────────────────────────── */

  let people = [];
  const deskOf = new Map();   // employee id → desk
  let firstPaint = true;

  // What an employee should be doing, from the same status line the list shows.
  function want(e) {
    const s = window.__employees && window.__employees.status ? window.__employees.status(e) : { kind: e.onShift ? 'on' : 'off' };
    if (e.working) return 'type';
    if (e.pending) return 'type-slow';
    if (s.kind === 'ask' || e.waiting) return 'wave';
    if (s.kind === 'on') return 'desk';
    return 'rest';
  }

  function sync(list) {
    people = (list || []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const rebuilt = build(people);

    // Desks: in hire order within each section.
    deskOf.clear();
    for (const d of screens) d.who = null;
    for (const s of sections) {
      const mine = people.filter((p) => sectionOf(p) === s);
      mine.forEach((p, i) => { const d = s.desks[i]; if (d) { d.who = p; deskOf.set(p.id, d); } });
    }
    for (const d of screens) { d.vacant.visible = !d.who && !d.npc; d.drawn = ''; }

    // Gone: beam out.
    for (const [id, a] of actors) {
      if (!people.some((p) => p.id === id)) {
        beam(a.obj.position, 0xff7a9a);
        actorGroup.remove(a.obj);
        dispose(a.obj);
        actors.delete(id);
        removeTag(id);
      }
    }

    for (const p of people) {
      let a = actors.get(p.id);
      const faceKey = JSON.stringify(p.face || {});
      if (a && a.faceKey !== faceKey) { actorGroup.remove(a.obj); dispose(a.obj); actors.delete(p.id); a = null; }
      const desk = deskOf.get(p.id);
      if (!desk) continue;
      const spot = deskSpot(desk);
      if (!a) {
        a = newActor(makeBot(p.face), { id: p.id, faceKey });
        actors.set(p.id, a);
        const w = want(p);
        if (firstPaint) {
          // Already here when you arrive.
          settle(a, p, w, spot, true);
        } else {
          // New hire: beams in on the teleporter and walks to its desk.
          place(a, spots.teleport, 'idle');
          beam(spots.teleport.p, 0x6fffd8);
          a.obj.scale.set(1, 0.01, 1);
          a.grow = 0;
          setTimeout(() => settle(a, p, w, spot, false), 900);
        }
      } else if (rebuilt || a.mode !== want(p) || a.desk !== desk) {
        settle(a, p, want(p), spot, rebuilt && a.mode === want(p));
      }
      a.person = p;
      a.desk = desk;
      a.deskSpot = spot;
    }
    firstPaint = false;
    paintStats();
    paintHint();
    paintRoster();
  }

  // Send an employee to where its state says it should be.
  function settle(a, p, mode, spot, instant) {
    a.mode = mode;
    a.onArrive = null;
    a.errand = null;
    if (mode === 'wave') {
      const target = { p: spot.stand, via: spot.via };
      if (instant) place(a, target, 'wave', spot.face + Math.PI);
      else walkTo(a, target, 'wave', spot.face + Math.PI);
      return;
    }
    const anim = mode === 'type' || mode === 'type-slow' ? 'type' : mode === 'rest' ? 'rest' : 'type-slow';
    if (instant) place(a, spot, anim, spot.face);
    else walkTo(a, spot, anim, spot.face);
    a.nextBreak = performance.now() / 1000 + rand(25, 70);
  }

  // Now and then someone on shift, with nothing running, gets a coffee.
  function errands(now) {
    for (const a of actors.values()) {
      if (a.mode !== 'desk' || a.path.length || a.errand || !a.deskSpot) continue;
      if (now < (a.nextBreak || 0)) continue;
      a.errand = true;
      const cup = pick(spots.coffee);
      walkTo(a, { p: cup.p, via: [V(cup.p.x - 2, 0, rand(-1, 1))] }, 'coffee', cup.face);
      a.onArrive = () => setTimeout(() => {
        if (a.mode !== 'desk' || !actors.has(a.id)) return;
        walkTo(a, a.deskSpot, 'type-slow', a.deskSpot.face);
        a.onArrive = () => { a.errand = null; a.nextBreak = performance.now() / 1000 + rand(40, 110); };
      }, rand(4000, 9000));
    }
  }

  /* ── the crew ───────────────────────────────────────────────────── */

  function hireCrew() {
    // Crew at the ops desk.
    for (const s of spots.ops) {
      const a = newActor(makeBot({ hue: 180, shape: pick(['round', 'squircle', 'dome']), accessory: 'visor' }, { crew: true }), { crew: 'ops' });
      place(a, { p: s.p }, 'type', s.face);
      a.obj.position.copy(s.p);
      crew.push(a);
    }
    // Walkers who wander the whole place.
    for (let i = 0; i < 6; i++) {
      const a = newActor(makeBot({ hue: 0, shape: pick(['round', 'squircle', 'dome', 'shield']), accessory: 'visor' }, { crew: true, scale: 0.94 }), { crew: 'walker', speed: rand(1.3, 2.1) });
      const s = openSpot(pick(spots.hub).p);
      place(a, s, 'idle');
      a.wait = rand(0, 6);
      crew.push(a);
    }
    // Cleaning bots on the corridor.
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      g.add(mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.16, 24), std(0xe6e9f2, { metalness: 0.3 }), 0, 0.1, 0));
      g.add(mesh(new THREE.TorusGeometry(0.3, 0.025, 6, 24), glow(0x6fffd8, 2), 0, 0.19, 0, false).rotateX(Math.PI / 2));
      g.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), glow(0xff5c7a, 3), 0, 0.22, 0.2, false));
      const a = newActor(g, { crew: 'cleaner', speed: 0.7 });
      a.obj.position.set(rand(bounds.x0 + 4, bounds.x1 - 4), 0, rand(-2, 2));
      a.at = null;
      crew.push(a);
    }
    // Drones overhead, ferrying glowing parcels between sections.
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      g.add(mesh(new THREE.SphereGeometry(0.22, 16, 12), std(0xdfe4ee, { metalness: 0.5, roughness: 0.3 }), 0, 0, 0, false));
      for (const [x, z] of [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]) {
        g.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 16), new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.35 }), x, 0.1, z, false));
      }
      g.add(mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), glow(pick([0x6fffd8, 0xff7ad9, 0xffd24a, 0x4aa8ff]), 2), 0, -0.3, 0, false));
      g.add(mesh(new THREE.SphereGeometry(0.05, 8, 6), glow(0xff5c7a, 3), 0, 0.02, 0.22, false));
      g.position.set(rand(bounds.x0, bounds.x1), rand(3.5, 6), rand(bounds.z0, bounds.z1) * 0.6);
      const a = newActor(g, { crew: 'drone' });
      a.from = g.position.clone();
      a.to = g.position.clone();
      a.t = 1;
      crew.push(a);
    }
  }

  function crewStep(a, dt, t) {
    if (a.crew === 'walker') {
      if (!a.path.length) {
        a.wait -= dt;
        if (a.wait <= 0) {
          const r = Math.random();
          let target, anim = 'idle', face = null;
          if (r < 0.25) { const c = pick(spots.coffee); target = { p: c.p, via: [V(c.p.x - 2, 0, rand(-1, 1))] }; anim = 'coffee'; face = c.face; }
          else if (r < 0.5) target = openSpot(pick(spots.hub).p);
          else if (r < 0.7) target = openSpot(pick(spots.lounge).p);
          else {
            // Drop by a section, look in, move on.
            const s = pick(sections);
            if (s) {
              const p = toWorld(s, pick(AISLES), -rand(0.4, 1.2));
              target = { p, via: [V(p.x, 0, rand(-1, 1))] };
              face = s.north ? Math.PI : 0;
            } else target = openSpot(pick(spots.hub).p);
          }
          walkTo(a, target, anim, face);
          a.wait = rand(3, 10);
        }
      }
      step(a, dt);
      pose(a, dt, t);
    } else if (a.crew === 'ops') {
      pose(a, dt, t);
      let diff = a.heading - a.obj.rotation.y;
      a.obj.rotation.y += Math.atan2(Math.sin(diff), Math.cos(diff)) * Math.min(1, dt * 8);
    } else if (a.crew === 'cleaner') {
      if (!a.target || a.obj.position.distanceTo(a.target) < 0.2) a.target = V(rand(bounds.x0 + 3, bounds.x1 - 3), 0, rand(-LANE + 0.8, LANE - 0.8));
      const d = a.target.clone().sub(a.obj.position);
      const dist = d.length();
      a.obj.position.add(d.multiplyScalar(Math.min(1, (a.speed * dt) / dist)));
      a.obj.rotation.y += dt * 1.5;
    } else if (a.crew === 'drone') {
      a.t += dt / (a.dur || 1);
      if (a.t >= 1) {
        a.from.copy(a.obj.position);
        const s = pick(sections);
        a.to = s ? toWorld(s, rand(-5, 5), -rand(2, s.depth - 2)) : V(rand(bounds.x0, bounds.x1), 0, 0);
        a.to.y = rand(3.2, 6);
        a.dur = a.from.distanceTo(a.to) / 3.2 + 0.5;
        a.t = 0;
      }
      const k = a.t * a.t * (3 - 2 * a.t);
      a.obj.position.lerpVectors(a.from, a.to, k);
      a.obj.position.y += Math.sin(t * 2 + a.phase) * 0.12 + Math.sin(k * Math.PI) * 1.2;
      const dir = a.to.clone().sub(a.from);
      a.obj.rotation.y = Math.atan2(dir.x, dir.z);
      a.obj.rotation.z = Math.sin(t * 1.3 + a.phase) * 0.08;
    }
  }

  /* ── you ────────────────────────────────────────────────────────── */
  // Your own robot. WASD walks it (relative to the camera), Shift runs,
  // Space hops, E uses whatever you are standing at, and a click on the
  // floor or on something walks you there. The camera follows you around.

  const ME = 'operator.verse.me';
  const SHAPES = ['squircle', 'round', 'dome', 'shield'];
  const EXTRAS = ['none', 'antenna', 'visor', 'bolt', 'sprout', 'halo', 'ears'];
  const promptEl = $('versePrompt');
  const RADIUS = 0.32;          // how wide you are, for bumping into things
  let me = null;
  let follow = true;            // the camera stays on you until you look elsewhere
  let mySeat = null;            // the sofa seat you are sitting on
  let myPath = [];              // where a click is walking you
  let myAfter = null;           // what to do once you get there
  let stuckFor = 0;
  let steer = 1;                // which way round you go when something is in the way
  let near = null;              // what E would use right now

  // Where you were and which way the camera faced, kept so you come back
  // to the same spot.
  const WHERE = 'operator.verse.where';
  let savedAt = 0;
  function saveWhere(now) {
    if (!me || (now && now - savedAt < 2000)) return;
    savedAt = now || performance.now();
    const p = me.obj.position;
    write(WHERE, { x: p.x, z: p.z, h: me.heading, theta: goal.theta, phi: goal.phi, radius: goal.radius });
  }

  function spawnMe() {
    const face = read(ME, null) || { hue: 44, shape: 'squircle', accessory: 'halo' };
    me = newActor(makeBot(face, { scale: 1.05 }), { id: 'me', speed: 3.4, jumpV: 0, jumpY: 0 });
    const w = read(WHERE, null);
    const inside = w && Number.isFinite(w.x) && Number.isFinite(w.z) && w.x > bounds.x0 && w.x < bounds.x1 && w.z > bounds.z0 && w.z < bounds.z1;
    if (inside && !blocked(w.x, w.z)) {
      place(me, { p: V(w.x, 0, w.z) }, 'idle', w.h || 0);
      me.obj.rotation.y = me.heading;
      return w;
    }
    // First time here: beam in on the teleporter.
    place(me, spots.teleport, 'idle', Math.PI / 2);
    beam(spots.teleport.p, 0xffd24a);
    return null;
  }

  // A new face for you, from the same parts the employees are made of.
  function newLook() {
    const face = { hue: pick(HUES), shape: pick(SHAPES), accessory: pick(EXTRAS) };
    write(ME, face);
    const old = me.obj;
    const next = makeBot(face, { scale: 1.05 });
    next.position.copy(old.position);
    next.rotation.copy(old.rotation);
    actorGroup.remove(old);
    dispose(old);
    actorGroup.add(next);
    me.obj = next;
    beam(next.position, 0xffd24a);
  }

  const blocked = (x, z) => solids.some((b) => x > b.x0 - RADIUS && x < b.x1 + RADIUS && z > b.z0 - RADIUS && z < b.z1 + RADIUS);

  // Move by (dx, dz), sliding along whatever is in the way. Somewhere you are
  // already stuck inside (a desk that appeared round you) never holds you.
  function tryMove(dx, dz) {
    const p = me.obj.position;
    const inside = blocked(p.x, p.z);
    const edge = (v, a, b) => Math.min(b - 0.5, Math.max(a + 0.5, v));
    const nx = edge(p.x + dx, bounds.x0, bounds.x1);
    if (inside || !blocked(nx, p.z)) p.x = nx;
    const nz = edge(p.z + dz, bounds.z0, bounds.z1);
    if (inside || !blocked(p.x, nz)) p.z = nz;
  }

  function stand() {
    if (!mySeat) return;
    const s = mySeat;
    mySeat = null;
    if (s.taken === me) s.taken = null;
    // Step off the sofa forwards.
    me.obj.position.add(V(Math.sin(s.face) * 0.9, 0, Math.cos(s.face) * 0.9));
  }

  // Walk to a point. A desk inside a section is reached from its aisle, so
  // you go out to the corridor and in, not through the glass.
  function walkMeTo(p, via, after) {
    stand();
    const pts = [];
    const pos = me.obj.position;
    if (Math.abs(pos.z) > LANE - 0.3 && via && via.length) pts.push(V(pos.x, 0, 0));
    for (const v of via || []) pts.push(v.clone());
    pts.push(p.clone());
    myPath = pts;
    myAfter = after || null;
    stuckFor = 0;
    follow = true;
  }

  function arrived() {
    myPath = [];
    const f = myAfter;
    myAfter = null;
    if (f) f();
  }

  function moveMe(dt) {
    if (!me || flight || screenOpen) return;
    let ix = 0, iz = 0;
    if (!typing()) {
      if (keys.has('w') || keys.has('arrowup')) iz += 1;
      if (keys.has('s') || keys.has('arrowdown')) iz -= 1;
      if (keys.has('a') || keys.has('arrowleft')) ix -= 1;
      if (keys.has('d') || keys.has('arrowright')) ix += 1;
    }
    const fwd = V(-Math.sin(orbit.theta), 0, -Math.cos(orbit.theta));
    const right = V(-fwd.z, 0, fwd.x);
    let dir = fwd.multiplyScalar(iz).addScaledVector(right, ix);
    const run = keys.has('shift');
    if (dir.lengthSq() > 0) { myPath = []; myAfter = null; }
    else if (myPath.length) {
      const next = myPath[0];
      dir = V(next.x - me.obj.position.x, 0, next.z - me.obj.position.z);
      if (dir.length() < 0.2) { myPath.shift(); if (!myPath.length) arrived(); dir.set(0, 0, 0); }
    }

    if (dir.lengthSq() > 0) {
      stand();
      dir.normalize();
      const sp = (run ? 6.2 : 3.4) * dt;
      const before = me.obj.position.clone();
      tryMove(dir.x * sp, dir.z * sp);
      let moved = before.distanceTo(me.obj.position);
      // Walking somewhere by click into something in the way: steer round it,
      // turning the same way each time so you don't dither.
      if (myPath.length && moved < sp * 0.5) {
        for (const a of [0.8, 1.57, -0.8, -1.57].map((x) => x * steer)) {
          me.obj.position.copy(before);
          const d = dir.clone().applyAxisAngle(V(0, 1, 0), a);
          tryMove(d.x * sp, d.z * sp);
          moved = before.distanceTo(me.obj.position);
          if (moved > sp * 0.5) { steer = Math.sign(a); break; }
        }
      }
      // Still not getting anywhere: go straight on to whatever it was for.
      if (myPath.length && moved < sp * 0.25) { stuckFor += dt; if (stuckFor > 1.5) { stuckFor = 0; arrived(); } }
      else stuckFor = 0;
      me.heading = Math.atan2(dir.x, dir.z);
      me.anim = 'walk';
      follow = true;
    } else if (me.anim === 'walk') me.anim = 'idle';

    // Hop.
    if (me.jumpY > 0 || me.jumpV > 0) {
      me.jumpV -= 22 * dt;
      me.jumpY = Math.max(0, me.jumpY + me.jumpV * dt);
      if (me.jumpY === 0) me.jumpV = 0;
    }
    me.obj.position.y = me.jumpY;

    let diff = me.heading - me.obj.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    me.obj.rotation.y += diff * Math.min(1, dt * 10);
    findNear();
  }

  // What is within reach, for the E prompt.
  function findNear() {
    const p = me.obj.position;
    let best = null, bestD = 2.1;
    const offer = (d, what) => { if (d < bestD) { bestD = d; best = what; } };
    const w = new THREE.Vector3();
    for (const d of screens) {
      if (d.npc) continue;
      d.group.getWorldPosition(w);
      offer(Math.hypot(w.x - p.x, w.z - p.z) - 0.4, { kind: 'desk', desk: d });
    }
    for (const a of actors.values()) offer(Math.hypot(a.obj.position.x - p.x, a.obj.position.z - p.z) - 0.2, { kind: 'bot', id: a.id });
    for (const s of spots.sofa || []) if (!s.taken || s.taken === me) offer(Math.hypot(s.p.x - p.x, s.p.z - p.z), { kind: 'sofa', seat: s });
    for (const c of spots.coffee || []) offer(Math.hypot(c.p.x - p.x, c.p.z - p.z), { kind: 'coffee', spot: c });
    if (mySeat) best = { kind: 'up' };
    near = best;
    let text = '';
    if (best) {
      if (best.kind === 'desk') text = best.desk.who ? `Sit at ${best.desk.who.name}'s computer` : `Hire someone at this desk in ${best.desk.sec.name}`;
      else if (best.kind === 'bot') { const a = actors.get(best.id); text = a && a.person ? `Talk to ${a.person.name}` : ''; }
      else if (best.kind === 'sofa') text = 'Take a seat';
      else if (best.kind === 'coffee') text = me.anim === 'coffee' ? 'Mmm, coffee' : 'Grab a coffee';
      else if (best.kind === 'up') text = 'Get up';
    }
    const html = text ? '<kbd>E</kbd> ' + esc(text) : '';
    if (promptEl.dataset.html !== html) { promptEl.innerHTML = html; promptEl.dataset.html = html; }
    promptEl.hidden = !text;
  }

  function use(what) {
    if (!what) return;
    if (what.kind === 'up') return stand();
    if (what.kind === 'desk') {
      if (what.desk.who) return sit(what.desk.who.id);
      if (window.__employees) window.__employees.hire(what.desk.sec.name);
      return;
    }
    if (what.kind === 'bot') return sit(what.id);
    if (what.kind === 'sofa') {
      const s = what.seat;
      s.taken = me;
      mySeat = s;
      myPath = [];
      me.obj.position.set(s.p.x, 0, s.p.z);
      me.heading = s.face;
      me.anim = 'sofa';
      return;
    }
    if (what.kind === 'coffee') {
      me.heading = what.spot.face;
      me.anim = 'coffee';
    }
  }

  // Walk over to an employee's desk, then sit down at it.
  function goSit(id) {
    const d = deskOf.get(id);
    if (!d || !me) return sit(id);
    const spot = deskSpot(d);
    walkMeTo(spot.via[2], spot.via.slice(0, 2), () => sit(id));
  }
  function goHire(desk) {
    const spot = deskSpot(desk);
    walkMeTo(spot.via[2], spot.via.slice(0, 2), () => window.__employees && window.__employees.hire(desk.sec.name));
  }

  /* ── effects ────────────────────────────────────────────────────── */

  const beams = [];
  function beam(p, color) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 5, 24, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    m.position.set(p.x, 2.5, p.z);
    world.add(m);
    beams.push({ m, life: 1.2 });
  }

  /* ── tags over heads ────────────────────────────────────────────── */

  const tags = new Map();
  function tagFor(id) {
    let el = tags.get(id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'vt';
      el.addEventListener('click', () => goSit(id));
      tagsEl.appendChild(el);
      tags.set(id, el);
    }
    return el;
  }
  function removeTag(id) { const el = tags.get(id); if (el) { el.remove(); tags.delete(id); } }

  function paintTag(a) {
    const p = a.person;
    const el = tagFor(a.id);
    const kind = a.mode === 'type' || a.mode === 'type-slow' ? 'busy' : a.mode === 'wave' ? 'ask' : a.mode === 'desk' ? 'on' : 'off';
    const html = '<i class="vt-dot vt-' + kind + '"></i><b>' + esc(p.name) + '</b>' +
      (a.mode === 'wave' ? '<span class="vt-bang">!</span>' : '') +
      (a.mode === 'rest' ? '<span class="vt-z">z</span>' : '') +
      (p.unread ? '<span class="vt-unread">' + (p.unread > 9 ? '9+' : p.unread) + '</span>' : '');
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  const tmp = new THREE.Vector3();
  let myTag = null;
  function placeTags(w, h) {
    if (me && !myTag) {
      myTag = document.createElement('div');
      myTag.className = 'vt vt-me';
      myTag.innerHTML = '<i class="vt-dot vt-you"></i><b>You</b>';
      tagsEl.appendChild(myTag);
    }
    for (const a of [...actors.values(), ...(me ? [me] : [])]) {
      if (!a.person && a !== me) continue;
      if (a !== me) paintTag(a);
      const el = a === me ? myTag : tags.get(a.id);
      tmp.copy(a.obj.position);
      tmp.y += a.anim === 'type' || a.anim === 'type-slow' || a.anim === 'rest' || a.anim === 'sofa' ? 1.95 : 2.1;
      world.localToWorld(tmp);
      const dist = tmp.distanceTo(camera.position);
      tmp.project(camera);
      const off = tmp.z > 1 || dist > 90 || screenOpen;
      el.hidden = off;
      if (off) continue;
      const s = Math.max(0.7, Math.min(1.1, 22 / dist));
      el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * w}px, ${(-tmp.y * 0.5 + 0.5) * h}px) translate(-50%, -100%) scale(${s})`;
      el.style.zIndex = String(1000 - Math.round(dist));
    }
  }

  /* ── monitor screens ────────────────────────────────────────────── */

  function drawScreen(d, t) {
    const who = d.who;
    const a = who && actors.get(who.id);
    const mode = d.npc ? 'npc' : !who ? 'vacant' : a ? a.mode : 'desk';
    const live = mode === 'type' || mode === 'npc';
    const key = mode + '|' + (who ? who.name + who.unread + (who.tasks || []).filter((x) => !x.done).length : '') + (live ? Math.floor(t * 6) : '');
    if (key === d.drawn) return;
    d.drawn = key;
    const c = d.canvas.getContext('2d');
    const W2 = d.canvas.width, H2 = d.canvas.height;
    const tint = '#' + d.sec.tint.getHexString();
    c.fillStyle = mode === 'rest' ? '#05060c' : '#0a0f1f';
    c.fillRect(0, 0, W2, H2);
    let glowK = 0;
    if (mode === 'vacant') {
      c.strokeStyle = tint; c.globalAlpha = 0.5 + Math.sin(t * 2) * 0.2; c.lineWidth = 3;
      c.setLineDash([10, 8]); c.strokeRect(14, 14, W2 - 28, H2 - 28); c.setLineDash([]); c.globalAlpha = 1;
      c.fillStyle = tint; c.font = '600 54px Inter, sans-serif'; c.textAlign = 'center'; c.fillText('+', W2 / 2, 96);
      c.fillStyle = '#c8d0e6'; c.font = '500 22px Inter, sans-serif'; c.fillText('Empty desk · click to hire', W2 / 2, 140);
      glowK = 0.15;
    } else if (mode === 'rest') {
      c.fillStyle = '#3a4260'; c.font = '500 22px Inter, sans-serif'; c.textAlign = 'center';
      c.fillText(who.name + ' is off shift', W2 / 2, H2 / 2 + 6);
      glowK = 0;
    } else {
      // Title bar, like the app's own window.
      c.fillStyle = tint; c.fillRect(0, 0, W2, 30);
      c.fillStyle = '#050505'; c.font = '600 17px Inter, sans-serif'; c.textAlign = 'left';
      c.fillText(d.npc ? 'OPS · station monitor' : who.name + (who.role ? ' · ' + who.role : ''), 12, 21, W2 - 24);
      const lines = 7;
      const scroll = live ? t * 3 : 0;
      for (let i = 0; i < lines; i++) {
        const n = Math.floor(i + scroll);
        const w = 40 + ((n * 97) % 190);
        const ind = ((n * 31) % 4) * 14;
        c.fillStyle = ['#4aa8ff', '#9ea7c7', '#6fffd8', '#ff7ad9', '#9ea7c7'][n % 5];
        c.globalAlpha = 0.85;
        c.fillRect(14 + ind, 44 + i * 18 - (scroll % 1) * 18, w, 8);
      }
      c.globalAlpha = 1;
      if (mode === 'wave') {
        c.fillStyle = 'rgba(240,161,46,0.95)'; c.fillRect(0, H2 - 40, W2, 40);
        c.fillStyle = '#1a1206'; c.font = '600 19px Inter, sans-serif'; c.fillText('Needs your answer', 12, H2 - 14);
      } else if (!d.npc) {
        c.fillStyle = 'rgba(5,8,18,0.85)'; c.fillRect(0, H2 - 36, W2, 36);
        c.fillStyle = mode === 'type' ? '#4aa8ff' : '#46d17f'; c.font = '500 17px Inter, sans-serif';
        const open = (who.tasks || []).filter((x) => !x.done).length;
        c.fillText((mode === 'type' ? '● Working' : mode === 'type-slow' ? '● Queued reply' : '● On shift') + ' · ' + open + ' to-do', 12, H2 - 12);
        if (who.unread) { c.fillStyle = '#299fff'; c.beginPath(); c.arc(W2 - 22, H2 - 18, 11, 0, 7); c.fill(); c.fillStyle = '#050505'; c.textAlign = 'center'; c.fillText(String(who.unread), W2 - 22, H2 - 12); }
      }
      glowK = live ? 0.22 : 0.12;
      if (live && Math.random() < 0.5) { c.fillStyle = '#e8f0ff'; c.fillRect(14 + ((Math.floor(t * 6) * 37) % 200), 44 + 6 * 18, 10, 12); }
    }
    d.light.material.opacity = glowK;
    d.tex.needsUpdate = true;
  }

  /* ── camera ─────────────────────────────────────────────────────── */

  const orbit = { target: V(8, 0, 0), radius: 42, theta: 0.75, phi: 0.95 };
  const goal = { target: V(8, 0, 0), radius: 42, theta: 0.75, phi: 0.95 };
  let flight = null;       // { from:{p,l}, to:{p,l}, t, dur, done }
  let parked = null;       // camera sitting at a desk: { p, l }
  let screenOpen = false;
  const lookAt = V(0, 0, 0);

  function orbitPose(o) {
    const p = V(
      o.target.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
      o.target.y + o.radius * Math.cos(o.phi),
      o.target.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta),
    );
    return { p, l: o.target.clone() };
  }

  function frameAll() {
    const cx = (bounds.x0 + bounds.x1) / 2;
    goal.target.set(cx, 0, 0);
    goal.radius = Math.min(95, Math.max(30, (bounds.x1 - bounds.x0) * 0.72));
  }

  function fly(to, dur, done) {
    flight = { from: { p: camera.position.clone(), l: lookAt.clone() }, to, t: 0, dur, done };
  }

  // Sit down at an employee's computer.
  async function sit(id) {
    const d = deskOf.get(id);
    if (!d || !window.__employees) return;
    hideTip();
    const m = d.screen.matrixWorld;
    const scr = V(0, 0, 0).applyMatrix4(m);
    const normal = V(0, 0, 1).transformDirection(m);
    const side = V(1, 0, 0).transformDirection(m);
    // Over the employee's shoulder, looking at its screen.
    const to = { p: scr.clone().addScaledVector(normal, 2.2).addScaledVector(side, 1.0).add(V(0, 1.1, 0)), l: scr };
    parked = to;
    await window.__employees.open(id);
    fly(to, 0.95, async () => {
      screenOpen = true;
      view.classList.add('screen-open');
      document.documentElement.style.setProperty('--verse-hue', String(d.sec.hue));
      // Open it again now it is on screen, which is what marks it read.
      await window.__employees.open(id);
    });
  }

  function closeScreen(quiet) {
    if (!screenOpen && !parked) return;
    screenOpen = false;
    view.classList.remove('screen-open');
    parked = null;
    if (!quiet) fly(orbitPose(orbit), 0.85, null);
    else flight = null;
  }
  $('sdClose').addEventListener('click', () => closeScreen(false));

  /* ── input ──────────────────────────────────────────────────────── */

  let drag = null;
  const pointer = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  let hover = null;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const aim = (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    return r;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (flight || screenOpen) return;
    aim(e);
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button === 2 || e.button === 1 };
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = aim(e);
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.pan) pan(-dx * goal.radius * 0.0016, -dy * goal.radius * 0.0016);
      else {
        goal.theta -= dx * 0.0055;
        goal.phi = Math.min(1.42, Math.max(0.22, goal.phi - dy * 0.0045));
      }
      hideTip();
      return;
    }
    tipAt = { x: e.clientX - r.left, y: e.clientY - r.top };
    wantPick = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved > 5) return;
    const hit = pickAt();
    if (hit) return click(hit);
    // The floor: walk there.
    ray.setFromCamera(pointer, camera);
    const p = new THREE.Vector3();
    if (me && ray.ray.intersectPlane(new THREE.Plane(V(0, 1, 0), -world.position.y), p)) walkMeTo(V(p.x, 0, p.z), null, null);
  });
  canvas.addEventListener('pointerleave', () => { hideTip(); hover = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (screenOpen || flight) return;
    goal.radius = Math.min(110, Math.max(5, goal.radius * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });

  function pan(dx, dz) {
    follow = false;
    const f = V(Math.sin(goal.theta), 0, Math.cos(goal.theta));
    const r = V(f.z, 0, -f.x);
    goal.target.addScaledVector(r, -dx).addScaledVector(f, dz);
    goal.target.x = Math.min(bounds.x1, Math.max(bounds.x0, goal.target.x));
    goal.target.z = Math.min(bounds.z1, Math.max(bounds.z0, goal.target.z));
  }

  const keys = new Set();
  const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
  const active = () => !view.hidden && view.classList.contains('verse-on');
  window.addEventListener('keydown', (e) => {
    if (!active()) return;
    const staffSheet = $('staffSheet');
    if (e.key === 'Escape' && screenOpen && (!staffSheet || staffSheet.hidden)) { e.preventDefault(); closeScreen(false); return; }
    if (typing() || screenOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys.add(k); e.preventDefault(); }
    if (k === 'e' && !e.repeat) use(near);
    if (k === ' ' && me && me.jumpY === 0 && !mySeat) { e.preventDefault(); me.jumpV = 7; }
    if (k === 'f') { follow = false; frameAll(); }
    if (k === 'c') { follow = true; goal.radius = 15; }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  let tipAt = null;
  let wantPick = false;
  function pickAt() {
    ray.setFromCamera(pointer, camera);
    const hits = ray.intersectObjects([...pickables, ...[...actors.values()].map((a) => a.obj.userData.hit), ...(me ? [me.obj.userData.hit] : [])], false);
    for (const h of hits) {
      if (me && h.object === me.obj.userData.hit) return { type: 'me' };
      if (h.object.userData.pick) return h.object.userData.pick;
      for (const a of actors.values()) if (a.obj.userData.hit === h.object) return { type: 'bot', id: a.id };
    }
    // Crew, for a word about who they are.
    const crewHits = ray.intersectObjects(crew.filter((c) => c.obj.userData.hit).map((c) => c.obj.userData.hit), false);
    if (crewHits.length) return { type: 'crew' };
    return null;
  }

  function describe(h) {
    if (!h) return null;
    if (h.type === 'bot') { const a = actors.get(h.id); return a && a.person ? `<b>${esc(a.person.name)}</b> · ${esc(statusText(a.person))}<small>Click to sit at their computer</small>` : null; }
    if (h.type === 'desk') {
      const d = h.desk;
      if (d.who) return `<b>${esc(d.who.name)}'s computer</b> · ${esc(d.sec.name)}<small>Click to sit down</small>`;
      return `<b>Empty desk</b> · ${esc(d.sec.name)}<small>Click to hire someone here</small>`;
    }
    if (h.type === 'sign') { const n = people.filter((p) => sectionOf(p) && sectionOf(p).name === h.section).length; return `<b>${esc(h.section)}</b> · ${n} ${n === 1 ? 'employee' : 'employees'}<small>Click to fly over</small>`; }
    if (h.type === 'crew') return '<b>Crew</b><small>Keeps the Verse running. Not on your payroll.</small>';
    if (h.type === 'me') return '<b>You</b><small>WASD to walk · Shift to run · Space to hop · E to use</small>';
    if (h.type === 'board') return '<b>What everyone\'s doing</b><small>Live. Click to look at it up close</small>';
    return null;
  }
  const statusText = (p) => (window.__employees && window.__employees.status ? window.__employees.status(p).text : '');

  function click(h) {
    hideTip();
    if (h.type === 'bot') return goSit(h.id);
    if (h.type === 'desk') {
      if (h.desk.who) return goSit(h.desk.who.id);
      return goHire(h.desk);
    }
    if (h.type === 'board' && spots.board) {
      follow = false;
      spots.board.face.getWorldPosition(tmp);
      goal.target.set(tmp.x, tmp.y - 0.6, tmp.z);
      goal.radius = 9;
      goal.phi = 1.35;
      return;
    }
    if (h.type === 'sign') {
      follow = false;
      const s = sections.find((x) => x.name === h.section);
      if (s) { goal.target.copy(toWorld(s, 0, -s.depth / 2)); goal.radius = 20; goal.phi = 0.85; goal.theta = s.north ? 0.35 : Math.PI - 0.35; }
    }
  }

  function hoverTick() {
    if (!wantPick || drag || flight || screenOpen) return;
    wantPick = false;
    const h = pickAt();
    hover = h;
    const html = describe(h);
    canvas.style.cursor = h && h.type !== 'crew' && h.type !== 'me' ? 'pointer' : 'grab';
    if (!html || !tipAt) return hideTip();
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.transform = `translate(${tipAt.x + 16}px, ${tipAt.y + 14}px)`;
  }
  function hideTip() { tip.hidden = true; }

  /* ── HUD ────────────────────────────────────────────────────────── */

  function paintStats() {
    const n = people.length;
    const working = people.filter((p) => p.working).length;
    const on = people.filter((p) => p.onShift).length;
    const ask = people.filter((p) => p.waiting).length;
    const parts = [`${n} ${n === 1 ? 'employee' : 'employees'}`, `${on} on shift`];
    if (working) parts.push(`${working} working`);
    if (ask) parts.push(`${ask} waiting on you`);
    statsEl.textContent = parts.join(' · ');
  }
  function paintRoster() {
    const box = $('verseRoster');
    const html = people.map((p) => {
      const a = actors.get(p.id);
      const kind = !a ? 'off' : a.mode === 'type' || a.mode === 'type-slow' ? 'busy' : a.mode === 'wave' ? 'ask' : a.mode === 'desk' ? 'on' : 'off';
      return '<button type="button" class="vr-row" data-id="' + esc(p.id) + '"><i class="vt-dot vt-' + kind + '"></i><b>' + esc(p.name) + '</b>' +
        '<small>' + esc(p.section || 'General') + '</small>' + (p.unread ? '<span class="vt-unread">' + (p.unread > 9 ? '9+' : p.unread) + '</span>' : '') + '</button>';
    }).join('');
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
    box.hidden = !people.length;
  }
  $('verseRoster').addEventListener('click', (e) => {
    const row = e.target.closest('.vr-row');
    if (row) goSit(row.dataset.id);
  });

  function paintHint() {
    hint.hidden = people.length > 0;
    hint.innerHTML = '<b>Welcome to the Agent Verse.</b> Click a glowing <span>+</span> desk to hire your first employee into that section.';
  }

  $('verseHire').addEventListener('click', () => window.__employees && window.__employees.hire(''));
  $('verseMe').addEventListener('click', () => { if (me) newLook(); });
  $('verseSections').addEventListener('click', () => { pop.hidden = !pop.hidden; if (!pop.hidden) { paintPop(); $('versePopInput').focus(); } });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== $('verseSections')) pop.hidden = true; });

  function paintPop() {
    const list = $('versePopList');
    list.textContent = '';
    for (const s of sections) {
      const n = people.filter((p) => sectionOf(p) === s).length;
      const row = document.createElement('div');
      row.className = 'verse-pop-row';
      row.innerHTML = '<i style="background:hsl(' + s.hue + ' 75% 55%)"></i><span>' + esc(s.name) + '</span><small>' + n + '</small>';
      if (!n) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'verse-pop-x';
        x.title = 'Remove ' + s.name;
        x.textContent = '×';
        x.addEventListener('click', () => {
          const saved = (read(SECTIONS, null) || ['General', 'Inbox', 'Research', 'Sales']).filter((v) => v.toLowerCase() !== s.name.toLowerCase());
          write(SECTIONS, saved);
          sync(people);
          paintPop();
        });
        row.appendChild(x);
      }
      list.appendChild(row);
    }
  }
  pop.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('versePopInput');
    const name = input.value.trim().slice(0, 40);
    if (!name) return;
    const saved = read(SECTIONS, null) || sections.map((s) => s.name);
    if (!saved.some((v) => v.toLowerCase() === name.toLowerCase())) saved.push(name);
    write(SECTIONS, saved);
    input.value = '';
    sync(people);
    paintPop();
    const s = sections.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (s) click({ type: 'sign', section: s.name });
  });

  /* ── the loop ───────────────────────────────────────────────────── */

  let running = false;
  let last = performance.now();
  let t = 0;
  let meteorAt = 3;
  let lastScreens = 0;

  function resize() {
    const r = root.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(root);

  function frame(now) {
    if (!active() || document.hidden) { running = false; return; }
    requestAnimationFrame(frame);
    // A chat on screen does not need the world at full speed behind it.
    if (screenOpen && now - last < 1000 / 24) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;

    moveMe(dt);
    if (follow && me) goal.target.set(me.obj.position.x, 1, me.obj.position.z);
    for (const k of ['radius', 'theta', 'phi']) orbit[k] += (goal[k] - orbit[k]) * Math.min(1, dt * 7);
    orbit.target.lerp(goal.target, Math.min(1, dt * 6));

    if (flight) {
      flight.t = Math.min(1, flight.t + dt / flight.dur);
      const k = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - Math.pow(-2 * flight.t + 2, 3) / 2;
      camera.position.lerpVectors(flight.from.p, flight.to.p, k);
      lookAt.lerpVectors(flight.from.l, flight.to.l, k);
      if (flight.t >= 1) { const f = flight; flight = null; if (f.done) f.done(); }
    } else if (parked) {
      camera.position.copy(parked.p);
      lookAt.copy(parked.l);
    } else {
      const o = orbitPose(orbit);
      camera.position.copy(o.p);
      lookAt.copy(o.l);
    }
    camera.lookAt(lookAt);

    // The world floats.
    world.position.y = Math.sin(t * 0.45) * 0.25;
    world.rotation.z = Math.sin(t * 0.3) * 0.004;
    galaxy.rotation.y += dt * 0.006;
    gridMat.uniforms.uTime.value = t;
    if (office) office.traverse((o) => { if (o.userData.spin) o.rotation.z += dt * o.userData.spin; });
    for (const r of rocks) {
      r.a += r.sp * dt;
      r.m.position.set(r.cx + Math.cos(r.a) * r.rad, r.y + Math.sin(t * 0.3 + r.a * 3) * 0.6, Math.sin(r.a) * r.rad * 0.7);
      r.m.rotation.x += r.spin.x * dt; r.m.rotation.y += r.spin.y * dt;
    }
    if (spots.teleBeam) spots.teleBeam.material.opacity = 0.05 + Math.sin(t * 3) * 0.03;
    // Signs bob, and turn to whoever is looking.
    for (const s of sections) {
      s.sign.position.y = 3.3 + Math.sin(t * 1.2 + s.hue) * 0.08;
      s.sign.getWorldPosition(tmp);
      s.sign.rotation.y = Math.atan2(camera.position.x - tmp.x, camera.position.z - tmp.z) - s.group.rotation.y;
    }
    for (const d of screens) if (d.vacant.visible) { d.vacant.rotation.y += dt * 1.6; d.vacant.position.y = 1.25 + Math.sin(t * 2 + d.index) * 0.06; }

    // Shooting stars.
    meteorAt -= dt;
    if (meteorAt <= 0) { meteor(); meteorAt = rand(2.5, 7); }
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.life -= dt;
      m.l.position.addScaledVector(m.dir, dt * 420);
      m.l.material.opacity = Math.max(0, m.life / 1.4);
      if (m.life <= 0) { sky.remove(m.l); m.l.geometry.dispose(); m.l.material.dispose(); meteors.splice(i, 1); }
    }
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i];
      b.life -= dt;
      b.m.material.opacity = Math.max(0, b.life / 1.2) * 0.9;
      b.m.scale.set(1 + (1.2 - b.life) * 0.6, 1, 1 + (1.2 - b.life) * 0.6);
      if (b.life <= 0) { world.remove(b.m); b.m.geometry.dispose(); b.m.material.dispose(); beams.splice(i, 1); }
    }

    errands(now / 1000);
    for (const a of actors.values()) {
      if (a.grow != null) { a.grow = Math.min(1, a.grow + dt * 1.3); a.obj.scale.set(1, a.grow, 1); if (a.grow >= 1) a.grow = null; }
      step(a, dt);
      pose(a, dt, t);
      // Eyes carry state, as on the flat face.
      const eye = a.mode === 'type' ? 0x7cc4ff : a.mode === 'wave' ? 0xffb347 : a.mode === 'rest' ? 0x6f7697 : 0xffffff;
      a.obj.userData.parts.eyeMat.color.setHex(eye).multiplyScalar(1.6);
    }
    for (const c of crew) crewStep(c, dt, t);
    if (me) { pose(me, dt, t); saveWhere(now); }

    if (now - lastScreens > 120) { lastScreens = now; for (const d of screens) drawScreen(d, t); drawBoard(t); }
    if (spots.board) {
      const f = spots.board.face;
      f.getWorldPosition(tmp);
      f.rotation.y = Math.atan2(camera.position.x - tmp.x, camera.position.z - tmp.z) - f.parent.rotation.y;
    }

    hoverTick();
    const r = root.getBoundingClientRect();
    placeTags(r.width, r.height);
    composer.render(dt);
  }

  function wake() {
    if (running || !active() || document.hidden) return;
    running = true;
    last = performance.now();
    resize();
    requestAnimationFrame(frame);
  }
  new MutationObserver(wake).observe(view, { attributes: true, attributeFilter: ['hidden', 'class'] });
  document.addEventListener('visibilitychange', wake);

  /* ── data ───────────────────────────────────────────────────────── */

  view.addEventListener('staff:people', (e) => sync(e.detail || []));
  window.operator.onEmployeeOpen((p) => {
    if (!p || !p.botId || !view.classList.contains('verse-on')) return;
    setTimeout(() => sit(p.botId), 400);
  });

  build([]);
  frameAll();
  Object.assign(orbit, { radius: goal.radius + 30, theta: goal.theta - 0.6, phi: 0.7 });
  orbit.target.copy(goal.target);
  hireCrew();
  // You go in once the employees have, so the office is its full size when
  // the spot you left from is checked.
  function arrive() {
    if (me) return;
    const back = spawnMe();
    if (back) {
      // Back again: the camera as you left it, on you.
      Object.assign(goal, { theta: back.theta ?? goal.theta, phi: back.phi ?? 1.02, radius: back.radius ?? 15 });
      goal.target.set(me.obj.position.x, 1, me.obj.position.z);
      Object.assign(orbit, { theta: goal.theta, phi: goal.phi, radius: goal.radius + 12 });
      orbit.target.copy(goal.target);
    } else {
      // Start wide on the whole place, then settle in behind you.
      setTimeout(() => { goal.radius = 15; goal.phi = 1.02; }, 1200);
    }
  }
  window.addEventListener('beforeunload', () => saveWhere(0));
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveWhere(0); });
  window.operator.employees()
    .then((list) => { if (firstPaint) sync(list || []); })
    .catch(() => { if (firstPaint) sync([]); })
    .finally(arrive);
  wake();
}
