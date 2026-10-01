/**
 * updater.cjs — 检查更新 / 自动更新
 *
 * 为什么自己写而不是用 electron-updater：桌宠是**两种装机方式**混着用的，
 * 而它们「怎么更新」是两回事，得分别认：
 *
 *   ① git 装机（pi 扩展装法、`git clone` 后自己跑）：包根就是 git 工作区。
 *      查 = `git fetch` + 比 HEAD 和远端；更 = `git pull --ff-only`。
 *      这是**唯一能全自动**的一档，也是最常见的一档（pi 装的就是这个）。
 *   ② npm 装机（`npm i -g pi-dsh-pet`）：没有 .git，只能问 npm registry 有没有新版。
 *      全局装的话自动 `npm i -g <包名>@latest`；不是全局装（本地 npx / 自己 clone 完
 *      link 进来的）就**只报告、不代劳** —— 替别人跑 npm install 说不定改的是别处的依赖。
 *   ③ 其它（解压即用的 zip / asar 打包版）：没有 .git 也没有 npm 装机信息，
 *      一律只报告当前版本 + 该去哪儿手动更。
 *
 * 两条硬规矩：
 *   - **不碰脏工作区**：`git status --porcelain` 非空就拒绝自动更。用户本地改了
 *     pi/assets/pet.js 还没提交时，pull 过去会让人丢改动（那比没更新糟糕得多）。
 *   - **只用 --ff-only**：宁可报「有更新但拉不下来（本地有分叉）」也不要自动 merge，
 *     merge 冲突留在一堆 webm/代码里是最难收拾的一种烂摊子。
 *
 * 更新完**宿主进程自己不会换代码**（它是 detached 的，没人负责再拉起它），
 * 所以调用方要自己换一扇窗：渲染层（pet.js / pet.css）立刻就是新的，
 * 宿主层（app/*）要等下次 `pi-pet restart`。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PKG_ROOT = path.resolve(__dirname, "..");

/** 跑一条命令。**永不抛**：找不到 git / 超时 / 非零退出都变成返回值，
 *  更新失败只是「没更成」，绝不能把宿主带崩（它是那个 HTTP 服务）。 */
function run(cmd, args, { cwd = PKG_ROOT, timeoutMs = 15000 } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, shell: false });
		} catch {
			resolve(null);
			return;
		}
		let out = "";
		let errOut = "";
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, stdout: out.trim(), stderr: errOut.trim() });
		};
		// spawn 的 timeout 只发信号不一定收尸，自己再兜一层
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* 已经退了 */
			}
			finish(-2);
		}, timeoutMs + 3000);
		timer.unref?.();
		if (child.stdout) child.stdout.on("data", (d) => { if (out.length < 1 << 20) out += d; });
		if (child.stderr) child.stderr.on("data", (d) => { if (errOut.length < 1 << 20) errOut += d; });
		child.on("error", () => finish(-1));
		child.on("close", (code) => finish(typeof code === "number" ? code : -1));
	});
}

/** git 在不在。不在的话 git 装机那套一律走不了（报告「没装 git」而不是干等超时）。 */
let gitChecked = null;
async function gitUsable() {
	if (gitChecked === null) {
		const r = await run("git", ["--version"], { timeoutMs: 8000 });
		gitChecked = !!(r && r.code === 0);
	}
	return gitChecked;
}

function readPkg() {
	try {
		const j = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
		return { name: String(j.name || "pi-dsh-pet"), version: String(j.version || "?") };
	} catch {
		return { name: "pi-dsh-pet", version: "?" };
	}
}

let npmRoot = null;
/** npm 的全局 node_modules 路径（拿不到就 null = 不敢替用户跑 npm i -g）。 */
async function globalNodeModules() {
	if (npmRoot !== null) return npmRoot;
	const r = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { timeoutMs: 20000 });
	npmRoot = r && r.code === 0 && r.stdout ? path.resolve(r.stdout) : "";
	return npmRoot;
}

/** 这是什么装机？给菜单和 dialog 看的「当前版本」也从这儿出。 */
async function detect() {
	const pkg = readPkg();
	const base = { name: pkg.name, version: pkg.version, dir: PKG_ROOT };
	if (fs.existsSync(path.join(PKG_ROOT, ".git"))) {
		if (!(await gitUsable())) return { ...base, mode: "unknown", reason: "这是个 git 检出，但系统里没有 git 命令" };
		return { ...base, mode: "git" };
	}
	if (PKG_ROOT.includes(`${path.sep}node_modules${path.sep}`)) {
		const g = await globalNodeModules();
		const global = !!g && path.resolve(PKG_ROOT).startsWith(g + path.sep);
		return { ...base, mode: "npm", global };
	}
	return { ...base, mode: "unknown" };
}

/** 远端跟踪分支：HEAD 跟着谁走就查谁。别写死 origin/main（有人用 master/别的远端名）。 */
async function remoteRef(dir) {
	for (const args of [
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
		["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
	]) {
		const r = await run("git", args, { cwd: dir, timeoutMs: 8000 });
		if (r && r.code === 0 && r.stdout) {
			// @{u} 给 origin/main；origin/HEAD 给 origin/main → 都要 refs/remotes/ 前缀才是真 ref
			const name = r.stdout.trim().replace(/^refs\/remotes\//, "");
			if (name && !name.includes("@{")) return `refs/remotes/${name}`;
		}
	}
	for (const cand of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
		const r = await run("git", ["show-ref", "--verify", "--quiet", cand], { cwd: dir, timeoutMs: 8000 });
		if (r && r.code === 0) return cand;
	}
	return "";
}

async function shortSha(dir, ref) {
	const r = await run("git", ["rev-parse", "--short", ref], { cwd: dir, timeoutMs: 8000 });
	return r && r.code === 0 ? r.stdout : "";
}

/** 工作区脏不脏（有本地改动 / 未跟踪文件）。脏了不许自动更。 */
async function dirty(dir) {
	const r = await run("git", ["status", "--porcelain"], { cwd: dir, timeoutMs: 15000 });
	if (!r) return false; // 拿不到状态就别拦（真拦错了更烦人）
	return r.stdout.length > 0;
}

/**
 * 查有没有新版。**只读**（git 只 fetch，不动工作区），所以可以随时调。
 * 返回 {ok, hasUpdate, mode, version, current, latest, behind, note}
 */
/**
 * 离线查（PI_PET_UPDATE_NO_FETCH=1）：只比本地已经 fetch 过的 ref，不碰网络。
 * 专给测试用（也适合没网时看一眼「我落后几个提交」）。
 * 自动检查（autoUpdate）不认这个开关 —— 用户要的是「启动就自动更到最新」。
 */
async function check({ fetch = process.env.PI_PET_UPDATE_NO_FETCH !== "1" } = {}) {
	const info = await detect();
	if (info.mode === "git") {
		if (fetch) {
			const f = await run("git", ["fetch", "--quiet", "--prune"], { cwd: info.dir, timeoutMs: 45000 });
			if (!f || (f.code !== 0 && f.code !== -2)) {
				return { ...info, ok: false, hasUpdate: false, note: "git fetch 失败（多半是没网），先按当前版本继续跑" };
			}
		}
		const ref = await remoteRef(info.dir);
		if (!ref) return { ...info, ok: false, hasUpdate: false, note: "这个检出没有可跟随的远端分支（自己 clone 的？）" };
		const current = await shortSha(info.dir, "HEAD");
		const latest = await shortSha(info.dir, ref);
		const cnt = await run("git", ["rev-list", "--count", `HEAD..${ref}`], { cwd: info.dir, timeoutMs: 10000 });
		const behind = cnt && cnt.code === 0 ? Number(cnt.stdout) || 0 : 0;
		const subj = await run("git", ["log", "-1", "--format=%s", ref], { cwd: info.dir, timeoutMs: 10000 });
		return {
			...info,
			ok: true,
			hasUpdate: behind > 0,
			behind,
			current,
			latest,
			note: behind > 0 && subj && subj.stdout ? `最新一条：${subj.stdout}` : "",
		};
	}
	if (info.mode === "npm") {
		const r = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["view", info.name, "version"], {
			timeoutMs: 30000,
		});
		if (!r || r.code !== 0 || !r.stdout) {
			return { ...info, ok: false, hasUpdate: false, note: "问不到 npm registry（没网/没 npm），先按当前版本继续跑" };
		}
		const latest = r.stdout.trim();
		return {
			...info,
			ok: true,
			hasUpdate: latest !== info.version,
			latest,
			note: info.global ? "" : "这个包不是全局装的，只报告不代劳（你自己在哪儿装的就在哪儿 npm i）",
		};
	}
	return { ...info, ok: false, hasUpdate: false, note: info.reason || "这种装法没法自动更新（打包版 / 解压即用）" };
}

/**
 * 真的去更。返回 {ok, mode, note, restarted?} —— 调用方拿到 ok 之后
 * 自己决定要不要换一扇窗（宿主那边换窗 = 渲染层立刻用上新代码）。
 */
async function apply() {
	const info = await detect();
	if (info.mode === "git") {
		if (await dirty(info.dir)) {
			return {
				ok: false,
				mode: "git",
				note: "这个检出里有本地改动，先 commit 或 stash 了再更新（别让更新盖掉你的改动）",
			};
		}
		const before = await shortSha(info.dir, "HEAD");
		const r = await run("git", ["pull", "--ff-only", "--quiet"], { cwd: info.dir, timeoutMs: 120000 });
		if (!r || r.code !== 0) {
			const why = (r && (r.stderr || r.stdout)) || "git 没跑起来";
			return { ok: false, mode: "git", note: `拉不下来：${why.split("\n")[0]}` };
		}
		const after = await shortSha(info.dir, "HEAD");
		return {
			ok: true,
			mode: "git",
			note: after && before && after !== before ? `已更新：${before} → ${after}` : "已经是最新",
			changed: !!(after && before && after !== before),
		};
	}
	if (info.mode === "npm" && info.global) {
		const r = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "-g", `${info.name}@latest`], {
			timeoutMs: 240000,
		});
		if (!r || r.code !== 0) {
			const why = (r && (r.stderr || r.stdout)) || "npm 没跑起来";
			return { ok: false, mode: "npm", note: `npm 装失败：${why.split("\n").slice(-1)[0]}` };
		}
		const after = await check({ fetch: false });
		return { ok: true, mode: "npm", note: `已装上 ${info.name}@${after.version || "?"}（宿主自身要 pi-pet restart 才换新代码）` };
	}
	return { ok: false, mode: info.mode, note: info.note || info.reason || "这种装法没法自动更新，手动来" };
}

/* ============================== 启动时的自动检查 ============================== */

/** 6h 内不重复查：宿主是 keepAlive 长驻的，别的 tick 拉起来就会查一次。 */
const AUTO_GAP_MS = Number(process.env.PI_PET_UPDATE_GAP_MS || 6 * 3600 * 1000);
/** 启动后先等一会儿再查：别跟宿主起窗抢 IO。 */
const AUTO_DELAY_MS = Number(process.env.PI_PET_UPDATE_DELAY_MS || 12000);

function readStateFile(home, file) {
	try {
		return JSON.parse(fs.readFileSync(path.join(home, file), "utf8")) || {};
	} catch {
		return {};
	}
}

function writeStateFile(home, file, patch) {
	try {
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(path.join(home, file), `${JSON.stringify(patch, null, 2)}\n`, "utf8");
	} catch {
		/* 记不住就当没记（顶多多查一次） */
	}
}

/**
 * 启动后自动查一次、有新版就装上（用户要求「启动自动检查更新到最新版本」）。
 *
 * 开关：`PI_PET_NO_UPDATE=1` 全关；`PI_PET_UPDATE_GAP_MS` 调间隔；
 * `PI_PET_UPDATE=check` 只查不装。
 *
 * 返回一个 Promise 便于测试；宿主那边只是 `void` 掉它。所有失败都只走 onNote，
 * **不弹窗** —— 启动时弹窗打断用户，而且这类事天天发生。
 */
function autoUpdate(home, { log: logFn, onUpdated, delayMs = AUTO_DELAY_MS, gapMs = AUTO_GAP_MS } = {}) {
	const note = (s) => {
		if (logFn) logFn(s);
	};
	if (process.env.PI_PET_NO_UPDATE === "1") {
		note("PI_PET_NO_UPDATE=1 → 不自动检查更新");
		return Promise.resolve({ skipped: "disabled" });
	}
	return new Promise((resolve) => {
		const timer = setTimeout(async () => {
			timer.unref?.();
			const st = readStateFile(home, "update.json");
			const last = Number(st.lastCheck) || 0;
			if (last && Date.now() - last < gapMs) {
				note(`上次检查才过去 ${Math.round((Date.now() - last) / 60000)} 分钟，跳过（要强制查走菜单「检查更新」）`);
				resolve({ skipped: "recent" });
				return;
			}
			let res;
			try {
				res = await check();
			} catch (err) {
				note(`自动检查更新炸了：${err && err.message}`);
				resolve({ ok: false });
				return;
			}
			writeStateFile(home, "update.json", {
				...st,
				lastCheck: Date.now(),
				lastMode: res.mode,
				lastCurrent: res.current || "",
				lastResult: res.note || (res.hasUpdate ? "有更新" : "已是最新"),
			});
			if (!res.ok) {
				note(`自动检查更新：${res.note || res.mode}`);
				resolve(res);
				return;
			}
if (!res.hasUpdate) {
				note(`自动检查更新：已是最新（${res.current || res.version}）`);
				resolve(res);
				return;
			}
			// 「只查不装」档：手动启动时想看「有没有新版」但别让它动工作区
			if (process.env.PI_PET_UPDATE === "check") {
				note(`PI_PET_UPDATE=check → 只查不装：${res.note || `有更新（落后 ${res.behind || 0} 个提交）`}`);
				resolve({ ...res, skipped: "check-only" });
				return;
			}
			note(`自动检查更新：有新版（${res.current || res.version} → ${res.latest || "?"}），正在更新…`);
			let ap;
			try {
				ap = await apply();
			} catch (err) {
				note(`自动更新炸了：${err && err.message}`);
				resolve({ ok: false });
				return;
			}
			writeStateFile(home, "update.json", { lastCheck: Date.now(), lastApplied: Date.now(), lastMode: ap.mode, lastResult: ap.note });
			note(`自动更新：${ap.note}`);
			// 只在真的动了代码才让调用方换窗（换窗 = 1.5s 后新代码接管渲染层）
			if (ap.ok && ap.changed !== false && onUpdated) {
				try {
					onUpdated(ap);
				} catch (err) {
					note(`更新完了但换窗失败：${err && err.message}`);
				}
			}
			resolve({ ...res, applied: ap });
		}, Math.max(0, delayMs));
		timer.unref?.();
	});
}

/** 读 home/update.json（上次查/更到哪儿了）：给「关于」框和 /state 用。 */
function readUpdateInfo(home) {
	const st = readStateFile(home, "update.json");
	return {
		lastCheck: Number(st.lastCheck) || 0,
		lastApplied: Number(st.lastApplied) || 0,
		lastResult: String(st.lastResult || ""),
		mode: String(st.lastMode || ""),
		current: String(st.lastCurrent || ""),
	};
}

module.exports = { detect, check, apply, autoUpdate, readUpdateInfo, PKG_ROOT };
