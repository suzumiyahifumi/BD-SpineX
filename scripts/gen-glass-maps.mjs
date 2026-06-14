// Generate liquid-glass displacement + specular maps for the dock and inject
// a kube-style refraction filter into app/renderer/index.html.
//
// The dock filter mirrors the technique from kube.io's music-player example:
//   blur -> displace (image map) -> saturate -> composite specular rim -> blend.
// Unlike the procedural #liquid-lens (feTurbulence), this uses a baked
// displacement map shaped like a rounded rectangle, so the glass refracts
// cleanly along its edges and stays clear in the middle — that crisp
// "real glass slab" look. Maps are embedded as data URIs so feImage works
// inside backdrop-filter without CORS/tainting issues.
//
// Run: node scripts/gen-glass-maps.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");

// ---- tunables -------------------------------------------------------------
const W = 1000;          // map width (stretched to the dock via preserveAspectRatio=none)
const H = 88;            // map height
const R = 22;            // corner radius
const BEZEL = 34;        // width of the refractive edge band (px)
const GAIN = 1.0;        // how hard the rim pushes (0..1+)
const SIGN = 1;          // +1 magnify (sample outward), -1 pinch
const EDGE_EXP = 1.0;    // rim falloff shape (lower = broader band)
const LIGHT = norm(-1, -1.1); // specular light direction (top-left)
// ---------------------------------------------------------------------------

function norm(x, y) { const m = Math.hypot(x, y) || 1; return [x / m, y / m]; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function sdfRoundRect(px, py) {
  const cx = W / 2, cy = H / 2;
  const qx = Math.abs(px - cx) - (W / 2 - R);
  const qy = Math.abs(py - cy) - (H / 2 - R);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - R;
}

function build() {
  const disp = Buffer.alloc(W * H * 4);
  const spec = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = sdfRoundRect(x + 0.5, y + 0.5);
      // numeric gradient of the SDF -> outward normal
      const gx = sdfRoundRect(x + 1.5, y + 0.5) - sdfRoundRect(x - 0.5, y + 0.5);
      const gy = sdfRoundRect(x + 0.5, y + 1.5) - sdfRoundRect(x + 0.5, y - 0.5);
      const [nx, ny] = norm(gx, gy); // points outward (toward edge)

      let dx = 0, dy = 0, specA = 0;
      if (d < 0 && d > -BEZEL) {
        const t = clamp(-d / BEZEL, 0, 1);     // 0 at edge, 1 inner
        const e = Math.pow(1 - t, EDGE_EXP);   // strong at edge, fades inward
        const mag = e * GAIN * SIGN;
        dx = nx * mag;
        dy = ny * mag;
        // specular: bright where the rim faces the light, mid-band peak
        const bump = Math.sin(Math.min(t, 1) * Math.PI); // 0 at edges of band, 1 mid
        const lit = clamp(nx * LIGHT[0] + ny * LIGHT[1], -1, 1) * 0.5 + 0.5;
        specA = clamp((0.4 + 0.6 * lit) * bump, 0, 1);
      }

      disp[i] = clamp(Math.round(128 + dx * 127), 0, 255);
      disp[i + 1] = clamp(Math.round(128 + dy * 127), 0, 255);
      disp[i + 2] = 128;
      disp[i + 3] = 255;

      spec[i] = 255; spec[i + 1] = 255; spec[i + 2] = 255;
      spec[i + 3] = clamp(Math.round(specA * 255), 0, 255);
    }
  }
  return { disp, spec };
}

// ---- minimal PNG encoder (RGBA, no deps) ----------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const { disp, spec } = build();
const dispPng = encodePNG(W, H, disp);
const specPng = encodePNG(W, H, spec);
const dispURI = "data:image/png;base64," + dispPng.toString("base64");
const specURI = "data:image/png;base64," + specPng.toString("base64");

// also drop the PNGs in public/ for reference / the design book
const pub = path.join(repo, "app/renderer/public");
fs.mkdirSync(pub, { recursive: true });
fs.writeFileSync(path.join(pub, "glass-displacement.png"), dispPng);
fs.writeFileSync(path.join(pub, "glass-specular.png"), specPng);

const filter = `<!-- DOCK-GLASS:START (generated by scripts/gen-glass-maps.mjs — do not edit by hand) -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <filter id="dock-glass" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceGraphic" stdDeviation="1.1" result="blurred"/>
    <feImage href="${dispURI}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="dmap"/>
    <feDisplacementMap in="blurred" in2="dmap" scale="88" xChannelSelector="R" yChannelSelector="G" result="displaced"/>
    <feColorMatrix in="displaced" type="saturate" values="5" result="saturated"/>
    <feImage href="${specURI}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="spec"/>
    <feComposite in="saturated" in2="spec" operator="in" result="specSaturated"/>
    <feComponentTransfer in="spec" result="specFaded"><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
    <feBlend in="specSaturated" in2="displaced" mode="normal" result="withSaturation"/>
    <feBlend in="specFaded" in2="withSaturation" mode="screen"/>
  </filter>
</svg>
<!-- DOCK-GLASS:END -->`;

const indexPath = path.join(repo, "app/renderer/index.html");
let html = fs.readFileSync(indexPath, "utf8");
html = html.replace(/<!-- DOCK-GLASS:START[\s\S]*?<!-- DOCK-GLASS:END -->/, filter);
fs.writeFileSync(indexPath, html);

console.log(`disp ${(dispPng.length / 1024).toFixed(1)}KB, spec ${(specPng.length / 1024).toFixed(1)}KB; injected into ${path.relative(repo, indexPath)}`);
