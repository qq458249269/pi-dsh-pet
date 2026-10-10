/**
 * scripts/retry-write.cjs —— 挂给打包进程的「写文件重试」补丁（**只在打包这一步生效**）
 *
 * 为什么需要它：刚 unpack 出来的那个 180MB exe，有那么几秒正被实时防护
 * （这台机器上是腾讯电脑管家 QQPCRTP）扫着，句柄没放开。这时 electron-builder
 * 任何一次「把这个 exe 整个重写一遍」的 open 都会失败，而它报出来的是：
 *
 *     UNKNOWN: unknown error, open '…\dist\win-unpacked\pi-dsh-pet.exe'
 *
 * `UNKNOWN` 是 libuv 的 UV_UNKNOWN —— Win32 那个错码它没映射，所以看不出是啥错
 * （errno = -4094 就是 UV_UNKNOWN 本身，不是错误码）。实测这不是权限/磁盘/文件坏了：
 * **报错的同一瞬间**，对同一个文件 open('r+')、读、追加写、改名全部正常，几十毫秒
* 后自己又好了 —— 纯瞬态。以前只能整包重来（scripts/build.cjs 的重试），一次要一分多钟，
 * 还未必撞得上；这里在 open 失败时原地等一下再试，实测第 3～4 次就成了
 * （忙起来时攥得更久，能到十几秒，所以上限给到 20 次）。
 *
 * 安全性：只在 **open 就失败**（一个字节都还没写出去）时重试，写到一半失败照旧抛出去，
 * 不吞错、不改内容。日志里会明说第几次重试，不会静悄悄地吞掉一次故障。
 *
 * 用法只有 scripts/build.cjs 一处：它给 electron-builder 那个子进程塞
 *   NODE_OPTIONS=--require <本文件>
 * 宿主是零依赖的，所以**别**把它写进 package.json 的 dependencies；
 * 日常开发 / `npm test` 也碰不到它。
 */

"use strict";

const fs = require("node:fs");

/** 试几次、每次隔多久（20×0.75s ≈ 15s 封顶：实测最后会变成 EBUSY，
 *  说明就是防护攥着句柄没放；抓完就成，再久就没意义了，交给整包重来） */
const TRIES = 20;
const WAIT_MS = 750;

/** Atomics.wait 当 sleep：不 spawn 进程（本机 PATH 里的 sleep 未必是想要的那个） */
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 只重试「打开就失败」这一类：说明还没落盘，重试是安全的 */
const TRANSIENT = new Set(["UNKNOWN", "EBUSY", "EPERM", "EACCES", "ETXTBSY"]);
const isTransient = (e) => !!e && TRANSIENT.has(e.code);

const shortPath = (p) => {
	const s = typeof p === "string" ? p : String((p && p.path) || p || "");
	return s.length > 60 ? `…${s.slice(-57)}` : s;
};

function note(p, code, n) {
	console.log(`  • 写 ${shortPath(p)} 撞上实时防护（${code}），${WAIT_MS}ms 后重试（${n}/${TRIES}）`);
}

// ---- 同步版（scripts/after-pack.cjs 自己写版本信息走的就是它）
const origSync = fs.writeFileSync;
fs.writeFileSync = function retryWriteFileSync(p, ...rest) {
	for (let n = 1; ; n++) {
		try {
			return origSync.call(this, p, ...rest);
		} catch (e) {
			if (n >= TRIES || !isTransient(e)) throw e;
			note(p, e.code, n);
			sleepMs(WAIT_MS);
		}
	}
};

// ---- promise 版（app-builder-lib 写 asar integrity 资源走的就是它）
const origPromise = fs.promises.writeFile;
fs.promises.writeFile = async function retryWriteFile(p, ...rest) {
	for (let n = 1; ; n++) {
		try {
			return await origPromise.call(fs.promises, p, ...rest);
		} catch (e) {
			if (n >= TRIES || !isTransient(e)) throw e;
			note(p, e.code, n);
			await new Promise((r) => setTimeout(r, WAIT_MS));
		}
	}
};