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

exports.default = async function afterPack(context) {
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