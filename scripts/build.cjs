#!/usr/bin/env node
/**
 * scripts/build.cjs — 跑 electron-builder，**顺手把下载源指到国内镜像**
 *
 * 为什么要有它：electron-builder 下 electron 运行时、winCodeSign、7z 全走 GitHub，
 * 国内直连基本是 ETIMEDOUT（实测 20.205.243.166:443 超时，整个 build 直接红）。
 * 每个环境变量都写成 setIfMissing —— 外层已经设过（例如 CI 有自己的代理/缓存）就不动它。
 *
 * 用法：node scripts/build.cjs [传给 electron-builder 的参数…]
 *   node scripts/build.cjs --win --publish never --config electron-builder.yml
 *   node scripts/build.cjs --win --dir --publish never --config electron-builder.ci.json
 */

"use strict";

const cp = require("node:child_process");
const path = require("node:path");

const MIRRORS = {
	ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
	ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

const env = { ...process.env };
for (const [k, v] of Object.entries(MIRRORS)) if (!env[k]) env[k] = v;

const args = process.argv.slice(2);
const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
const res = cp.spawnSync(cmd, ["--yes", "electron-builder", ...args], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(res.status === null ? 1 : res.status);
