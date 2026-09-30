/**
 * single.cjs — 单例锁 / 原子写 / 状态文件 / token
 *
 * 「整机只有一只宠物」是这套东西的**头号不变量**：多开几个 pi、dsh 也在跑、
 * 用户手敲两次 `/pet`，屏幕上仍然只能有一只。实现它的三样东西都在这里：
 *
 *   1. mkdir 独占锁（跨进程原子）—— 比 pid 记账可靠：pid 会被回收、陈旧锁要能接管。
 *   2. state.json —— 端口的**唯一真源**，先写 tmp 再 rename，读者永远看到完整一份。
 *   3. token —— REST/WS 的鉴权凭据。127.0.0.1 不等于可信：同一台机器上任何进程
 *      都能往 :47653 发 `shutdown` 或 `add_pet`。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { ROLE } = require("./protocol.cjs");
const { PATHS, log } = require("./paths.cjs");

/** 锁的存活上限：主人被硬杀留下的陈旧锁，超过这个时间就允许接管。 */
const LOCK_TTL_MS = 60_000;

/** 状态文件里的心跳超过这个值就当「报了个状态但其实死了」。 */
const HEARTBEAT_STALE_MS = 15_000;

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM"; // 别人（别的用户）持有，但确实活着
	}
}

/* ============================== 原子写 ============================== */

/** 先写临时文件再改名：读者永远看不到半截 JSON。 */
function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* 删不掉就让 rename 报错 */
	}
	fs.renameSync(tmp, file);
}

function readJson(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return raw && typeof raw === "object" ? raw : null;
	} catch {
		return null;
	}
}

/* ============================== 单例锁 ============================== */

let holdingLock = false;

/**
 * 抢单例锁：**mkdir 必须是原子的**。
 *
 * 关键细节：`fs.mkdirSync(dir)` **不能**加 `{recursive:true}`。加了它，目录已存在时
 * mkdir 也不报错，锁就永远抢不到第二个 —— 单例保证直接失效（两个宿主都以为自己是唯一的）。
 * 不加时 EEXIST 就是「有人拿着」，这才是我们要的互斥原语。父目录由 ensureHome() 先建好。
 */
function acquireLock(lockDir = PATHS.lock) {
	const ownerFile = path.join(lockDir, "owner.json");
	const tryMkdir = () => {
		try {
			fs.mkdirSync(lockDir); // 故意不加 recursive：EEXIST = 锁被占
			return true;
		} catch {
			return false;
		}
	};

	if (tryMkdir()) {
		holdingLock = true;
	} else {
		const owner = readJson(ownerFile);
		const alive = owner && pidAlive(Number(owner.pid));
		const fresh = alive && Date.now() - (Number(owner.at) || 0) < LOCK_TTL_MS;
		if (fresh) return { ok: false, owner };
		log(`锁是陈旧的（owner ${owner ? owner.pid : "无"}），接管`);
		try {
			fs.rmSync(lockDir, { recursive: true, force: true });
		} catch {
			/* 清不掉就当没抢到 */
		}
		if (!tryMkdir()) return { ok: false, owner };
		holdingLock = true;
	}

	// 抢到就**立刻**写 owner：别的宿主只看得到「没有 owner」= 陈旧锁，
	// 写晚一点都可能让对方误判成没人在跑，再抢第二次。
	try {
		fs.writeFileSync(
			ownerFile,
			`${JSON.stringify({ pid: process.pid, at: Date.now(), startedAt: STARTED_AT }, null, 2)}\n`,
			"utf8",
		);
		// POSIX 上把锁目录收到 0700：token 在同目录，别的用户不该读得到
		try {
			fs.chmodSync(lockDir, 0o700);
		} catch {
			/* Windows / 不支持的 fs 上无所谓 */
		}
	} catch {
		/* 写不上就认了：最坏是下个宿主等 TTL */
	}
	return { ok: true, owner: null };
}

/**
 * 续锁（心跳）。
 *
 * **必须有**：owner.json 里的 `at` 是抢锁那一刻写的，而别人判断「锁是不是陈旧」看的就是
 * `now - at < TTL`。只写一次的话，活了超过 TTL（60s）的宿主会被第二个 `pi-pet start`
 * 判定成「主人已死」→ 抢进锁 → **开出第二扇窗**。老实现就有这个洞（靠「没人会在宿主
 * 活着时再点一次 start」侥幸没炸）。现在每拍 tick 续一次，锁的语义才真的是
 * 「主人还活着我就一直占着」。
 */
function refreshLock(lockDir = PATHS.lock) {
	if (!holdingLock) return false;
	try {
		fs.writeFileSync(
			path.join(lockDir, "owner.json"),
			`${JSON.stringify({ pid: process.pid, at: Date.now(), startedAt: STARTED_AT }, null, 2)}\n`,
			"utf8",
		);
		return true;
	} catch {
		// 写不上就等 TTL 被接管；宁可被接管也别让两个宿主同时以为自己是唯一
		return false;
	}
}

function releaseLock(lockDir = PATHS.lock) {
	if (!holdingLock) return;
	holdingLock = false;
	try {
		fs.rmSync(lockDir, { recursive: true, force: true });
	} catch {
		/* 留着等 TTL 接管 */
	}
}

function readLockOwner(lockDir = PATHS.lock) {
	return readJson(path.join(lockDir, "owner.json"));
}

/* ============================== 状态 ============================== */

const STARTED_AT = Date.now();

function newState(extra = {}) {
	return {
		role: ROLE,
		version: 1,
		pid: process.pid,
		port: 0,
		token: "",
		startedAt: STARTED_AT,
		heartbeatAt: STARTED_AT,
		windowPid: 0,
		windowStartedAt: 0,
		windowState: "none",
		clients: 0,
		feeds: 0,
		restarts: 0,
		size: "normal",
		...extra,
	};
}

function writeState(state) {
	state.heartbeatAt = Date.now();
	try {
		writeJsonAtomic(PATHS.state, state);
	} catch (err) {
		log(`写状态失败：${err.message}`);
	}
}

function readState() {
	return readJson(PATHS.state);
}

/** 状态文件看着在、心跳也新鲜、而且报告的 pid 还活着 → 这台机器上确实有个宿主。 */
function stateLooksAlive(state, now = Date.now()) {
	if (!state || state.role !== ROLE) return false;
	if (!pidAlive(Number(state.pid))) return false;
	const hb = Number(state.heartbeatAt) || 0;
	return now - hb < HEARTBEAT_STALE_MS;
}

/* ============================== token ============================== */

/** 一次性生成并落盘：宿主重启后 token 不变，客户端缓存的凭据不会突然失效。 */
function loadOrCreateToken() {
	try {
		const existing = fs.readFileSync(PATHS.token, "utf8").trim();
		if (existing) return existing;
	} catch {
		/* 没有就生成 */
	}
	const token = crypto.randomBytes(24).toString("hex");
	fs.mkdirSync(PATHS.home, { recursive: true });
	fs.writeFileSync(PATHS.token, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		fs.chmodSync(PATHS.token, 0o600);
	} catch {
		/* Windows 上没有 POSIX 权限位 */
	}
	return token;
}

function readToken() {
	try {
		return fs.readFileSync(PATHS.token, "utf8").trim();
	} catch {
		return "";
	}
}

/** 定时恒定时间比较，避免把 token 比较变成时序侧信道（本机场景，纯粹是好习惯）。 */
function tokenMatches(given, expected) {
	if (!given || !expected) return false;
	const a = Buffer.from(String(given));
	const b = Buffer.from(String(expected));
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

module.exports = {
	LOCK_TTL_MS,
	HEARTBEAT_STALE_MS,
	pidAlive,
	writeJsonAtomic,
	readJson,
	acquireLock,
	refreshLock,
	releaseLock,
	readLockOwner,
	newState,
	writeState,
	readState,
	stateLooksAlive,
	loadOrCreateToken,
	readToken,
	tokenMatches,
};
