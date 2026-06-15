// Bake the dock's liquid-glass refraction filter into app/renderer/index.html.
//
// This uses the displacement + specular maps from kube.io's music-player
// example (downloaded into app/renderer/public/), embedding them as data URIs
// so feImage works inside backdrop-filter without CORS/tainting issues, and
// wires kube's exact filter pipeline:
//   blur -> displace -> saturate -> composite specular -> fade specular -> blend.
//
// To go back to the procedurally-generated maps instead, set SOURCE = "generated".
// Run: node scripts/gen-glass-maps.mjs   (or: npm run gen:glass)
import zlib from "node:zlib";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");
const pub = path.join(repo, "app/renderer/public");

// ---- which maps to bake in ------------------------------------------------
// The dock is a responsive element; Chromium's feImage does not stretch a
// raster to the element inside backdrop-filter (it draws at the map's own
// pixel size from the top-left). So the displacement map must be authored at
// the dock's size or the lens only covers part of it / is offset. We use the
// procedural rounded-rect lens sized to the dock.
const SOURCE = "generated"; // "kube" | "generated"
const KUBE_DISP = "displacement-map-yr2eh1.png";
const KUBE_SPEC = "specular-map-yr2eh1.png";

// ---- filter parameters ----------------------------------------------------
const BLUR = 1;          // feGaussianBlur stdDeviation
const SCALE = 44;        // feDisplacementMap scale (refraction strength)
const SATURATE = 4.5;    // feColorMatrix saturate
const SPEC_OPACITY = 0.5; // feComponentTransfer specular alpha slope

// ---- procedural map, sized to the dock ------------------------------------
const W = 1080, H = 84, R = 22, BEZEL = 26, GAIN = 1.0, SIGN = 1, EDGE_EXP = 1.0;
const LIGHT = norm(-1, -1.1);
function norm(x, y) { const m = Math.hypot(x, y) || 1; return [x / m, y / m]; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sdfRoundRect(px, py) {
  const cx = W / 2, cy = H / 2;
  const qx = Math.abs(px - cx) - (W / 2 - R);
  const qy = Math.abs(py - cy) - (H / 2 - R);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - R;
}
function buildGenerated() {
  const disp = Buffer.alloc(W * H * 4), spec = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const d = sdfRoundRect(x + 0.5, y + 0.5);
    const gx = sdfRoundRect(x + 1.5, y + 0.5) - sdfRoundRect(x - 0.5, y + 0.5);
    const gy = sdfRoundRect(x + 0.5, y + 1.5) - sdfRoundRect(x + 0.5, y - 0.5);
    const [nx, ny] = norm(gx, gy);
    let dx = 0, dy = 0, specA = 0;
    if (d < 0 && d > -BEZEL) {
      const t = clamp(-d / BEZEL, 0, 1), e = Math.pow(1 - t, EDGE_EXP), mag = e * GAIN * SIGN;
      dx = nx * mag; dy = ny * mag;
      const bump = Math.sin(Math.min(t, 1) * Math.PI);
      const lit = clamp(nx * LIGHT[0] + ny * LIGHT[1], -1, 1) * 0.5 + 0.5;
      specA = clamp((0.4 + 0.6 * lit) * bump, 0, 1);
    }
    disp[i] = clamp(Math.round(128 + dx * 127), 0, 255);
    disp[i + 1] = clamp(Math.round(128 + dy * 127), 0, 255);
    disp[i + 2] = 128; disp[i + 3] = 255;
    spec[i] = spec[i + 1] = spec[i + 2] = 255; spec[i + 3] = clamp(Math.round(specA * 255), 0, 255);
  }
  return { disp: encodePNG(W, H, disp), spec: encodePNG(W, H, spec) };
}

// ---- minimal PNG encoder (no deps) ----------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pchunk(type, data) { const t = Buffer.from(type, "ascii"); const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const body = Buffer.concat([t, data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0); return Buffer.concat([len, body, crc]); }
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  return Buffer.concat([sig, pchunk("IHDR", ihdr), pchunk("IDAT", zlib.deflateSync(raw, { level: 9 })), pchunk("IEND", Buffer.alloc(0))]);
}

// ---- resolve the two maps as data URIs ------------------------------------
let dispPng, specPng, note;
if (SOURCE === "kube") {
  dispPng = fs.readFileSync(path.join(pub, KUBE_DISP));
  specPng = fs.readFileSync(path.join(pub, KUBE_SPEC));
  note = `kube maps (${KUBE_DISP}, ${KUBE_SPEC})`;
} else {
  const g = buildGenerated();
  dispPng = g.disp; specPng = g.spec;
  fs.writeFileSync(path.join(pub, "glass-displacement.png"), dispPng);
  fs.writeFileSync(path.join(pub, "glass-specular.png"), specPng);
  note = "generated maps";
}
const dispURI = "data:image/png;base64," + dispPng.toString("base64");
const specURI = "data:image/png;base64," + specPng.toString("base64");

const filter = `<!-- DOCK-GLASS:START (generated by scripts/gen-glass-maps.mjs — do not edit by hand) -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <filter id="dock-glass" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceGraphic" stdDeviation="${BLUR}" result="blurred"/>
    <feImage href="${dispURI}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="dmap"/>
    <feDisplacementMap in="blurred" in2="dmap" scale="${SCALE}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>
    <feColorMatrix in="displaced" type="saturate" values="${SATURATE}" result="saturated"/>
    <feImage href="${specURI}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="spec"/>
    <feComposite in="saturated" in2="spec" operator="in" result="specSaturated"/>
    <feComponentTransfer in="spec" result="specFaded"><feFuncA type="linear" slope="${SPEC_OPACITY}"/></feComponentTransfer>
    <feBlend in="specSaturated" in2="displaced" mode="normal" result="withSaturation"/>
    <feBlend in="specFaded" in2="withSaturation" mode="normal"/>
  </filter>
</svg>
<!-- DOCK-GLASS:END -->`;

const indexPath = path.join(repo, "app/renderer/index.html");
let html = fs.readFileSync(indexPath, "utf8");
html = html.replace(/<!-- DOCK-GLASS:START[\s\S]*?<!-- DOCK-GLASS:END -->/, filter);
fs.writeFileSync(indexPath, html);

console.log(`baked ${note}: disp ${(dispPng.length / 1024).toFixed(1)}KB, spec ${(specPng.length / 1024).toFixed(1)}KB -> ${path.relative(repo, indexPath)}`);
