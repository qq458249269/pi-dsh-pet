#!/usr/bin/env node
/**
 * 素材生成器：程序化画大肥鱼 → 640x360 透明 WebM（VP9 alpha）。
 * 零运行时依赖（只用 node:zlib）；需要 ffmpeg（读 FFMPEG_PATH 或 PATH 上的 ffmpeg）。
 *
 *   node scripts/gen-anim.cjs                 # 生成全部预设
 *   node scripts/gen-anim.cjs swim            # 只生成某个预设
 *   node scripts/gen-anim.cjs swim roll --gif # 顺便出 README 预览 GIF
 *
 * ponytail: 纯 2D 矢量骨架（椭圆+多边形），没有骨骼/绑定系统。
 *           要更复杂的表演就往 PRESETS 里加一条 keyframe 函数，别引动画库。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const W = 640, H = 360, FPS = 24, CX = W / 2, CY = H / 2 + 20;

// ---------- 调色板 ----------
const OUTLINE = [26, 52, 74, 1];
const BODY = [104, 176, 214, 1];
const BELLY = [226, 243, 252, 1];
const FIN = [86, 154, 196, 1];
const INK = [26, 52, 74, 1];
const WHITE = [255, 255, 255, 1];
const BLUSH = [255, 158, 173, 0.55];

// ---------- 画布（straight alpha，source-over 混合） ----------
function canvas(w, h) {
  return { w, h, d: new Float32Array(w * h * 4) };
}
function blend(cv, x, y, c, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4, d = cv.d;
  const ia = 1 - a;
  d[i] = c[0] * a + d[i] * ia;
  d[i + 1] = c[1] * a + d[i + 1] * ia;
  d[i + 2] = c[2] * a + d[i + 2] * ia;
d[i + 3] = (a + d[i + 3] * ia) * 255; // alpha 与 rgb 同一个量纲（0..255），别再当 0..1 处理
}
// 3x3 超采样填充；inside(x,y) 返回该采样点是否在形状内
function fill(cv, bbox, color, inside) {
  const [x0, y0, x1, y1] = bbox;
  const N = 3, inv = 1 / (N * N);
  for (let py = Math.max(0, Math.floor(y0)); py <= Math.min(cv.h - 1, Math.ceil(y1)); py++) {
    for (let px = Math.max(0, Math.floor(x0)); px <= Math.min(cv.w - 1, Math.ceil(x1)); px++) {
      let hit = 0;
      for (let sy = 0; sy < N; sy++)
        for (let sx = 0; sx < N; sx++)
          if (inside(px + (sx + 0.5) / N, py + (sy + 0.5) / N)) hit++;
      if (hit) blend(cv, px, py, color, hit * inv * (color[3] ?? 1));
    }
  }
}
function ellipse(cv, cx, cy, rx, ry, rot, color) {
  if (rx <= 0 || ry <= 0) return;
  const co = Math.cos(-rot), si = Math.sin(-rot), r = Math.max(rx, ry);
  fill(cv, [cx - r, cy - r, cx + r, cy + r], color, (x, y) => {
    const dx = x - cx, dy = y - cy;
    const ux = (dx * co - dy * si) / rx, uy = (dx * si + dy * co) / ry;
    return ux * ux + uy * uy <= 1;
  });
}
function poly(cv, pts, color) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  fill(cv, [x0, y0, x1, y1], color, (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}
const rotAll = (pts, a, o) => pts.map((p) => rot(p, a, o));
const rot = (p, a, o = [0, 0]) => {
  const co = Math.cos(a), si = Math.sin(a), dx = p[0] - o[0], dy = p[1] - o[1];
  return [o[0] + dx * co - dy * si, o[1] + dx * si + dy * co];
};
// 描边 = 沿质心放大一点再画一遍底色（比真描边便宜，视觉够用）
const fat = (pts, k) => {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  return pts.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]);
};

// ---------- 鱼骨架（局部坐标：头朝 +x，尾巴在 -x） ----------
function drawWhale(cv, T) {
const { x = 0, y = 0, spin = 0, scale = 1, sx: sx0 = 1, sy: sy0 = 1, wag = 0, fin = 0, blink = 1, mouth = 0 } = T;
  const sx = sx0 * scale, sy = sy0 * scale;
  const P = ([px, py]) => {
    const p = rot([px * sx, py * sy], spin);
    return [CX + x + p[0], CY + y + p[1]];
  };
  const pl = (pts) => pts.map(P);

  // 尾鳍（铰接在 (-96,0)）
  const tail = [
    [[-96, 0], [-170, -62], [-150, -14]],
    [[-96, 0], [-150, 14], [-170, 62]],
  ];
for (const tri of tail) poly(cv, pl(rotAll(fat(tri, 1.14), wag, [-96, 0])), OUTLINE);
  for (const tri of tail) poly(cv, pl(rotAll(tri, wag, [-96, 0])), FIN);

  // 背鳍
  const dorsal = [[-10, -60], [26, -108], [44, -54]];
  poly(cv, pl(fat(dorsal, 1.12)), OUTLINE);
  poly(cv, pl(dorsal), FIN);

  // 身体 + 头
  ellipse(cv, ...P([-6, 0]), 112 * sx, 68 * sy, spin, OUTLINE);
  ellipse(cv, ...P([-6, 0]), 105 * sx, 61 * sy, spin, BODY);
  ellipse(cv, ...P([-2, 16]), 82 * sx, 44 * sy, spin, BELLY);
  ellipse(cv, ...P([64, -10]), 52 * sx, 48 * sy, spin, BODY);
  ellipse(cv, ...P([78, 6]), 40 * sx, 30 * sy, spin, BELLY);

  // 胸鳍（铰接在 (24,42)）
  const pec = [[24, 42], [-16, 92], [-26, 44]];
poly(cv, pl(rotAll(fat(pec, 1.12), fin, [24, 42])), OUTLINE);
  poly(cv, pl(rotAll(pec, fin, [24, 42])), FIN);

  // 腮线 / 嘴
  ellipse(cv, ...P([56, 16]), 4 * sx, 16 * sy, spin, OUTLINE);
  if (mouth > 0.05) ellipse(cv, ...P([98, 20 + mouth * 4]), (12 + 10 * mouth) * sx, (3 + 9 * mouth) * sy, spin, OUTLINE);
  else ellipse(cv, ...P([100, 18]), 13 * sx, 3 * sy, spin, OUTLINE);

  // 眼（blink 0=闭 1=睁）
  ellipse(cv, ...P([62, -18]), 17 * sx, 17 * Math.max(blink, 0.06) * sy, spin, WHITE);
  ellipse(cv, ...P([66, -18]), 9 * sx, 9 * Math.max(blink, 0.06) * sy, spin, INK);
  ellipse(cv, ...P([69, -22]), 3.4 * sx, 3.4 * Math.max(blink, 0.06) * sy, spin, WHITE);
  // 腮红
  ellipse(cv, ...P([84, 6]), 15 * sx, 8 * sy, spin, BLUSH);
}

// ---------- 预设（t ∈ [0,1)，必须首尾相接才能循环） ----------
const TAU = Math.PI * 2;
const PRESETS = {
  // 原地漂浮摇尾巴
swim: {
    file: "原地漂浮摇尾巴",
    slug: "yuandi-piaofu-yao-weiba", // preview GIF 用拼音（仓库惯例）
    frames: 48,
    pose: (t) => ({
      scale: 0.85, // 角色宽度对齐现有素材（约 640 的 40%）
      y: -10 * Math.sin(TAU * t),
      sx: 1 + 0.03 * Math.sin(TAU * t),
      sy: 1 - 0.03 * Math.sin(TAU * t),
      wag: 0.38 * Math.sin(TAU * 2 * t),
      fin: 0.3 * Math.sin(TAU * 2 * t + 1.2),
      blink: t > 0.58 && t < 0.66 ? 0.12 : 1,
      mouth: 0.15 + 0.1 * Math.sin(TAU * t),
    }),
  },
  // 原地翻肚皮打滚
roll: {
    file: "原地翻肚皮打滚",
    slug: "yuandi-fandupi-da-gun",
    frames: 60,
    pose: (t) => {
const squash = 1 + 0.12 * Math.sin(TAU * 2 * t);
      return {
        scale: 0.72, // 旋转后的外接框要留在 640x360 里，不然切边
        spin: TAU * t,
        y: -8 - 6 * Math.sin(TAU * t),
        sx: 1 / squash,
        sy: squash,
        wag: 0.42 * Math.sin(TAU * 2 * t + 0.6),
        fin: 0.5 * Math.sin(TAU * 2 * t),
        blink: t > 0.05 && t < 0.16 ? 0.1 : 1,
        mouth: Math.max(0, 0.7 * Math.sin(TAU * t)),
      };
    },
  },
};

// ---------- PNG（RGBA8，filter 0） ----------
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function png(cv) {
  const raw = Buffer.alloc(cv.h * (cv.w * 4 + 1));
  for (let y = 0; y < cv.h; y++) {
    const o = y * (cv.w * 4 + 1);
    raw[o] = 0;
for (let x = 0; x < cv.w * 4; x++) raw[o + 1 + x] = Math.round(Math.min(255, Math.max(0, cv.d[y * cv.w * 4 + x])));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0);
  ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 跑 ----------
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
function ffmpeg(args) {
  const r = spawnSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg 失败(${r.status}): ${String(r.stderr).trim().split("\n").slice(-4).join("\n")}`);
}
function alphaBox(cv) {
  let x0 = cv.w, y0 = cv.h, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++)
if (cv.d[(y * cv.w + x) * 4 + 3] > 5) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return [x0, y0, x1, y1];
}
function render(name, opts) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`未知预设 ${name}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anim-"));
  try {
let box = [1e9, 1e9, 0, 0];
    for (let i = 0; i < preset.frames; i++) {
      const cv = canvas(W, H);
      drawWhale(cv, preset.pose(i / preset.frames));
      // 自检：切边是静默故障（窗里看着像角色被削平），所以逐帧查外接框
      const b = alphaBox(cv);
      if (b[0] < 2 || b[1] < 2 || b[2] > W - 3 || b[3] > H - 3)
        throw new Error(`${preset.file} 第 ${i} 帧切边 bbox=${b.join(",")}（调 pose 的 scale）`);
      box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])];
      fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, "0")}.png`), png(cv));
    }
// 编码：VP8 + yuva420p。ffmpeg 自带的 vp9 解码器**根本不读 alpha**（解出来全不透明，
// 而 Chrome 读）—— 没法自检，所以选 VP8：libvpx 解码器能验，Chrome 也认。
const ENC = ["-c:v", "libvpx", "-pix_fmt", "yuva420p", "-b:v", "700k",
  "-crf", "10", "-qmin", "4", "-qmax", "48", "-deadline", "good", "-cpu-used", "2",
  "-auto-alt-ref", "0", "-g", String(preset.frames)];
    const out = path.join(opts.dir, preset.file + ".webm");
    ffmpeg(["-y", "-framerate", String(FPS), "-i", path.join(dir, "f%04d.png"), ...ENC, out]);
    if (opts.gif) {
      ffmpeg([
        "-y", "-framerate", String(FPS), "-i", path.join(dir, "f%04d.png"),
        "-vf", "split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
path.join(opts.preview, (preset.slug || preset.file) + ".gif"),
      ]);
    }
const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`✓ ${preset.file}.webm  ${preset.frames} 帧  ${kb} KB  bbox=${box.join(",")}`);
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const names = args.filter((a) => !a.startsWith("-") && PRESETS[a]);
  const opts = {
    gif: args.includes("--gif"),
    dir: path.join(__dirname, "..", "assets", "thumb"),
    preview: path.join(__dirname, "..", "assets", "preview"),
  };
  fs.mkdirSync(opts.dir, { recursive: true });
  if (opts.gif) fs.mkdirSync(opts.preview, { recursive: true });
  const list = names.length ? names : Object.keys(PRESETS);
  if (!list.length) throw new Error(`没有可生成的预设；可用：${Object.keys(PRESETS).join(", ")}`);
  for (const n of list) render(n, opts);
  // 自检：产物存在且非空（素材坏了是静默的：窗里就是一片空白）
  for (const n of list) {
    const f = path.join(opts.dir, PRESETS[n].file + ".webm");
    if (!fs.existsSync(f) || fs.statSync(f).size < 2048) throw new Error(`产物异常：${f}`);
  }
}
if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
module.exports = { canvas, ellipse, poly, drawWhale, png, PRESETS };