#!/usr/bin/env node
/**
 * 视频 → 桌宠素材（mp4/mov → assets/thumb/<名字>.webm）。
 * 用现成的图/视频当素材时走这条，不必去 scripts/gen-anim.cjs 里手写骨架。
 *
*   node scripts/mp4-to-webm.cjs 生成图片.mp4 夜晚躺在床上睡觉
 *   node scripts/mp4-to-webm.cjs a.mp4 名字 --fps 24 --size 640x360 --loop 3
 *   node scripts/mp4-to-webm.cjs a.mp4 名字 --key 0x061733   # 抠掉纯色底
 *
 * 为什么要有这个脚本：手敲 ffmpeg 参数十有八九会漏四样 —— SAR 复位（不然播放器
 * 按 9:16 显示）、-auto-alt-ref 0（不然带 alpha 直接拒绝编码）、首尾无缝（AI 出的
 * 视频第一帧和最后一帧对不上，直接循环会跳）、产物自检（尺寸不对/文件 0 字节都是
 * **静默**故障，窗里表现为「这段动画不播」）。
 *
 * ⚠️ 两条现实限制（都是 ffmpeg 那边的事，不是这里能绕的）：
 *   1) 精简版 ffmpeg（如 Steam 游戏自带那份 --disable-everything）常常
 *      **编不出 alpha**（yuva420p 被静默忽略 → 产物不透明），也**没有 blend 滤镜**
 *      （那就做不了 --loop）。本脚本会实测，不支持就明说，别等桌面上出现黑方块。
 *   2) mp4 本身没有 alpha，抠底得靠 --key 指定一个纯色；AI 出���的视频底色带噪点，
 *      容差给大了会把角色一起抠掉。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes("--" + n);
const pos = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const src = pos[0], name = pos[1];
if (!src || !name) {
  console.error("用法：node scripts/mp4-to-webm.cjs <输入.mp4> <素材名> [--fps 24] [--size 640x360] [--keep-aspect]");
  process.exit(1);
}
const FPS = Number(flag("fps", 24));
const LOOP = Number(flag("loop", 0));        // >0：剪成多少秒的首尾无缝循环
const KEY = flag("key", "");                 // 如 0x061733：抠掉这个纯色底
const [W, H] = flag("size", "640x360").split("x").map(Number);
const OUT = path.join(__dirname, "..", "assets", "thumb", name + ".webm");
if (!fs.existsSync(src)) { console.error(`找不到输入：${src}`); process.exit(1); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// ffmpeg 不在 PATH 上的机器很常见（本项目开发机就没有），逐个试
const CANDIDATES = [
  process.env.FFMPEG_PATH, "ffmpeg",
  path.join(__dirname, "..", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe"),
  "D:/games/Steam/steamapps/common/CSNZ/Bin/FFmpeg.exe",
].filter(Boolean);
const FF = CANDIDATES.find((c) => spawnSync(c, ["-hide_banner", "-version"], { stdio: "ignore", windowsHide: true }).status === 0);
if (!FF) { console.error("找不到 ffmpeg：装一个，或设 FFMPEG_PATH 指向它"); process.exit(1); }

const run = (args, quiet) => {
  const r = spawnSync(FF, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  if (r.status !== 0 && !quiet) throw new Error(String(r.stderr).split("\n").slice(-5).join("\n"));
  return String(r.stderr);
};
/** 只为验 alpha：解一张 RGBA PNG（不引依赖，自己解开 filter） */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ctype = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ctype = d[9]; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const ch = ctype === 6 ? 4 : 3, stride = w * ch;
  const raw = require("zlib").inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * h); let q = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[q++], line = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride), prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev ? prev[i] : 0, c = prev && i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, px: out };
}
// ffmpeg 读 -i 不给输出文件时会以非 0 退出（这正常），所以探测一律 quiet
const info = run(["-hide_banner", "-i", src], true);
const dim = info.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
const dur = (info.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).map(Number);
if (!dim) { console.error("这文件里没有视频流"); process.exit(1); }
const sw = +dim[1], sh = +dim[2], seconds = dur.length === 3 ? dur[0] * 3600 + dur[1] * 60 + dur[2] : 0;

// 等比补边需要 pad 滤镜；没有就拉伸（会变形）—— 用户要的是「照原样搬进来」，拉伸最诚实
const base = has("keep-aspect")
  ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  : `scale=${W}:${H},setsar=1`;
const withKey = (v) => (KEY ? `${v},colorkey=${KEY}:0.32:0.08` : v);

let args;
if (LOOP > 0) {
  // 首尾交叉淡化：AI 视频第一帧与最后一帧对不上，直接循环会跳一拍。
  // 取 L = (LOOP + X) / 2（X 为淡化时长），用后半段的开头去接前半段的结尾。
  const X = Math.min(1, LOOP / 2);
  const L = (LOOP + X) / 2;
  const pre = withKey(`scale=${W}:${H},setsar=1`);
  const seg = (a, b, name) => `[0:v]trim=${a}:${b},setpts=PTS-STARTPTS,${pre},split=2[${name}0][${name}1]`;
  args = ["-y", "-i", src, "-filter_complex",
    `${seg(0, L.toFixed(3), "a")};${seg(L, 2 * L, "b")};` +
    `[a0]trim=0:${(L - X).toFixed(3)},setpts=PTS-STARTPTS[a0];` +
    `[a1]trim=${(L - X).toFixed(3)}:${L.toFixed(3)},setpts=PTS-STARTPTS[a1];` +
    `[b0]trim=0:${X.toFixed(3)},setpts=PTS-STARTPTS[b0];` +
    `[b1]trim=${X.toFixed(3)}:${L.toFixed(3)},setpts=PTS-STARTPTS[b1];` +
    `[a1][b0]blend=all_expr='A*(1-min(T/${X.toFixed(3)},1))+B*min(T/${X.toFixed(3)},1)':shortest=1[xf];` +
    `[a0][xf][b1]concat=n=3:v=1:a=0[v]`, "-map", "[v]", "-an", "-r", String(FPS),
    "-c:v", "libvpx", "-pix_fmt", "yuva420p", "-b:v", "1200k", "-crf", String(flag("crf", 10)),
    "-qmin", "4", "-qmax", "48", "-deadline", "good", "-cpu-used", "2", "-auto-alt-ref", "0", OUT];
} else {
  args = ["-y", "-i", src, "-vf", withKey(base), "-an", "-r", String(FPS),
    "-c:v", "libvpx", "-pix_fmt", "yuva420p", "-b:v", "1200k", "-crf", String(flag("crf", 10)),
    "-qmin", "4", "-qmax", "48", "-deadline", "good", "-cpu-used", "2", "-auto-alt-ref", "0", OUT];
}
run(args);

// 自检：产物坏掉全是静默的（窗里表现为这段动画不播），所以逐项验
if (!fs.existsSync(OUT) || fs.statSync(OUT).size < 2048) throw new Error("产物异常（空文件）");
const pinfo = run(["-hide_banner", "-i", OUT], true);
if (!new RegExp(`\\b${W}x${H}\\b`).test(pinfo)) throw new Error("产物尺寸不对：" + (pinfo.match(/Video:.*/) || ["?"])[0]);
// alpha：抽第一帧真数一遍有多少半透明像素（不支持 alpha 的 ffmpeg 会静默给你不透明）
const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), "m2w-"));
let alphaNote = "";
try {
  run(["-y", "-i", OUT, "-frames:v", "1", "-pix_fmt", "rgba", path.join(tmpd, "f.png")], true);
  const { ch, px, w, h } = decodePng(fs.readFileSync(path.join(tmpd, "f.png")));
  let clear = 0;
  for (let i = 3; i < px.length; i += ch) if (px[i] < 250) clear++;
  if (clear === 0) alphaNote = "⚠️ 本机 ffmpeg 编不出 alpha（yuva420p 被忽略），产物不透明 —— 桌面上会是方块。换全功能 ffmpeg 重编。";
  else if (KEY && clear < (w * h) / 100) alphaNote = "⚠️ --key 抠得太狠，几乎没留下不透明像素；调大容差或换个底色";
} catch { alphaNote = "⚠️ 抽帧失败，alpha 未知"; }
finally { fs.rmSync(tmpd, { recursive: true, force: true }); }

const outDur = (run(["-hide_banner", "-i", OUT], true).match(/Duration: ([\d:.]+)/) || [])[1] || "?";
console.log(`✓ ${name}.webm  ${W}x${H} @${FPS}fps  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB  ${outDur}` +
  `  （源 ${sw}x${sh} ${seconds.toFixed(2)}s${LOOP > 0 ? `，无缝 ${LOOP}s` : "，原时长"}${KEY ? "，已抠底" : ""}）`);
if (alphaNote) console.log(alphaNote);
console.log("接着：node scripts/check-assets.cjs --write（更新 thumb.sha256 清单），" +
  "再在 README 图库补一行（缺了 npm test 的图库断言会红）。");
if (LOOP <= 0 && seconds > 6) console.log("⚠️ 素材普遍 2~4s 一段；这段偏长，桌宠循环播完会有明显接缝（要无缝加 --loop 3）。");