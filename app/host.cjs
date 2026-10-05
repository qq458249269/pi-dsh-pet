/**
 * host.cjs — 宿主进程（把 server / bus / window / single 装起来）
 *
 * 这是「独立应用」的本体。它做四件事，之后就靠 2s 一拍的 tick 维持自己不散：
 *
 *   1. 抢 mkdir 单例锁 → 整机只可能有一个宿主 = 只可能有一扇窗；
 *   2. 起 127.0.0.1 的 HTTP + WS（喂窗 + 喂 pi/dsh/curl），端口写进 state.json；
 *   3. 拉起 Electron 透明窗（detached，本进程死了它也能撑到 WS 断为止）；
 *   4. tick：读 ctrl.json 的意图 → 换窗 / 自愈 / 放回空闲动画 / 刷心跳。
 *
 * 反过来，**它不属于任何 pi/dsh 进程**：父进程退出、SIGINT、Ctrl+C 都不该影响它
 * （靠调用方 spawn 时用 detached + windowsHide；本进程自己也不注册会自杀的 exit 处理，
 *  只在 exit 时释放锁与状态文件）。
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// 省电开关总闸（见 control() 开头）。false = 接口一律回「已屏蔽」。
const POWER_SAVE_ENABLED = false;

const { ENDPOINTS, ROLE, SIZES, MAX_PETS_CEILING, EVENTS } = require("./protocol.cjs");
const {
	PATHS,
	ensureHome,
	readConfig,
	writeCtrl,
	readCtrl,
	writePortFile,
	clearPortFile,
	readPositions,
	rememberPosition,
	log,
} = require("./paths.cjs");
const {
	acquireLock,
	refreshLock,
	releaseLock,
	readState,
	stateLooksAlive,
	newState,
	writeState,
	loadOrCreateToken,
	pidAlive,
} = require("./single.cjs");
const { createBus } = require("./bus.cjs");
const { createServer, listen } = require("./server.cjs");
const updater = require("./updater.cjs");

/**
 * 宿主自己是不是 Electron 主进程（打包版：pi-dsh-pet.exe 既是宿主又是窗的运行时）。
 * 是的话窗直接开在本进程（app/window-inproc.cjs），少一整套 Electron 实例 ——
 * 省两个进程（第二套的浏览器进程 + GPU 进程）和第二份 Chromium profile 缓存。
 * 纯 node（开发态 / `pi-pet serve` / CI 冒烟）没有 electron，走原来的双进程；
 * 逃生门 PI_PET_SPLIT_WINDOW=1 强制双进程（窗崩了服务还活着的老形态）。
 * ⚠️ 只换**开窗方式**：WS / HTTP / 事件总线一行没动，画质也一行没动。
 */
const FUSED_WINDOW = Boolean(process.versions.electron) && process.env.PI_PET_SPLIT_WINDOW !== "1";

const TICK_MS = 2000;
const STATE_WRITE_MIN_GAP_MS = 5000;

/** 别的宿主可能留下的状态文件（含本机旧版 pi 扩展写的那份）。
 *  作用是**别在同一台机器上开出第二只宠物**——这是历史上最难查的一类故障。
 *
 *  `PI_PET_SKIP_FOREIGN=1` 可以关掉这一层（只给测试/多实例调试用）。注意它**只**关掉
 *  外部状态文件这一层：自己 home 里的状态文件与单例锁照样生效，所以「一个 home 一只」
 *  的保证不受影响。 */
function foreignStateFiles() {
	if (process.env.PI_PET_SKIP_FOREIGN === "1") return [];
	const files = [];
	if (process.env.PI_PET_FOREIGN_STATE) files.push(process.env.PI_PET_FOREIGN_STATE);
	// 旧版 pi 扩展（pi-pet-autostart）写的位置
	files.push(path.join(os.homedir(), ".pi", "agent", "state", "pi-pet-global.json"));
	return files.filter((f) => path.resolve(f) !== path.resolve(PATHS.state));
}

/** 探一遍已存在的宿主（含旧路径），返回 [{state, file}]。 */
function probeExistingHosts() {
	const found = [];
	const own = readState();
	if (own && own.role === ROLE) found.push({ state: own, file: PATHS.state });
	for (const file of foreignStateFiles()) {
		try {
			const st = JSON.parse(fs.readFileSync(file, "utf8"));
			if (st && st.role === ROLE) found.push({ state: st, file });
		} catch {
			/* 读不到就当没有 */
		}
	}
	return found.filter((h) => stateLooksAlive(h.state));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 HTTP 调用（给“请退已有的宿主”用；不引依赖、不抛异常）。 */
function httpJSON(port, method, pathname, body, token) {
	return new Promise((resolve) => {
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: pathname,
				method,
				timeout: 1500,
				headers: {
					...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
			},
			(res) => {
				let buf = "";
				res.setEncoding("utf8");
				res.on("data", (c) => {
					buf += c;
				});
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode, body: JSON.parse(buf) });
					} catch {
						resolve({ status: res.statusCode, body: null });
					}
				});
			},
		);
		req.on("timeout", () => {
			req.destroy();
			resolve({ status: 0, body: null });
		});
		req.on("error", () => resolve({ status: 0, body: null }));
		if (payload) req.write(payload);
		req.end();
	});
}

/** 探一次某个端口上的宿主是不是还活着。 */
async function probeHealth(port) {
	const res = await httpJSON(port, "GET", ENDPOINTS.health);
	return res.status === 200 && res.body && res.body.role === ROLE ? res.body : null;
}

/**
 * `--force` 的实际动作：**先请退已有的宿主**，而不是无视它。
 * 顺序很重要：先走控制面（体面退：广播 shutdown → 窗自己关 → 宿主释放锁），
 * 3s 还不动才 taskkill 硬杀，最后清掉它的状态文件（否则新进程会以为自己撞上活宿主）。
 */
async function stopExistingHosts(list) {
	for (const h of list) {
		const st = h.state || {};
		const port = Number(st.port);
		if (port > 0) {
			log(`--force：先请退已有宿主 pid ${st.pid} :${port}`);
			await httpJSON(port, "POST", ENDPOINTS.control, { action: "shutdown" }, st.token || "");
		}
		for (let i = 0; i < 15; i++) {
			await sleep(200);
			if (st.pid && !pidAlive(st.pid)) break;
			if (port > 0 && !(await probeHealth(port))) break;
		}
		// 还活着就硬杀（只杀确认是宠物宿主的 pid）
		if (st.pid && pidAlive(st.pid)) {
			log(`--force：pid ${st.pid} 不肯退，硬杀`);
			try {
				if (process.platform === "win32") spawn("taskkill", ["/pid", String(st.pid), "/f", "/t"], { windowsHide: true });
				else process.kill(st.pid, "SIGKILL");
			} catch {
				/* 杀不掉就算了，下面的状态文件清理照做 */
			}
			await sleep(400);
		}
		try {
			fs.rmSync(h.file, { force: true });
		} catch {
			/* ignore */
		}
	}
}

/**
 * 起宿主。
 * @param {object} options
 *   port        期望端口（默认配置 47653，被占退随机）
 *   noWindow    只起服务不起窗
 *   insecure    关闭 token 校验
 *   force       即使已经有别的宿主在跑也照起（会**先请退旧的那个**，不是无视它）
 *   foreground  前台运行（不 detach，由调用方决定）—— 本函数永远前台，日志更全
 */
async function start(options = {}) {
	ensureHome();

	const cfg = readConfig();
	const wantNoWindow = options.noWindow !== undefined ? options.noWindow : cfg.noWindow;
	const insecure = options.insecure !== undefined ? options.insecure : cfg.insecure;

	/* ---- 1. 已经有人在跑？ ---- */
	const existing = probeExistingHosts();
	if (existing.length > 0) {
		if (!options.force) {
			const h = existing[0];
			log(`已经有宠物宿主在跑（pid ${h.state.pid} :${h.state.port}，状态文件 ${h.file}），本进程不重复起`);
			return { started: false, existing: h.state, reason: "already-running" };
		}
		await stopExistingHosts(existing);
	}

	/* ---- 2. 抢单例锁（与「已存在」检查互补：文件状态可能刚被别人写坏）---- */
	const lock = acquireLock();
	if (!lock.ok) {
		const owner = lock.owner || {};
		log(`抢不到单例锁（owner pid ${owner.pid}），本进程安静退出`);
		return { started: false, existing: owner, reason: "locked" };
	}

	/* ---- 3. 组装 ---- */
	const token = loadOrCreateToken();
	const state = newState({ token, port: 0 });
	const ctrl = () => {
		// 意图文件优先于本地配置：客户端（pi/dsh 的开关）比宿主自己更懂用户要什么
		const c = readCtrl();
		return { ...c, port: state.port, maxPets: Number(c.maxPets) || cfg.maxPets || 1 };
	};

	// bus 与 onStateChange 互相需要（一个要写状态文件，一个要读 bus 统计），
	// 所以先给 hooks 一个空壳，拿到 bus 之后再回填（hooks 是活对象，每次现读）。
const busHooks = { onStateChange: () => {}, maxPets: () => 1, paused: () => false, positions: () => readPositions(), power: () => false };
	const bus = createBus(busHooks);

const win = (FUSED_WINDOW ? require("./window-inproc.cjs") : require("./window.cjs")).createWindowManager({
		// 窗靠 PI_PET_TOKEN 拿到权威口令（不要让它自己去 home 里猜）
		token,
		onWindowChange: (patch) => Object.assign(state, patch),
	});

	const onStateChange = () => {
		const s = bus.stats();
		state.clients = s.clients;
		state.feeds = s.feeds;
		state.petState = s.state;
		state.windowState =
			s.clients > 0 ? "connected" : state.windowState === "connected" ? "disconnected" : state.windowState;
		writeState(state);
	};

	busHooks.onStateChange = onStateChange;
	busHooks.maxPets = () => Number(readCtrl().maxPets) || cfg.maxPets || 1;
busHooks.paused = () => readCtrl().paused === true;
	busHooks.power = () => readCtrl().powerSave === true;

	// 更新信息（「关于」框和 /state 看它）：开机先从 home/update.json 里读上次的结果，
	// 之后由 check-update / do-update / 自动检查刷新。
	// ⚠️ 必须在 createServer **之前**声明：server 一 listen 就可能收到请求，
	//    而 control() 里要用它 —— 晚于监听声明 = 那一下请求吃到 TDZ。
	let updateInfo = updater.readUpdateInfo(PATHS.home);

	const onWsConnection = (conn, req) => bus.handleConnection(conn, req);

	const { server } = createServer({
		bus,
		state,
		token,
		tokenPath: PATHS.token,
		insecure,
		ctrl,
		control: (action, body) => control(action, body),
		onWsConnection,
	});

	/* ---- 4. 监听 ---- */
	let port;
	/** uncaughtException 累计次数（只给 handler 里的“闭嘴上限”用，见下方监听器）。 */
	let fatalLogged = 0;
	try {
		port = await listen(server, Number(options.port) || cfg.port);
	} catch (err) {
		releaseLock();
		log(`监听失败：${err && err.message ? err.message : err}`);
		return { started: false, reason: "listen-failed", error: String(err && err.message) };
	}
	bus.setPort(port);
	state.port = port;
	state.size = readCtrl().size || cfg.size;
	state.pkg = require("./paths.cjs").PKG_ROOT;
	// 端口写进 home/port：pi 扩展 / dsh 插件 / 外部脚本读这一行就能连上，
	// 不用 spawn `pi-pet status`、也不用赌 47653 没被占。
	writePortFile(port);

	/* ---- 5. 生命周期 ---- */
	let stopping = false;
	function shutdown(code = 0, { withWindow = true } = {}) {
		if (stopping) return;
		stopping = true;
		clearInterval(ticker);
		if (withWindow) {
			// 先告诉窗「自己关」，给它 250ms 走完 close 流程，再补一刀 taskkill
			bus.broadcast(EVENTS.shutdown);
			setTimeout(() => {
				win.close();
				finish(code);
			}, 250);
		} else {
			finish(code);
		}
	}
	function finish(code) {
		try {
			server.close();
		} catch {
			/* ignore */
		}
		// WS 连接跟着 http server 一起收（attachWebSocket 挂了 close 钩子）
		for (const c of bus.windowClients) {
			try {
				c.close(1001, "host shutdown");
			} catch {
				/* ignore */
			}
		}
		state.windowState = "stopped";
		writeState(state);
		// 状态文件删掉：留着会让客户端以为「还有个宿主在跑」（心跳过期前它们都这么以为）
		try {
			fs.rmSync(PATHS.state, { force: true });
		} catch {
			/* 删不掉就靠心跳过期 */
		}
		clearPortFile(port);
		releaseLock();
		log(`宿主退出（code ${code}）`);
		process.exit(code);
	}

	process.on("SIGINT", () => shutdown(0));
	process.on("SIGTERM", () => shutdown(0));
	// 硬退出（被 taskkill / 崩溃）时至少把锁还回去，别让下个宿主等 TTL
	process.on("exit", () => {
		// 硬退出（taskkill / 崩溃）也要留痕。finish() 走过的话 state 已是 stopped，不重复记。
		if (state.windowState !== "stopped") log(`宿主退出（code ${process.exitCode || 0}）`);
		releaseLock();
		clearPortFile(port);
		try {
			fs.rmSync(PATHS.state, { force: true });
		} catch {
			/* ignore */
		}
	});
	process.on("uncaughtException", (err) => {
		// 服务已经起来了就别自杀，只记一笔（窗还能继续用）。
		// 但**这个处理器自己再抛**就变成自触发死循环（log → 写 stderr → 异步 EPIPE → 又进来），
		// 所以加个上限：前 20 条照记，之后闭嘴（否则日志会被同一份栈刷满，真因第一条反而没了）。
		fatalLogged++;
		if (fatalLogged > 20) return;
		log(`未捕获异常：${err && err.stack ? err.stack : err}`);
	});

/* ---- 6. 控制动作 ---- */
	function control(action, body = {}) {
		const arg = body || {};
		// ⚠️ 省电模式暂时屏蔽（2026-10，用户口径：宠物就该一直动，空闲也照常放）。
		//   底下 power-save / set-ctrl{powerSave} 的实现都还在，改成 true 就原样回来；
		//   窗侧的 applyPowerFrame、power 帧、ctrl.json 的 powerSave 也一并留着没删。
		if (!POWER_SAVE_ENABLED && (action === "power-save" || typeof arg.powerSave === "boolean")) {
			return { ok: false, error: "省电模式暂时屏蔽（宠物一直动）", hint: "窗最小化 / 锁屏 / 挂起仍会自动停" };
		}
		switch (action) {
			case "shutdown":
			case "stop":
				shutdown(0);
				return { ok: true, detail: "正在退出" };
			case "restart-window":
			case "restart":
				win.restart(arg.size || readCtrl().size || cfg.size, state.port, () => readCtrl().desired !== false);
				return { ok: true, detail: "换一扇窗（1.5s 后）" };
			case "add-pet":
				if ((Number(readCtrl().maxPets) || cfg.maxPets || 1) <= 1) {
					return { ok: false, error: "max-pets=1，加不了第二只（改 ctrl.json 的 maxPets 或 config.json）" };
				}
				bus.broadcast(`${EVENTS.addPet}${SIZES.includes(arg.size) ? `:${arg.size}` : ""}`);
				return { ok: true, detail: "已要求加一只" };
			case "drop-pets":
				// 窗侧没有「删掉除第一只以外所有只」的命令；靠换窗达到同样效果
				win.restart(arg.size || readCtrl().size || cfg.size, state.port, () => true);
				return { ok: true, detail: "换一扇窗（多余的只随旧窗一起没）" };
case "say":
				return bus.say(arg.text, Number(arg.ms) || 0);
			case "power-save": {
				// 省电模式：把动画冻在当前帧（不产生新帧 → 不抢别的窗口的合成预算）。
				// 落盘 ctrl.json：换窗、重启都还保持着，直到用户自己关掉。
				const on = arg.on === true || arg.sleep === true || arg.powerSave === true;
				writeCtrl({ powerSave: on });
				bus.setPower(on);
				return { ok: true, detail: on ? "省电模式已开（动画冻住，气泡文字照常）" : "已退出省电模式" };
			}
			case "pause":
			case "resume": {
				const next = action === "pause";
				writeCtrl({ paused: next });
				// 恢复时先把会话状态重新算一遍（否则要等下一个事件才动）
				if (!next) bus.drive();
				return { ok: true, detail: next ? "已暂停响应（宠物不再跟着 agent 状态变）" : "已恢复响应" };
			}
			case "hide-window":
				// 服务留着、窗收起来。不做成「连服务一起退」：退服务就没有端口可以再被
				// pi/dsh 调了，那正是独立应用存在的意义。
				writeCtrl({ window: false });
				win.close();
				return { ok: true, detail: "窗已收起来（服务还在，pi-pet show 恢复）" };
			case "show-window": {
				writeCtrl({ window: true });
				if (bus.windowClients.size > 0) return { ok: true, detail: "窗已经在跑" };
				win.launch(arg.size || readCtrl().size || cfg.size, state.port);
				return { ok: true, detail: "窗已拉起" };
			}
			case "set-ctrl": {
				const patch = {};
				if (typeof arg.desired === "boolean") patch.desired = arg.desired;
				if (typeof arg.keepAlive === "boolean") patch.keepAlive = arg.keepAlive;
				if (typeof arg.paused === "boolean") patch.paused = arg.paused;
				if (typeof arg.window === "boolean") patch.window = arg.window;
if (SIZES.includes(arg.size)) patch.size = arg.size;
				if (typeof arg.powerSave === "boolean") patch.powerSave = arg.powerSave;
				if (Number.isInteger(arg.maxPets) && arg.maxPets >= 1 && arg.maxPets <= MAX_PETS_CEILING) {
					patch.maxPets = arg.maxPets;
				}
				if (Number.isInteger(arg.restartNonce)) patch.restartNonce = arg.restartNonce;
const next = writeCtrl(patch);
				// powerSave 也走 set-ctrl 时要立刻告诉窗（否则菜单/API 改了，画面上没反应）
				if (typeof arg.powerSave === "boolean") bus.setPower(arg.powerSave);
				return { ok: true, detail: "意图已更新", ctrl: next };
			}
			case "set-position": {
				// 窗里拖完报上来的落点（比例）。落盘 home/positions.json，下次启动就在那儿。
				const id = String(arg.id || "").trim();
				if (!id) return { ok: false, error: "set-position 缺 id" };
const map = rememberPosition(id, arg.rx, arg.ry, arg.w, arg.h);
				if (!Object.prototype.hasOwnProperty.call(map, id)) {
					return { ok: false, error: "set-position 的坐标不合法（要 0~1 的数字）" };
				}
				return { ok: true, detail: "位置已记住" };
			}
			case "state":
				return { ok: true, detail: "当前状态", state: ctx.state, ctrl: readCtrl(), bus: bus.stats() };
			case "check-update":
				// 查更新是异步的（要 fetch 远端）：server 那头已经 await 了（见 server.cjs）。
				// ⚠️ 别用 spawnSync —— 宿主就是这个 HTTP/WS 服务，卡住几分钟等于全机断网。
				return updater.check().then((r) => {
					updateInfo = { ...updateInfo, ...updateSummary(r), lastCheck: Date.now() };
					return updateResult(r, "检查完了");
				});
			case "do-update":
				return updater.apply().then((ap) => {
					if (!ap.ok) return updateResult(ap, "没更成");
					// 换了渲染层的代码 → 换一扇窗，1.5s 后新代码接管
					if (ap.changed !== false) {
						win.restart(readCtrl().size || cfg.size, state.port, () => readCtrl().desired !== false);
					}
					updateInfo = { ...updateInfo, ...updateSummary(ap), lastApplied: Date.now() };
					return updateResult({ ...ap, hasUpdate: false }, "更新完成", true);
				});
			case "release-lock":
				releaseLock();
				return { ok: true, detail: "锁已释放" };
			default:
				return {
					ok: false,
error: `未知 action：${action}`,
					hint:
"可用：shutdown | restart-window | add-pet | drop-pets | say | pause | resume | " +
						(POWER_SAVE_ENABLED ? "power-save | " : "") +
						"hide-window | show-window | set-ctrl | set-position | check-update | do-update | " +
						"state | release-lock",
				};
		}
	}

	/** 把 updater 的结果拼成控制面回包（菜单/对话框直接吃这个形状）。 */
	function updateResult(r, prefix, okOverride) {
		const ok = okOverride === undefined ? r.ok === true : okOverride === true;
		return {
			ok,
			detail: `${prefix}：${r.note || (r.hasUpdate ? "有新版" : "已是最新")}`,
			update: { ...updateSummary(r), hasUpdate: r.hasUpdate === true, note: r.note || "" },
		};
	}

/**
	 * updater 的原始结果 → 给 /state / 关于框看的那份摘要。
	 * ⚠️ 空串的键**要丢掉**（返回 undefined 而不是 ""）：apply() 只回 {ok,mode,note,changed}，
	 *    直接铺开会用空串盖掉 check 阶段拿到的 version/current —— 表现是「刚更新完，
	 *    关于框里的提交号和 /state 的版本突然空了」。
	 *global/behind 是布尔/数字，默认值本身就是安全方向（不自动代劳 / 落后 0），所以留着。
	 */
	function updateSummary(r) {
		const s = {
			mode: r.mode || "",
			global: r.global === true,
			version: r.version || "",
			current: r.current || "",
			latest: r.latest || "",
			behind: Number(r.behind) || 0,
		};
		for (const k of ["mode", "version", "current", "latest"]) if (!s[k]) delete s[k];
		return s;
	}

	/* ---- 7. 心跳 tick ---- */
	let lastRestartNonce = Number(readCtrl().restartNonce) || 0;
	let lastStateWrite = 0;
	const ticker = setInterval(() => {
		const c = readCtrl();
		// 意图是「不要宠物」：广播 shutdown、关窗、放手走人（下次 start 会重新拉起）
		if (c.desired === false) {
			log("ctrl 说不要宠物了 → 关窗退出");
			shutdown(0);
			return;
		}
		// restartNonce 变了 = 有人要换一扇窗。由**宿主自己**关旧窗再拉新的：
		// 客户端不该伸手 taskkill —— 那样宿主会以为窗还在，keepAlive 又拉一只。
		const nonce = Number(c.restartNonce) || 0;
		if (nonce !== lastRestartNonce) {
			lastRestartNonce = nonce;
			log("ctrl.restartNonce 变了 → 换一扇窗");
			win.restart(c.size || cfg.size, state.port, () => readCtrl().desired !== false);
			return;
		}
		if (c.size) state.size = c.size;

		// 续锁：主人的心跳就是「我还占着这台机器」
		refreshLock();

		// 卡在忙碌态的会话（pi 被硬杀）→ 丢掉并把宠物放回空闲
		bus.reapStaleSessions();

		// 忙碌期间定期给气泡续期（只发文字帧 → 不碰动画 → 不重播）
		bus.refreshBubbles();

		if (!wantNoWindow && readCtrl().window !== false) {
			const connected = bus.windowClients.size > 0;
			if (connected) {
				if (state.windowState !== "connected") {
					state.windowState = "connected";
					writeState(state);
				}
			} else if (win.needsRelaunch(false)) {
				if (c.keepAlive === false) {
					if (state.windowState !== "no-window") {
						state.windowState = "no-window";
						writeState(state);
					}
				} else {
					log("窗没了（keepAlive）→ 重新拉起");
					win.launch(c.size || cfg.size, state.port);
				}
			} else if (state.windowState !== "starting" && state.windowState !== "connected") {
				state.windowState = "no-window";
			}
		} else {
			state.windowState = "disabled";
		}

		if (Date.now() - lastStateWrite > STATE_WRITE_MIN_GAP_MS) {
			lastStateWrite = Date.now();
			const s = bus.stats();
			state.clients = s.clients;
			state.feeds = s.feeds;
			state.feedsBySource = s.feedsBySource;
			state.petState = s.state;
			state.busySessions = s.busySessions;
			state.restarts = win.getRestarts();
			state.windowPid = win.getPid();
			state.electron = win.electronBin() || "";
			state.update = { ...updateInfo };
			writeState(state);
		}
	}, TICK_MS);
	ticker.unref?.();

	/* ---- 8. 开张 ---- */
	state.windowState = wantNoWindow ? "disabled" : "starting";
	state.restarts = win.getRestarts();
	state.petState = "idle";
	writeState(state);

	if (wantNoWindow) {
		log(`宿主已起（仅服务，不起窗）：127.0.0.1:${port}  pid ${process.pid}  端口文件 ${PATHS.port}`);
	} else {
		log(`宿主已起：127.0.0.1:${port}  pid ${process.pid}  home=${PATHS.home}  端口文件 ${PATHS.port}`);
		win.launch(state.size, port);
	}

	// 启动后自动检查更新，有新版就装上（延迟一会儿，别抢起窗的 IO；6h 内不重复查）。
	// ⚠️ 只换**窗**：宿主是 detached 的、没人负责再拉起它，它自己不能重启；
	//    app/* 的新代码要等下次 `pi-pet restart`（这点在对话框里也写给用户）。
	updater.autoUpdate(PATHS.home, {
		log,
		onUpdated: () => {
			log("更新完了 → 换一扇窗（渲染层立刻用上新代码）");
			win.restart(readCtrl().size || cfg.size, state.port, () => readCtrl().desired !== false);
		},
	}).catch(() => { /* 失败已经落过日志了 */ });

	return {
		started: true,
		port,
		pid: process.pid,
		token,
		state,
		bus,
		server,
		window: win,
		shutdown,
		control,
	};
}

/** 本进程是不是已经有宿主在跑（status 命令用）。 */
function findRunning() {
	const own = readState();
	if (own && stateLooksAlive(own)) return { state: own, file: PATHS.state };
	for (const file of foreignStateFiles()) {
		try {
			const st = JSON.parse(fs.readFileSync(file, "utf8"));
			if (st && st.role === ROLE && stateLooksAlive(st)) return { state: st, file };
		} catch {
			/* ignore */
		}
	}
	return null;
}

module.exports = { start, findRunning, probeExistingHosts, foreignStateFiles, TICK_MS, ENDPOINTS, pidAlive };
