#!/usr/bin/env node
/**
 * scripts/sync-running.cjs —— 把**当前 checkout** 的运行时代码推到「正在跑的那个宿主」
 * 用的 checkout 去。
 *
 * 为什么需要（2026-10 实测坑）：这台机器上有两份 pi-dsh-pet ——
 *   · 开发用：D:\AI\pi-dsh-pet（人改代码的地方）
 *   · 运行用：C:\Users\yxh\.pi\agent\git\...（pi 装的，宿主从这里起、也从这里发 pet.js）
 * 改完开发那份直接 `restart`，窗拿到的还是运行那份的旧 JS（`/health` 的 `pkg` 字段
 * 自报宿主用的是哪一份）—— 症状是「改了没反应」，最容易误判成代码没跑到。
 *
 * 所以：改完跑一次 `npm run sync`，再 `pi-pet restart`。
 * 宿主没在跑 / 两边本来就是同一份时，本脚本什么都不做（退出码 0）。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/** 只同步这些：窗与宿主真正读的文件。 */
const SYNC = ["app", "bin", "pi/assets", "assets/config.jsonc", "package.json"];

/**
 * 素材也推，但只推**缺的和大小不同的**。
 * ⚠️ 以前素材整个不在同步列表里（怕 90 几个 webm 每次全拷），于是新加的素材永远
 * 只躺在开发那份：窗去 /thumb/ 取到的是 404，Chromium 把 404 的响应体当媒体解 →
 * `MEDIA_ERR_SRC_NOT_SUPPORTED`（错误码 4）—— 症状是「这段动画不播」，查素材本身却
 * 完全正常（实测：睡床做梦.webm 用 file:// 打开好好的）。按大小比对就够，
 * 一次全量也就 90 多次 stat。
 */
const THUMB = "assets/thumb";
function syncThumbs(target, tally) {
	const dir = path.join(ROOT, THUMB);
	if (!fs.existsSync(dir)) return;
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".webm")) continue;
		const src = path.join(dir, name);
		const dst = path.join(target, THUMB, name);
		const st = fs.statSync(src);
		if (fs.existsSync(dst) && fs.statSync(dst).size === st.size) {
			tally.same++;
			continue;
		}
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
		tally.copied.push(`${THUMB}\\${name}`);
	}
}

async function health() {
	const portFile = process.env.PI_PET_PORT || (() => {
		const pf = path.join(process.env.APPDATA || "", "pi-dsh-pet", "port");
		try {
			return fs.readFileSync(pf, "utf8").trim();
		} catch {
			return "";
		}
	})();
	if (!portFile) return null;
	try {
		const res = await fetch(`http://127.0.0.1:${portFile}/health`, { signal: AbortSignal.timeout(1500) });
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

const CRLF = String.fromCharCode(13, 10); // 比内容不比换行：两份 checkout 的 EOL 常常不一样
function sameBytes(a, b) {
	// 只比内容：两份 checkout 的换行风格常常一 CRLF 一 LF，逐字节比会把
	// 「没改过的文件」也报成更新，sync 输出全是噪音。
	const norm = (buf) => {
		if (!buf.includes(13)) return buf;
		return Buffer.from(buf.toString('utf8').split(CRLF).join(String.fromCharCode(10)), 'utf8');
	};
	return norm(fs.readFileSync(a)).equals(norm(fs.readFileSync(b)));
}

function copyFile(src, dst, tally, rel) {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	if (fs.existsSync(dst) && sameBytes(src, dst)) {
		tally.same++;
		return;
	}
	fs.copyFileSync(src, dst);
	tally.copied.push(rel);
}

function walk(rel, target, tally) {
	const src = path.join(ROOT, rel);
	const dst = path.join(target, rel);
	const st = fs.statSync(src);
	if (st.isFile()) {
		copyFile(src, dst, tally, rel);
		return;
	}
	for (const name of fs.readdirSync(src)) walk(path.join(rel, name), target, tally);
}

(async () => {
	const h = await health();
	if (!h) {
		console.log("· 宿主没在跑（或探不到），没什么要同步的");
		return;
	}
	const target = path.resolve(h.pkg || "");
	if (!target || target === ROOT) {
		console.log(`· 宿主用的就是这份（${ROOT}），无需同步`);
		return;
	}
	const tally = { copied: [], same: 0 };
	for (const rel of SYNC) {
		if (fs.existsSync(path.join(ROOT, rel))) walk(rel, target, tally);
	}
	syncThumbs(target, tally);
	console.log(`已同步到宿主在用的那份：${target}`);
	console.log(`  更新 ${tally.copied.length} 个文件，${tally.same} 个本来就一样`);
	for (const f of tally.copied.slice(0, 20)) console.log(`    ~ ${f}`);
	if (tally.copied.length) console.log("  接着：node bin/pi-pet.cjs restart（换一扇窗才会重新加载 pet.js）");
})();