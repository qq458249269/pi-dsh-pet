/**
 * test/smoke.mjs — 无头端到端自测
 *
 * 起一个真宿主（临时 PI_PET_HOME、serve 模式、不起窗），用 WebSocket 冒充那扇窗，
 * 逐条验证：握手、状态机去重、状态文案、气泡、暂停、单只闸门、token 鉴权、锁心跳、
 * 以及「第二个宿主起不来」这条互斥红线。
 *
 * 跑：npm test
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const WebSocket = globalThis.WebSocket;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), "pi-pet-smoke-"));
const PORT = 47699;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		failures.push(name);
		console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 收集下行帧（用 Node 内置的 WebSocket 客户端，零依赖） */
function fakeWindow(port) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	const frames = [];
	ws.addEventListener("message", (e) => frames.push(typeof e.data === "string" ? e.data : String(e.data)));
	const ready = new Promise((res, rej) => {
		ws.addEventListener("open", res);
		ws.addEventListener("error", rej);
	});
	return { ws, frames, ready, close: () => ws.close() };
}

async function post(port, path, body, token) {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(port, path, token) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			headers: token ? { authorization: `Bearer ${token}` } : {},
		});
		return { status: res.status, body: await res.json().catch(() => null) };
	} catch {
		// 连不上 = 没人在这个端口上
		return { status: 0, body: null };
	}
}

const isBubble = (f) => f.startsWith("{\"type\":\"bubble\"");
/** 动画帧（把气泡帧滤掉）：thinking / agent_idle / tool_call / add_pet / shutdown */
const animFrames = (frames) => frames.filter((f) => !isBubble(f));
const bubbleFrames = (frames) => frames.filter(isBubble).map((f) => JSON.parse(f).text);

console.log(`\npi-dsh-pet 冒烟测试  (home=${HOME} port=${PORT})\n`);

// ---------------------------------------------------------------- 参数解析
// 纯函数，不用起进程。覆盖当初真出过的坑：带值选项不吞下一个 token，
// 导致 `say "过来玩" --ms 6000` 把 6000 当成气泡文字、`--text=任务名` 整条丢进 flag 名。
console.log("命令行参数解析…");
const { parseArgs, probeCaps } = await import(pathToFileURL(join(ROOT, "app", "main.cjs")).href);
const pa = (argv) => parseArgs(argv);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check("`--ms 6000` 吃掉值，位置参数不被污染", eq(pa(["say", "过来玩", "--ms", "6000"]), { flags: { ms: 6000 }, positional: ["say", "过来玩"], missing: [] }));
check("`--text=任务名` 的值能拿到", pa(["feed", "thinking", "--text=修复登录"]).flags.text === "修复登录");
check("`--text 任务名` 与 `=` 写法等价", pa(["feed", "thinking", "--text", "修复登录"]).flags.text === "修复登录");
check("`--port` 是数字不是字符串", pa(["start", "--port", "4000"]).flags.port === 4000);
check("`-p 4000` == `--port 4000`", pa(["-p", "4000", "start"]).flags.port === 4000);
check("`--port=4000` == `--port 4000`", eq(pa(["--port=4000", "start"]).flags, { port: 4000 }));
check("`--no-window` → camelCase", pa(["start", "--no-window"]).flags.noWindow === true);
check("开关不吃下一个 token（`--insecure start` 仍是命令）", eq(pa(["--insecure", "start"]).positional, ["start"]));
check("缺值记进 missing（不静默吞）", pa(["say", "hi", "--ms"]).missing.includes("ms"));
check("非数字值记进 missing（不产生 NaN）", pa(["--port=abc", "start"]).missing.includes("port") && pa(["--port=abc", "start"]).flags.port === undefined);
check("负数是合法值（`--ms -1`）", pa(["say", "hi", "--ms", "-1"]).flags.ms === -1);
check("`feed tool_call bash --text x`：tool 与 text 各自到位", (() => {
	const r = pa(["feed", "tool_call", "bash", "--text", "跑一下"]);
	return r.positional[2] === "bash" && r.flags.text === "跑一下";
})());
check("多词位置参数保留（feed say）", eq(pa(["feed", "say", "多", "个", "词"]).positional, ["feed", "say", "多", "个", "词"]));

// ---------------------------------------------------------------- 拉窗的 cwd
// 这条不是洁癖，是「双击 exe 只出服务不出窗」的**唯一**根因：
// 打包后 paths.cjs 的 PKG_ROOT = <exe目录>\resources\app.asar，而 asar 是**文件**；
// 把它当 spawn 的 cwd，Windows CreateProcess 回 ERROR_PATH_NOT_FOUND，Node 翻译成
// ENOENT，日志却长得像「exe 找不到」（exe 明明在跑，gpu/network 子进程就是它起的）。
// CI 的 `--no-window` 冒烟碰不到窗，所以只能在这里把「成品形态」钉住。
console.log("\n拉窗的工作目录（打包版的 ENOENT 坑）…");
const { launchCwd } = await import(pathToFileURL(join(ROOT, "app", "window.cjs")).href);
{
	const isDir = (p) => {
		try {
			return existsSync(p) && statSync(p).isDirectory();
		} catch {
			return false;
		}
	};
	// ① 开发态：PKG_ROOT 是仓库根，原样返回
	check("开发态 cwd = 仓库根（是目录）", launchCwd() === ROOT && isDir(launchCwd()));
	// ② 成品态：拿一个**真实存在的文件**冒充 app.asar，必须退到真目录
	const fakeAsar = launchCwd(join(ROOT, "package.json"));
	check("PKG_ROOT 是文件（打包版的 app.asar）→ 退到真目录", isDir(fakeAsar), String(fakeAsar));
	check("退到的目录不是那个文件本身", fakeAsar !== join(ROOT, "package.json"));
	// ③ 连上一层都不存在时，宁可不给 cwd（undefined）也不硬塞一个坏路径
	check("完全不存在 → 不给 cwd（undefined）", launchCwd(join(ROOT, "没有这个目录", "app.asar")) === undefined);
}

// ---------------------------------------------------------------- 头顶的气泡
// 「气泡只显示一半」和「气泡不跟着宠物走」都是窗侧（渲染进程）的毛病，冒烟开不了窗，
// 所以把三条容易改回去的地方钉在这儿（都是实测踩过的坑，不是洁癖）：
console.log("\n头顶气泡（截断 / 不跟随）…");
{
	const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const petCss = readFileSync(join(ROOT, "pi", "assets", "pet.css"), "utf8");
	// ① 收缩盒 + left:50% 时可用宽度只有宠物宽度的一半（231px），写在 max-width 上的
	//    320/420 根本够不着，长文案就在半路被省略号切掉 —— 必须显式 width: max-content
	check("气泡显式 width:max-content（否则 max-width 够不着）", /width:\s*max-content/.test(petCss));
	check("气泡不再 nowrap（一行放不下就换行）", !/white-space:\s*nowrap/.test(petCss));
	// ② 漫游/拖拽时每帧都要重报命中区：SetWindowRgn 是按上一次上报的形状裁的，
	//    不跟着走 = 宠物移走后气泡被裁掉，看着就像「气泡留在原地」
	check("漫游时上报命中区", /container\.style\.left = mp\.left[\s\S]{0,400}pushHitRegion\(\)/.test(petJs));
	check("拖拽时上报命中区", /var dp = clampPos\([\s\S]{0,400}pushHitRegion\(\)/.test(petJs));
	// ③ 贴屏幕边时要把气泡夹回来，并且挪完再算命中区（否则形状和画出来的不是一处）
	check("气泡夹回屏幕内", /self\.clampBubble = function/.test(petJs));
	check("算命中区前先夹气泡", /clampBubbles\(\);[\s\S]{0,200}collectHitRects\(\)/.test(petJs));
	// ④ 宠物本身也不能拖到屏幕外（半只在屏外时头顶气泡必然被裁）
	check("拖拽位置有夹取", /clampPos\(e\.clientX - dragState\.offX/.test(petJs));
	// ⑤ showBubble 写文案不能碰 bubble.textContent：会把输入框节点删掉（「说点什么…」出不来）
	check("文案走独立节点，不动 bubble.textContent", !/^\s*bubble\.textContent\s*=/m.test(petJs) && /bubbleText\.textContent = t/.test(petJs));
}

// ------------------------------------------------ 「说点什么…」的键盘与收尾
// 这一整块都是**窗拿不到键盘焦点**惹的：窗平时 focusable:false，点宠物不抢你正在
// 打字的窗口；那样的窗 DOM 里的 input.focus() 会被系统丢掉 —— 框出来了却打不进字，
// 关框又只有 Enter / Esc 两条路（都走键盘），于是框永远赖在屏幕上。三条都钉上：
console.log("\n「说点什么…」输入框（焦点 / 关闭 / 鉴权）…");
{
	const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const mainJs = readFileSync(join(ROOT, "pi", "assets", "pet-electron.cjs"), "utf8");
	const preloadJs = readFileSync(join(ROOT, "pi", "assets", "preload.cjs"), "utf8");
	const windowCjs = readFileSync(join(ROOT, "app", "window.cjs"), "utf8");
	// ① 叫输入框时先把窗切成可聚焦（顺序反了 focus 会被系统丢掉）
	check("叫输入框前先开输入模式（可聚焦）", /ipcMain\.on\("pet:say-ask",[\s\S]{0,200}setInputMode\(true\)/.test(mainJs));
	check("输入模式用 setFocusable 切（不是构造时的 focusable:false）", /win\.setFocusable\(on\)/.test(mainJs));
	// ② 关框后要把焦点还给下面的窗口，否则宠物一直顶着别人的输入焦点
	check("收工信号把输入模式关掉", /ipcMain\.on\("pet:say-input-end", \(\) => setInputMode\(false\)\)/.test(mainJs));
	check("关输入模式时先 blur", /if \(!on\) \{[\s\S]{0,120}win\.blur\(\)/.test(mainJs));
	// ③ 关框的所有路径都要走同一个 closeInput（Enter / Esc / 点宠物 / 失焦 / 主进程强收）
	check("关框只有一个入口 closeInput", /function closeInput\(\)/.test(petJs) && /self\.closeInput = closeInput/.test(petJs));
	check("Esc 走 closeInput（不是就地清一下）", /e\.key === "Escape"\) closeInput\(\)/.test(petJs));
	check("点宠物身上也收框", /pointerdown[\s\S]{0,220}self\.closeInput\(\)/.test(petJs));
	check("失焦时主进程叫渲染进程收框", /win\.on\("blur"[\s\S]{0,400}pet:say-cancel/.test(mainJs));
	check("收框信号两头都接上了", /sayInputEnd: \(\) => ipcRenderer\.send\("pet:say-input-end"\)/.test(preloadJs) && /onSayCancel: \(cb\) => ipcRenderer\.on\("pet:say-cancel"/.test(preloadJs));
	// ④ 菜单动作 401：token 必须由宿主经环境变量交给窗，窗不能只认 home/token 文件
	//    （那个文件没了 / 临时 home 盖了 → 空串 → 「unauthorized」，而用户完全看不出所以然）
	check("拉窗时把 token 交给窗（PI_PET_TOKEN）", /env\.PI_PET_TOKEN = String\(ctx\.token\)/.test(windowCjs));
	check("窗优先认 PI_PET_TOKEN，文件只当兜底", /process\.env\.PI_PET_TOKEN/.test(mainJs) && /兜底读/.test(mainJs));
	check("401 的报错要指向 token，而不是干巴巴一个 unauthorized", /failureDetail/.test(mainJs) && /鉴权 token 没读到/.test(mainJs));
}

// ---------------------------------------------------------------- 互斥：外部宿主
// 先看看本机有没有别的宿主（尤其是旧版 pi 扩展起的那个）：默认必须拒绝共存。
// PI_PET_SKIP_FOREIGN=1 只对本测试自己起的进程生效，它只关「外部状态文件」这一层。
const hostMod = await import(pathToFileURL(join(ROOT, "app", "host.cjs")).href);
const foreign = hostMod.probeExistingHosts();
console.log(`外部宿主探测：${foreign.length ? foreign.map((h) => `pid ${h.state.pid}:${h.state.port}`).join(", ") : "无"}`);

/** Run the CLI against the test HOME, resolve stdout ("" on failure). */
function runCli(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(ROOT, "bin", "pi-pet.cjs"), ...args], {
			env: { ...process.env, PI_PET_HOME: HOME, PI_PET_SKIP_FOREIGN: "1" },
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("exit", (code) => resolve(code === 0 ? out.trim() : out.trim()));
	});
}

// ---------------------------------------------------------------- 起宿主
console.log("启动宿主（serve 模式，无窗）…");
const host = spawn(process.execPath, [join(ROOT, "bin", "pi-pet.cjs"), "serve", "--port", String(PORT)], {
	env: { ...process.env, PI_PET_HOME: HOME, PI_PET_SKIP_FOREIGN: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
let hostLog = "";
host.stdout.on("data", (d) => (hostLog += d));
host.stderr.on("data", (d) => (hostLog += d));

let health = null;
for (let i = 0; i < 60; i++) {
	try {
		health = (await get(PORT, "/health")).body;
		if (health && health.role === "pi-pet-host") break;
	} catch {
		/* 还没起来 */
	}
	await sleep(150);
}
check("宿主起来了且 /health 自报 role", !!(health && health.role === "pi-pet-host"), JSON.stringify(health));
if (!health) {
	console.log(hostLog);
	host.kill();
	process.exit(1);
}

const token = readFileSync(join(HOME, "token"), "utf8").trim();
check("token 文件已生成", token.length >= 16);

// ---------------------------------------------------------------- 鉴权
console.log("\n鉴权…");
check("/event 无 token → 401", (await post(PORT, "/event", { type: "thinking" }, "")).status === 401);
check("/control 错 token → 401", (await post(PORT, "/control", { action: "state" }, "nope")).status === 401);
check("/health 免鉴权", (await get(PORT, "/health")).status === 200);

// ---------------------------------------------------------------- 能力探测
// CLI 的 withHost() 全靠它判断「这个宿主到底有没有控制面 / 事件面」：
// 外来旧宿主只有 /health + /ws + /feed，探错了 say/restart 就只剩一个裸 404。
console.log("\n能力探测（CLI withHost 依赖）…");
const caps = await probeCaps(PORT, token);
check("控制面认得（GET /control 无 action → 400 + action 清单）", caps.control === true, JSON.stringify(caps));
check("事件面认得（GET /event 无 type → 400）", caps.event === true);
check("带对 token 时鉴权通过", caps.auth === true);
check("action 清单带得上（reportMissing 靠它说人话）", caps.actions.includes("say") && caps.actions.includes("restart-window"));
const capsNoTok = await probeCaps(PORT, undefined);
check("token 不对 → 鉴权被拒，且两面都探不到（不会瞎发请求）", capsNoTok.auth === false && !capsNoTok.control && !capsNoTok.event);
// 探测本身不能弄脏状态机/日志：pi 扩展在 /feed 掉线时每 2s 探一次，
// 早期版本把「不带 type 的 GET /event」当事件喂进 bus，于是日志被刷屏。
check("能力探测不写状态机、不写「丢弃无法识别的帧」", !/丢弃无法识别的帧/.test(hostLog), hostLog.split("\n").filter((l) => /丢弃无法识别的帧/.test(l)).slice(0, 2).join(" | "));
const capsDead = await probeCaps(PORT + 1, token);
check("端口没人听 → 两面都没有（不是「都支持」）", !capsDead.control && !capsDead.event);

// ---------------------------------------------------------------- 窗接入
console.log("\n窗接入 + 状态机…");
const win = fakeWindow(PORT);
await win.ready;
await sleep(120);

// thinking 连发 5 次：动画只能播一次，气泡也只出一条（但会被续期）
for (let i = 0; i < 5; i++) {
	await post(PORT, "/event", { type: "thinking", task: "修复登录" }, token);
	await sleep(30);
}
await sleep(200);
check("重复 thinking 只产生 1 个动画帧", animFrames(win.frames).filter((f) => f === "thinking").length === 1, JSON.stringify(win.frames));
check("气泡是 sticky（不按时消失）", win.frames.some((f) => f.includes('"sticky":true')));

// 再来一次 thinking（文案没变）→ 依然不重播
const before = win.frames.length;
await post(PORT, "/event", { type: "thinking", task: "修复登录" }, token);
await sleep(150);
check("同状态同文案：零新帧", win.frames.length === before, `新帧 ${JSON.stringify(win.frames.slice(before))}`);

// 任务名变了 → 只更新气泡，不动动画
await post(PORT, "/event", { type: "thinking", task: "修复登录+注册" }, token);
await sleep(150);
check("任务名变化：只多一个气泡帧", win.frames.length === before + 1 && bubbleFrames(win.frames).pop() === "「修复登录+注册」思考中…", JSON.stringify(win.frames.slice(before)));

// tool_call：bash → write 都是「写代码组」，中间不该重播
const b2 = win.frames.length;
await post(PORT, "/event", { type: "tool_call", tool: "bash", detail: "npm test" }, token);
await sleep(120);
await post(PORT, "/event", { type: "tool_call", tool: "write" }, token);
await sleep(150);
const coding = animFrames(win.frames.slice(b2));
check("进入执行中：1 个动画帧", coding.length === 1, JSON.stringify(coding));
check("写代码组内不重播（bash→write）", coding.filter((f) => f.includes("tool_call")).length === 1);
check("执行中文案带 detail", bubbleFrames(win.frames).includes("执行中：npm test"), JSON.stringify(bubbleFrames(win.frames).slice(-2)));

// done → 回空闲 + 完成气泡
await post(PORT, "/event", { type: "done", summary: "改完 3 个文件" }, token);
await sleep(150);
check("done 回到空闲动画", animFrames(win.frames.slice(b2)).pop() === "agent_idle", JSON.stringify(animFrames(win.frames.slice(b2))));
check("完成气泡", bubbleFrames(win.frames).pop() === "完成：改完 3 个文件", JSON.stringify(bubbleFrames(win.frames).slice(-1)));

// ---------------------------------------------------------------- 手动说话
console.log("\n手动说话…");
const b3 = win.frames.length;
check("control say 成功", (await post(PORT, "/control", { action: "say", text: "过来玩" }, token)).body.ok === true);
await sleep(120);
const sayFrame = JSON.parse(win.frames.slice(b3).find((f) => f.startsWith("{\"type\":\"bubble\"")));
check("say 只冒泡、不动动画", !!sayFrame && sayFrame.text === "过来玩" && sayFrame.ms > 0 && animFrames(win.frames.slice(b3)).length === 0);
check("事件通道 say 也通", (await post(PORT, "/event", { type: "say", text: "hi" }, token)).body.ok === true);

// ---------------------------------------------------------------- 暂停
console.log("\n暂停 / 恢复…");
const b4 = win.frames.length;
await post(PORT, "/control", { action: "pause" }, token);
await post(PORT, "/event", { type: "thinking" }, token);
await sleep(150);
check("暂停后状态事件被丢弃", win.frames.length === b4, JSON.stringify(win.frames.slice(b4)));
await post(PORT, "/control", { action: "resume" }, token);
await post(PORT, "/event", { type: "thinking" }, token);
await sleep(150);
check("恢复后又能驱动", win.frames.length > b4);

// ---------------------------------------------------------------- 单只闸门
console.log("\n单只闸门…");
check("maxPets=1 时 add_pet 被拦", (await post(PORT, "/control", { action: "add-pet" }, token)).body.ok === false);
const b5 = win.frames.length;
await post(PORT, "/event", { type: "add_pet" }, token);
await sleep(120);
check("add_pet 事件也被拦（不转发）", win.frames.length === b5);

// ---------------------------------------------------------------- WS 生产者
console.log("\nWS 生产者（pi/dsh 的接法）…");
// /feed 没 token 必须被拒
const noAuth = new WebSocket(`ws://127.0.0.1:${PORT}/feed?source=bad`);
check(
	"/feed 无 token 被拒",
	await new Promise((res) => {
		noAuth.addEventListener("open", () => res(false));
		noAuth.addEventListener("error", () => res(true));
		noAuth.addEventListener("close", () => res(true));
	}),
);

const feed = new WebSocket(`ws://127.0.0.1:${PORT}/feed?source=dsh-test&token=${encodeURIComponent(token)}`);
await new Promise((res) => feed.addEventListener("open", res));
const b6 = win.frames.length;
// 先把窗放回空闲，才能看出「thinking 触发了一次状态变化」
await post(PORT, "/event", { type: "agent_idle" }, token);
await sleep(150);
const b7 = win.frames.length;
feed.send("thinking");
feed.send("thinking");
await sleep(250);
check("WS 上行两次 thinking 只触发一次状态变化", animFrames(win.frames.slice(b7)).filter((f) => f === "thinking").length === 1, JSON.stringify(win.frames.slice(b7)));
const st = (await get(PORT, "/state", token)).body;
check("/state 看得见 WS 会话", st.bus.feeds === 1 && st.bus.feedsBySource["dsh-test"] === 1, JSON.stringify(st.bus));
check(
	"/state 看得见忙碌状态",
	st.bus.state === "thinking" && st.bus.busySessions.some((s) => s.source === "dsh-test"),
	JSON.stringify(st.bus),
);
feed.close();
await sleep(250);
check("WS 断开后会话状态回落", (await get(PORT, "/state", token)).body.bus.feeds === 0);

// ---------------------------------------------------------------- 崩溃红线
// 窗被 taskkill（= pi-pet restart / --force / 崩溃自愈）时，宿主这边收到的是 TCP RST：
// socket 报 ECONNRESET → WsConnection emit("error")。EventEmitter 对没人监听的 "error"
// 是直接抛的，不兜住的话每次换窗都会在宿主里炸一条 uncaughtException。
console.log("\n连接层的 ECONNRESET 不变成未捕获异常…");
await new Promise((resolve) => {
	const s = net.connect(PORT, "127.0.0.1", () => {
		s.write(
			"GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
		);
		setTimeout(() => {
			s.resetAndDestroy(); // RST，不是 FIN
			resolve();
		}, 60);
	});
	s.on("error", () => resolve());
});
await sleep(400);
check(
	"硬 RST 一条 /ws 连接 → 宿主不记未捕获异常",
	!/未捕获异常/.test(hostLog),
	hostLog.split("\n").filter((l) => /未捕获异常/.test(l)).slice(0, 2).join(" | "),
);

// ---------------------------------------------------------------- 锁心跳
console.log("\n单例互斥 + 锁心跳…");
const owner = JSON.parse(readFileSync(join(HOME, "host.lock", "owner.json"), "utf8"));
check("锁 owner 是本进程", owner.pid === host.pid);
await sleep(2500);
const owner2 = JSON.parse(readFileSync(join(HOME, "host.lock", "owner.json"), "utf8"));
check("锁有心跳（at 在走）", owner2.at > owner.at, `${owner.at} → ${owner2.at}`);

// ---------------------------------------------------------------- 端口文件
// pi 扩展 / dsh 插件 / 外部脚本不看 state.json，只读 <home>/port 那一行。
// ⚠️ 端口是**运行期**才知道的：默认 47653 被占时 listen() 会退到随机端口，
// 所以写死端口的调用方只能靠这个文件（否则永远连不上）。
console.log("\n端口文件…");
check("home/port 里就是真实监听的端口", readFileSync(join(HOME, "port"), "utf8").trim() === String(PORT));
check("port 命令直接读它", (await runCli(["port"])) === String(PORT));
check("端口是纯数字一行（cat / readFileSync 都能用），不多带 JSON", /^\d+\n?$/.test(readFileSync(join(HOME, "port"), "utf8")));

const second = spawn(process.execPath, [join(ROOT, "bin", "pi-pet.cjs"), "start", "--port", "47700", "--no-window"], {
	env: { ...process.env, PI_PET_HOME: HOME, PI_PET_SKIP_FOREIGN: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
let secondOut = "";
second.stdout.on("data", (d) => (secondOut += d));
second.stderr.on("data", (d) => (secondOut += d));
const secondCode = await new Promise((res) => second.on("exit", res));
check("第二个宿主起不来（互斥）", secondCode === 0 && /已经在跑|锁/.test(secondOut), `exit=${secondCode} out=${secondOut.trim()}`);
check("第二个宿主没占端口 47700", (await get(47700, "/health")).status === 0);
check("活着的还是原来那个宿主", health.pid === (await get(PORT, "/health")).body.pid);

// 锁原语：用一个**别的**锁目录去试（不碰活着的那个）
const probeLock = join(HOME, "probe.lock");
const { acquireLock: probeAcquire, releaseLock: probeRelease } = await import(
	pathToFileURL(join(ROOT, "app", "single.cjs")).href
);
check("第一次能抢到锁", probeAcquire(probeLock).ok === true);
check("同一个锁抢不到第二次", probeAcquire(probeLock).ok === false);
probeRelease(probeLock);
check("释放后能再抢到", probeAcquire(probeLock).ok === true);
probeRelease(probeLock);

// ---------------------------------------------------------------- 收尾
console.log("\n收尾…");
check("stop 返回成功", (await post(PORT, "/control", { action: "shutdown" }, token)).body.ok === true);
const exitCode = await new Promise((res) => host.on("exit", res));
check("宿主干净退出", exitCode === 0, `exit=${exitCode}`);
check("锁已释放", !existsSync(join(HOME, "host.lock")));
// 留着端口文件 = 让脚本连一个没人听的端口（重连会一直报 ECONNREFUSED）
check("端口文件随宿主一起清掉（不留死端口给脚本）", !existsSync(join(HOME, "port")));

win.close();
rmSync(HOME, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
if (fail) {
	console.log(`失败项：\n  - ${failures.join("\n  - ")}`);
	process.exit(1);
}
