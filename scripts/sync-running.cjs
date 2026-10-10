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
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

/**
 * 只同步这些：窗与宿主真正读的文件。
 * ⚠️ `pi/extensions` 在列表里：pi 加载扩展时读的是**运行那份**的 index.ts，
 *    以前不在列表里，于是扩展改了永远不生效（症状：宿主认了新协议，
 *    但生产者的会话标题永远是空的 —— 因为跑的还是旧扩展）。
 */
const SYNC = ["app", "bin", "pi/assets", "pi/extensions", "dsh", "opencode", "assets/config.jsonc", "package.json"];

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

/* ================= 同步完：别把宿主那份的 git 拓脏 ================= */

/** 跑一条 git（cwd = 宿主那份检出），拿 {code, stdout, stderr}；跑不了返回 null。 */
function git(dir, args, timeoutMs = 30000) {
	const r = spawnSync("git", args, { cwd: dir, timeout: timeoutMs, encoding: "utf8", windowsHide: true });
	if (r.error) return null;
	return { code: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

/** 这份检出工作区脏不脏（有本地改动/未跟踪文件）。不是 git 检出就当不是。 */
function isDirty(dir) {
	const r = git(dir, ["status", "--porcelain"]);
	return !!(r && r.code === 0 && r.stdout.trim().length);
}

/**
 * git 认的、且工作区里**真的被改了**的跟踪文件（路径统一成正斜杠）。
 * ⚠️ 必须问 git 而不是「这次拷了哪些文件」：拷贝清单里混着**生成物**
 * （app/build.cjs 由 stamp 生成、.gitignore 掉的），它压根不在 git 里——
 *   拿拷贝清单当脏文件清单，就会为它报一句「内容还没 push」，而其实没人管得了它。
 * 只收 M（modified）：`??` 未跟踪的不算（sync 从不删文件，未跟踪跟这事无关）。
 */
function modifiedPaths(dir) {
	const out = new Set();
	const r = git(dir, ["status", "--porcelain", "-z"], 20000); // -z：路径里有中文/空格也不乱
	if (!r || r.code !== 0) return out;
	for (const entry of String(r.stdout).split("\0")) {
		if (!entry) continue;
		const code = entry.slice(0, 2);
		const file = entry.slice(3).trim();
		if (!file) continue;
		if (code === "M" || code === "MM" || code === "AM") out.add(file.split(path.sep).join("/"));
	}
	return out;
}

/** 工作区里一个文件的 blob hash（跟 git index 无关，就是「现在这份内容」）。 */
function blobOf(dir, rel) {
	const r = git(dir, ["hash-object", "--", rel], 8000);
	return r && r.code === 0 ? r.stdout.trim() : "";
}

/** 远端某个 ref 上那个文件的 blob hash。 */
function remoteBlobOf(dir, ref, rel) {
	const r = git(dir, ["rev-parse", "--verify", "--quiet", `${ref}:${rel}`], 8000);
	return r && r.code === 0 ? r.stdout.trim() : "";
}

/**
 * 同步完把「工作区被拓脏」的后果收掉。
 *
 * 为什么要管：更新器（app/updater.cjs 的 apply）**故意**不碰脏工作区
 * —— `git status --porcelain` 非空就拒绝自动更（用户提示「有本地改动，先 commit 或 stash」）。
 * 而 sync 的本质就是把开发那份的文件**写进**宿主那份检出 ⇒ 每次同步都把它拓脏 ⇒
 * 自动更新从此一直失败（症状：明明 push 了，宿主却说「没更成：有本地改动」）。
 *
 * 怎么收：这些内容**远端已经有了**（= 已经 push 过）时，把那份检出的 HEAD **快进**到远端。
 *   文件内容已经逐字核对过（一样），所以快进不改任何文件内容，只是让 git 认它干净 ⇒ 更新恢复。
 * ⚠️⚠️ 为什么不是 `git checkout -- <files>`（曾经的写法，错）：
 *   checkout 是从 **index/HEAD** 还原的，而此刻 HEAD 恰恰是**旧的**那份 ⇒ 一 checkout
 *   就把刚同步进来的新代码**打回旧版**（sync 的意义当场没了），而且还得等下次更新才补回来。
 *   「让工作区干净且内容不变」在 git 里只有一条路：把 HEAD 也带到那份内容去 = fast-forward。
 *
 * 还对不上（改了还没 push）就**不动**：这时候本来就该先 push，更新走 git。
 */
async function unblockUpdates(target, copied) {
	if (!fs.existsSync(path.join(target, ".git"))) return null; // 不是 git 检出，管不着
	// 本次推过去的优先；**一次都没推也照样收**：上一次 sync 拓的脏还留在那儿，
	// 用户往往正是「再跑一次 sync」时才发现更新被拦的（症状：菜单里点更新一直失败）。
	const modified = modifiedPaths(target);
	// 只看 git 跟踪 ∧ 真的改了：别人早先留在那儿的老 hand-edit 不归我们擦，
	// 生成物（app/build.cjs 之类）压根不在 git 里，也别拿来当「有本地改动」的借口
	const changed = copied.length
		? copied.filter((rel) => modified.has(rel.split(path.sep).join("/")))
		: [...modified];
	if (!changed.length) return null;
	const upstream = git(target, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 8000);
	const ref = upstream && upstream.code === 0 ? upstream.stdout.trim() : "";
	if (!ref) return { ok: false, note: "那份检出没有上游分支，自动更新要手动处理" };
	// 先 fetch：本地那个 ref 可能还没见过最新的 push
	git(target, ["fetch", "--quiet", ref], 45000);
	const same = changed.filter((rel) => blobOf(target, rel) && blobOf(target, rel) === remoteBlobOf(target, ref, rel));
	if (same.length !== changed.length) {
		// 本次没推任何东西 ⇒ 别拿别人早先的老 hand-edit 来烦人（那本来就该他自己管）
		if (!copied.length) return null;
		const diff = changed.filter((rel) => !same.includes(rel));
		return {
			ok: false,
			note:
				`那份检出有 ${changed.length} 个本地改动，内容**还没 push**（${diff.slice(0, 3).join("、")}${diff.length > 3 ? "…" : ""}）—— ` +
				`先 push，再在那份检出里 git reset --hard ${ref}，自动更新才恢复`,
		};
	}
	// 内容都在远端了 ⇒ 把 HEAD 快进过去（文件内容不变，工作区变干净）
	const ff = git(target, ["merge", "--ff-only", "--quiet", ref], 30000);
	if (!ff || ff.code !== 0) {
		const why = ((ff && (ff.stderr || ff.stdout)) || "").split("\n")[0];
		return {
			ok: false,
			note: `那份检出和 ${ref} 分叉了（本地有别的提交），快不过去：要更得先在那份检出里 git pull --rebase ${ref} —— ${why}`,
		};
	}
	const head = git(target, ["rev-parse", "--short", "HEAD"], 8000);
	return { ok: true, count: same.length, head: head ? head.stdout.trim() : "" };
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
	// 把那份检出收干净（不然自动更新会以「有本地改动」为由拒绝）
	const un = await unblockUpdates(target, tally.copied);
	if (un && un.ok) {
		console.log(`  那份检出已快进到 ${un.head}（${un.count} 个文件内容未变，工作区干净 → 自动更新不再被拦）`);
	} else if (un && un.note) {
		console.log(`  ⚠ ${un.note}`);
	}
})();
