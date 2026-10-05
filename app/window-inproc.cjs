/**
 * window-inproc.cjs — 窗开在**宿主自己这个进程**里（融合模式）
 *
 * 什么时候走这条：宿主本身就跑在 Electron 主进程上（打包版的 pi-dsh-pet.exe 就是
 * 这么起的，见 app/electron.cjs 的宿主分支）。这时窗没必要再 spawn 第二个实例 ——
 * 一个 Electron 实例 = 1 个浏览器进程 + 1 个 GPU 进程 + 1 份 Chromium profile 缓存，
 * 分成两套就是白白多一份：
 *
 *   进程：2 浏览器 + 2 GPU + 1 渲染  →  1 浏览器 + 1 GPU + 1 渲染
 *   内存：第二套 V8 堆 + 第二份 disk/GPU cache（实测每个实例 100MB 上下）
 *
 * 画质一行没动：窗还是那扇窗、素材还是那些 webm、解码与合成都走同一条管线。
 *
 * 协议也没动：窗仍然连宿主自己的 127.0.0.1 端口（WS + HTTP 静态资源），所以
 * app/bus.cjs / app/server.cjs 一行都不用碰 —— 融合的是**进程**，不是数据面。
 *
 * 接口与 app/window.cjs 的 createWindowManager 完全一致，宿主那边只换 require。
 * 纯 node（开发态 / `pi-pet serve` / CI 冒烟）没有 electron，照旧走双进程那条。
 * 逃生门：PI_PET_SPLIT_WINDOW=1 强制双进程（窗崩了服务还活着的老形态）。
 */

"use strict";

const fs = require("node:fs");

const { ELECTRON_SCRIPT, log } = require("./paths.cjs");
const { WINDOW_GRACE_MS, RELAUNCH_MIN_GAP_MS } = require("./window.cjs");

/** 取窗那一份代码。**每次 launch 都重载**：换窗的语义就是「窗里的代码换成磁盘上那份」，
 *  跟双进程模式里重新 spawn 一个 electron.exe 等价（渲染层本来就靠 no-store 现取）。 */
function loadWindowModule() {
	delete require.cache[require.resolve(ELECTRON_SCRIPT)];
	return require(ELECTRON_SCRIPT);
}

function createWindowManager(ctx) {
	let mod = null; // 上一次开窗用的那一份（关窗要用它，不能重载）
	let startedAt = 0;
	let lastLaunchAt = 0;
	let restarts = 0;

	function launch(size, port) {
		if (!fs.existsSync(ELECTRON_SCRIPT)) {
			log(`找不到窗脚本 ${ELECTRON_SCRIPT}`);
			return false;
		}
		// 权威口令跟双进程那条一样经环境变量给（pet-electron.cjs 认 PI_PET_TOKEN）
		if (ctx && ctx.token) process.env.PI_PET_TOKEN = String(ctx.token);
		try {
			mod = loadWindowModule();
			if (mod.startWindow(port) === false) return false;
		} catch (err) {
			log(`同进程开窗失败：${err && err.message ? err.message : err}`);
			return false;
		}
		startedAt = Date.now();
		lastLaunchAt = startedAt;
		restarts++;
		log(`开窗（本进程融合：省掉一整套 Electron 实例）pid ${process.pid} → http://127.0.0.1:${port}（size=${size || "normal"}）`);
		if (ctx && ctx.onWindowChange) ctx.onWindowChange({ windowPid: process.pid, windowState: "starting" });
		return true;
	}

	function close() {
		// ⚠️ 别在这里重载模块：winRef 挂在刚开窗那一份的闭包里，重载后 closeWindow()
		//   看到的是空引用，窗关不掉（宿主 keepAlive 于是每 20s 又叠一只）。
		if (!mod) return false;
		let ok = false;
		try {
			ok = mod.closeWindow();
		} catch {
			/* 窗已经没了 */
		}
		startedAt = Date.now();
		if (ctx && ctx.onWindowChange) ctx.onWindowChange({ windowPid: 0, windowState: "closed" });
		return ok;
	}

	/** 换一扇窗：关掉旧的，等它真关掉（1.5s），再开新的（与双进程同一节拍）。 */
	function restart(size, port, done) {
		close();
		setTimeout(() => {
			if (done && !done()) return; // 这 1.5s 里意图变成「不要宠物」就别开了
			launch(size, port);
		}, 1500);
	}

	/**
	 * 自愈判定：窗在不在只看**有没有窗**（同进程没有独立 pid 可看）。
	 * 条件与双进程一致：没窗 + 超过宽限期 + 距上次开窗够久。
	 */
	function needsRelaunch(connected) {
		if (connected) return false;
		const gone = !mod || !mod.hasWindow();
		return gone && Date.now() - startedAt > WINDOW_GRACE_MS && Date.now() - lastLaunchAt > RELAUNCH_MIN_GAP_MS;
	}

	return {
		launch,
		close,
		restart,
		needsRelaunch,
		assetsPresent: () => fs.existsSync(ELECTRON_SCRIPT),
		getPid: () => (mod && mod.hasWindow() ? process.pid : 0),
		getStartedAt: () => startedAt,
		getRestarts: () => restarts,
		electronBin: () => process.execPath,
	};
}

module.exports = { createWindowManager };