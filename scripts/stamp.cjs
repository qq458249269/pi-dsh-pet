#!/usr/bin/env node
/**
 * scripts/stamp.cjs — 把「这个包是从哪一次提交打出来的」写进 app/build.cjs
 *
 * 为什么要有它：**改了源码却在跑旧 exe**，这种错在界面上完全看不出来
 * （宠物照样动，只是行为是老的）。用户只能靠猜。stamp 让三处都能自证：
 *   · /health 与 `pi-pet doctor` 报 build.sha —— 看一眼就知道在跑哪次提交
 *   · afterPack 比对 stamp.sha 与当前 HEAD，**不一致直接让打包失败**
 *     （打成旧 exe 比不打更坏：它看起来是新的）
 *   · 素材条数一起记下，config 引用的 webm 少了也能一眼看出来
 *
 * 跑：node scripts/stamp.cjs（npm run build / build:dir 会自动先跑；
 *     直接调 electron-builder 时由 after-pack.cjs 代跑，所以两边都不会缺）
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "app", "build.cjs");

/** git 问不到就写 "unknown" —— 不因为没装 git 就打包失败。 */
function git(args) {
	try {
		return cp.execFileSync("git", args, {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
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

/** 生成（或重生成）app/build.cjs，返回戳本身。幂等，谁调都行。 */
function stamp() {
	const sha = git(["rev-parse", "--short", "HEAD"]) || "unknown";
	const s = {
		sha,
		// 有未提交改动就标出来：这时 exe 和仓库 HEAD 本来就不等价，别拿 HEAD 冒充身份
		dirty: Boolean(git(["status", "--porcelain"])),
		builtAt: new Date().toISOString(),
		thumbs: thumbCount(),
	};
	fs.writeFileSync(OUT, `"use strict";\n\n// 本文件由 scripts/stamp.cjs 生成，勿手改（每次 build 覆盖）。\nmodule.exports = ${JSON.stringify(s, null, "\t")};\n`, "utf8");
	return s;
}

if (require.main === module) {
	const s = stamp();
	console.log(`  • build.cjs: ${s.sha}${s.dirty ? " (dirty)" : ""} @ ${s.builtAt}, ${s.thumbs} 个 webm`);
}

module.exports = { stamp };

