#!/usr/bin/env node
/**
 * check-assets.cjs —— 钉死「素材不许降画质」这条硬规则（README「🚫 硬规则」）
 *
 * 断言方式：sha256 清单 `assets/thumb.sha256`（sha256sum 格式，已入库），逐个对。
 * 任何重编码 / 缩放 / 改 CRF / 换编码器都会改字节 → 清单对不上 → 当场红。
 *
 * 为什么不用 ffprobe 比分辨率/码率：
 *   ① 那样只能抓到降分辨率，抓不到**同分辨率**的 CRF 重编码（那才是省得最多的那种，
 *      46MB → 21MB 而分辨率纹丝不动）；② ffprobe 得先装 ffmpeg，
 *      而本仓库是零依赖、CI 与本地环境不一定有。
 * 哈希不需要任何依赖，也不给「换个参数压一下试试」留缝。
 *
 * 用法：
 *   node scripts/check-assets.cjs           # 校验（npm test 的一环）
 *   node scripts/check-assets.cjs --write   # **故意**换过素材后重生成清单
 *
 * ⚠️ `--write` 是唯一能绕过这条规则的口子，所以清单本身必须在 git 里，
 * 改动它等于改规则 —— review 时会看到 91 行全变（换素材）或某几行变（单文件重编码）。
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const THUMB = path.join(ROOT, "assets", "thumb");
const MANIFEST = path.join(ROOT, "assets", "thumb.sha256");

const files = fs
	.readdirSync(THUMB)
	.filter((f) => f.toLowerCase().endsWith(".webm"))
	.sort();

if (!files.length) {
	console.error(`✗ ${path.relative(ROOT, THUMB)} 里一个 .webm 都没有`);
	process.exit(1);
}

const sha = (f) =>
	crypto.createHash("sha256").update(fs.readFileSync(path.join(THUMB, f))).digest("hex");

if (process.argv.includes("--write")) {
	const body = files.map((f) => `${sha(f)}  ${f}`).join("\n");
	fs.writeFileSync(MANIFEST, `${body}\n`, "utf8");
	console.log(`✓ 已写 ${path.relative(ROOT, MANIFEST)}（${files.length} 个素材）`);
	process.exit(0);
}

if (!fs.existsSync(MANIFEST)) {
	console.error(
		`✗ 缺 ${path.relative(ROOT, MANIFEST)}。生成一次：node scripts/check-assets.cjs --write`,
	);
	process.exit(1);
}

/** 清单：`sha256␠␠文件名` → Map。名字里可能有各种空白，一律按「最后一个连续空白」切。 */
const expect = new Map(
	fs
		.readFileSync(MANIFEST, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
			return m ? [m[2], m[1]] : null;
		})
		.filter(Boolean),
);

const bad = [];
for (const f of files) {
	const want = expect.get(f);
	if (!want) bad.push(`${f}: 清单里没有（新增素材？跑 --write）`);
	else if (want !== sha(f)) bad.push(`${f}: 字节变了 —— 素材被重编码/缩放/改 CRF 了？还原原始 webm`);
}
for (const f of expect.keys()) {
	if (!fs.existsSync(path.join(THUMB, f))) bad.push(`${f}: 清单里有、目录里没有（素材被删了？）`);
}

if (bad.length) {
	console.error(`✗ 素材与 ${path.relative(ROOT, MANIFEST)} 不一致（${bad.length} 处）：`);
	for (const line of bad.slice(0, 10)) console.error(`    ${line}`);
	console.error(
		"\n  硬规则：assets/thumb/*.webm 一律原分辨率、原码率打包（README「🚫 硬规则」）。\n" +
			"  确实要换素材时：换完跑 node scripts/check-assets.cjs --write，并把清单一起提交。",
	);
	process.exit(1);
}

console.log(`✓ 素材未动：${files.length} 个 webm 与清单逐字节一致`);