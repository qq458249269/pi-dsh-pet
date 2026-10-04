/**
 * afterPack —— 打包完把用不到的 Electron 自带文件删掉
 *
 * 只删一个文件：**dxcompiler.dll**（连带 dxil.dll）。
 * 它是 Dawn 的 **D3D12** 后端编译器，本应用只用到 WebGL + 一个透明置顶窗，
 * Electron 默认走 ANGLE/D3D11，这两个文件从头到尾没人加载 —— 纯白带 26MB。
 * 缺了它 GPU 进程初始化 D3D12 会失败并自动回落（不是崩溃），本项目实测照样出窗。
 *
 * ⚠️ ponytail: 万一将来换到 D3D12 / WebGPU（`--enable-unsafe-webgpu`）并出现黑屏，
 *   第一个要怀疑的就是这里 —— 把下面 TRIM 列表清空即可回退，别去动别的地方。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** 白名单式：只列确证没人用的。要删别的先在这里加一行，别写通配。 */
const TRIM = ["dxcompiler.dll", "dxil.dll"];

/**
 * 打包身份：确保 asar 里带着一份**此刻的** build.cjs。
 *
 * 之前这里是「不匹配就抛错拦打包」，结果把 CI 打挂了：exe job 直接调
 * `npx electron-builder`，不走 npm 脚本 → prebuild 不跑 → build.cjs 根本不存在。
 * 拦的是「没人绕过脚本」这种自己造成的小失误，坏的是自动发布 —— 方向反了。
 *
 * 正确分工：
 *   · 这里 —— **缺/旧就当场重生成**（幂等），保证包里的身份戳是真的；
 *   · `pi-pet doctor` 与 /health —— 报出 sha 与素材数，这才是发现
 *     「我跑的是旧 exe」的地方（对着旧 exe 调试，界面完全看不出来）。
 */
function assertFreshStamp() {
	const ROOT = path.join(__dirname, "..");
	const out = path.join(ROOT, "app", "build.cjs");
	let prev = null;
	try {
		prev = require(out);
	} catch {
		/* 没有就重建，下面会写 */
	}
const s = require("./stamp.cjs").stamp();
	if (!prev) console.log(`  • 生成包身份戳 ${s.sha}（之前没有 app/build.cjs）`);
	else if (prev.sha !== s.sha || prev.builtAt !== s.builtAt) console.log(`  • 包身份戳重生成 ${prev.sha} → ${s.sha}`);
	console.log(`  • 包身份 = ${s.sha}${s.dirty ? " (dirty)" : ""}，素材 ${s.thumbs} 段`);
}

exports.default = async function afterPack(context) {
	assertFreshStamp();
	// context.appOutDir 是打包输出目录（win-unpacked 之类）；Linux/Mac 布局不同就跳过。
	const dir = context && context.appOutDir;
	if (!dir || process.platform !== "win32") return;
	for (const name of TRIM) {
		const file = path.join(dir, name);
		try {
			const mb = fs.statSync(file).size / 1048576;
			fs.rmSync(file, { force: true });
			console.log(`  • 删掉 ${name}（${mb.toFixed(1)}MB，D3D12 后端用不上）`);
		} catch {
			/* 本次布局里没有这个文件：无所谓 */
		}
	}
};