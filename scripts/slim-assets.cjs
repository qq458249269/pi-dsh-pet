#!/usr/bin/env node
/**
 * scripts/slim-assets.cjs —— 把 assets/thumb/*.webm 重编码成小一号的版本，让 portable exe 瘦下来
 *
 * 为什么需要它：portable 单文件里只有两块能省。
 *   ① Electron 运行时（~147MB）：动不了。
 *   ② locales（41MB）：打包配置里 electronLanguages 已经砍到只剩 zh-CN/en-US。
 *   ③ assets/thumb/*.webm（46MB）：**已经压过的 VP9**，7z 再压几乎没收益，
 *      只能从源头降分辨率/码率。这块就是本脚本干的。
 *
 * 用法：
 *   node scripts/slim-assets.cjs --dry     # 只报「能省多少」，不动文件
 *   node scripts/slim-assets.cjs           # 真压（原件先备份到 assets/thumb.orig/）
 *   node scripts/slim-assets.cjs --restore # 从 assets/thumb.orig/ 还原
 *   node scripts/slim-assets.cjs --width 448 --crf 36   # 想更小/更糊自己调
 *
 * 前提：PATH 里有 ffmpeg（没有就明确报错退出，不留半成品）。
 *
 * ⚠️ 为什么是「原地替换 + 备份目录」而不是「输出到另一个目录」：
 * electron-builder.yml 的 files 是静态白名单，没法写成「有 thumb-lite 就用它、
 * 否则用 thumb」。原地替换对打包链是零改动的；代价是压完 git status 会显示 91 个
 * 二进制文件被改（不想入库就 `npm run assets:restore`，或者干脆别提交）。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const THUMB = path.join(ROOT, "assets", "thumb");
const BACKUP = path.join(ROOT, "assets", "thumb.orig");

/* ---- 参数 ---- */
const argv = process.argv.slice(2);
const flag = (name, def) => {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return def;
	const v = argv[i + 1];
	return v && !v.startsWith("--") ? v : true;
};
const DRY = flag("dry", false) !== false;
const RESTORE = flag("restore", false) !== false;
/** 目标宽度。素材原片 640×360，宠物最大档位是 540px 宽 → 512 是「不糊」的底线。 */
const WIDTH = Number(flag("width", 512)) || 512;
/** VP9 的 CRF：原素材是 32（≈肉眼无损）。34~38 在这个尺寸上基本看不出差别。 */
const CRF = String(flag("crf", 34));

const MB = (n) => `${(n / 1048576).toFixed(1)}MB`;
const KB = (n) => `${Math.round(n / 1024)}KB`;

function die(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

/* ---- ffmpeg 在不在 ---- */
function haveFfmpeg() {
	const r = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", windowsHide: true });
	return !r.error && r.status === 0;
}

/* ---- 还原 ---- */
if (RESTORE) {
	if (!fs.existsSync(BACKUP)) die(`没有备份目录 ${path.relative(ROOT, BACKUP)}，没东西可还原`);
	const files = fs.readdirSync(BACKUP).filter((f) => f.endsWith(".webm"));
	if (!files.length) die(`${path.relative(ROOT, BACKUP)} 里没有 .webm`);
	for (const f of files) {
		fs.copyFileSync(path.join(BACKUP, f), path.join(THUMB, f));
	}
	console.log(`✓ 已从 assets/thumb.orig/ 还原 ${files.length} 个素材`);
	process.exit(0);
}

/* ---- 素材清单 ---- */
if (!fs.existsSync(THUMB)) die(`找不到素材目录 ${path.relative(ROOT, THUMB)}`);
const files = fs.readdirSync(THUMB).filter((f) => f.toLowerCase().endsWith(".webm")).sort();
if (!files.length) die(`${path.relative(ROOT, THUMB)} 里一个 .webm 都没有`);

const before = files.reduce((n, f) => n + fs.statSync(path.join(THUMB, f)).size, 0);
console.log(`素材：${files.length} 个，共 ${MB(before)}`);
console.log(`目标：宽 ${WIDTH}px（等比缩放，高度取偶数），CRF ${CRF}，VP9 yuva420p（保 alpha）\n`);

if (!haveFfmpeg()) {
	die(
		"PATH 里找不到 ffmpeg。装一个再跑（Windows: winget install Gyan.FFmpeg；\n" +
			"  或 choco install ffmpeg；macOS: brew install ffmpeg）。\n" +
			"  没有它就只能靠 electronLanguages 那点配置瘦身（约省十几 MB）。",
	);
}

/** 单个文件的编码参数。
 *  -pix_fmt yuva420p：素材是带 alpha 的 VP9，**必须**保住 alpha 通道，
 *    换成 yuv420p 会得到黑底方块（宠物就变成一整块矩形了）。
 *  -an：这些 webm 没有音轨，去掉省得 ffmpeg 空跑一遍。
 *  -deadline good -cpu-used 4：慢但小；这里取一个打包时能接受的平衡点。 */
function encode(src, dst) {
	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		src,
		"-vf",
		`scale=${WIDTH}:-2:flags=lanczos`,
		"-c:v",
		"libvpx-vp9",
		"-pix_fmt",
		"yuva420p",
		"-crf",
		CRF,
		"-b:v",
		"0",
		"-row-mt",
		"1",
		"-deadline",
		"good",
		"-cpu-used",
		"4",
		"-an",
		dst,
	];
	const r = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
	return { ok: !r.error && r.status === 0, err: r.error ? String(r.error.message) : (r.stderr || "").trim() };
}

// 备份一次（只在第一次真压时做；重复跑会拿备份当源，改参数才能重压）
if (!DRY && !fs.existsSync(BACKUP)) {
	fs.mkdirSync(BACKUP, { recursive: true });
	for (const f of files) fs.copyFileSync(path.join(THUMB, f), path.join(BACKUP, f));
	console.log(`已备份原件 → assets/thumb.orig/（还原：npm run assets:restore）\n`);
}
const SRC = fs.existsSync(BACKUP) ? BACKUP : THUMB;

let after = 0;
let changed = 0;
const failures = [];
files.forEach((f, i) => {
	const src = path.join(SRC, f);
	const dst = path.join(THUMB, f);
	const outTmp = `${dst}.slim.webm`;
	const r = encode(src, outTmp);
	if (!r.ok || !fs.existsSync(outTmp) || fs.statSync(outTmp).size === 0) {
		failures.push(`${f}: ${r.err.split("\n").pop() || "ffmpeg 没产出文件"}`);
		try {
			fs.rmSync(outTmp, { force: true });
		} catch {
			/* ignore */
		}
		return;
	}
	const newSize = fs.statSync(outTmp).size;
	const oldSize = fs.statSync(src).size;
	after += newSize;
	// 只在真的变小的时候才换（分辨率变小但码率给高了的情况不该发生，但要防呆）
	const worth = newSize < oldSize;
	if (worth) changed++;
	if (DRY) {
		console.log(`  [${i + 1}/${files.length}] ${f}  ${KB(oldSize)} → ${KB(newSize)} ${worth ? "" : "（反而变大，跳过）"}`);
	} else if (worth) {
		fs.rmSync(dst, { force: true });
		fs.renameSync(outTmp, dst);
		console.log(`  [${i + 1}/${files.length}] ${f}  ${KB(oldSize)} → ${KB(newSize)}`);
	} else {
		fs.rmSync(outTmp, { force: true });
		console.log(`  [${i + 1}/${files.length}] ${f}  ${KB(oldSize)} → ${KB(newSize)}（反而变大，保持原样）`);
	}
});

if (failures.length) {
	console.error(`\n✗ ${failures.length} 个素材没压成功：`);
	for (const f of failures.slice(0, 5)) console.error(`    ${f}`);
	console.error("  已成功的保持原样（不替换），原素材一个都没丢。");
	process.exit(1);
}

const saved = before - after;
console.log(
	`\n${DRY ? "预计" : "实际"}：${MB(before)} → ${MB(after)}，省 ${MB(saved)}` +
		`（${((saved / before) * 100).toFixed(0)}%），${changed}/${files.length} 个变小`,
);
console.log(
	DRY
		? "这是 --dry，文件没动。去掉 --dry 就会真压。"
		: `portable exe 大概跟着省 ${MB(saved)} 上下（Electron 那部分压不动）。`,
);