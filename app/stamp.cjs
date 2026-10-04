"use strict";
/**
 * app/stamp.cjs — 包身份戳：这份代码是从哪一次提交来的（sha / dirty / 素材段数 / 时间）
 *
 * 为什么运行时也要能刷：开发时 `app/build.cjs` 是上次打包留下的，
 * 代码早就 pull 到新提交了，戳还停在旧的 —— /health 于是报出一个**假**的 sha，
 * 比不报更坏（它正是为了发现「跑的是旧代码」才存在的）。
 * 所以每次宿主启动都拿当前 HEAD 核一遍：不一样就地重写。
 *
 * 打包时由 scripts/after-pack.cjs 调（打进去的那份必须是真的）；
 * 开发时由宿主启动自动刷。刷新不了（不是 git 检出 / 没装 git）就保留原值，不影响功能。
 */

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "build.cjs");

/** git 问不到就返回空串 —— 不因为环境缺件就抛。 */
function git(args) {
	try {
		return cp.execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function thumbCount() {
	try {
		return fs.readdirSync(path.join(ROOT, "assets", "thumb")).filter((f) => f.endsWith(".webm")).length;
	} catch {
		return 0;
	}
}

function write(s) {
	fs.writeFileSync(OUT, `"use strict";\n\n// 本文件由 app/stamp.cjs / scripts/stamp.cjs 生成，勿手改。\nmodule.exports = ${JSON.stringify(s, null, "\t")};\n`, "utf8");
	return s;
}

function read() {
	try {
		return require(OUT);
	} catch {
		return null;
	}
}

/** 生成（或重生成）戳，返回它。幂等。 */
function stamp() {
	const sha = git(["rev-parse", "--short", "HEAD"]) || "unknown";
	return write({
		sha,
		// 有未提交改动就标出来：这时 exe 和仓库 HEAD 本来就不等价，别拿 HEAD 冒充身份
		dirty: Boolean(git(["status", "--porcelain"])),
		builtAt: new Date().toISOString(),
		thumbs: thumbCount(),
	});
}

/**
 * 拿「此刻这份代码」的戳：能问 git 就重建（顺带落盘，给 doctor 读），问不到就用落盘那份。
 * @param {boolean} persist 落盘（打包时 true；只想读就别落，免得改动工作区）
 */
function current({ persist = false } = {}) {
	const sha = git(["rev-parse", "--short", "HEAD"]);
	if (!sha) return read() || stamp0();
	const dirty = Boolean(git(["status", "--porcelain"]));
	const prev = read();
	if (prev && prev.sha === sha && prev.dirty === dirty) return prev; // 一样就别写，省一次 IO
	return persist ? write({ sha, dirty, builtAt: new Date().toISOString(), thumbs: thumbCount() }) : { sha, dirty, builtAt: (prev && prev.builtAt) || null, thumbs: thumbCount() };
}

/** 连 git 都没有时的兜底（不该发生，但别让 require 失败）。 */
function stamp0() {
	return { sha: "unknown", dirty: false, builtAt: null, thumbs: thumbCount() };
}

module.exports = { stamp, current, read };