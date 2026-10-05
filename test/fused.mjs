/**
 * test/fused.mjs — 融合开窗：宿主与窗住在**同一个** Electron 进程里
 *
 * 为什么要钉：省一整套 Electron 实例（第二套的浏览器进程 + GPU 进程 + 第二份
 * profile 缓存）是这次优化的大头；而它**不出错的时候什么都不明显**——窗照常在、
 * 宠物照常动，只是没人再提醒你「多了一整套实例」。所以这里用桩 electron 把
 * 「同进程开窗」这条路整个走一遍：
 *
 *   ① 不 spawn 任何子进程（进程数真的少了）；
 *   ② closeWindow 只关窗，**不退应用**（hide-window 之后服务还得留着）；
 *   ③ 同进程重开一次窗，ipcMain 监听器**不许翻倍**（翻倍 = 右键弹两次菜单）。
 *
 * 跑：node test/fused.mjs（无 electron 依赖，纯桩）
 */

import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);

let pass = 0;
const failures = [];
function check(label, ok, detail = "") {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		failures.push(`${label}${detail ? ` —— ${detail}` : ""}`);
		console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
	}
}

/* ---------------- 桩 electron（只需要窗这条路上真用到的东西） ---------------- */

const winOpts = [];
const ipc = new Map(); // channel -> listener 数组（ipcMain）
const screenEv = new Map();

function onTo(map, ev, fn) {
	if (!map.has(ev)) map.set(ev, []);
	map.get(ev).push(fn);
}
function offAll(map, ev) {
	map.delete(ev);
}

let quitCalls = 0;

class FakeWebContents {
	constructor(win) {
		this.win = win;
	}
	send() {}
	invalidate() {}
	focus() {}
	on() {}
	once() {}
	loadURL(u) {
		this.win.loadedUrl = u;
	}
}

class FakeBrowserWindow {
	constructor(opts = {}) {
		this.opts = opts;
		this.destroyed = false;
		this.visible = true;
		this.pos = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 0, height: opts.height || 0 };
		this.handlers = new Map();
		this.webContents = new FakeWebContents(this);
		winOpts.push(opts);
	}
	on(ev, fn) {
		onTo(this.handlers, ev, fn);
		return this;
	}
	once(ev, fn) {
		return this.on(ev, fn);
	}
	emit(ev, ...a) {
		for (const fn of this.handlers.get(ev) || []) fn(...a);
	}
	isDestroyed() {
		return this.destroyed;
	}
	isVisible() {
		return this.visible;
	}
	isMinimized() {
		return false;
	}
	getBounds() {
		return { ...this.pos };
	}
	getContentBounds() {
		return { ...this.pos };
	}
	getPosition() {
		return [this.pos.x, this.pos.y];
	}
	setBounds(b) {
		this.pos = { ...this.pos, ...b };
	}
	setPosition(x, y) {
		this.pos.x = x;
		this.pos.y = y;
	}
	setShape() {}
	setIgnoreMouseEvents() {}
	setAlwaysOnTop() {}
	setFocusable() {}
	setFocusableOnMac() {}
	showInactive() {}
	focus() {}
	blur() {}
	loadURL(u) {
		this.loadedUrl = u;
	}
	close() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("closed");
	}
}

const fakeElectron = {
	app: {
		commandLine: { appendSwitch() {} },
		whenReady: () => Promise.resolve(),
		on() {},
		once() {},
		setPath() {},
		getPath: () => ROOT,
		quit() {
			quitCalls++;
		},
		exit() {},
		relaunch() {},
	},
	BrowserWindow: FakeBrowserWindow,
	Menu: { buildFromTemplate: () => ({ popup() {} }) },
	dialog: { showMessageBox: async () => ({ response: 0 }) },
	shell: { openExternal() {}, openPath() {} },
	clipboard: { writeText() {} },
	screen: {
		getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
		getAllDisplays: () => [],
		getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
		getCursorScreenPoint: () => ({ x: 0, y: 0 }),
		on(ev, fn) {
			onTo(screenEv, ev, fn);
		},
		removeAllListeners(ev) {
			offAll(screenEv, ev);
		},
	},
	ipcMain: {
		on(ev, fn) {
			onTo(ipc, ev, fn);
		},
		once(ev, fn) {
			onTo(ipc, ev, fn);
		},
		removeAllListeners(ev) {
			if (ev) ipc.delete(ev);
			else ipc.clear();
		},
		eventNames: () => [...ipc.keys()],
	},
	powerMonitor: {
		on() {},
		removeAllListeners() {},
	},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "electron") return fakeElectron;
	return origLoad.call(this, request, parent, isMain);
};

/* ---------------- 跑一遍宿主在 Electron 里会走的那条路 ---------------- */

// 宽限期/重拉节流调到 0：单测里等不了 20s（真值不变，只是让「判死」立刻成立）
process.env.PI_PET_WINDOW_GRACE_MS = "0";
process.env.PI_PET_RELAUNCH_GAP_MS = "0";
const PORT = 47653;

console.log("\n融合开窗（宿主与窗同一个 Electron 进程）…");
const { createWindowManager } = req("../app/window-inproc.cjs");

// app/window-inproc.cjs 只在宿主是 Electron 主进程时被 require；这里直接点它。
check("融合窗管理器是纯 require（不 spawn 子进程）", !/\bspawn\s*\(/.test(readFileSync(path.join(ROOT, "app", "window-inproc.cjs"), "utf8")));

const states = [];
const win = createWindowManager({ token: "tok-test", onWindowChange: (p) => states.push(p) });
check("开窗", win.launch("normal", PORT) === true);
await new Promise((r) => setImmediate(r)); // app.whenReady 的 then 跑完，窗才真的造出来

check("窗确实在本进程造出来了（没有第二个 Electron 实例）", winOpts.length === 1 && winOpts[0].transparent !== undefined);
check("窗装的是宿主那个端口的页面", winOpts.length === 1);
const created = winOpts[0];
check("窗照旧是那扇小透明置顶窗（画质参数一字未动）", created.transparent === true && created.alwaysOnTop === true && created.width === 620 && created.height === 560, JSON.stringify({ t: created.transparent, a: created.alwaysOnTop, w: created.width }));
check("渲染进程仍拿 token（PI_PET_TOKEN）", process.env.PI_PET_TOKEN === "tok-test");
check("pid 就是本进程（没有独立窗 pid）", win.getPid() === process.pid);
check("关掉这扇窗后不算已关（同进程还在服务）", win.needsRelaunch(false) === false);

const menuCount1 = (ipc.get("pet:menu") || []).length;
check("右键菜单监听器只挂了一个（不是每开一次窗多一份）", menuCount1 === 1, `pet:menu×${menuCount1}`);

check("close 关掉窗", win.close() === true && quitCalls === 0, `quit=${quitCalls}`);
check("关窗不退应用（hide-window 之后 HTTP/WS 服务还在）", quitCalls === 0);
await new Promise((r) => setTimeout(r, 5)); // close() 会重算宽限期（与双进程同口径）
check("窗没了 → 判定该重拉（宿主 keepAlive 那条路）", win.needsRelaunch(false) === true);
check("有客户端时不判重拉", win.needsRelaunch(true) === false);
check("pid 归零", win.getPid() === 0);

// 再开一扇（= show-window）：这才是「同进程重复调用」的那条路
check("同进程再开一扇窗", win.launch("normal", PORT) === true);
await new Promise((r) => setImmediate(r));
const menuCount2 = (ipc.get("pet:menu") || []).length;
check("重开窗后菜单监听器仍是 1（没翻倍 —— 否则右键弹两次菜单）", menuCount2 === 1, `pet:menu×${menuCount2}`);
check("重开窗后确实多了一扇新窗（旧的已关）", winOpts.length === 2);
check("状态回调报了 pid=本进程 / 关窗报 0", states.some((s) => s.windowPid === process.pid) && states.some((s) => s.windowPid === 0));

// 独立窗进程那条路没被拆掉（打包版双击第二个实例仍走 argv）
const petMain = readFileSync(path.join(ROOT, "pi", "assets", "pet-electron.cjs"), "utf8");
check("独立窗进程仍由 argv 触发（--pi-pet-window 那条路保留）", /process\.argv\.includes\("--pi-pet-window"\)/.test(petMain));
check("同进程下 window-all-closed 不退（服务要留着）", /else \{\s*\/\/ ⚠️ Electron 的默认行为[\s\S]{0,300}window-all-closed[\s\S]{0,120}e\.preventDefault\(\)/.test(petMain));

Module._load = origLoad;
console.log(`\n${failures.length === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
	console.log(`失败项：\n  - ${failures.join("\n  - ")}`);
	process.exit(1);
}