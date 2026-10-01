/**
 * paths.cjs — 数据目录、配置、日志
 *
 * 独立应用的第一件事就是**不再依赖 pi 的目录**：所有状态落在自己的 home 里，
 * 谁来调（pi / dsh / curl）都读同一份。
 *
 * 目录选择：`$PI_PET_HOME` > Windows `%APPDATA%/pi-dsh-pet` > `~/.pi-dsh-pet`。
 * 里面放：state.json（宿主写的全局状态）/ port（**只要一个端口号，纯文本，给脚本读**）
 *        / ctrl.json（意图）/ config.json / host.lock/（单例锁）/ token（REST 鉴权）
 *        / positions.json（窗里拖到哪儿，下次启动还在那儿）/ electron.json（记住 electron.exe）
 *        / log.txt
 *
 * 为什么专门再写一个 port 文件：state.json 是给本项目的代码读的（带心跳、角色、版本），
 * 而 pi 扩展 / dsh 插件 / 用户自己的脚本只想知道「现在该连哪个端口」。47653 被占时宿主
 * 会退到随机端口，这时写死 47653 的调用方就永远连不上 —— 读这个文件才对。
 * 内容就是 `47653\n` 这种一行，`cat` / `$(<port)` / `readFileSync` 都能直接用。
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MAX_PETS_CEILING, SIZES, sanitizePositions } = require("./protocol.cjs");

/** 包根目录：app/ 的上一层。装机后是 <npm 全局>/node_modules/pi-dsh-pet。 */
const PKG_ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(PKG_ROOT, "pi", "assets");
const THUMB_DIR = path.join(PKG_ROOT, "assets", "thumb");
const CONFIG_JSONC = path.join(PKG_ROOT, "assets", "config.jsonc");
const ELECTRON_SCRIPT = path.join(ASSETS_DIR, "pet-electron.cjs");

function defaultHome() {
	if (process.env.PI_PET_HOME) return path.resolve(process.env.PI_PET_HOME);
	if (process.platform === "win32") {
		const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
		return path.join(base, "pi-dsh-pet");
	}
	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Application Support", "pi-dsh-pet");
	}
	return path.join(os.homedir(), ".pi-dsh-pet");
}

const HOME = defaultHome();

const PATHS = {
	home: HOME,
	state: path.join(HOME, "state.json"),
	port: path.join(HOME, "port"),
	ctrl: path.join(HOME, "ctrl.json"),
	config: path.join(HOME, "config.json"),
	token: path.join(HOME, "token"),
	lock: path.join(HOME, "host.lock"),
	log: path.join(HOME, "log.txt"),
	positions: path.join(HOME, "positions.json"),
	electronMemo: path.join(HOME, "electron.json"),
};

function ensureHome() {
	fs.mkdirSync(HOME, { recursive: true });
	return HOME;
}

/* ============================== 端口文件 ============================== */

/**
 * 把真正监听的端口写成一行纯文本。
 *
 * ⚠️ 端口是**运行期**才知道的：配置里的 47653 被占时 listen() 会退到随机端口。
 * 只写 state.json 的话，pi 扩展要 spawn 一次 `pi-pet status --json` 才能知道端口，
 * dsh 插件和外部脚本更拿不到 —— 所以给它们一个「读一行就是端口」的文件。
 * 走临时文件 + rename：Windows 的 rename 不能覆盖已存在的目标，直接写会读到半行。
 */
function writePortFile(port) {
	const n = Number(port);
	if (!Number.isInteger(n) || n <= 0 || n > 65535) return false;
	ensureHome();
	const tmp = `${PATHS.port}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, `${n}\n`, "utf8");
		fs.rmSync(PATHS.port, { force: true });
		fs.renameSync(tmp, PATHS.port);
		return true;
	} catch {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		return false;
	}
}

/** 读端口文件（宿主没跑 / 文件是别人留下的就返回 0）。 */
function readPortFile() {
	try {
		const n = Number(fs.readFileSync(PATHS.port, "utf8").trim());
		return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
	} catch {
		return 0;
	}
}

/**
 * 退出时清掉端口文件。
 * 只在文件里写的还是**自己的**端口时才删：同一台机器上万一有另一个宿主刚起来
 * （换 home 跑、或测试里连着起停），不能把人家的端口文件顺手删了。
 */
function clearPortFile(port) {
	try {
		const cur = readPortFile();
		if (cur && Number(port) && cur !== Number(port)) return false;
		fs.rmSync(PATHS.port, { force: true });
		return true;
	} catch {
		return false;
	}
}

/* ============================== 配置 ============================== */

const CONFIG_DEFAULTS = {
	/** 期望端口（全局共享的固定端口）。被占就退随机空闲端口，真实端口写进 state.json。 */
	port: 47653,
	/** 窗自己没了要不要被重新拉起 */
	keepAlive: true,
	/** 机器级同时几只（1 = 只留一只，add_pet 在这层被丢掉） */
	maxPets: 1,
	/** 默认尺寸档位（只对 add_pet:<size> 与换窗时的记录有意义） */
	size: "normal",
	/** 只起服务不起窗（无头模式：给 CI / 远程 / 只想喂事件的人用） */
	noWindow: false,
	/** 关掉 token 校验（只在同机多人共用的开发环境里临时开） */
	insecure: false,
	/** 单实例抢不到锁时：true = 安静退出（默认，交给先起的那位）；false = 报错退出 */
	attachInsteadOfExit: true,
};

function readConfig() {
	try {
		const raw = JSON.parse(fs.readFileSync(PATHS.config, "utf8"));
		if (!raw || typeof raw !== "object") return { ...CONFIG_DEFAULTS };
		const cfg = { ...CONFIG_DEFAULTS };
		if (Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536) cfg.port = raw.port;
		if (typeof raw.keepAlive === "boolean") cfg.keepAlive = raw.keepAlive;
		if (Number.isInteger(raw.maxPets) && raw.maxPets >= 1 && raw.maxPets <= MAX_PETS_CEILING) {
			cfg.maxPets = raw.maxPets;
		}
		if (SIZES.includes(raw.size)) cfg.size = raw.size;
		if (typeof raw.noWindow === "boolean") cfg.noWindow = raw.noWindow;
		if (typeof raw.insecure === "boolean") cfg.insecure = raw.insecure;
		if (typeof raw.attachInsteadOfExit === "boolean") cfg.attachInsteadOfExit = raw.attachInsteadOfExit;
		return cfg;
	} catch {
		return { ...CONFIG_DEFAULTS };
	}
}

function writeConfig(patch) {
	const next = { ...readConfig(), ...patch };
	ensureHome();
	fs.writeFileSync(PATHS.config, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

/* ============================== 意图文件 ============================== */

/**
 * ctrl.json 是**客户端写、宿主读**的意图通道（`desired` / `keepAlive` / `size` /
 * `maxPets` / `restartNonce`）。保留它是为了让 pi 扩展的既有开关
 * （`/pet-auto on|off|restart|size`）在宿主化之后仍然有效——那是跨进程的契约，不该改形状。
 */
const CTRL_DEFAULTS = {
	desired: true,
	keepAlive: true,
	maxPets: 1,
	size: "normal",
	restartNonce: 0,
/** 暂停响应：宠物继续自己玩，但不跟着 agent 状态变（右键菜单切）。 */
	paused: false,
	/** 省电模式：把动画冻在当前那一帧（右键菜单切）。窗是全屏透明置顶的，
	 *  每产生一帧 DWM 都要重算整块桌面 —— 不动就不会抢别的窗口的渲染预算。 */
	powerSave: false,
	/** 要不要开着窗（false = 服务留着、窗收起来；pi-pet show 恢复）。 */
	window: true,
};

function readCtrl() {
	try {
		const raw = JSON.parse(fs.readFileSync(PATHS.ctrl, "utf8"));
		return { ...CTRL_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
	} catch {
		return { ...CTRL_DEFAULTS };
	}
}

/** 合并写（只改给的那几个字段）：多个客户端同时写别互相清空。 */
function writeCtrl(patch) {
	ensureHome();
	const next = { ...readCtrl(), ...patch };
	const tmp = `${PATHS.ctrl}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	// Windows 的 rename 不能覆盖已存在的目标（EPERM），先删再改名
	try {
		fs.rmSync(PATHS.ctrl, { force: true });
	} catch {
		/* 删不掉就让下面的 rename 报错 */
	}
	fs.renameSync(tmp, PATHS.ctrl);
	return next;
}

/* ============================== 位置记忆 ============================== */

/**
 * home/positions.json —— 窗里拖到哪儿，下次启动还在那儿。
 *
 * 存的是**比例**（rx/ry，相对窗口宽高）而不是像素：换分辨率、换尺寸、换显示器之后
 * 仍然落在同一个「地方」，而不是停在旧分辨率下的某个绝对坐标（跑到屏外就再也看不见）。
 * 键是 config.jsonc 里的宠物 id；文件坏掉/不认识时回落到空表 = 回到默认角落。
 */
function readPositions() {
	try {
		const raw = JSON.parse(fs.readFileSync(PATHS.positions, "utf8"));
		return sanitizePositions(raw && typeof raw === "object" ? raw.map || raw : null);
	} catch {
		return {};
	}
}

/** 合并写（只改给的那一只）：多只/多客户端同时拖不互相清空。
 *  w/h 是「存的时候窗多大」：舞台窗尺寸会变（配置改了 / 版本改了 / DPI 变了），
 *  窗内比例的含义跟着变，不把它一起存下来，下次启动宠物就会被比例拽得平移一截（§9.23）。 */
function rememberPosition(id, rx, ry, w, h) {
	const key = String(id || "").trim();
	const next = sanitizePositions({ ...readPositions(), [key]: { rx, ry, w, h } });
	if (!Object.prototype.hasOwnProperty.call(next, key)) return {};
	ensureHome();
	fs.writeFileSync(PATHS.positions, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

/* ============================== 日志 ============================== */

const LOG_MAX_LINES = 400;

/**
 * stderr 还能不能写。
 *
 * 这里的坑是**异步**的：`process.stderr.write()` 在管道那头断了（拉起它的人先退出了、
 * `| head` 提前收口、宿主被 stop 掉）时，**不抛同步异常**，而是在 socket 上异步发
 * `EPIPE`。原来的 `try/catch` 一个都抓不住，于是：
 *   某次 uncaughtException → handler 里 log() → 写 stderr → EPIPE 异步事件
 *   → 又进 uncaughtException → handler 里又 log() → 又 EPIPE → ……**无限自触发**。
 * 实测后果：宿主 CPU 打满、log.txt 被 EPIPE 栈刷掉 400 行（真正的原因第一条就被挤没了），
 * 而服务其实还活着 —— 这种「日志把进程搞死」的失败最难查，所以单独兜住：
 * 挂一个 'error' 监听把断掉的 stderr 标记为不可写，之后一律只写 log.txt。
 */
let stderrWritable = true;
if (process.stderr && typeof process.stderr.on === "function") {
	process.stderr.on("error", () => {
		stderrWritable = false;
	});
}

function log(...parts) {
	const line = `[pi-pet ${new Date().toISOString()}] ${parts.join(" ")}`;
	try {
		fs.mkdirSync(HOME, { recursive: true });
		// 只留尾部：log.txt 长期跑会无脑膨胀
		const prev = fs.existsSync(PATHS.log) ? fs.readFileSync(PATHS.log, "utf8") : "";
		const lines = prev.split("\n").filter(Boolean);
		lines.push(line);
		fs.writeFileSync(PATHS.log, lines.slice(-LOG_MAX_LINES).join("\n") + "\n", "utf8");
	} catch {
		/* 写不上日志不影响服务 */
	}
	try {
		// stdio 被 ignore 时这行会失败，属正常；管道断了就当没有 stderr
		if (stderrWritable && process.stderr && process.stderr.writable && !process.stderr.destroyed) {
			process.stderr.write(`${line}\n`);
		}
	} catch {
		stderrWritable = false;
	}
	return line;
}

module.exports = {
	PKG_ROOT,
	ASSETS_DIR,
	THUMB_DIR,
	CONFIG_JSONC,
	ELECTRON_SCRIPT,
	HOME,
	PATHS,
	CONFIG_DEFAULTS,
	CTRL_DEFAULTS,
	ensureHome,
	readPositions,
	rememberPosition,
	writePortFile,
	readPortFile,
	clearPortFile,
	readConfig,
	writeConfig,
	readCtrl,
	writeCtrl,
	log,
};
