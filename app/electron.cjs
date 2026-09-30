/**
 * app/electron.cjs —— 打包成 exe 之后的入口（electron main）
 *
 * 一个 exe 干两件事，用命令行参数区分：
 *   pi-dsh-pet.exe                    → 起宿主（HTTP/WS 服务）+ 拉起窗进程
 *   pi-dsh-pet.exe --pi-pet-window N  → 同一个 exe 的第二个实例，只负责开那扇透明窗
 *   pi-dsh-pet.exe --no-window        → 只当服务（给 pi/dsh 连，桌面上什么都不出现）
 *   pi-dsh-pet.exe --port 47653       → 指定端口
 *   pi-dsh-pet.exe --force            → 先请退已有的宿主再起
 *
 * 为什么窗要开成第二个进程（而不是本进程开个 BrowserWindow）：
 * 透明穿透窗 + 右键菜单 + 「隐藏窗但服务留着」这三件事，在同一个进程里很难干净地拆开
 * ——窗一崩，服务跟着完蛋。分成两个进程后，窗随便崩，宿主都会按 keepAlive 把它拉回来。
 * 打包版没有 electron.exe 可 spawn，所以第二个进程就是**这个 exe 自己**。
 */

const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

/** 数据目录（与 app/paths.cjs 同一套规则；这里只为了给窗单独的 userData）。 */
function dataHome() {
	try {
		return require(path.join(__dirname, "paths.cjs")).PATHS.home;
	} catch {
		/* paths.cjs 读不到就自己算 */
	}
	if (process.env.PI_PET_HOME) return path.resolve(process.env.PI_PET_HOME);
	if (process.platform === "win32") {
		return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "pi-dsh-pet");
	}
	return path.join(os.homedir(), ".pi-dsh-pet");
}

/* ---- 1. 窗模式：直接把自己变成那扇窗 ---- */
if (process.argv.includes("--pi-pet-window")) {
	// 宿主与窗是两个 Electron 进程，却默认共用同一个 userData（%APPDATA%\pi-dsh-pet）：
	// Chromium 的 disk cache / GPU cache 被两边同时抢，窗一启动就刷一串
	//   ERROR:cache_util_win.cc(20) Unable to move the cache: 拒绝访问。 (0x5)
	//   ERROR:gpu_disk_cache.cc(713) Gpu Cache Creation failed: -2
	// 本来无害，但它会把「窗到底起来没有」的排查搅成一团（窗没起来也有一屏红字），
	// 而且 Chromium 抢缓存失败时首帧会明显变慢。给窗一个自己的 profile 就干净了。
	// ⚠️ 必须在 app ready 之前调用 setPath，晚一步就抛。
	try {
		app.setPath("userData", path.join(dataHome(), "window-profile"));
	} catch {
		/* 抢不到就算了，不影响开窗 */
	}
	// argv[2] 就是端口（pet-electron.cjs 一直读它）
	require(path.join(__dirname, "..", "pi", "assets", "pet-electron.cjs"));
} else {
	/* ---- 2. 宿主模式 ---- */
	const http = require("node:http");
	const { start, findRunning } = require("./host.cjs");

	const argv = process.argv.slice(1);
	const flagPort = Number(argv[argv.indexOf("--port") + 1]) || 0;
	const noWindow = argv.includes("--no-window");

	/** 叫已经在跑的那个宿主把窗叫出来（双击第二下 = 想看宠物）。 */
	function askRunningHostToShow() {
		try {
			const found = findRunning();
			if (!found) return;
			const st = found.state || {};
			const body = JSON.stringify({ action: "show-window" });
			const req = http.request(
				{
					host: "127.0.0.1",
					port: Number(st.port),
					path: "/control",
					method: "POST",
					timeout: 1500,
					headers: {
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
						authorization: `Bearer ${st.token || ""}`,
					},
				},
				() => {},
			);
			req.on("error", () => {});
			req.end(body);
		} catch {
			/* 叫不出来就算了 */
		}
	}

	// 单实例：让「双击两次」只出一个宠物。锁在 host 里抢（跨进程），这里只管 exe 自身。
	const gotLock = app.requestSingleInstanceLock();
	if (!gotLock) {
		askRunningHostToShow();
		app.quit();
	} else {
		app.on("second-instance", askRunningHostToShow);
		app.whenReady().then(async () => {
			const res = await start({ port: flagPort, noWindow, window: !noWindow, force: argv.includes("--force") });
			if (!res || !res.started) {
				// 已经有宿主在跑（或者抢不到锁）：把这个进程退掉，别留个空壳 exe
				// ——已经跑着的那个会把窗叫出来，这里只需要退出。
				process.exit(0);
			}
		});
	}
}
