/**
 * window.cjs — 拉起 / 关闭 / 盯住 Electron 透明窗
 *
 * 这一层的存在理由只有一句话：**窗的寿命不能绑在任何一个 pi/dsh 进程上**。
 * 旧版把服务挂在 pi 进程里，于是两条独立的路都会杀死窗：
 *   1. pi 退出 → 上游 `process.on('exit')` → `taskkill /f /t`（代码里写死的）；
 *   2. 就算不杀，服务随 pi 一起没了 → pet.js 的 `ws.onclose` 重试 5 次（约 15s）
 *      后调 `closeWindow()` → `app.quit()`。
 * 宿主化之后，本进程就是那个「更长寿的人」，窗挂在它下面。
 *
 * 三个 Windows 上的实测坑（照抄，别改回去）：
 *   - **别用 npx electron**：npx 那层不带 CREATE_NO_WINDOW，会凭空弹一个黑框控制台。
 *     直接 spawn electron.exe：一条进程、零控制台，还省掉 1~2s 的解析。
 *   - **detached + windowsHide 一起给**：无论本进程自己被怎么拉起（node / bun），
 *     窗都不在父控制台的控制台事件范围里（Ctrl+C / 关 cmd 都碰不到）。
 *   - **窗在不在以「有没有 WS 客户端」为准**，不是 pid：pid 在但渲染进程崩了照样连不上。
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { ELECTRON_SCRIPT, PATHS, PKG_ROOT, log } = require("./paths.cjs");
const { pidAlive } = require("./single.cjs");

/** 窗连上以后多久算「连上了」：首次拉 Electron 可能要十几秒。 */
const WINDOW_GRACE_MS = Number(process.env.PI_PET_WINDOW_GRACE_MS || 20_000);
/** 窗断线多久后判死（窗侧 5 次重试 ≈15s 就自己关了，20s 足够）。 */
const WINDOW_LOST_MS = Number(process.env.PI_PET_WINDOW_LOST_MS || 20_000);
/** 重启节流：刚起就崩别疯狂重拉。 */
const RELAUNCH_MIN_GAP_MS = Number(process.env.PI_PET_RELAUNCH_GAP_MS || 15_000);

/** 是不是跑在打包好的 exe 里（electron 运行时且不是 `electron .` 直跑）。 */
function isPackaged() {
	return Boolean(process.versions.electron) && !process.defaultApp;
}

function electronExe(distDir) {
	return path.join(distDir, process.platform === "win32" ? "electron.exe" : "electron");
}

/** npm 的 cache 目录：环境变量 → 各级 .npmrc 的 cache= → 平台默认值。**刻意不 spawn npm**。 */
function npmCacheDirs() {
	const dirs = [];
	for (const v of [process.env.NPM_CONFIG_CACHE, process.env.npm_config_cache]) {
		if (v) dirs.push(path.resolve(v));
	}
	const rcs = [path.join(os.homedir(), ".npmrc"), path.join(PKG_ROOT, ".npmrc"), path.join(process.cwd(), ".npmrc")];
	if (process.env.APPDATA) rcs.push(path.join(process.env.APPDATA, "npm", "etc", "npmrc"));
	for (const rc of rcs) {
		let text = "";
		try {
			text = fs.readFileSync(rc, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split(/\r?\n/)) {
			const m = /^\s*cache\s*=\s*(.+?)\s*$/.exec(line);
			if (m) dirs.push(path.resolve(m[1].replace(/^["']|["']$/g, "")));
		}
	}
	dirs.push(path.join(os.homedir(), ".npm"));
	if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "npm-cache"));
	return [...new Set(dirs)];
}

let electronBinMemo;

/**
 * 找现成的 electron.exe，绕开 npx。查找顺序：
 *   1. `$PI_PET_ELECTRON`（给 dist/ 目录或直接给 exe 都行）
 *   2. 上次找到的（记在 home/electron.json；缓存被清 / 换机器时自动失效）
 *   3. 包自带的 `node_modules/electron/dist`
 *   4. npx 缓存 `_npx/<hash>/node_modules/electron/dist`
 *   5. 都没有 → 退回 npx（能开窗，但会闪一个黑框）
 */
function resolveElectronBin() {
	if (electronBinMemo !== undefined) return electronBinMemo;
	let found = null;

	if (process.env.PI_PET_ELECTRON) {
		const v = process.env.PI_PET_ELECTRON;
		if (fs.existsSync(v)) found = v;
		else if (fs.existsSync(electronExe(v))) found = electronExe(v);
	}
	if (!found && fs.existsSync(PATHS.electronMemo)) {
		try {
			const cached = String(fs.readFileSync(PATHS.electronMemo, "utf8")).trim();
			if (cached && fs.existsSync(cached)) found = cached;
		} catch {
			/* 读不到就往下找 */
		}
	}
	if (!found) {
		const local = electronExe(path.join(PKG_ROOT, "node_modules", "electron", "dist"));
		if (fs.existsSync(local)) found = local;
	}
	if (!found) {
		for (const cache of npmCacheDirs()) {
			const npxDir = path.join(cache, "_npx");
			let names = [];
			try {
				names = fs.readdirSync(npxDir);
			} catch {
				continue;
			}
			for (const name of names) {
				const exe = electronExe(path.join(npxDir, name, "node_modules", "electron", "dist"));
				if (fs.existsSync(exe)) {
					found = exe;
					break;
				}
			}
			if (found) break;
		}
	}

	electronBinMemo = found;
	if (found) {
		log(`electron 直接用 ${found}（不经 npx，不弹控制台）`);
		try {
			fs.mkdirSync(PATHS.home, { recursive: true });
			fs.writeFileSync(PATHS.electronMemo, found, "utf8");
		} catch {
			/* 写不上就下次重新找 */
		}
	} else {
		log("没找到现成的 electron.exe，退回 npx 拉窗（会闪一个控制台窗口）");
	}
	return found;
}

function createWindowManager(ctx) {
	let child = null;
	let pid = 0;
	let startedAt = 0;
	let lastSeenAt = 0;
	let lastLaunchAt = 0;
	let restarts = 0;

	function assetsPresent() {
		return fs.existsSync(ELECTRON_SCRIPT);
	}

	function launch(size, port) {
		if (!assetsPresent()) {
			log(`找不到窗脚本 ${ELECTRON_SCRIPT}`);
			return false;
		}
		const isWin = process.platform === "win32";
		const env = { ...process.env };
		// 国内机器走 npmmirror（GitHub / S3 不通）
		if (isWin && !env.ELECTRON_MIRROR) {
			env.ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
			env.NPM_CONFIG_REGISTRY = "https://registry.npmmirror.com";
		}
		const bin = resolveElectronBin();
		const args = [ELECTRON_SCRIPT, String(port)];
		let spec;
		if (isPackaged()) {
			// 打包版没有 electron.exe：窗就是**这个 exe 的第二个实例**
			spec = { file: process.execPath, args: ["--pi-pet-window", String(port)], shell: false };
		} else {
			spec = bin
				? { file: bin, args, shell: false }
				: { file: isWin ? "npx.cmd" : "npx", args: ["--yes", "electron", ...args], shell: isWin };
		}

		try {
			child = spawn(spec.file, spec.args, {
				cwd: PKG_ROOT,
				env,
				stdio: "ignore",
				detached: true,
				windowsHide: true,
				shell: spec.shell,
			});
		} catch (err) {
			log(`拉起 electron 失败：${err.message}`);
			return false;
		}

		pid = child.pid || 0;
		startedAt = Date.now();
		lastLaunchAt = startedAt;
		lastSeenAt = 0;
		restarts++;
		log(`拉起窗：pid ${pid} → http://127.0.0.1:${port}（size=${size || "normal"}）`);

		child.on("error", (err) => {
			log(`electron 启动出错：${err.message}`);
			if (pid) ctx.onWindowChange({ windowPid: pid, windowState: "error" });
		});
		child.on("exit", (code) => {
			log(`electron 退出（code ${code}）`);
			if (child && child.pid === pid) {
				pid = 0;
				ctx.onWindowChange({ windowPid: 0, windowState: "exited" });
			}
		});
		try {
			child.unref();
		} catch {
			/* 不影响 */
		}
		return true;
	}

	function close() {
		if (!pid) return false;
		log(`关掉窗 pid ${pid}`);
		if (process.platform === "win32") {
			try {
				spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
			} catch {
				/* 忽略 */
			}
		} else {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* 已经没了 */
			}
		}
		pid = 0;
		// 宽限期从此刻重算：不然本拍的「窗没了 → keepAlive 重拉」会和 restart 安排的
		// 换窗撞车，旧窗刚 taskkill、新窗又叠上来，屏幕上就是两只
		startedAt = Date.now();
		ctx.onWindowChange({ windowPid: 0, windowState: "closed" });
		return true;
	}

	/** 换一扇窗：关掉旧的，等 taskkill 真正落地（1.5s），再拉新的。 */
	function restart(size, port, done) {
		close();
		setTimeout(() => {
			if (done && !done()) return; // 这 1.5s 里意图变成「不要宠物」就别拉了
			launch(size, port);
		}, 1500);
	}

	/**
	 * 自愈判定。窗在不在**以有没有 WS 客户端为准**（比 pid 可靠）。
	 * 三个条件同时满足才重拉：没客户端 + 超过宽限期 + 超过丢失判定期 + 距上次拉起够久。
	 */
	function needsRelaunch(connected) {
		if (connected) {
			lastSeenAt = Date.now();
			return false;
		}
		const sinceSeen = lastSeenAt === 0 ? Infinity : Date.now() - lastSeenAt;
		const childGone = !child || child.exitCode !== null || !pidAlive(pid);
		const pastGrace = Date.now() - startedAt > WINDOW_GRACE_MS;
		const pastLost = sinceSeen > WINDOW_LOST_MS;
		return childGone && pastGrace && pastLost && Date.now() - lastLaunchAt > RELAUNCH_MIN_GAP_MS;
	}

	return {
		launch,
		close,
		restart,
		needsRelaunch,
		assetsPresent,
		getPid: () => pid,
		getStartedAt: () => startedAt,
		getRestarts: () => restarts,
		electronBin: () => electronBinMemo,
	};
}

module.exports = { createWindowManager, resolveElectronBin, WINDOW_GRACE_MS, WINDOW_LOST_MS, RELAUNCH_MIN_GAP_MS };
