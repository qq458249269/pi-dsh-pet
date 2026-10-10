#!/usr/bin/env node
/**
 * scripts/build.cjs — 跑 electron-builder，做三件「让它在这台机器上能跑通」的事
 *
 * ① 把下载源指到国内镜像（否则整包红在 ETIMEDOUT 上）；
 * ② 给它挂上 scripts/retry-write.cjs（躲开「exe 正被实时防护扫着，写不进去」那几秒）；
 * ③ 万一还是红了，清掉产物整包重来（见下面 RETRY 那段）。
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
const fs = require("node:fs");
const path = require("node:path");

const MIRRORS = {
	ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
	ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

/** 失败后等这么久再重来一次（秒）—— 够实时防护放开句柄了 */
const RETRY_WAIT = 10;
const RETRY_TRIES = 4;

/** 本仓库的产物目录（electron-builder.yml: directories.output），重试前要清掉上一次的残骸 */
const OUT_DIR = "dist";

const env = { ...process.env };
for (const [k, v] of Object.entries(MIRRORS)) if (!env[k]) env[k] = v;

// ② 写文件重试补丁。**只挂给这个子进程**（宿主/测试都碰不到），
//    外层自己设过 NODE_OPTIONS 就往后追加，别把它顶掉（那可能是调试器/覆盖率）。
const PATCH = path.resolve(__dirname, "retry-write.cjs");
if (fs.existsSync(PATCH)) {
	const flag = `--require ${JSON.stringify(PATCH)}`;
	env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag;
}

const args = process.argv.slice(2);
const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
const spawnOpts = { stdio: "inherit", env, shell: process.platform === "win32" };

/** 等一下：不 spawn 进程（本机 PATH 里的 timeout/sleep 说不定就不是想要的那个） */
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let attempt = 1; ; attempt++) {
	const res = cp.spawnSync(cmd, ["--yes", "electron-builder", ...args], spawnOpts);
	const code = res.status === null ? 1 : res.status;
	if (code === 0) process.exit(0);
	if (attempt >= RETRY_TRIES) process.exit(code);
	cleanOutput();

	// ③ 重试。**不是掩盖问题，是躲开一个几秒的窗口**：刚 unpack 出来的 180MB exe
	//    有时会正被实时防护（腾讯电脑管家 QQPCRTP 之类）扫着，句柄没放开 ——
	//    electron-builder 紧接着的任何一次改写都会撞上，症状五花八门：
	//      rcedit:            Fatal error: Unable to commit changes
	//      asar integrity:    UNKNOWN: unknown error, open '…\pi-dsh-pet.exe'
	//      下一轮的开头:       remove '…\pi-dsh-pet.exe': Access is denied
	//    都是**瞬态**的：实测报错的同一瞬间，对同一个文件 open/read/rename/追加写
	//    全都正常，同一份代码重跑一遍就成了 —— 不是本仓库代码的问题。
	//    （retry-write.cjs 已经在原地试过了，走到这里说明连它都没扛住。）
	//    根治是把仓库目录加进防护的白名单/信任区 —— 那是机器上的设置，脚本管不了。
	console.log(`\n✗ 第 ${attempt}/${RETRY_TRIES} 次打包失败。`);
	console.log(`  多半是实时防护正扫描刚写出来的 exe —— 清掉产物等 ${RETRY_WAIT}s 让它扫完，重来一次。`);
	console.log(`  ${RETRY_TRIES} 次都失败就别指望重试了，去看上面第一处报错。`);

	sleepMs(RETRY_WAIT * 1000);
}

/**
 * 清输出目录。失败的那轮可能留下一个正被扫描的 exe，不走掉它，下一轮连
 * 「清空输出目录」都过不去（remove: Access is denied）。删不动就再等，最多等 1 分钟。
 */
function cleanOutput() {
	if (!fs.existsSync(OUT_DIR)) return;
	for (let i = 1; i <= 6; i++) {
		sleepMs(RETRY_WAIT * 1000);
		try {
			fs.rmSync(path.resolve(OUT_DIR), { recursive: true, force: true });
			console.log(`  • 清掉 ${OUT_DIR}/（上一轮的残骸，可能还正被扫描）`);
			return;
		} catch (e) {
			console.log(`    ⚠ ${OUT_DIR}/ 删不掉（${e.code}），再等 ${RETRY_WAIT}s`);
		}
	}
	console.log(`    ⚠ ${OUT_DIR}/ 删不掉，重试交给 electron-builder 自己清`);
}