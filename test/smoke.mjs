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
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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
/** 会话气泡帧（v1.4：每个会话一条，sid 认领） */
const isSession = (f) => f.startsWith("{\"type\":\"session\"");
/** 位置帧（v1.2，不带动画也不带气泡；滤掉以免被当成动画帧计数） */
const isPositions = (f) => f.startsWith("{\"type\":\"positions\"");
/** 动画帧（把气泡/位置帧滤掉）：thinking / agent_idle / tool_call / add_pet / shutdown */
const animFrames = (frames) => frames.filter((f) => !isBubble(f) && !isPositions(f) && !isSession(f));
const bubbleFrames = (frames) => frames.filter(isBubble).map((f) => JSON.parse(f).text);
const positionFrames = (frames) => frames.filter(isPositions).map((f) => JSON.parse(f).map);
/** 会话气泡帧（解包成对象；收掉的那条 remove=true） */
const sessionFrames = (frames) => frames.filter(isSession).map((f) => JSON.parse(f));
/**
 * 「状态序列」= 老协议那部分（动画帧 + v1.1 那条全局气泡）。
 * ⚠️ v1.4 起会话气泡是**另一条**通道，它变了不代表状态机动了（反之亦然）：
 *    拿总帧数算「零新帧」会把两者混起来，所以一律只数这一条。
 */
const stateFrames = (frames) => frames.filter((f) => !isPositions(f) && !isSession(f));

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
// ④ 打包态（process.resourcesPath 存在 = 跑在 Electron 里）：**必须**用它，
	// 因为 asar 补丁会把 app.asar 这个文件 stat 成目录（isDirectory()===true），
	// fs 那条判断在成品里必然被骗 —— 纯 node 单测照不到，只有钉住这条分支才拦得住。
	// pkgRoot 故意传一个「文件」（冒充 app.asar），返回的必须是 resourcesPath。
	// 用赋值模拟「跑在 Electron 里」：纯 node 下这个字段是 undefined，设上去即可。
	const realResources = process.resourcesPath;
	try {
		process.resourcesPath = join(ROOT, "app");
		check("打包态用 process.resourcesPath，不问 pkgRoot（asar 被 stat 成目录）", launchCwd(join(ROOT, "package.json")) === join(ROOT, "app"));
	} finally {
		if (realResources === undefined) delete process.resourcesPath;
		else process.resourcesPath = realResources;
	}
}

// ---------------------------------------------------------------- 头顶的气泡
// 「气泡只显示一半」和「气泡不跟着宠物走」都是窗侧（渲染进程）的毛病，冒烟开不了窗，
// 所以把三条容易改回去的地方钉在这儿（都是实测踩过的坑，不是洁癖）：
console.log("\n头顶气泡（截断 / 不跟随）…");
{
const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const petCss = readFileSync(join(ROOT, "pi", "assets", "pet.css"), "utf8");
	const extTs = readFileSync(join(ROOT, "pi", "extensions", "index.ts"), "utf8");
/** 从两处源码里抠出 {small,normal,large} 的数字（逗号连起来的字符串，便于直接比） */
	const sizeOf = (src, re) => (src.match(re) || []).slice(1).join(",");
	const MIN_SIZE = Number(sizeOf(petJs, /SIZE_MAP = \{ small: (\d+)/));
	// ① 收缩盒 + left:50% 时可用宽度只有宠物宽度的一半（231px），写在 max-width 上的
	//    320/420 根本够不着，长文案就在半路被省略号切掉 —— 必须显式 width: max-content
	check("气泡显式 width:max-content（否则 max-width 够不着）", /width:\s*max-content/.test(petCss));
check("气泡不再 nowrap（一行放不下就换行）", !/white-space:\s*nowrap/.test((petCss.match(/\.pet-bubble\s*\{[^}]*\}/) || [""])[0]));
	// ② 漫游/拖拽时每帧都要重报命中区：SetWindowRgn 是按上一次上报的形状裁的，
	//    不跟着走 = 宠物移走后气泡被裁掉，看着就像「气泡留在原地」
	check("漫游时上报命中区", /container\.style\.left = mp\.left[\s\S]{0,400}pushHitRegion\(\)/.test(petJs));
	check("拖拽时上报命中区", /var dp = clampPos\([\s\S]{0,400}pushHitRegion\(\)/.test(petJs));
	// ③ 贴屏幕边时要把气泡夹回来，并且挪完再算命中区（否则形状和画出来的不是一处）
	check("气泡夹回屏幕内", /self\.clampBubble = function/.test(petJs));
	check("算命中区前先夹气泡", /clampBubbles\(\);[\s\S]{0,200}collectHitRects\(\)/.test(petJs));
	// ④ 宠物本身也不能拖到屏幕外（半只在屏外时头顶气泡必然被裁）
	check("拖拽位置有夹取", /clampPos\(e\.clientX - dragState\.offX/.test(petJs));
// ⑤ showBubble 写文案不能碰气泡框的 textContent：会把同级节点（输入行）删掉（「说点什么…」出不来）
	check("文案走独立节点，不动气泡框的 textContent", !/^\s*(?:bubble|inputRow)\.textContent\s*=/m.test(petJs) && /span\.textContent = t/.test(petJs) && /span\.className = "pet-bubble-text"/.test(petJs));
	// ⑥ 最小档宽度：舞台太窄时头顶气泡（最宽 420px）会被挤到屏幕边上，看着像被裁了一半。
	//    而且 SIZE_MAP 有**两份**（pet.js 与 pi 扩展的补全用），改一处不改另一处就前后不一。
check("最小档 ≥ 380px（气泡不被挤到屏外）", MIN_SIZE >= 380, `实际 ${MIN_SIZE}px`);
check("两处 SIZE_MAP 一致（pet.js ↔ pi 扩展补全）", sizeOf(petJs, /SIZE_MAP = \{ small: (\d+), normal: (\d+), large: (\d+)/) === sizeOf(extTs, /SIZE_MAP: Record<string, number> = \{ small: (\d+), normal: (\d+), large: (\d+)/));
}

// ---------------------------------------------- 换手不许交叉淡化（拖动闪烁的病根）
// 症状：拖动时宠物“闪一下”。根因不是搬运，是换姿势那一下两头视频在交叉淡化：
// `transition: opacity .18s` 让旧姿势淡出、新姿势淡入同时进行，约 180ms 里宠物只剩
// 一半亮度还叠着鬼影；一次拖拽连着切好几次（抓起 → 状态帧 → 落回），于是连成一片闪。
// 修法：`.pet-video` 不许有 opacity 过渡 + 换手改成等 requestVideoFrameCallback 的硬切。
// 这两条要钉住：DOM/CSS 层面一改回去，闪就回来了（见 DESIGN.md §9.19 的实测数据）。
console.log("\n换手不淡化（拖动不闪）…");
{
	const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const petCss = readFileSync(join(ROOT, "pi", "assets", "pet.css"), "utf8");
	const videoRule = (petCss.match(/\.pet-video\s*\{[^}]*\}/) || [""])[0];
	check(".pet-video 没有 opacity 过渡（淡化=宠物半透明+重影）", !/transition\s*:[^;}]*opacity/.test(videoRule), videoRule.replace(/\s+/g, " ").slice(0, 90));
	check("换手等 requestVideoFrameCallback（loadeddata 时首帧还没贴屏）", /requestVideoFrameCallback/.test(petJs));
	check("硬切有超时兜底（FRAME_WAIT_MS，rVFC 不回调时不能卡在旧姿势）", /FRAME_WAIT_MS = \d+/.test(petJs) && /setTimeout\(commit, FRAME_WAIT_MS\)/.test(petJs));
	check("换手只做一次（swapped 守卫，别让兜底和 rVFC 抢着换）", /swapped/.test(petJs));
	check("拖拽姿势在 pointerdown 预热（抓起那一下不等解码）", /warmAnim/.test(petJs) && /pointerdown[\s\S]{0,900}warmAnim/.test(petJs));
}

// ------------------------------------------------ 待机动画的节奏（别切一半 / 别太短）
// 症状两条，都是同一个病根：**待机时正在演的那段动画被从中间砍掉**。
//   ① 动画还没执行完就跳下一个 —— 触发者全是「被动」切换：鼠标扫过宠物（hover 移出就回
//      待机）、拖拽落点回待机、待机链重抽。config.jsonc 的 idle 池只有一条片子，pick()
//      排除不掉自己，于是这些回待机全是「从头重播」，看起来就是原地闪一下。
//   ② 待机时间太短 —— 权重 idle 10 / turn 5 / move 5 / action 80，一段待机呼吸刚放完就有
//      90% 概率直接跳去演随机动作，宠物一直忙个不停，根本没有「待机」这回事。
// 修法：switchTo 加门禁（minPlayMs 内不许被动切换，切换请求排队等 ended），
// 外加待机停留（idleDwellMs：待机片放完原地续播一会儿再抽下一个）。四条钉上：
console.log("\n待机动画节奏（不切一半 / 待机别太短）…");
{
	const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const cfg = readFileSync(join(ROOT, "assets", "config.jsonc"), "utf8");
	// ① 门禁：被动切换先排队，不直接换 src
	check("switchTo 有门禁（切不动就排队）", /!self\.canInterrupt\(\)[\s\S]{0,120}self\.queueSwitch\(next, nextOnce\)/.test(petJs));
	check("排队切换带 minPlayMs 兜底", /minPlayMs\(\) - \(Date\.now\(\) - self\.playedAt\)/.test(petJs));
	check("canInterrupt 放过已放完的当前段", /front\.ended\) return true/.test(petJs));
	// ② 同一段不重播（重播 = 跳回第一帧）；但**循环中的不能跳**（跳了就永远卡在那一条里）
	check("同一段不从头重播", /next === self\.playing[\s\S]{0,200}!cur\.ended && !cur\.loop\) return/.test(petJs));
	// ③ 屏幕上在放什么看 playing，不是 anim（anim 可能已被排队的请求改掉了）
	check("判定当前段用 playing", /var endedAnim = self\.playing \|\| self\.anim/.test(petJs) && /this\.playing = ""/.test(petJs));
	// ④ 待机停留：待机片放完先续播，别急着抽下一个；用户一动就收摊
	check("待机放完先停留再抽", /self\.canDwell\(endedAnim\)[\s\S]{0,80}self\.startDwell\(endedAnim\)/.test(petJs));
	check("停留期间循环续播当前片（不换 src）", /this\.startDwell = function[\s\S]{0,600}front\.loop = true/.test(petJs));
	check("用户上手就收摊（点击/拖拽/状态帧都停 dwell）", (petJs.match(/stopDwell\(\)/g) || []).length >= 4);
// ⑤ 节奏参数可配，两个默认值都写在 config.jsonc 里
	//    ⚠️ 默认值 = 用户口径的「每段动画播放时间延长 5 秒」：2.6s+5s / 6s+5s。
	//    这里把两个数都钉住：改小回去就等于「动画又被切一半」，那就是回归。
	check("timing 段带 minPlayMs / idleDwellMs（+5s 后的值）", /"minPlayMs"\s*:\s*7600/.test(cfg) && /"idleDwellMs"\s*:\s*11000/.test(cfg));
	check("timing 缺省/写错都有兜底", /function readTiming\(raw\)/.test(petJs) && /TIMING_DEFAULT = \{ minPlayMs: 7600, idleDwellMs: 11000 \}/.test(petJs));
	// ⚠️ 空闲自动冻住（idleSleepMs）已按用户意见拿掉：写回去就等于宠物空闲就停。
check("timing 段不再有 idleSleepMs（空闲不自动冻）", !/idleSleepMs/.test(cfg) && !/idleSleepMs/.test(petJs.replace(/^.*原 timing\.idleSleepMs.*$/m, "")));
}

// ------------------------------------------------ 聊天 & 碎碎念（§9.30）
// 两条需求合在这里：双击能聊天（输入框 → 回一句）、闲着没人理时自己碎碎念。
// 回归点有三个：① 碎碎念在 agent 忙/有人打字时必须闭嘴（不然盖掉状态气泡）；
//           ② 配置没写 chatter 段就得彻底闭嘴（代码里不许藏第二份默认文案）；
//           ③ 关键词取最长命中（否则「你好吗」被短词先截胡，回错话）。
console.log("\n聊天气泡 & 待机碎碎念…");
{
	const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const cfg = readFileSync(join(ROOT, "assets", "config.jsonc"), "utf8");
	check("双击宠物弹输入框（单击仍是点回应动画）", /hit\.addEventListener\("dblclick"/.test(petJs) && /self\.askSay\(\)/.test(petJs));
	check("提交后按关键词回一句", /function chatReply\(text\)/.test(petJs) && /var r = chatReply\(v\)/.test(petJs));
	check("关键词取最长命中", /keys\.sort\(function \(a, b\) \{ return b\.length - a\.length; \}\)/.test(petJs));
	check("busy 时不碎碎念（agent 忙 / 有人在输入）", /function chatBusy\(\)/.test(petJs) && /pets\[i\]\.currentOverrideAnim\) return true/.test(petJs) && /pet-bubble-input\.on/.test(petJs));
check("碎碎念自己排自己（随机时刻，不是固定间隔）", /function startChatter\(\)/.test(petJs) && /var sec = c\.idleSec\[0\] \+ Math\.random\(\)/.test(petJs) && /chatSay\(pick\(c\.idle\)\);[\s\S]{0,40}startChatter\(\);/.test(petJs));
	check("config 没写 chatter 段 → 不碎碎念、也不报错", /function readChat\(raw\)/.test(petJs) && /if \(!c \|\| typeof c !== "object"\) return null;/.test(petJs) && /chatter: readChat\(raw\)/.test(petJs));
	check("config.jsonc 里 chatter 段是真文案（idle/fallback/replies 都非空）", (() => {
		const raw = JSON.parse(readFileSync(join(ROOT, "assets", "config.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
		const ch = raw.chatter;
// enabled 只是开关（默认 false 关碎碎念），文案在不在才是回归点
		return !!ch && typeof ch.enabled === "boolean" && Array.isArray(ch.idle)
	})());
}

// ------------------------------------------------ 空闲别硬烧（别抢别的窗口的渲染预算）
// 症状：桌宠一开，别的程序的后台窗口就不刷新 / 卡成幻灯片。
// 病根是**全屏透明置顶窗**：它每产生一帧，DWM 就得把整块桌面重新合成一遍（连带下面
// 所有窗口）；待机链又一直在抽动画 → 别的窗口永远抢不到合成预算。
// 所以修法只能是：**没事的时候不产生帧**（冻在当前那一帧）＋别把重合成的高频调用打满。
// 七条钉上：
console.log("\n空闲别硬烧（不抢别的窗口的渲染预算）…");
{
	const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const pre = readFileSync(join(ROOT, "pi", "assets", "preload.cjs"), "utf8");
	const elec = readFileSync(join(ROOT, "pi", "assets", "pet-electron.cjs"), "utf8");
	const proto = readFileSync(join(ROOT, "app", "protocol.cjs"), "utf8");
	const pathsSrc = readFileSync(join(ROOT, "app", "paths.cjs"), "utf8");
	const hostSrc = readFileSync(join(ROOT, "app", "host.cjs"), "utf8");
	const busSrc = readFileSync(join(ROOT, "app", "bus.cjs"), "utf8");
	// ① 协议：只加不改（新帧），老窗不认识也无害
	check("协议有 power 帧（v1.3，只加不改）", /power: "power"/.test(proto) && /function powerFrame\(sleep\)/.test(proto));
	// ② 睡：双 video 一起暂停，醒来接着放（pause/play 不改 currentTime）
	check("睡 = 两个 video 一起暂停", /this\.sleep = function[\s\S]{0,600}videoA\.pause\(\);[\s\S]{0,60}videoB\.pause\(\)/.test(petJs));
	check("醒来接着当前帧放（有排队就补演）", /this\.wake = function[\s\S]{0,500}self\.asleepNext[\s\S]{0,400}front\.play\(\)/.test(petJs));
	check("睡着时不换 src（换 src = 一次解码 + 一次重绘）", /if \(self\.asleep\) \{[\s\S]{0,80}self\.asleepNext = \{ anim: next, once: nextOnce \};[\s\S]{0,40}return;/.test(petJs));
	check("待机续播不会把睡着的视频叫醒", /this\.startDwell = function[\s\S]{0,600}front\.loop = true[\s\S]{0,200}if \(!self\.asleep\)/.test(petJs));
// ③ 睡/醒的口子：主进程（最小化、锁屏）/ 页签隐藏 / 手动省电帧。
	//    ⚠️ 空闲自动冻住（noteActivity + armIdle 定时器）已拿掉：宠物就该一直动。
	check("空闲自动休眠已拿掉（不再有 noteActivity/armIdle）", !/function noteActivity\(\)/.test(petJs) && !/function armIdle\(\)/.test(petJs));
check("最小化/锁屏/挂起 → 睡（pet:power）", /onPower: \(cb\) => ipcRenderer\.on\("pet:power"/.test(pre) && /win\.on\("minimize", \(\) => sendPower\(true\)\)/.test(elec) && /\["lock-screen", true\]/.test(elec));
	check("页签隐藏也睡", /document\.addEventListener\("visibilitychange"[\s\S]{0,200}goSleep\(\)/.test(petJs));
	check("WS 有 power 帧处理", /obj\.type === "power"[\s\S]{0,200}applyPowerFrame/.test(petJs));
	// ④ 手动省电：落盘 + 菜单 + 只加不改的协议帧
	check("省电模式落盘（换窗/重启还在）", /powerSave: false/.test(pathsSrc) && /case "power-save"/.test(hostSrc) && /setPower\(on\)/.test(busSrc));
	check("窗接上来时补发 power 帧", /conn\.send\(powerFrame\(power\(\) === true\)\)/.test(busSrc));
check("省电接口暂时屏蔽（POWER_SAVE_ENABLED 总闸）", /POWER_SAVE_ENABLED = false/.test(hostSrc) && /!POWER_SAVE_ENABLED && \(action === "power-save"/.test(hostSrc));
	// ⚠️ 渲染侧总闸：四个触发源（窗 hide/minimize、锁屏/挂起、visibilitychange、
	//   powerSave 帧）全都汇进 goSleep，所以一道 SLEEP_ENABLED=false 就全屏蔽。
	//   恢复的话把这行删掉 —— 「看不见时自动冻住」曾经偶发再也醒不过来（宠物自己不见了）。
	check("窗侧冻住/隐藏已屏蔽（SLEEP_ENABLED 总闸）", /var SLEEP_ENABLED = false/.test(petJs) && /function goSleep\(\) \{\s*if \(!SLEEP_ENABLED\) return;/.test(petJs));
	check("右键菜单不再有「省电模式」", !/label: "省电模式/.test(elec));
	// ⑤ 高频重活（SetWindowRgn / 全屏重合成）别打满：
	//    主进程侧：同形状不重裁 + 60ms 节流 + 取最新的一份；窗侧：2px 量化后去重
	check("setShape 有去重 + 节流（不动就别重裁全屏）", /SHAPE_GAP_MS = \d+/.test(elec) && /if \(key === shapeKey\) return;/.test(elec) && /shapePending = list;/.test(elec));
	check("漫游写样式/命中区封顶 30fps", /var MOVE_FRAME_MS = 33/.test(petJs) && /now - lastWrite >= MOVE_FRAME_MS/.test(petJs) && /if \(last \|\| now - lastWrite/.test(petJs));
	check("命中区量化到 2px 再去重（亚像素抖动不重裁）", /var HIT_QUANT = 2/.test(petJs) && /x: quant2\(box\.left\)/.test(petJs) && /if \(key === lastRegionKey\) return;/.test(petJs));
	check("睡着/看不见时不上报命中区（force 仅删除宠物时用）", /function pushHitRegion\(force\)/.test(petJs) && /if \(asleep && !force\) return;/.test(petJs) && /pushHitRegion\(true\)/.test(petJs));
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
	//    ⚠️ 两条入口都得算上：右键菜单项（唯一的真实入口）和渲染进程请求。
	//    以前只钉了 ipc 那条，菜单那条绕过 setInputMode 直接 send → 框出来却打不进字。
	check("叫输入框统一走 askSay（先开输入模式再叫渲染进程）", /function askSay\(\)[\s\S]{0,300}setInputMode\(true\)[\s\S]{0,300}webContentsSend\("pet:say-ask"\)/.test(mainJs));
	check("右键菜单的「说点什么…」也走 askSay", /label: "说点什么…"[\s\S]{0,600}click: \(\) => askSay\(\)/.test(mainJs));
	check("渲染进程请求也走 askSay", /ipcMain\.on\("pet:say-ask", \(\) => askSay\(\)\)/.test(mainJs));
	check("输入模式用 setFocusable 切（不是构造时的 focusable:false）", /win\.setFocusable\(on\)/.test(mainJs));
	check("开输入模式后要补几遍 focus（菜单收起时第一下常被吞）", /focusWindow\(\);[\s\S]{0,80}\[\s*50,\s*160,\s*320\s*\]\.forEach/.test(mainJs));
	// ② 关框后要把焦点还给下面的窗口，否则宠物一直顶着别人的输入焦点
	check("收工信号把输入模式关掉", /ipcMain\.on\("pet:say-input-end", \(\) => setInputMode\(false\)\)/.test(mainJs));
	check("关输入模式时先 blur", /if \(!on\) \{[\s\S]{0,120}win\.blur\(\)/.test(mainJs));
	// ③ 关框的所有路径都要走同一个 closeInput（Enter / Esc / 点宠物 / 失焦 / 主进程强收）
	check("关框只有一个入口 closeInput", /function closeInput\(\)/.test(petJs) && /self\.closeInput = closeInput/.test(petJs));
	check("Esc 走 closeInput（不是就地清一下）", /e\.key === "Escape"\) closeInput\(\)/.test(petJs));
	check("拿不到焦点就收框（不留打不了字又关不掉的框）", /FOCUS_LADDER[\s\S]{0,400}document\.activeElement !== input\) closeInput\(\)/.test(petJs));
	check("点宠物身上也收框", /pointerdown[\s\S]{0,220}self\.closeInput\(\)/.test(petJs));
	check("失焦时主进程叫渲染进程收框", /win\.on\("blur"[\s\S]{0,400}pet:say-cancel/.test(mainJs));
	check("收框信号两头都接上了", /sayInputEnd: \(\) => ipcRenderer\.send\("pet:say-input-end"\)/.test(preloadJs) && /onSayCancel: \(cb\) => ipcRenderer\.on\("pet:say-cancel"/.test(preloadJs));
	// ④ 菜单动作 401：token 必须由宿主经环境变量交给窗，窗不能只认 home/token 文件
	//    （那个文件没了 / 临时 home 盖了 → 空串 → 「unauthorized」，而用户完全看不出所以然）
	check("拉窗时把 token 交给窗（PI_PET_TOKEN）", /env\.PI_PET_TOKEN = String\(ctx\.token\)/.test(windowCjs));
	check("窗优先认 PI_PET_TOKEN，文件只当兜底", /process\.env\.PI_PET_TOKEN/.test(mainJs) && /兜底读/.test(mainJs));
check("401 的报错要指向 token，而不是干巴巴一个 unauthorized", /failureDetail/.test(mainJs) && /鉴权 token 没读到/.test(mainJs));
}

// ------------------------------------------------ 右键菜单：不再有「尺寸」
// 换尺寸要重启整扇窗，代价远大于收益（小号还得为气泡不被裁而顶着 380px 下限），
// 所以菜单里那档子菜单拿掉了 —— 钉一条，免得哪天顺手又长回来。API（set-ctrl / /pet small）仍在。
console.log("\n右键菜单（不提供换尺寸）…");
{
	const mainJs = readFileSync(join(ROOT, "pi", "assets", "pet-electron.cjs"), "utf8");
const menuRaw = /Menu\.buildFromTemplate\(\[([\s\S]*?)\]\);/.exec(mainJs)?.[1] || "";
	// 注释里会提到「尺寸」这两个字，判菜单项之前先把 // 注释抹掉
	const menuBlock = menuRaw.replace(/\/\/[^\n]*/g, "");
	check("菜单里没有尺寸子菜单", !/尺寸/.test(menuBlock) && !/submenu:/.test(menuBlock));
	check("换一只 / 添加一只 / 退出 还在", /换一只（重启窗）/.test(menuBlock) && /添加一只/.test(menuBlock) && /退出桌宠/.test(menuBlock));
	check("换尺寸仍可走 API（文档里留了路）", /set-ctrl/.test(mainJs));
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
	// PI_PET_NO_UPDATE：不自动查更新（测试里不该动网络）
	// PI_PET_UPDATE_NO_FETCH：手动 check-update 也只比本地 ref（快，且不需要网）
	env: { ...process.env, PI_PET_HOME: HOME, PI_PET_SKIP_FOREIGN: "1", PI_PET_NO_UPDATE: "1", PI_PET_UPDATE_NO_FETCH: "1" },
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
const before = stateFrames(win.frames).length;
await post(PORT, "/event", { type: "thinking", task: "修复登录" }, token);
await sleep(150);
check("同状态同文案：零新帧", stateFrames(win.frames).length === before, `新帧 ${JSON.stringify(win.frames.slice(before))}`);

// 任务名变了 → 只更新气泡，不动动画
await post(PORT, "/event", { type: "thinking", task: "修复登录+注册" }, token);
await sleep(150);
check("任务名变化：只多一个气泡帧", stateFrames(win.frames).length === before + 1 && bubbleFrames(win.frames).pop() === "「修复登录+注册」思考中…", JSON.stringify(stateFrames(win.frames).slice(before)));

// tool_call：bash → write 都是「写代码组」，中间不该重播
const b2 = stateFrames(win.frames).length;
await post(PORT, "/event", { type: "tool_call", tool: "bash", detail: "npm test" }, token);
await sleep(120);
await post(PORT, "/event", { type: "tool_call", tool: "write" }, token);
await sleep(150);
const coding = animFrames(stateFrames(win.frames).slice(b2));
check("进入执行中：1 个动画帧", coding.length === 1, JSON.stringify(coding));
check("写代码组内不重播（bash→write）", coding.filter((f) => f.includes("tool_call")).length === 1);
check("执行中文案带 detail", bubbleFrames(win.frames).includes("执行中：npm test"), JSON.stringify(bubbleFrames(win.frames).slice(-2)));

// done → 回空闲 + 完成气泡
await post(PORT, "/event", { type: "done", summary: "改完 3 个文件" }, token);
await sleep(150);
check("done 回到空闲动画", animFrames(stateFrames(win.frames).slice(b2)).pop() === "agent_idle", JSON.stringify(animFrames(stateFrames(win.frames).slice(b2))));
check("完成气泡", bubbleFrames(win.frames).pop() === "完成：改完 3 个文件", JSON.stringify(bubbleFrames(win.frames).slice(-1)));

// ---------------------------------------------------------------- 手动说话
console.log("\n手动说话…");
const b3 = stateFrames(win.frames).length;
check("control say 成功", (await post(PORT, "/control", { action: "say", text: "过来玩" }, token)).body.ok === true);
await sleep(120);
const sayFrame = JSON.parse(stateFrames(win.frames).slice(b3).find((f) => f.startsWith("{\"type\":\"bubble\"")));
check("say 只冒泡、不动动画", !!sayFrame && sayFrame.text === "过来玩" && sayFrame.ms > 0 && animFrames(stateFrames(win.frames).slice(b3)).length === 0);
check("事件通道 say 也通", (await post(PORT, "/event", { type: "say", text: "hi" }, token)).body.ok === true);

// ---------------------------------------------------------------- 位置记忆
// 症状：拖完松手，下次启动又回 config.jsonc 写死的那个角落。
// 修法：松手时把**比例**（rx/ry）报给宿主落盘 home/positions.json，窗接上来时宿主补发一帧。
console.log("\n位置记忆（下次启动还在这儿）…");
{
	check("set-position 落盘成功", (await post(PORT, "/control", { action: "set-position", id: "pet-1", rx: 0.62, ry: 0.44 }, token)).body.ok === true);
	const posFile = join(HOME, "positions.json");
	const saved = existsSync(posFile) ? JSON.parse(readFileSync(posFile, "utf8")) : null;
	check("positions.json 里存的是比例坐标", saved && saved["pet-1"] && saved["pet-1"].rx === 0.62 && saved["pet-1"].ry === 0.44, JSON.stringify(saved));
	check("坐标不合法时被拒（不写坏文件）", (await post(PORT, "/control", { action: "set-position", id: "pet-1", rx: "abc", ry: 0.2 }, token)).body.ok === false);
	check("缺 id 时被拒", (await post(PORT, "/control", { action: "set-position", rx: 0.5, ry: 0.5 }, token)).body.ok === false);
	check("被拒的那次没把原来的位置冲掉", JSON.parse(readFileSync(posFile, "utf8"))["pet-1"].rx === 0.62);

	// 关键一环：**新接上来的窗**要拿到补发（换窗/崩溃重开都靠它）
	const win2 = fakeWindow(PORT);
	await win2.ready;
	await sleep(200);
	const maps = positionFrames(win2.frames);
check("新窗接上就收到位置帧", maps.length === 1 && maps[0]["pet-1"] && maps[0]["pet-1"].rx === 0.62 && maps[0]["pet-1"].ry === 0.44, JSON.stringify(win2.frames.slice(0, 3)));
	// 位置帧是**额外**补的一帧，不能把原有的状态/气泡补发顶掉
	const lastAnim = animFrames(win.frames).pop();
	check("位置帧没挤掉状态补发（新窗仍拿到当前状态）", !!lastAnim && win2.frames.includes(lastAnim), `lastAnim=${lastAnim}`);
	win2.close();
	await sleep(80);

	// 合并写：第二只不能把第一只的清掉
	await post(PORT, "/control", { action: "set-position", id: "pet-2", rx: 0.1, ry: 0.9 }, token);
	const merged = JSON.parse(readFileSync(posFile, "utf8"));
	check("多只合并写（互不清空）", merged["pet-1"] && merged["pet-2"] && merged["pet-2"].ry === 0.9, JSON.stringify(merged));

	// 洗白：窗与文件都不可信
	const { sanitizePositions } = await import(pathToFileURL(join(ROOT, "app", "protocol.cjs")).href);
	const dirty = sanitizePositions({ "": { rx: 1, ry: 1 }, a: { rx: "x", ry: 0.5 }, b: { rx: 2, ry: -1 }, c: { rx: 0.5, ry: 0.5 } });
check("洗白：非法 id/坐标被丢掉、越界夹回 0~1", JSON.stringify(dirty) === JSON.stringify({ b: { rx: 1, ry: 0 }, c: { rx: 0.5, ry: 0.5 } }), JSON.stringify(dirty));

	// 落点还带一个可选的 w/h（存的时候窗多大）—— 窗变了才能换算回同一个屏幕位置（§9.23）。
	const withWH = sanitizePositions({ d: { rx: 0.3, ry: 0.4, w: 622, h: 470 }, e: { rx: 0.3, ry: 0.4, w: "x" }, f: { rx: 0.3, ry: 0.4, w: -5, h: 470 } });
	check("位置帧带 w/h（数字才认，非数/非正丢掉）", withWH.d && withWH.d.w === 622 && withWH.d.h === 470 && withWH.e && withWH.e.w === undefined && withWH.f && withWH.f.w === undefined, JSON.stringify(withWH));
	await post(PORT, "/control", { action: "set-position", id: "pet-3", rx: 0.25, ry: 0.75, w: 862, h: 470 }, token);
	const withWHRound = JSON.parse(readFileSync(posFile, "utf8"));
	check("set-position 的 w/h 落盘（窗下次启动才换算得回去）", withWHRound["pet-3"].w === 862 && withWHRound["pet-3"].h === 470, JSON.stringify(withWHRound["pet-3"]));

	// 窗侧接线（渲染进程 / preload / 主进程）
	const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const preloadJs = readFileSync(join(ROOT, "pi", "assets", "preload.cjs"), "utf8");
	const mainJs = readFileSync(join(ROOT, "pi", "assets", "pet-electron.cjs"), "utf8");
	check("pet.js 认 positions 帧并套用", /obj\.type === "positions"[\s\S]{0,300}applySavedPositions\(\)/.test(petJs));
	check("拖拽松手就上报落点", /movedLocally = true[\s\S]{0,120}savePosition\(self\)/.test(petJs));
	check("用户已经拖过的宠物不被补发帧拽回去", /if \(!p \|\| p\.movedLocally \|\| p\.destroyed\) continue/.test(petJs));
check("套用位置后要重报命中区（宠物挪走了）", /p\.customPos = \{ rx: rescalePos\([\s\S]{0,400}pushHitRegion\(\)/.test(petJs));
check("preload 有 savePosition 桥（渲染进程没 token）", /savePosition: \(id, rx, ry, w, h\) => ipcRenderer\.send\("pet:save-position"/.test(preloadJs));
check("主进程代写 /control set-position", /ipcMain\.on\("pet:save-position"[\s\S]{0,400}callHost\("set-position"/.test(mainJs));
// ⚠️ 落点一律存**比例 + 当时窗宽高**（窗口尺寸变了才能换算回去）。
//   pointerup 那处必须拿 container 的实际矩形（rc），不能拿 e.clientX 反推 ——
//   贴边滑移会改写容器在窗里的位置，反推出来的是「光标该在的地方」，差着贴边那一截。
check("位置存的是比例不是像素", /p\.customPos = \{ rx: rescalePos\(/.test(petJs) && /customPos = \{ rx: \(done\.left \+ halfW\) \/ W, ry: \(done\.top \+ halfH\) \/ H, w: W, h: H \}/.test(petJs) && /customPos = \{ rx: \(rc\.left \+ halfW\) \/ W1, ry: \(rc\.top \+ halfH\) \/ H1, w: W1, h: H1 \}/.test(petJs));
}

// ---------------------------------------------------------------- 暂停
console.log("\n暂停 / 恢复…");
const b4 = stateFrames(win.frames).length;
await post(PORT, "/control", { action: "pause" }, token);
await post(PORT, "/event", { type: "thinking" }, token);
await sleep(150);
check("暂停后状态事件被丢弃", stateFrames(win.frames).length === b4, JSON.stringify(stateFrames(win.frames).slice(b4)));
await post(PORT, "/control", { action: "resume" }, token);
await post(PORT, "/event", { type: "thinking" }, token);
await sleep(150);
check("恢复后又能驱动", stateFrames(win.frames).length > b4);

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

// -------------------------------------------------- 每会话一条气泡（v1.4）
// 需求：多开几个 pi 时，**每个会话一个单独气泡框**，框上写会话标题 + 执行中/已完成；
// 会话退出（连接断）或用户点掉已完成的那条 ⇒ 移除该气泡。
// 回归点有三个：① 一条连接 = 一个会话（两个 pi 不许挤成一条）；② 同一会话的状态变化
//   是**原地换**而不是新冒一条；③ 「点掉」必须同时告诉宿主，否则补发又塞回来。
// ⚠️ 这一整段用**自己那扇假窗**看帧（win 记着前面所有 /event 的历史帧，混一起看不出变化）。
console.log("\n每会话一条气泡（sid 认领 / 退出即收 / 点掉即消失）…");
{
	const w = fakeWindow(PORT);
	await w.ready;
	await sleep(120);
	const since = (n) => w.frames.slice(n);
	const mark = () => w.frames.length;
const live = () => {
		const m = new Map();
		// 只看 pi 来源的：假窗接上来时会**补发**宿主现有的**所有**会话气泡
		// （含前面 /event 那个 src:http 的），混进来就看不出本段的变化了。
		for (const f of sessionFrames(w.frames)) if (!f.remove && f.source === "pi") m.set(f.sid, f);
		return m;
	};

	// 同一 source 连两条 = 两个会话（多开 pi 就是这么来的）
	const a = new WebSocket(`ws://127.0.0.1:${PORT}/feed?source=pi&token=${encodeURIComponent(token)}`);
	await new Promise((r) => a.addEventListener("open", r));
	const b = new WebSocket(`ws://127.0.0.1:${PORT}/feed?source=pi&token=${encodeURIComponent(token)}`);
	await new Promise((r) => b.addEventListener("open", r));
	await sleep(100);

	// 只报标题：不改状态、不冒泡（没干活就不占头顶）
	let n = mark();
	a.send(JSON.stringify({ type: "session", title: "修复登录" }));
	await sleep(150);
	check("只报标题不冒泡（没开始干活）", sessionFrames(since(n)).length === 0, JSON.stringify(since(n)));

	a.send(JSON.stringify({ type: "thinking" }));
	await sleep(120);
	a.send(JSON.stringify({ type: "tool_call", tool: "bash", detail: "npm test" }));
	await sleep(180);
	const one = [...live().values()];
	check("第一个会话冒出一条「执行中」气泡", one.length === 1 && one[0].status === "running" && one[0].title === "修复登录" && one[0].text === "npm test", JSON.stringify(one));
	const sidA = one[0] && one[0].sid;
	check("气泡带 sid（窗靠它认领）", !!sidA && typeof sidA === "string", JSON.stringify(one));

	// 第二个会话（同一 source 的另一条连接）⇒ **另一条**气泡，不是同一条的更新
	b.send(JSON.stringify({ type: "session", title: "写文档" }));
	await sleep(100);
	b.send(JSON.stringify({ type: "thinking", task: "README" }));
	await sleep(180);
	const two = live();
	const sidB = [...two.keys()].find((s) => s !== sidA);
	check("两个会话各有一条（sid 不一样）", two.size === 2 && !!sidB, JSON.stringify([...two.values()]));
	check("第二个会话的标题是自己的", !!sidB && two.get(sidB).title === "写文档", JSON.stringify([...two.values()]));

	// 同一会话的状态变化 = 原地换（sid 一样、条数不变）
	n = mark();
	a.send(JSON.stringify({ type: "thinking" }));
	await sleep(180);
	check("同一会话改状态不新冒一条（sid 认领）", live().size === 2 && sessionFrames(since(n)).every((f) => f.sid === sidA), JSON.stringify(since(n)));

	// done → 那条变「已完成」，但**留着**（等会话退出或用户点掉）
	a.send(JSON.stringify({ type: "done", summary: "改完 3 个文件" }));
	await sleep(180);
	const doneA = live().get(sidA);
	check("done → 变「已完成」并保留", doneA && doneA.status === "done" && doneA.text === "改完 3 个文件", JSON.stringify(doneA));

	// 点掉已完成的那条 → 宿主也得忘掉它（不然补发/续期又塞回来）
	check("dismiss-bubble 成功", (await post(PORT, "/control", { action: "dismiss-bubble", sid: sidA }, token)).body.ok === true);
	const stAfter = (await get(PORT, "/state", token)).body.bus.sessionBubbles || [];
	check("点掉后宿主不再留着它", !stAfter.some((x) => x.sid === sidA), JSON.stringify(stAfter));
	n = mark();
	a.send(JSON.stringify({ type: "done" }));
	await sleep(180);
	check("点掉之后同一个 done 不把它塞回来", !sessionFrames(since(n)).some((f) => f.sid === sidA && !f.remove), JSON.stringify(since(n)));
	// 下一轮真忙起来 → 气泡重新冒（否则「点一下就再也不出现」）
	a.send(JSON.stringify({ type: "thinking" }));
	await sleep(180);
	check("下一轮开工时气泡重新出现", (live().get(sidA) || {}).status === "running", JSON.stringify([...live().values()]));

	// 窗重连（换窗 / 崩溃重开）→ 逐条补发；再动一下也要能更新到
	const w2 = fakeWindow(PORT);
	await w2.ready;
	await sleep(200);
const resent = sessionFrames(w2.frames);
	check("新接上的窗能拿到补发的会话气泡", resent.length >= 2 && resent.every((f) => typeof f.sid === "string"), JSON.stringify(resent));
	b.send(JSON.stringify({ type: "tool_call", tool: "read", detail: "a.ts" }));
	await sleep(180);
	check("补发之后继续更新（还是同一条 sid）", sessionFrames(w2.frames).filter((f) => f.sid === sidB).pop().text === "a.ts", JSON.stringify(sessionFrames(w2.frames)));
	w2.close();
	await sleep(80);

	// 会话退出（连接断）⇒ 移除那条气泡，另一条不受影响
	a.close();
	await sleep(300);
	const gone = sessionFrames(w.frames).filter((f) => f.remove && f.sid === sidA);
	check("会话退出 → 发 remove 收掉那条气泡", gone.length >= 1, JSON.stringify(gone));
	check("别的会话的气泡不动", !!live().get(sidB), JSON.stringify([...live().values()]));
	b.close();
	await sleep(200);

	// 窗侧接线（渲染进程 / preload / 主进程）
	const petJs = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
	const petCss = readFileSync(join(ROOT, "pi", "assets", "pet.css"), "utf8");
	const preloadJs = readFileSync(join(ROOT, "pi", "assets", "preload.cjs"), "utf8");
	const mainJs = readFileSync(join(ROOT, "pi", "assets", "pet-electron.cjs"), "utf8");
	check("pet.js 认 session 帧（老窗忽略即可）", /obj\.type === "session"[\s\S]{0,200}applySessionFrame\(obj\)/.test(petJs));
	check("session 帧不能拿去切动画（它是气泡不是状态）", /function applyEventOverride\(anim\)[\s\S]{0,120}anim === "session"/.test(petJs));
	check("会话气泡按 sid 认领（原地换，不堆条）", /function bubbleIndexBySid\(sid\)/.test(petJs) && /var at = bubbleIndexBySid\(sid\)/.test(petJs));
	check("退出/点掉都能按 sid 移除", /self\.removeSessionBubble = function/.test(petJs));
	// ⚠️ 点掉必须**同时**告诉宿主：不然下一次补发/续期又把它塞回来（用户看着像「点了没用」）
	check("点掉已完成的会通知宿主（dismiss-bubble）", /__petElectron__\.dismissSession\(sid\)/.test(petJs) && /dismissSession: \(sid\) => ipcRenderer\.send\("pet:dismiss-session"/.test(preloadJs) && /ipcMain\.on\("pet:dismiss-session"[\s\S]{0,300}callHost\("dismiss-bubble"/.test(mainJs));
	// 角标：执行中 / 已完成；执行中的不吃点击，已完成的才能点
	check("执行中的气泡不吃点击，已完成的可点", /\.pet-bubble-session \{[\s\S]{0,200}pointer-events: none/.test(petCss) && /\.pet-bubble-session\.done \{[\s\S]{0,120}pointer-events: auto/.test(petCss));
	check("状态角标写死执行中/已完成两个词", /done \? "已完成" : "执行中"/.test(petJs));
	// 老宿主（只会发 v1.1 全局气泡）不能黑屏：session 帧一个没收到时照旧画那条
	check("老宿主退路：没收到过 session 帧时仍画全局气泡", /if \(obj\.sticky === true && hostSpeaksSessions\) return;/.test(petJs));
	// 新宿主下那条全局气泡会跟会话气泡重复说同一句话 ⇒ 收掉（只清一次）
	check("宿主换口径后清掉重复的全局状态气泡", /if \(first\) for \(var k = 0;[\s\S]{0,120}clearStateBubbles/.test(petJs) && /self\.clearStateBubbles = function/.test(petJs));
	w.close();
	await sleep(120);
}

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
// ⚠️ 端口是**运行期**才知道的：配置里的 47653 被占时 listen() 会换一个，
// 所以写死端口的调用方只能靠这个文件（否则永远连不上）。
console.log("\n端口文件…");
check("home/port 里就是真实监听的端口", readFileSync(join(HOME, "port"), "utf8").trim() === String(PORT));
check("port 命令直接读它", (await runCli(["port"])) === String(PORT));
check("端口是纯数字一行（cat / readFileSync 都能用），不多带 JSON", /^\d+\n?$/.test(readFileSync(join(HOME, "port"), "utf8")));
// 端口**固定**：真用上的那个记在 port.keep（退出也不删），下次启动第一个就试它。
const hostSrcEarly = readFileSync(join(ROOT, "app", "host.cjs"), "utf8");
const serverSrcEarly = readFileSync(join(ROOT, "app", "server.cjs"), "utf8");
const pathsSrcEarly = readFileSync(join(ROOT, "app", "paths.cjs"), "utf8");
check("home/port.keep 记住真用上的端口", existsSync(join(HOME, "port.keep")) && readFileSync(join(HOME, "port.keep"), "utf8").trim() === String(PORT));
check("宿主启动时先读 port.keep（复用上次端口），再退配置里的", /candidates = flagPort \? \[flagPort, cfg\.port\] : \[readPortKeep\(\), cfg\.port\]/.test(hostSrcEarly));
check("listen 按候选顺序试，被占才换（不是一被占就整段随机）", /portCandidates/.test(serverSrcEarly) && /EADDRINUSE[\s\S]{0,160}tryAt\(i \+ 1/.test(serverSrcEarly));
check("port.keep 只在真的换了端口时才写（没换不碰文件）", /if \(readPortKeep\(\) !== port && writePortKeep\(port\)\)/.test(hostSrcEarly));
check("清端口文件只删 port，不动 port.keep（记忆得留住）", /fs\.rmSync\(PATHS\.port, \{ force: true \}\)/.test(pathsSrcEarly) && !/clearPortFile[\s\S]{0,400}rmSync\(PATHS\.portKeep/.test(pathsSrcEarly));
// 候选表本身（纯函数，不用起进程就能验）：顺序 = 优先级，去重，不够才补随机。
{
	const srv = (await import(pathToFileURL(join(ROOT, "app", "server.cjs")).href)).default;
	const pc = srv.portCandidates;
	check("候选表按顺序排（记忆端口在前）", JSON.stringify(pc([47888, 47653], 3, () => 30000)) === "[47888,47653,30000]");
	check("候选表去重（记忆端口 == 配置端口时不试两遍）", JSON.stringify(pc([47653, 47653], 2, () => 30000)) === "[47653,30000]");
	check("候选表丢掉非法端口", JSON.stringify(pc([0, -1, 47653, 70000], 2, () => 30000)) === "[47653,30000]");
	check("候选表兼容老的单数字写法", JSON.stringify(pc(47653, 2, () => 30000)) === "[47653,30000]");
}

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

// ---------------------------------------------------------------- 检查更新
// 查/装都走控制面；实现全在 app/updater.cjs，这里验证「动作存在、回包形状对、
// 不会顺手把本地改动冲掉」（PI_PET_UPDATE_NO_FETCH 让它不碰网络）。
console.log("\n检查更新…");
const updSrc = readFileSync(join(ROOT, "app", "updater.cjs"), "utf8");
const hostSrc = readFileSync(join(ROOT, "app", "host.cjs"), "utf8");
const serverSrc = readFileSync(join(ROOT, "app", "server.cjs"), "utf8");
const elecSrc = readFileSync(join(ROOT, "pi", "assets", "pet-electron.cjs"), "utf8");
const petSrc = readFileSync(join(ROOT, "pi", "assets", "pet.js"), "utf8");
const petCss = readFileSync(join(ROOT, "pi", "assets", "pet.css"), "utf8");
const preloadSrc = readFileSync(join(ROOT, "pi", "assets", "preload.cjs"), "utf8");
const protoSrc = readFileSync(join(ROOT, "app", "protocol.cjs"), "utf8");
const pathsSrc = readFileSync(join(ROOT, "app", "paths.cjs"), "utf8");

const chk = (await post(PORT, "/control", { action: "check-update" }, token)).body;
check("check-update 有回包", !!chk);
check("check-update 回带 update 摘要（mode/version/current）", !!(chk.update && chk.update.mode && chk.update.version));
check("check-update 不把宿主带崩（宿主还活着）", (await get(PORT, "/health")).body.role === "pi-pet-host");
check("装法认得出来（本仓库是 git 检出）", chk.update.mode === "git", `mode=${chk.update && chk.update.mode}`);
check("/state 里也带得上一份更新信息", typeof (await get(PORT, "/state", token)).body.state.update === "object");

check("更新只认 --ff-only（不要自动 merge）", /pull", "--ff-only/.test(updSrc));
check("工作区脏就拒绝自动更（别冲掉用户的本地改动）", /dirty\(info\.dir\)[\s\S]{0,400}有本地改动/.test(updSrc));
check("git 模式认远端分支而不是写死 origin/main", /rev-parse", "--abbrev-ref", "--symbolic-full-name", "@\{u\}"/.test(updSrc));
check("npm 非全局装只报告不代劳", /info\.global[\s\S]{0,600}只报告不代劳/.test(updSrc));
check("自动检查有开关（PI_PET_NO_UPDATE / 间隔 / 延迟）", /PI_PET_NO_UPDATE/.test(updSrc) && /PI_PET_UPDATE_GAP_MS/.test(updSrc) && /PI_PET_UPDATE_DELAY_MS/.test(updSrc));
check("自动检查按 home/update.json 限频", /PI_PET_UPDATE_GAP_MS[\s\S]{0,1200}readStateFile\(home, "update\.json"\)[\s\S]{0,900}gapMs/.test(updSrc));
check("host 起动就自动查 + 自动装 + 换窗", /updater\.autoUpdate\(PATHS\.home, \{[\s\S]{0,400}win\.restart\(/.test(hostSrc));
check("update-info 在 listen 之前就有（不然第一下请求吃到 TDZ）", hostSrc.indexOf("updater.readUpdateInfo(PATHS.home)") < hostSrc.indexOf("await listen(server"));
check("control 可以是 Promise（server 那头 await）", /await ctx\.control\(/.test(serverSrc));
check("宿主不会 spawnSync 卡死自己", !/spawnSync\s*\(/.test(hostSrc));
check("菜单里有「检查更新」", /label: "检查更新…"/.test(elecSrc));
// ⚠️ 症状：第一次点菜单里的「检查更新…」不弹窗，第二次才弹（DESIGN.md §9.30）。
// 无父窗的 message box 是应用级模态，而窗平时 focusable:false ⇒ 弹不到前台；菜单收尾时
// 创建的模态框还会被 Windows 吞掉。所以只认showDialog 这一个出口。
check("所有弹窗都走 showDialog（不再直接 dialog.showMessageBox）", !/dialog\.showMessageBox\(/.test(elecSrc.replace(/dialog\.showMessageBox\(win, opts\)/, "")) && /function showDialog\(opts\)/.test(elecSrc));
check("弹窗带父窗 win（模态到那扇窗，不靠进程在前台）", /dialog\.showMessageBox\(win, opts\)/.test(elecSrc));
check("弹窗延后一拍再弹（等原生菜单收干净）", /showDialog[\s\S]{0,400}setTimeout\(r, 80\)/.test(elecSrc));
check("弹窗期间临时给窗可聚焦 + 激活，弹完还原", /setFocusable\(true\)[\s\S]{0,600}setFocusable\(false\)/.test(elecSrc));
check("连点两下只弹一个盒子（showDialog 排队）", /const prev = dialogBusy[\s\S]{0,80}dialogBusy = prev\.then/.test(elecSrc));
check("菜单更新走宿主（check-update / do-update）", /callHost\("check-update"/.test(elecSrc) && /callHost\("do-update"/.test(elecSrc));
check("菜单更新请求的超时给到分钟级（git fetch / npm i 很慢）", /callHost\("check-update", \{\}, token, 240000\)/.test(elecSrc));
check("自动更新不需要用户点（宿主自己拉）", /PI_PET_NO_UPDATE=1 → 不自动检查更新/.test(updSrc));
// 单文件 exe：认 env、问 Releases、退出后覆盖（正在跑的 exe 是锁着的，直接 move 必失败）
check("认得 portable 单文件（PORTABLE_EXECUTABLE_FILE）", /PORTABLE_EXECUTABLE_FILE/.test(updSrc));
check("portable 查 GitHub Releases 的 latest tag", /api\.github\.com\/repos\/\$\{REPO\}\/releases\/latest/.test(updSrc));
check("portable 覆盖要等进程退出（不能直接 move 正在跑的 exe）", /tasklist \/fi "PID eq/.test(updSrc) && /if not errorlevel 1 goto wait/.test(updSrc));
check("portable 不在启动时偷着下 125MB", /自动检查更新：portable 单文件不自动下载/.test(updSrc));
// 版本号比较：字符串比会把 2026.9.3 判成比 2026.09.30 小 → 反复骗人“假有更新”
const upd = await import(pathToFileURL(join(ROOT, "app", "updater.cjs")).href);
check("版本号逐段按数字比（不是字符串比）", upd.cmpVersion("2026.09.30.0002", "2026.9.30.0001") === 1);
check("版本号相等时没有更新（含 v 前缀）", upd.cmpVersion("v2026.09.30.0002", "2026.09.30.0002") === 0);
check("版本号短的那个不比长的新", upd.cmpVersion("2026.9.3", "2026.09.30.0002") === -1);

check("do-update 不会用空串盖掉刚查到的版本/提交", /if \(!s\[k\]\) delete s\[k\]/.test(hostSrc));

// ---------------------------------------------------------------- 舞台窗（小窗，别改回全屏）
console.log("\n舞台窗（只包住宠物，不是全屏）…");
check("主进程不再按屏幕大小开窗", !/workAreaSize/.test(elecSrc));
check("窗落点落在工作区里（默认右下角 + 记住上次）", /workArea/.test(elecSrc) && /stage\.json/.test(elecSrc));
check("拖宠物 = 搬窗（位移从按下那下算起）", /queueWinMove\(dx, dy\)/.test(petSrc) && /windowDrag\.x \+ dx/.test(elecSrc));
// ⚠️ 位移必须是**屏幕**坐标：clientX/Y 是窗内坐标，而窗正跟着拖拽一起动，
//   拿它算「从按下那下算起的位移」= 光标位移 - 窗已走的位移 → 每次只跟上一半
//   （实测跟手比 0.50，窗还一格一格抖。见 DESIGN.md §9.20）。
check("搬窗位移用屏幕坐标（不是窗内 clientX —— 那样只跟一半）", /var p = screenPoint\(e\)[\s\S]{0,200}var dx = p\.x - dragState\.psx/.test(petSrc) && /queueWinMove\(dx, dy/.test(petSrc) && !/queueWinMove\(e\.clientX/.test(petSrc));
check("按下时记下屏幕坐标基准点（psx/psy）", /psx: ps\.x[\s\S]{0,40}psy: ps\.y/.test(petSrc) && /function screenPoint\(e\)/.test(petSrc));
check("screenX/Y 拿不到时退回 client（别把拖拽弄死）", /Number\.isFinite\(sx\) && Number\.isFinite\(sy\)/.test(petSrc) && /return \{ x: Number\(e\.clientX\) \|\| 0, y: Number\(e\.clientY\) \|\| 0 \}/.test(petSrc));
check("主进程/preload 都写明 dx/dy 是屏幕位移", /屏幕坐标/.test(elecSrc) && /屏幕坐标/.test(preloadSrc) && /屏幕坐标/.test(petSrc));
// ⚠️ 夹的是**整扇窗**进屏，不是「宠物别出屏」（§9.23）：早先夹的是后者（窗挂到屏外
//   il-6，宠物能贴屏幕边），而气泡只按**窗**夹 ⇒ 窗挂出去多少就有多少气泡在屏外看不见。
check("搬窗时把**整扇窗**夹在屏幕工作区内（窗挂出去多少就有多少气泡看不见）", /const loX = w\.x;[\s\S]{0,200}const hiX = w\.x \+ w\.width - cs\.w/.test(elecSrc) && !/w\.x - il \+ 6/.test(elecSrc) && !/w\.y - it \+ 6/.test(elecSrc));
check("搬窗的窗尺寸按拖拽开始时缓存一次（别每帧问 getContentBounds）", /windowDrag = Object\.assign\(\{\}, currentPos\(\), \{ w: cs0\.w, h: cs0\.h \}\)/.test(elecSrc));
check("搬完记住落点", /pet:window-drag-end/.test(elecSrc) && /endWinDrag\(\)/.test(petSrc));
check("渲染进程报舞台尺寸（宠物 + 气泡）", /reportWindowSize\(\)/.test(petSrc) && /pet:window-size/.test(elecSrc));
check("preload 三个新口都齐", /setWindowSize/.test(preloadSrc) && /moveWindow/.test(preloadSrc) && /endWindowDrag/.test(preloadSrc));
// 症状2（用户口径）：「移除 padding 和强制尺寸吧，对显示没有任何改善，较宽的动画还是显示不全」。
//   实测：左右留白抬到 200（§9.22）后窗 622→862，动画一点没变大 —— size=900 时窗 1300 宽，
//   贴右上角后动画右边离窗边只剩 marginX=24px、左边空 376px，看着就是被窗边切了一角。
//   修法：左右留白只当「离窗边的余量」（24），窗宽改成**按内容自适应**（动画宽 / 气泡基准宽取大），
//   真正给足的是**高度**（头顶 150 装气泡），气泡封顶独立走 BUBBLE_W_MAX。
check("舞台窗 = 高度定死 + 宽度自适应内容（不再有强制窗宽和 200 留白）", /var STAGE_PAD_X = 32/.test(petSrc) && /var BUBBLE_W_MAX = 340/.test(petSrc) && /var w = maxW \+ sidePad \* 2/.test(petSrc) && !/MIN_STAGE_W/.test(petSrc) && !/BUBBLE_BASE_W/.test(petSrc));
// 窗不许为气泡撑宽：窗一比「动画 + 余量」宽，气泡（封顶 = 窗宽-16）就比动画宽很多，
//   居中时必被 clampBubble 推到贴一边（实测 592 宽居中于 462 动画：左探 196 / 右探 16）。
check("气泡宁窄勿歪（定宽 = min(窗宽-16, 340)）", /Math\.min\(Math\.max\(BUBBLE_W_MIN, Math\.round\(winW\) - 16\), BUBBLE_W_MAX\)/.test(petSrc) && /var BUBBLE_W_MIN = 220/.test(petSrc));
check("设置高度、自适应宽度：height 优先，width 由 16:9 推（只加不改，老配置走 size）", /function petSizeOf\(cfg\)[\s\S]{0,400}return Math\.round\(\(h \* 16\) \/ 9\)/.test(petSrc) && /if \(isFinite\(height\) && height > 0\)[\s\S]{0,600}size = Math\.round\(\(height \* 16\) \/ 9\)/.test(petSrc) && /var MIN_PET_H = 214/.test(petSrc) && /var s = petSizeOf\(cfg\)/.test(petSrc) && /this\.size = petSizeOf\(cfg\)/.test(petSrc));
check("高度小于下限也抬（和宽度一个口径：抬，不报错）", /if \(h < MIN_PET_H\) h = MIN_PET_H/.test(petSrc) && /if \(height < MIN_PET_H\)/.test(petSrc));
// ⚠️ marginX/marginY 现在是**下限**（§9.21）：比留白小的抬到留白。头顶那截是气泡的舞台，
//   不抬的话贴上边的宠物头顶只有 marginY（实测 100）= 三行字，窗底那截空白一点用没有。
check("配置里的 marginX/marginY 当留白的下限（不够就抬上去）", /function topOffsetOf\(cfg\)[\s\S]{0,200}Math\.max\(m, STAGE_PAD_TOP\)/.test(petSrc) && /Math\.max\(mX, STAGE_PAD_X\)/.test(petSrc) && /Math\.max\(m, STAGE_PAD_BOTTOM\)/.test(petSrc) && /botPad = Math\.max\(botPad, bottomPadOf\(cfg\)\)/.test(petSrc));
// ⚠️ 窗只报**尺寸**、不动位置：宠物在窗里的偏移是常量，窗左上不动它就不跳。
//   「按宠物贴住的角挪窗」实测是反的（高度差里只有一部分来自头顶偏移，会挪走宠物、窗挂到屏外）。
check("改窗只改尺寸，左上角不动（宠物在屏幕上不跳）", /function applyBounds\(width, height\)/.test(elecSrc) && /applyBounds\(w, h\);/.test(elecSrc) && !/applyBounds\([\w, ]+, m\.anchor/.test(elecSrc) && !/cur\.h - height/.test(elecSrc));
check("getContentBounds 两种形状都认（现代版返回对象，老版返回数组）", /function contentSize\(\)[\s\S]{0,320}cb\.width !== undefined \? cb\.width : cb\[2\]/.test(elecSrc) && !/w === cb\[2\]/.test(elecSrc));
check("主进程也扣一道 380 的底", /const MIN_STAGE_W = 380/.test(elecSrc) && /num\(m\.w, STAGE\.w\), MIN_STAGE_W\)/.test(elecSrc));

check("漫游/气泡仍按窗口尺寸算（舞台=窗口，逻辑没变）", /window\.innerWidth/.test(petSrc) && /function clampPos\(/.test(petSrc));

// ------------------------------------------------ 气泡放得下（§9.21）
// 症状：窗放不下自带气泡 —— 长文案只留三行（看着像「话没说完」），
// 贴上边的宠物（corner: top-*）头顶只有 marginY，气泡顶出窗被切或被挤到宠物身上。
// 病根两个：① 窗高是「宠物 + 260」的死公式，留白全落在窗底（贴上边的宠物头顶没多出一点）；
// ② 气泡高度写死在 CSS 的「最多三行」，不量头顶真实空间。
// 修法：窗 = 宠物 + 四边留白（配置里的 margin 当下限），气泡按头顶实测空间算行数与 max-height。
console.log("\n气泡放得下（留白 + 按空间夹）…");
check("气泡宽度**定死**（--bubble-w = 窗宽 - 16），最多 6 行", /width: min\(var\(--bubble-w, 300px\), calc\(100vw - 16px\)\)/.test(petCss) && /-webkit-line-clamp: 6/.test(petCss) && !/width: max-content/.test(petCss) && !/max-width: min\(560px/.test(petCss));
// ⚠️ 气泡必须 border-box：--bubble-max-w 说的是**外框**宽，而 max-width 默认按内容盒算，
//   差着 24px padding + 2px border。算错的后果不是不好看，是气泡比窗还宽 ⇒ 左右两个
//   8px 边距永远夹不住，clampBubble 每次把它往另一边推 10px（实测 -12 → -22 来回甩）。
check("气泡 border-box（max-width 按外框算，夹取才夹得住）", /\.pet-bubble \{[\s\S]{0,2400}box-sizing: border-box/.test(petCss));
// ⚠️ 气泡的宽度上限只许有一个出处：窗宽算一次 → CSS 变量 → pet.css 读它。
//   写死过一次（pet.css 560 / pet.js 按窗宽 620），多出来的留白就白留了（§9.22）。
check("气泡宽度只有一个出处（stageSize → --bubble-w → pet.css）", /function stageSize\(/.test(petSrc) && /function applyBubbleWidth\(/.test(petSrc) && /applyBubbleWidth\(s\.w\)/.test(petSrc) && /Math\.round\(winW\) - 16/.test(petSrc) && !/560px/.test(petCss));
// ⚠️ 宽度**定死**（§9.34）：漫游余量再宽也不会把气泡撑肥 —— 宽度只看窗宽与 BUBBLE_W_MAX。
check("气泡不跟着漫游余量变胖（定宽，不再按宠物宽长）", !/var around = Math\.max\(420/.test(petSrc) && /function applyBubbleWidth\(winW\) \{\s*\n\s*try \{\s*\n\s*var w = Math\.min/.test(petSrc));
check("气泡高度由 clampBubble 按头顶空间写（两条 lane 共用同一条分法）", /var roomAbove = Math\.max\(0, Math\.round\(cr\.top - BUBBLE_CHROME_H\)\)/.test(petSrc) && /var room = Math\.max\(BUBBLE_MIN_H, Math\.floor\(\(roomAbove - BUBBLE_GAP_PX/.test(petSrc) && /function capHeight\(arr, room\)/.test(petSrc) && /arr\[i\]\.style\.maxHeight = room \+ "px"/.test(petSrc) && /arr\[i\]\.style\.webkitLineClamp = String\(/.test(petSrc) && /capHeight\(bubbles, room\)[\s\S]{0,120}capHeight\(chatBubbles, room\)/.test(petSrc));
// ⚠️ 头顶挂不下也**不翻到身下**（§9.27，实测回退）：身下只有 bottomPad 60 的余量，
//   翻下去就是把气泡塞进 60px 的缝里 —— 字被裁掉还压着脚（用户口径「脚下气泡被遮挡了 高度不够」）。
check("气泡恒在头顶（不翻到身下，§9.25 那套 .below 已删）", !/roomBelow/.test(petSrc) && !/var below/.test(petSrc) && !/classList\.toggle\("below"/.test(petSrc) && !/\.pet-bubble\.below \{/.test(petCss) && !/margin-top: 10px[\s\S]{0,80}transform: translate\(-50%, -6px\)/.test(petCss));
// ⚠️ 夹取的偏移是**绝对**的：写下去的是 `left: calc(50% ± X)`（相对容器居中位），不是增量。
//   算增量的话容器一动就只补回一部分，实测左右各欠 40px、怎么夹都夹不准。
check("夹取偏移按「居中位 + 绝对偏移」算（不是增量，否则拖一次差 40px）", /var baseL = cr\.left \+ \(cr\.width - r\.width\) \/ 2/.test(petSrc) && /dx = Math\.round\(wantL - baseL\)/.test(petSrc) && /var baseT = cr\.top - BUBBLE_GAP - r\.height/.test(petSrc));
// 高度/换边写完会重新折行、宽度跟着变：拿旧宽度算偏移就是夹在旧位置上（实测差 48px）
check("写完高度/换边重新量几何再算偏移（量的是两条 lane 的并集）", /r = lanes\.getBoundingClientRect\(\);\r?\n\s*if \(!r \|\| !\(r\.width > 0\)/.test(petSrc));
// ⚠️⚠️ 竖向**只往上夹、绝不往下压**（§9.38）：以前 `if (r.top < 8) wantT = 8` 会把气泡
//   往下按回窗内 —— 正好落在宠物脸上 = 用户口径「气泡文本框位置异常下移」。竖向偏移只保留
//   「往窗顶推」这一种；头顶真放不下时封高（overlap 分支），不许挪。
check("气泡竖向只往上夹（不许往下压到宠物头上，§9.38）", !/wantT = 8/.test(petSrc) && !/if \(r\.top < 8\)/.test(petSrc) && /if \(r\.bottom > H - 8\) wantT = Math\.min\(wantT, H - 8 - r\.height\)/.test(petSrc));
check("头顶放不下时**封高**而不是撤掉封高盖到头上（§9.38）", !/bubbles\[j\]\.style\.removeProperty\("max-height"\)/.test(petSrc) && /var tight = Math\.max\(BUBBLE_MIN_H, roomAbove\)/.test(petSrc));
// ⚠️⚠️ 纵向夹取**只有一份**（§9.38）：站位恢复 / 拖拽 / 量完可见框重夹 都走 stageKeepIn。
//   §9.28 那版把拖拽那两处改成 0 起夹、站位却还是 150 ⇒ 拖到屏幕上边松手记住 ry≈0，
//   下次启动按 150 一夹，宠物凭空下移一截（用户口径「位置并非放下的准确位置」）。
check("纵向夹取只有一份（三处都走 stageKeepIn，§9.38）", /var loY = STAGE_PAD_TOP/.test(petSrc) && /function stageKeepIn[\s\S]{0,1200}var loY = STAGE_PAD_TOP/.test(petSrc) && /stageKeepIn\(inkLeft - inkOff \+ safe\.off, top, safe\.w, halfH \* 2\)/.test(petSrc) && /stageKeepIn\(d\.base\.x \+ safe\.off \+ \(want\.x - at\.x\), d\.base\.y \+ \(want\.y - at\.y\), safe\.w, halfH \* 2\)/.test(petSrc) && /stageKeepIn\(cp\.rx \* window\.innerWidth - inkHalf/.test(petSrc) && !/Math\.max\(d\.base\.y \+ \(want\.y - at\.y\), 0\)/.test(petSrc) && !/Math\.max\(top, 0\), maxTop/.test(petSrc));
check("行数按空间收（空间不够就少几行，而不是把话抽掉）", /Math\.min\(6, Math\.floor\(\(room - 14\) \/ BUBBLE_LINE_H\)\)/.test(petSrc) && /var BUBBLE_LINE_H = 18\.2/.test(petSrc) && /var BUBBLE_MIN_H = 30/.test(petSrc));
// 「说点什么」输入框是气泡栈里**独立的最后一行**（不再塞在某条消息里，§9.34）：
//   塞在消息里的话，每来一条新消息就把框顶来顶去，封高时还得给它单独留 44px。
check("输入框是**消息 lane** 里独立的一行（分头顶空间时把它算进条数）", /var inputRow = document\.createElement\("div"\)/.test(petSrc) && /inputRow\.className = "pet-bubble pet-bubble-row"/.test(petSrc) && /chatStack\.appendChild\(inputRow\)/.test(petSrc) && /var n = bubbles\.length \+ chatBubbles\.length \+ \(inputOpen \? 1 : 0\)/.test(petSrc));
// §9.34 气泡**一棳**（不是复用一个框）：每条消息一个节点，最多 3 条，多了收最老的。
//   为什么不是复用一个框：复用一个框时三条消息互相顶替，看上去就是「文字闪来闪去」。
console.log("\n气泡一棳（最多 3 条，新者在下）…");
check("一摞：外框 + 两条 lane，每条消息一个节点", /lanes\.className = "pet-bubble-lanes"/.test(petSrc) && /stack\.className = "pet-bubble-stack"/.test(petSrc) && /var bubbles = \[\]/.test(petSrc) && /var chatBubbles = \[\]/.test(petSrc) && /chatBubbles\.push\(b\)/.test(petSrc) && /bubbles\.push\(el\)/.test(petSrc) && /b\.className = "pet-bubble"/.test(petSrc));
check("最多同时 5 条（多了把最老的收掉）", /while \(bubbles\.length > BUBBLE_MAX\) dropBubble\(bubbles\[0\]\)/.test(petSrc));
check("消息 lane 独立（第二个容器 + 第二个数组 + 自己的上限 3）", /var chatStack = document\.createElement\("div"\)/.test(petSrc) && /chatStack\.className = "pet-bubble-stack pet-chat-stack"/.test(petSrc) && /lanes\.appendChild\(chatStack\)/.test(petSrc) && /var chatBubbles = \[\]/.test(petSrc) && /var CHAT_MAX = 3/.test(petSrc) && /while \(chatBubbles\.length > CHAT_MAX\) dropBubble\(chatBubbles\[0\]\)/.test(petSrc));
check("碎碎念恢复：有没有会话气泡都不闭嘴（只看 agent 忙 / 有人在打字 / 窗不可见）", !/pet-bubble-session\[data-status/.test(petSrc) && /function chatBusy\(\)[\s\S]{0,400}currentOverrideAnim/.test(petSrc));
check("两 lane 各自的退后档位表（拿错表索引，最老那条会反而满亮）", /var AGE_FADE = \[1, 0\.72, 0\.5, 0\.34, 0\.22\]/.test(petSrc) && /var CHAT_FADE = \[1, 0\.66, 0\.42\]/.test(petSrc) && /function fadeLane\(arr, table\)/.test(petSrc) && /fadeLane\(bubbles, AGE_FADE\)[\s\S]{0,80}fadeLane\(chatBubbles, CHAT_FADE\)/.test(petSrc));
// ⚠️ 上限不等于真能留几条：头顶 150 的台子，每条至少「一行字 + 内边距 + 间隙」= 34px，
//   分摊下来放不下 5 条。硬分的结果是每条只剩 20px = **字被裁掉半行**（难看得多）。
//   所以真留几条由 fitCount() 按头顶实测空间算，放不下就收最老的。
check("能留几条按头顶实测空间收（两条 lane 共享头顶 ⇒ 扣掉另一条已占的）", /function fitCount\(arr, max\)[\s\S]{0,400}return Math\.max\(1, Math\.min\(max, fit\)\)/.test(petSrc) && /var fit = Math\.floor\(\(roomAbove \+ BUBBLE_GAP_PX\) \/ per\) - otherCount\(arr\)/.test(petSrc) && /function trim\(arr, max\)[\s\S]{0,400}while \(arr\.length > fitCount\(arr, max\)\)/.test(petSrc) && /var BUBBLE_MIN_H = 30/.test(petSrc) && /var room = Math\.max\(BUBBLE_MIN_H,/.test(petSrc));
// v1.4：头顶不够时优先收**已完成**的（正在执行的那条一收，就看不见谁还在干活了）
check("收栈优先收已完成的会话气泡（执行中的留着）", /function trim\(arr, max\)[\s\S]{0,400}getAttribute\("data-status"\) === "done"/.test(petSrc));
check("头顶变小（贴边 / 缩窗）也会收，不只在入栈时收（两条 lane 各收各的）", /if \(!overlap\) \{\s*\n\s*trim\(bubbles, BUBBLE_MAX\);[\s\S]{0,160}trim\(chatBubbles, CHAT_MAX\);/.test(petSrc));
check("新的在下面、老的上推（看着像滚动）", /\.pet-bubble-stack \{[\s\S]{0,400}flex-direction: column/.test(petCss) && /gap: 4px/.test(petCss));
check("收栈：淡出 200ms 后摘节点，计时器跟节点走（不泄）", /function dropBubble\(el\)[\s\S]{0,400}clearTimeout\(el\._timer\)[\s\S]{0,600}setTimeout\(function \(\) \{[\s\S]{0,120}removeChild\(el\)/.test(petSrc) && /el\._timer = setTimeout\(function \(\) \{ dropBubble\(el\); \}, ms\)/.test(petSrc));
check("同文案不重堆（宿主 10s 续帧）、sticky 全局只留一条", /getAttribute\("data-text"\) === t/.test(petSrc) && /classList\.contains\("sticky"\)[\s\S]{0,160}dropBubble/.test(petSrc));
check("尾巴只给最底下那条（两 lane 里靠下那条的；输入框开着时让位）", /function markTail\(\)[\s\S]{0,600}classList\.toggle\("has-tail", !chatLast && i === bubbles\.length - 1\)/.test(petSrc) && /classList\.toggle\("has-tail", !!chatLast && j === chatBubbles\.length - 1\)/.test(petSrc) && /\.pet-bubble\.has-tail::after/.test(petCss));
// §9.34 追加：老者退后（--fade 三档）+ 新的一条进来时老的**滑**上去（FLIP，不是跳）
check("越老越退后（--fade 5 档对上 BUBBLE_MAX，只淡字与底色不碰 opacity）",
	/var AGE_FADE = \[1, 0\.72, 0\.5, 0\.34, 0\.22\]/.test(petSrc) &&
	/setProperty\("--fade"/.test(petSrc) &&
	/color: rgba\(238, 241, 246, var\(--fade, 1\)\)/.test(petCss) &&
	/calc\(0\.96 \* var\(--fade, 1\)\)/.test(petCss) &&
	! /opacity: var\(--fade/.test(petCss));
check("上推时长随距离缩放（顶得越高走得越久，封 420ms）", /var ms = Math\.min\(420, 120 \+ Math\.round\(Math\.abs\(dist\) \* 3\)\)/.test(petSrc) && /"transform " \+ \(ms \/ 1000\) \+ "s cubic-bezier\(0\.22, 0\.78, 0\.26, 1\)"/.test(petSrc) && /setTimeout\(done, ms \+ 120\)/.test(petSrc));
check("上推曲线与入场分开（入场快、上推慢而稳）", /\.pet-bubble \{[\s\S]{0,3000}transform 0\.2s cubic-bezier\(0\.16, 0\.84, 0\.44, 1\)/.test(petCss) && !/transition: opacity 0\.18s ease, transform 0\.18s ease;/.test(petCss));
check("档位变淡能过渡（底色用 background-color，渐变另层）", /background-color: rgba\(26, 28, 36, calc\(0\.96 \* var\(--fade, 1\)\)\)/.test(petCss) && /background-image: linear-gradient\(180deg, rgba\(255, 255, 255, 0\.05\)/.test(petCss) && /background-color 0\.2s ease/.test(petCss));
check("新消息插在输入框**之上**（排到框下面会把正在打的字顶走）", /chatStack\.insertBefore\(b, inputOpen \? inputRow : null\)/.test(petSrc));
check("会话气泡也插在输入框之上（输入框在消息 lane 底下那一行）", /stack\.insertBefore\(el, inputOpen \? inputRow : null\)/.test(petSrc));
check("夹取量的是整摞（两条 lane 的并集），偏移写在外框上", /var r = lanes\.getBoundingClientRect\(\)/.test(petSrc) && /lanes\.style\.left = "calc\(50% \+ " \+ dx \+ "px\)"/.test(petSrc) && /lanes\.style\.removeProperty\("left"\)/.test(petSrc) && /self\.bubbleEl = lanes/.test(petSrc)
);
check("宠物没了就把两条 lane 的计时器都收掉", /this\.destroy = function \(\)[\s\S]{0,1200}bubbles\.length = 0[\s\S]{0,400}chatBubbles\.length = 0/.test(petSrc));
check("两 lane 都空了摘 .show（否则空的容器也占命中区）", /function stackEmpty\(\)[\s\S]{0,200}chatBubbles\.length === 0/.test(petSrc) && /lanes\.classList\.toggle\("show", !stackEmpty\(\)\)/.test(petSrc));
check("外框 CSS：两条 lane 上下排（会话在上、消息在下）", /\.pet-bubble-lanes \{[\s\S]{0,600}flex-direction: column/.test(petCss) && /\.pet-bubble-lanes\.show/.test(petCss) && !/\.pet-bubble-stack \{[\s\S]{0,120}position: absolute/.test(petCss));
// 气泡刚 show 出来那下量到的是旧布局：下一帧要再夹一次，否则右缘探出窗边被切（实测 38px）
check("气泡下一帧再夹一次（刚 show 时量的是上一段文案的布局）", /requestAnimationFrame\(function \(\) \{ self\.clampBubble\(\); \}\)/.test(petSrc));
check("窗一变就重新夹气泡（高度/宽度都变了）", /window\.addEventListener\("resize"[\s\S]{0,600}clampBubbles\(\)/.test(petSrc));

// ------------------------------------------------ 留白是宠物的禁区（§9.23 → §9.25）
// 症状：「上下高度不够 气泡无法完全显示」。量出来的根：位置记忆里 ry=0.2764627…
//   套上去正好把宠物钉在窗顶（top=0）—— 头顶 0 留白，气泡被压成 846x24 的一条、字全裁没了。
// 修法：站位记忆套回来时，宠物在**窗里**也必须给气泡留出舞台（顶 150、底 60）。
//   左右留给 roamRoom（§9.25：横向要贴边，留白全砍掉，行程改由窗宽给）。
//   漫游/拖动不夹（clampPos 仍按 0 起夹）：漫游只改 left 不改 top。
// ------------------------------------------------ 贴边是两个自由度（§9.25）
// 症状一：「拖不到边，中间空一大块」；症状二：「动画在左右被限制住」。
//   病根：贴边其实有**两个**自由度 —— 屏幕位置 = 窗位置 + 宠物在窗里的位置，
//   而主进程只管夹第一个，第二个是死值 → 差值恒等于「它在窗里贴着的那条边」。
//   修法：窗照旧整扇夹在屏内（气泡按窗夹才安全），差额由渲染进程把宠物在窗里滑出去顶到屏边；
//   横向不再留常数（那截会砍掉漫游行程），改成**按 moves 配置推出来的 roamRoom。
// 实测（2560×1400 屏、size 462）：拖过屏边 400px 后 left 0 / right 0 / up 0 / down 22
//   （22 = 画布脚下那截空白，脚贴着边），四个方向窗都完整在 workArea 内，气泡也没被裁。
check("横向站位贴边（不许再留常数 STAGE_PAD_X，那截会砍掉漫游行程）", /var loX = 0;/.test(petSrc) && /var hiX = W - inkW;/.test(petSrc) && !/var loX = STAGE_PAD_X/.test(petSrc));
// 漫游行程 = max(maxDist + 2×margin) − 2×留白，窗宽再加上它：窗太窄时 planMove 直接
//   return null（动画根本不播），这就是「动画在左右被限制住」。
check("窗宽按漫游行程给足（maxDist 走得到，动画不播不了）", /function roamRoom\(sidePad\)/.test(petSrc) && /maxDist = Math\.max\(maxDist, md\)/.test(petSrc) && /margin = Math\.max\(margin, mg\)/.test(petSrc) && /Math\.ceil\(maxDist \+ 2 \* margin - 2 \* pad\)/.test(petSrc) && /var w = maxW \+ sidePad \* 2 \+ roamRoom\(sidePad\)/.test(petSrc));
// 贴边的第二个自由度：窗被屏幕边夹住时，差额原样加到宠物在窗内的偏移上（不新增每帧 IPC）
check("贴边差额走宠物在窗内的偏移（slideTo，不靠每帧 IPC）", /function slideTo\(/.test(petSrc) && /var want = \{ x: d\.win0\.x \+ dx, y: d\.win0\.y \+ dy \}/.test(petSrc) && /clampBubbles\(\);[\s\S]{0,120}pushHitRegion\(\)/.test(petSrc) && /function workAreaNear\(/.test(petSrc));
check("主进程把工作区推给渲染进程（贴边滑移要知道屏边在哪）", /function pushDisplays\(/.test(elecSrc) && /ipcMain\.on\("pet:displays-get"/.test(elecSrc) && /screen\.getAllDisplays\(\)/.test(elecSrc) && /onDisplays: \(cb\)/.test(readFileSync(join(ROOT, "pi", "assets", "preload.cjs"), "utf8")) && /onDisplays\(function \(list\) \{ setDisplays\(list\); \}\)/.test(petSrc));
// 换屏/改分辨率也要重推：不然多屏拔掉一块之后还按老屏边滑（会滑到屏外）
check("显示器变化就重推工作区（added / removed / metrics-changed 都要）", /for \(const ev of \["display-added", "display-removed", "display-metrics-changed"\]\)/.test(elecSrc) && /screen\.on\(ev, pushDisplays\)/.test(elecSrc));
// ⚠️ init() 得排在 reportWindowSize() 之后：did-finish-load 那次推送早于配置加载完，
//   没这一手订阅的话 onDisplays 一个工作区都收不到，贴边滑移整段不触发（实测：拖不动）。
check("订阅工作区排在报尺寸之后（否则收不到 did-finish-load 那次）", /reportWindowSize\(\);[\s\S]{0,300}onDisplays\(function \(list\)/.test(petSrc));
// win0 = 屏幕坐标 − 窗内坐标。写成 `ps.x − (clientX − rect.left)` 就等于「假设光标按在
//   容器正中」：探针按在命中框中心（比容器中心偏 10px）时，左边就差 10px、贴边停在 302。
check("拖拽基准 win0 = 屏幕坐标减窗内坐标（别拿容器偏移推算）", /win0: \{ x: Math\.round\(ps\.x - e\.clientX\), y: Math\.round\(ps\.y - e\.clientY\) \}/.test(petSrc));
// 窗比「宠物 + 两侧留白」还窄时区间会翻过来（多开时窗按最大的那只算）：
//   这时取中间值，不然照样贴边、同样没头顶。
check("窗太窄时留白区间取中间（不翻车成贴边）", /if \(hiX < loX\) loX = hiX = Math\.max\(0, \(W - inkW\) \/ 2\)/.test(petSrc) && /if \(hiY < loY\) loY = hiY = Math\.max\(0, \(H - stageH\) \/ 2\)/.test(petSrc));
// 夹完把内存里的落点也改回实际值：不改的话漫游起点（读 customPos）会先跳一下再走
check("夹取后回写 customPos（漫游起点和 DOM 一致）", /self\.customPos\.rx = \(keep\.left \+ inkHalf\) \/ window\.innerWidth/.test(petSrc));
// refitInk 把容器搬进去之后也得回写：不然画面位置和位置记忆分叉 ——
// 下一次漫游从「夹之前」的旧点起手（跳一下再走），窗一 resize 就用 applyPosition 弹回原地
check("refitInk 搬完位置回写 customPos（不再和画面分叉）", /this\.refitInk = function \(\)[\s\S]{0,700}if \(self\.customPos\) \{\s*self\.customPos\.rx = \(m\.left \+ halfW\) \/ window\.innerWidth/.test(petSrc));
// 窗高公式和站位区间共用同一份 corner 算法（又一份算法就又一处对不上，§9.22 的教训）
check("窗底留白 corner 算法只有一份（stageSize 与 stageKeepIn 共用）", /function bottomPadOf\(/.test(petSrc) && /botPad = Math\.max\(botPad, bottomPadOf\(cfg\)\)/.test(petSrc) && !/botPad = Math\.max\(botPad, Math\.max\(mY, STAGE_PAD_BOTTOM\)\)/.test(petSrc));

// ------------------------------------------------ 舞台自适应宽度 + 居中（§9.26）
// 症状：舞台（窗）宽起来之后，按 corner 贴一侧摆位 → 另一侧空出一整块透明窗
//   （实测 size 462 / 窗 822：right=24 时左边空 336），看着就是「舞台歪着、有一大片没用」。
// 修法：① 窗宽完全由内容自适应（动画宽 + 余量 + 漫游行程，见上）；② 窗内横向一律居中。
// 实测（窗 822 / 宠物 462）：左留白 180 = 右留白 180。
check("舞台内横向居中（不许再按 corner 贴一侧）", /function centeredLeft\(size, index, total\)/.test(petSrc) && /container\.style\.left = centeredLeft\(inkW, self\.slot/.test(petSrc) && !/container\.style\.right = cfg\.position\.marginX/.test(petSrc) && !/container\.style\.left = cfg\.position\.marginX/.test(petSrc));
// ⚠️ resize 必须重新摆位：构造宠物时窗还是主进程那个 620 默认宽，居中位置按窗宽算，
//   窗涨到 822 之后不重摆，宠物会停在 620 上算出来的 left=79（79/281，不居中）。
check("窗一变就重新摆位（不然停在旧窗宽算出的位置上）", /window\.addEventListener\("resize",[\s\S]{0,400}\n\s*applyPosition\(\);/.test(petSrc) && !/if \(self\.customPos\) applyPosition\(\);/.test(petSrc));
// 多开：两只都居中会完全重叠（以前靠 corner 的 left/right 两支错开，§9.26 起那两支改成居中）
check("多开按序号在舞台里错开（都居中会叠在一起）", /function PetCard\(cfg, rootEl, slot\)/.test(petSrc) && /this\.slot = Math\.max\(0, Number\(slot\) \|\| 0\)/.test(petSrc) && /config\.pets\.forEach\(function \(cfg, i\)/.test(petSrc) && /return Math\.round\(\(lane \* i\) \/ \(n - 1\)\)/.test(petSrc));

// ------------------------------------------------ 可见框贴边（§9.27）
// 症状一：「左右拉不到很靠边」。真机实测（2560x1400）：把窗拖到屏幕 x=0、容器也贴到 0，
//   截图逐像素比出来的**可见 ink** 还在屏幕 x=153 —— 差 153px。窗/容器的机制是好的（gap=0），
//   差的这截是**动画画布自己的透明边**：HIT_BOX 量出角色只占 16:9 舞台的 37.5%，
//   size=462 时角色只有 173px 宽、左右各 144px 全透明。贴边贴的是舞台，于是角色永远差一截。
// 修法：横向几何（夹取/贴边/居中/漫游道/窗宽/气泡封顶）一律改按**可见框**算。
// ⚠️ 可见框口径直接用 HIT_BOX（它本来就是按「看着像角色」调出来的 640×360 框），别另写一份。
check("可见框口径只有一份（= HIT_BOX，640×360 基准）", /var INK_X0 = HIT_BOX\.x0 \/ 640/.test(petSrc) && /var INK_X1 = HIT_BOX\.x1 \/ 640/.test(petSrc) && /function inkWidth\(size\)/.test(petSrc) && /\(INK_X1 - INK_X0\)/.test(petSrc) && !/inkWidth\s*=\s*\d/.test(petSrc));
// 贴边（slideTo）：夹可见框、写容器左边 —— 少这一步就是「容器贴到 0、角色还在 144 外」
check("贴边按可见框夹（写回容器左边），不是按舞台夹", /var inkW = inkWidth\(this\.size\)/.test(petSrc) && /var inkOff = INK_X0 \* this\.size/.test(petSrc) && /var keep = stageKeepIn\(inkLeft - inkOff \+ safe\.off[\s\S]{0,200}left: keep\.left - safe\.off/.test(petSrc) && !/winW - self\.size\)/.test(petSrc));
// 漫游/拖拽/站位回夹：同理，「进的是可见框左边、出的是容器左边」（clampPos 的固定口径）
check("clampPos 进可见框、出容器（漫游/浏览器拖拽都走它）", /function clampPos\(inkLeft, top\)/.test(petSrc) && /var safe = inkSafe\(\)/.test(petSrc) && /stageKeepIn\(inkLeft - inkOff \+ safe\.off/.test(petSrc) && /return \{ left: keep\.left - safe\.off, top: keep\.top \}/.test(petSrc) && /clampPos\(px - inkHalf, py - halfH\)/.test(petSrc) && /clampPos\(e\.clientX - dragState\.offX - inkHalf/.test(petSrc));
// 漫游道两端按可见框半宽夹（道是给角色走的，透明舞台区不占地）
check("漫游道按可见框半宽夹（planMove 的 halfW 是 inkHalf）", /halfW: inkHalf/.test(petSrc));
// 窗宽基数：maxStage（size 口径，MIN 下限照旧）→ **整个舞台** → 窗宽（§9.28）。
//   为什么不是角色那一条/可见框并集：动画自带的气泡/火花（思考 93..551、蝴蝶蜜蜂 4..629）
//   比角色宽得多，窗装不下它们时靠边播放必被窗边切；舞台本来就是「这段动画可能画到的全部」，
//   配合 inkSafe() 的夹取，任何动画的像素都不会跑出窗（并集是运行时量的，不能拿来算窗宽）。
check("窗宽基数是整个舞台（maxStage → w），气泡宽度只按窗宽夹", /var maxStage = 0/.test(petSrc) && /if \(maxStage < MIN_PET_SIZE\) maxStage = MIN_PET_SIZE/.test(petSrc) && /var maxW = maxStage/.test(petSrc) && /var w = maxW \+ sidePad \* 2 \+ roamRoom\(sidePad\)/.test(petSrc) && /applyBubbleWidth\(s\.w\)/.test(petSrc) && /petW: inkWidth\(maxStage\)/.test(petSrc));
// 站位记忆的比例仍然存**中心**（可见框在舞台里居中 ⇒ 中心 = 容器中心），老 positions.json 继续能用；
// 横向区间走 inkSafe（角色 ∪ 当前动画），不然老落点靠边时宽动画仍被窗边切。
check("站位比例仍存中心（可见框居中，老位置记忆继续可用）+ 横向按 art 框夹", /stageKeepIn\(cp\.rx \* window\.innerWidth - inkHalf \+ over, cp\.ry \* window\.innerHeight - halfH, safe\.w, halfH \* 2\)/.test(petSrc) && /container\.style\.left = keep\.left - over - inkOff \+ "px"/.test(petSrc) && /var over = inkOff - safe\.off/.test(petSrc) && /self\.customPos\.rx = \(keep\.left \+ inkHalf\) \/ window\.innerWidth/.test(petSrc) && /stageKeepIn\(left, top, inkW, stageH\)/.test(petSrc));
// 纵向按舞台高算区间（量过，纵向没这问题），但**上下界都是 0**（§9.28）：能贴到屏边。
check("纵向按舞台高算区间（不改成 inkH），下界给头顶留气泡台子", /var hiY = H - stageH/.test(petSrc) && !/var hiY = H - inkH/.test(petSrc) && /var loY = STAGE_PAD_TOP/.test(petSrc));
// 纵向的**上下界**：§9.28 起四边全 0 起夹 —— 宠物能真的贴到屏幕上/下边。
//   头顶没有空间时不再封高（那会是一条 24px 的东西，字全裁没），改让气泡盖在头顶上。
//   底下不用再减 bottomPad：stage 有 translateY(bottomPad)，容器底本来就是脚底。
check("纵向上下界 0 起夹（贴边也行），头顶不够就不封高（盖头顶）", /var overlap = roomAbove < BUBBLE_LINE_H \* 2/.test(petSrc) && /if \(!overlap\)/.test(petSrc));

// 位置记忆换算：窗内比例是**相对窗**的，而舞台窗会变（这一版左右留白 80→200，宽 622→862）：
//   老落点 rx=0.5797 直接套上去，宠物水平平移 (862-622)*0.58 = 139px（「启动后宠物自己跑了一边」）。
//   修法：存的时候把当时窗宽一起存（可选字段），套的时候换算回同一个窗内绝对位置。
check("位置记忆带窗宽窗高（窗变了才换得算回去）", /function rescalePos\(/.test(petSrc) && /rescalePos\(Number\(pos\.rx\), Number\(pos\.w\), window\.innerWidth\)/.test(petSrc) && /return \(r \* wo\) \/ wn/.test(petSrc) && /api\.savePosition\(pet\.id, pet\.customPos\.rx, pet\.customPos\.ry, window\.innerWidth, window\.innerHeight\)/.test(petSrc));
check("窗宽一路带到落盘（preload / 主进程 / 宿主 / 协议 / 读回都认 w,h）", /savePosition: \(id, rx, ry, w, h\)/.test(preloadSrc) && /set-position", \{ id, rx, ry, w: Number\(payload\.w\), h: Number\(payload\.h\) \}/.test(elecSrc) && /rememberPosition\(id, arg\.rx, arg\.ry, arg\.w, arg\.h\)/.test(hostSrc) && /function rememberPosition\(id, rx, ry, w, h\)/.test(pathsSrc) && /out\[key\]\.w = Math\.min\(Math\.round\(w\), 20000\)/.test(protoSrc));
// 老记录没有 w/h：不能因此把宠物送到 0 之外（没存 = 不知道，按原比例套）
check("老位置记录（没有 w/h）照旧按原比例套，不报错", /if \(!isFinite\(wo\) \|\| !\(wo > 0\) \|\| !\(wn > 0\)\) return r/.test(petSrc));

// ------------------------------------------------ 留白必须点得穿（§9.21）
// 症状：窗一大（大出来的那圈留白），下面别的软件就点不到了。
// 实测：留白区点得穿（真光标 2/3，两点在留白穿到下面的窗、一点在宠物身上被形状吃掉）。
// 但那是**现在**没坏；这里钉的是「会让它坏的那几条路」：
//   ① 形状按「宠物 + 气泡」的包围盒裁，越界的矩形会被主进程 Math.max(0,·) 平移到窗角；
//   ② 窗一变（启动时按配置长大、DPI/显示器变化）形状没跟着重裁；
//   ③ 冻住的宠物不重报形状，布局变了形状还留在老地方。
console.log("\n留白点得穿（形状 = 宠物 + 气泡，不含留白）…");
check("上报前把矩形夹进窗内（否则主进程 Math.max(0,·) 会把它平移到窗角）", /box\.left = Math\.max\(0, box\.left\)/.test(petSrc) && /box\.right = Math\.min\(vw, box\.right\)/.test(petSrc) && /if \(!\(box\.right > box\.left\)[\s\S]{0,60}continue/.test(petSrc));
check("主进程也按窗裁一遍（拿不到窗有多大就别瞎推）", /winW = Number\(cb && cb\.width\) \|\| 0/.test(elecSrc) && /Math\.min\(winW \|\| Infinity, x0 \+ Math\.ceil/.test(elecSrc) && /Math\.min\(winH \|\| Infinity, y0 \+ Math\.ceil/.test(elecSrc) && !/x: Math\.max\(0, Math\.round\(Number\(r && r\.x\)/.test(elecSrc));
check("resize 必重报命中区（force：布局变了形状不能留在老地方）", /window\.addEventListener\("resize"[\s\S]{0,700}pushHitRegion\(true\)/.test(petSrc) && /if \(asleep && !force\) return/.test(petSrc));
check("主进程窗一变就把形状重裁一遍（记着上一次的形状）", /win\.on\("resize",[\s\S]{0,120}resyncShape\(\)/.test(elecSrc) && /function resyncShape\(\)/.test(elecSrc) && /lastShape = list/.test(elecSrc));
check("重裁不会被去重吃掉（shapeKey 清掉，下一次照裁）", /function resyncShape\(\)[\s\S]{0,300}shapeKey = ""/.test(elecSrc));

// ------------------------------------------------ 拖不许抖、不许有阻力
// 症状：拖宠物时「像被拽着走」（明显阻力）+ 抖。
// 病根：pointermove 的频率是**鼠标轮询率**（125~1000Hz），每一次都 ipc → setPosition
// → 一次 SetWindowPos + 一次 DWM 重合成。窗追不上光标就是阻力，补帧参差就是抖。
// 修法：渲染进程用 rAF **一帧最多搬一次**（只留最新位置），松手时把最后一帧落地；
// 主进程把「已经被屏幕边夹住、其实没动」的 move 丢掉。
console.log("\n拖拽不许抖 / 不许有阻力…");
check("搬窗走 rAF 合帧（不是每个 pointermove 都搬）", /function queueWinMove[\s\S]{0,320}requestAnimationFrame\(flushWinMove\)/.test(petSrc));
check("合帧只留最新位置（旧的丢掉，不会排队追）", /movePending = \{ dx: dx, dy: dy \}[\s\S]{0,200}if \(!moveRaf\) moveRaf/.test(petSrc));
check("位移仍然从按下那下算起（合帧不累积误差）", /var p = screenPoint\(e\)[\s\S]{0,900}var dx = p\.x - dragState\.psx[\s\S]{0,1400}queueWinMove\(dx, dy\)/.test(petSrc));
// ⚠️⚠️ 窗内位移（slideTo）也必须合帧（§9.38）：pointermove 跟着鼠标轮询率走（125~1000Hz），
//   贴边时每一帧都要写样式 + 夹气泡（强制同步布局）⇒ 渲染进程被拖死 = 拖到边框发抖。
check("窗内位移也合帧（slideTo 不在 pointermove 里立即跑）", /function flushWinMove\(\)[\s\S]{0,400}slideTo\(m\.dx, m\.dy\)/.test(petSrc) && !/pointermove[\s\S]{0,1200}\n\s*slideTo\(dx, dy\)/.test(petSrc));
// ⚠️⚠️ 松手那一帧不能丢：settleWinMove（→ slideTo）必须在 dragState.active=false **之前**
check("松手先落地最后一帧，再清 dragState.active", /var wasDragging = dragState\.dragging;[\s\S]{0,700}settleWinMove\(\);[\s\S]{0,200}dragState\.active = false/.test(petSrc));
// ⚠️⚠️ 拖拽期间不许别人再夹位置（换动画 commit / 量完可见框都会调 refitInk）：
//   两边都写 container.style 就是各夹各的 = 一格一格哆嗦 + 落点被中途改写。
check("refitInk 拖拽期间让位（不跟 slideTo 抢 container.style）", /this\.refitInk = function \(\) \{\s*\n\s*if \(dragState\.active\) return;/.test(petSrc));
check("松手时把最后一帧落地", /settleWinMove\(\)[\s\S]{0,120}endWinDrag\(\)/.test(petSrc));
check("主进程丢掉「其实没动」的搬窗", /pos\.x === stagePos\.x && pos\.y === stagePos\.y\) return/.test(elecSrc));

// ------------------------------------------------ 窗不许塌成一条缝（32x39 残骸窗）
// 症状：宿主/WS/菜单一切正常，屏幕上就是没有宠物。
// 病根：win.getPosition() 在窗还没真正映射时（loadURL 之后、ready-to-show 之前）
// 返回 [NaN, NaN]；把它塞进 setBounds，Chromium 就把整扇窗塌成 (0,0) 处 32x39 的残骸
// ——窗还活着，只是 32x39 的视口装不下 400px 的宠物。
// 修法：落点自己记一份（stagePos），getPosition() 只在是有限数的时候才采信；
// 摆完当场量一次，没摆成要看得见。
console.log("\n窗不许塌成残骸（NaN 落点 / 静默 setBounds）…");
check("落点自己记一份，不全信 getPosition()", /let stagePos = \{ x: Math\.round\(start\.x\), y: Math\.round\(start\.y\) \}/.test(elecSrc) && /function currentPos\(\)[\s\S]{0,400}return \{ x: stagePos\.x, y: stagePos\.y \}/.test(elecSrc) && /function rememberPos\(pos\)[\s\S]{0,300}Number\.isFinite\(x\)/.test(elecSrc));
check("搬窗/记落点都不再直接用 getPosition()", !/win\.getPosition\(\)\[0\]/.test(elecSrc) && /windowDrag = Object\.assign\(\{\}, currentPos\(\)/.test(elecSrc) && /writeStagePos\(home, currentPos\(\)\)/.test(elecSrc));
check("喂给 setBounds 的坐标都过有限性检查", /function clampToDisplay[\s\S]{0,400}Number\.isFinite/.test(elecSrc) && /function applyBounds[\s\S]{0,700}Number\.isFinite\(bounds\.x\)/.test(elecSrc));
check("摆完当场核对，没摆成就打日志", /窗没摆成（要 \$\{width\}x\$\{height\}/.test(elecSrc));
check("move / resize 事件同步落点（resize 还要把形状重裁一遍）", /win\.on\("move", \(_e, b\) => rememberPos\(b\)\)/.test(elecSrc) && /win\.on\("resize", \(_e, b\) => \{[\s\S]{0,80}rememberPos\(b\);[\s\S]{0,80}resyncShape\(\);/.test(elecSrc));

// ------------------------------------------------ 尺寸下限 380（再窄动画展示不全）
// 用户口径：宽度低于 380，16:9 舞台上的角色两侧（手脚 / 拖拽反馈 / 两行气泡）就被切掉。
// 所以 380 是硬下限，配置、档位、舞台窗、主进程兜底四处都得有。
console.log("\n尺寸下限 380（动画别被切一半）…");
check("pet.js 有 380 硬下限常量", /var MIN_PET_SIZE = 380/.test(petSrc) && /Math\.max\(MIN_PET_SIZE, Math\.round\(w\)\)/.test(petSrc));
check("配置里写小了抬到下限（不报错、不照用）", /if \(size < MIN_PET_SIZE\)[\s\S]{0,400}size = MIN_PET_SIZE/.test(petSrc));
check("换尺寸档位也过下限", /var size = Math\.max\(MIN_PET_SIZE, SIZE_MAP\[sizeArg\]/.test(petSrc));
check("config.jsonc 里的宠物宽度不小于下限", (() => { const m = /"id": "main"[\s\S]{0,80}?"size":\s*(\d+)/.exec(readFileSync(join(ROOT, "assets", "config.jsonc"), "utf8")); return m && Number(m[1]) >= 380; })());

// ---------------------------------------------------------------- 图库 = 素材目录
// README 开头写着「全部 91 个动画」，那就让它真的一一对得上：漏一张是静默的
//（图片只是少一张，谁都不会发现），多一张则是链接直接 404。
// ⚠️ 比对靠文件名一一对应（preview 用拼音 gif、thumb 用中文 webm，两边名字对不上，
//    所以只能拿 preview 目录互比 —— 别试图跨目录比，那必然误报）。
console.log("\nREADME 图库…");
{
	const readme = readFileSync(join(ROOT, "README.md"), "utf8");
	const referenced = new Set(
		[...readme.matchAll(/assets\/preview\/([^"'\s>]+\.gif)/g)].map((m) => m[1]),
	);
	const onDisk = readdirSync(join(ROOT, "assets", "preview"))
		.filter((f) => f.endsWith(".gif"))
		.map((f) => f);
	const missing = [...referenced].filter((f) => !onDisk.includes(f)).sort();
	const orphans = onDisk.filter((f) => !referenced.has(f)).sort();
	check(
		`README 图库里的每个文件都存在（${referenced.size} 个链接）`,
		missing.length === 0,
		missing.length ? `指向不存在的：${missing.join(", ")}` : "",
	);
	check(
		`assets/preview 里每个动画都在图库里（${onDisk.length} 个文件）`,
		orphans.length === 0,
		orphans.length ? `有文件没进图库：${orphans.join(", ")}` : "",
	);
	check(
		"README 宣称的动画总数与实际一致",
		new RegExp(`全部 ${onDisk.length} 个动画`).test(readme),
		`README 里找「全部 ${onDisk.length} 个动画」没找到（目录里有 ${onDisk.length} 个）`,
	);
}

// ------------------------------------------------ 动画可见框：运行时自测（§9.28）
// 症状：「思考动画的气泡左右还是会被截断」—— 不是文案气泡，是**动画里画的那个**。
//   原因：命中区（主进程 SetWindowRgn）按 HIT_BOX（200..440，只框角色）报，而
//   「深度思考碎碎念」画出来的气泡逐帧真值是 93..551、「蝴蝶蜜蜂环绕头顶开花」4..629，
//   超出去的那截像素直接被形状裁掉。
// ⚠️ 自测（decode webm + 按步长 seek + 扫 alpha）而不是硬编一张表：24 帧采样就把右边界
//   少报成 547（真值 551，用户反馈「右边还是展示不全」），而且以后每加一段新动画都得重新量。
check("可见框是运行时自测的（没有 ink-boxes.js 那种硬编表）", /var INK_CACHE_KEY = "petInkBoxV\d"/.test(petSrc) && /localStorage\.getItem\(INK_CACHE_KEY\)/.test(petSrc) && /function measureInkBox\(name\)/.test(petSrc) && /function scanInkBox\(name, src\)/.test(petSrc) && !/PET_INK_BOXES/.test(petSrc) && !existsSync(join(ROOT, "pi", "assets", "ink-boxes.js")));
// ⚠️ src 必须是 blob: URL：服务端不支持 Range ⇒ 直连的 <video> seekable=[0,0]，
//   seek 只会「立刻 seeked 回到 0」= 32 次量同一帧，看着量过了其实整段漏光（实测踩过）。
check("扫描的 webm 先 fetch 成 blob（直连的 video 根本不可 seek）", /fetch\(url\)/.test(petSrc) && /URL\.createObjectURL\(blob\)/.test(petSrc) && /URL\.revokeObjectURL\(src\)/.test(petSrc));
check("自测走 seek（不是 play）——透明窗里播放被 Chromium 节流", /addEventListener\("seeked"/.test(petSrc) && /video\.currentTime = Math\.min\(video\.duration, video\.currentTime \+ step\)/.test(petSrc) && !/measureInkBox[\s\S]{0,900}video\.play\(/.test(petSrc));
check("扫描均匀铺满整段（固定步长只看得到头 1.3s，后半段的气泡整段漏掉）", /step = Math\.max\(video\.duration \/ INK_FRAMES, 1 \/ 120\)/.test(petSrc));
check("扫描用的 video 必须挂在 DOM 上（不挂的 video 拿到的还是首帧）", /appendChild\(video\)/.test(petSrc) && /width:1px;height:1px;opacity:0;pointer-events:none/.test(petSrc));
// ⚠️⚠️ 回归护栏：扫描舞台**全局复用**，扫完不许拆。
//   每段动画现建现毁一个 <video>（load + removeChild）看着干净，实际是解码器/GPU 纹理
//   反复重建：全量扫 91 段 → GPU 进程 94MB 涨到 **5090MB**，扫完不降（实测）。
check("扫描 video 全局复用一个、扫完不回收（拆了就是 GPU 进程泄漏 5GB）", /var INK_STAGE = null/.test(petSrc) && /function ensureScanStage\(\)/.test(petSrc) && /function scanInkBox\(name, src\)[\s\S]{0,2000}ensureScanStage\(\)/.test(petSrc) && !/function scanInkBox\(name, src\)[\s\S]{0,2000}removeChild\(video\)/.test(petSrc) && !/function scanInkBox\(name, src\)[\s\S]{0,2000}video\.load\(\)/.test(petSrc));
check("复用的扫描元素必须成对摘监听器（旧闭包会吃掉下一段的 seeked）", /removeEventListener\("seeked", onSeeked\)/.test(petSrc) && /removeEventListener\("loadedmetadata", onMeta\)/.test(petSrc) && /removeEventListener\("error", onError\)/.test(petSrc));
check("采样余量只加在形状上（烘进缓存会渗进几何，待机贴边白差 9px）", /var mg = INK_MARGIN \* kx/.test(petSrc) && /var INK_MARGIN = 8/.test(petSrc) && /x0: minX \* 2,\s*x1: maxX \* 2 \+ 2/.test(petSrc));
check("起动就排上扫描（状态 override 最优先）+ 正在播的插队 + 量完重夹位置重报形状", /prewarmInkBoxes\(\)/.test(petSrc) && /function prewarmInkBoxes\(\)/.test(petSrc) && /EVENT_ANIM_MAP\[k\]\); \}/.test(petSrc) && /queueInkMeasure\(next\)/.test(petSrc) && /INK_QUEUE\.unshift\(name\)/.test(petSrc) && /function onInkBoxReady[\s\S]{0,400}p\.refitInk\(\)/.test(petSrc) && /this\.refitInk = function \(\)[\s\S]{0,600}clampPos\(r\.left \+ inkOff, r\.top\)/.test(petSrc));
check("扫描不拖累正常播放（一次一段 + 段间让开 + 超时兜底不死锁队列）", /if \(INK_BUSY\) return/.test(petSrc) && /setTimeout\(drainInkQueue, 200\)/.test(petSrc) && /setTimeout\(function \(\) \{ finish\(null\); \}, 20000\)/.test(petSrc));

/clampPos\(inkLeft, top\)[\s\S]{0,420}var safe = inkSafe\(\)/.test(petSrc)
check("量出新框后重夹位置 + 重报形状（不然新量到的宽动画第一次播仍靠窗边）", /this\.refitInk = function \(\)[\s\S]{0,700}clampPos\(r\.left \+ inkOff, r\.top\)/.test(petSrc) && /function onInkBoxReady[\s\S]{0,300}refitInk\(\)[\s\S]{0,120}pushHitRegion\(\)/.test(petSrc));
// ⚠️ refitInk 只挂在 onInkBoxReady 上不够（§9.31）：可见框进了 localStorage 缓存就不再量，
// refitInk 永远不跑 ⇒ 缓存一热，思考动画宽出来的那截就顶出窗外被切（「右侧缺失」）。
check("每次换手都重夹位置（宽动画靠窗边时右侧不被切）", /self\.playing = next;[\s\S]{0,900}self\.refitInk\(\)/.test(petSrc));
check("窗宽按整个舞台算（宽动画的像素不会被窗边裁，加新动画也不用重算）", /var maxW = maxStage/.test(petSrc) && /var w = maxW \+ sidePad \* 2 \+ roamRoom\(sidePad\)/.test(petSrc));

// ------------------------------------------------ 只镜像走位动画（§9.29）
// 症状：「为什么有的动画是镜像的」。病根：以前 facingRef 一变就把**所有**动画 scaleX(-1)，
//   于是待机/小动作/点击/状态 override 有一半时间在看镜像（写字、玩道具、文字全不对）。
//   修法：只有 turn（转身）+ moves.actions（走路）镜像 —— 那是「行进方向」才需要程序翻面，
//   其余按素材原样；镜不镜像与走位方向取同一口径（moveDir），别写两份。
check("只有 turn + moves.actions 镜像，其余按素材原样", /function isDirAnim\(name\)/.test(petSrc) && /a\.turn\.indexOf\(name\) >= 0\) return true/.test(petSrc) && /actions\[i\]\.name === name\) return true/.test(petSrc) && /isDirAnim\(next\) && moveDir\(\) === 1 \? "scaleX\(-1\)" : ""/.test(petSrc) && !/facingRef === "right" \? "scaleX\(-1\)"/.test(petSrc));
check("镜像方向与走位方向同一口径（moveDir 一处算，两处用）", /function moveDir\(\)/.test(petSrc) && /var dir = moveDir\(\)/.test(petSrc) && /return \(self\.facingRef === "right"\) !== turnAnim \? 1 : -1/.test(petSrc));
check("turn 动画放完仍翻 facing（不然转身动画永远朝一个方向）", /anims\.turn\.indexOf\(endedAnim\) >= 0[\s\S]{0,200}self\.facingRef = nextF/.test(petSrc));

// ⚠️ 反向断言（2026-10 用户口径「动画会自己晃动偏移」）：窗的几何**只能**由配置（舞台）决定。
//   曾经按当前动画的可见框缩窗宽（§9.32），而窗只改尺寸、容器又居中 ⇒ 每换一段动画窗宽就变一次，
//   宠物跟着左右跳（最狠的是整幅不透明的素材，宽 = 整个舞台，与窄动画每 7.6s 互跳一次）。
//   当前动画的宽窄只准影响形状/命中区（pushHitRegion），不准动窗宽。
check("窗宽与当前动画无关（stageSize 不许读 animInkBox）——否则宠物每换一段动画就左右晃",
  !/dynFrac/.test(petSrc) &&
    !/function stageSize\(\)[\s\S]{0,2600}animInkBox/.test(petSrc) &&
    /var w = maxW \+ sidePad \* 2 \+ roamRoom\(sidePad\)/.test(petSrc));
check("换手时报一次窗宽（宽动画↔窄动画切换才改）", /self\.refitInk\(\);\s*pushHitRegion\(\);[\s\S]{0,200}reportWindowSize\(\);/.test(petSrc));
check("窗宽变化有滞回（漫游微调不变成每秒十几次搬窗）", /WIN_W_HYSTERESIS/.test(petSrc) && /Math\.abs\(s\.w - lastWinW\) < WIN_W_HYSTERESIS/.test(petSrc));

// ---------------------------------------------------------------- 收尾
console.log("\n收尾…");
// 打包身份戳：CI 的 exe job 直接调 npx electron-builder（不走 npm 脚本 → prebuild 不跑），
// 所以 afterPack 必须自己把 build.cjs 补出来，而不是因为缺文件就把自动发布打红。
const req = (await import("node:module")).createRequire(import.meta.url);
rmSync(join(ROOT, "app", "build.cjs"), { force: true });
try {
	await req("../scripts/after-pack.cjs").default({ appOutDir: "" }); // appOutDir 空 → 只补戳，不动文件
} catch (e) {
	check("afterPack 自己补出 app/build.cjs（CI 不走 npm 脚本）", false, e.message);
}
const rebuilt = existsSync(join(ROOT, "app", "build.cjs"))
	? req("../app/build.cjs")
	: null;
check("afterPack 自己补出 app/build.cjs（CI 不走 npm 脚本）", !!rebuilt && /^\w{7,}$/.test(rebuilt.sha || ""));
check("补出来的戳带素材段数（少素材一眼看出来）", !!rebuilt && rebuilt.thumbs > 0, `thumbs=${rebuilt && rebuilt.thumbs}`);
check("/health 报出包身份（一眼看出在跑哪次提交）", /build: BUILD\.sha/.test(readFileSync(join(ROOT, "app", "server.cjs"), "utf8")));
// 残影/脏区：窗被 Windows 判成 occluded 就不再产生帧（激活到前台才恢复）
const petMain = readFileSync(join(ROOT, "pi", "assets", "pet-electron.cjs"), "utf8");
check("窗不被判 occluded 就停画（CalculateNativeWinOcclusion 关掉）", /appendSwitch\("disable-features", "CalculateNativeWinOcclusion/.test(petMain));
check("遮挡/后台节流两个开关都在（残影=不刷新，不是冻住）", /disable-backgrounding-occluded-windows/.test(petMain) && /disable-renderer-backgrounding/.test(petMain));
// 窗缩小后空出来的侧边锁住不重画 = 渲染进程自己的后台节流，得单独关
check("窗关掉 backgroundThrottling（窗变小后空出的侧边不锁帧）", /backgroundThrottling: false/.test(petMain));
// 改形状/尺寸/位置后必须排一次全窗重画，否则空出来的侧边锁帧
check("setShape / setBounds / setPosition 后都调 nudgeRepaint", (petMain.match(/nudgeRepaint\(\)/g) || []).length >= 4 && /webContents\.invalidate\(\)/.test(petMain));
check("重画请求 16ms 内合并（漫游 20fps 不变成 20 次全窗填充）", /repaintPending/.test(petMain));
// 排查开关：透明置顶窗的残影若来自合成器，软件合成往往就没有它
check("PI_PET_SOFTWARE_COMPOSITE=1 可切软件合成（残影排查用）", /PI_PET_SOFTWARE_COMPOSITE === "1"/.test(petMain) && /appendSwitch\("disable-gpu-compositing"\)/.test(petMain));
// 本体在动、周围别的软件的画面被锁住 ⇒ 窗里内容变了而那片区域从没被判脏
check("宠物在窗里一动（命中区上报）就并一次整窗重画", /ipcMain\.on\("pet:hit-region"[\s\S]{0,700}nudgeRepaint\(\);/.test(petMain));
check("兼底重画可调（PI_PET_REPAINT_MS）", /PI_PET_REPAINT_MS/.test(petMain) && /setInterval\(/.test(petMain));
// TOPMODE：重画类修法全试过仍复现后，最后要动的是合成路径本身
check("TOPMODE 1 = alwaysOnTop 走 screen-saver 层级", /TOPMODE === 1[\s\S]{0,200}setAlwaysOnTop\(true, "screen-saver"\)/.test(petMain));
check("TOPMODE 2 = 不置顶，定时 showInactive 顶上来", /TOPMODE === 2[\s\S]{0,400}showInactive\(\)/.test(petMain) && /alwaysOnTop: TOPMODE !== 2/.test(petMain));
check("TOPMODE 3 = 放弃透明，用实底色（最难看但没有透明层留快照）", /transparent: TOPMODE !== 3/.test(petMain) && /backgroundColor: TOPMODE === 3 \? "#0e0e12"/.test(petMain));
// 实测定案：PI_PET_NO_SHAPE=1 不锁 ⇒ 病根是 SetWindowRgn（窗不再覆盖那块屏，DWM 不重合成）
check("形状变小时先盖满整窗再收回（逼 DWM 重合成让出的像素）", /prevShapeArea > area\(list\)/.test(petMain) && /win\.setShape\(\[\{ x: 0, y: 0, width: b\.width, height: b\.height \}\]\)/.test(petMain));
check("兼底可关（PI_PET_SHAPE_DIRTY=0 做 A/B）", /SHAPE_DIRTY_FIX = process\.env\.PI_PET_SHAPE_DIRTY !== "0"/.test(petMain));
// 定案后：形状裁剪默认关（PI_PET_SHAPE=1 才开），默认走开关式穿透
check("setShape 默认关（Windows 上收窄区域会留别的软件的画面）", /SHAPE_OK = process\.env\.PI_PET_SHAPE === "1"/.test(petMain));
check("关掉形状时默认整窗穿透（pet:passthrough 动态开关接管）", /hitRects = list;/.test(petMain) && /screen\.getCursorScreenPoint\(\)/.test(petMain));
// 穿透开着时窗收不到鼠标事件 ⇒ 渲染进程的 passthrough 靠不住（实测拖不动/右键失效）
check("开关式穿透改由主进程轮询光标判定（不再听渲染进程）", /不再听渲染进程的/.test(petMain) && /win\.setIgnoreMouseEvents\(!inside, \{ forward: true \}\)/.test(petMain));
check("命中矩形与光标比的都是**屏幕**坐标（currentPos + 窗内矩形）", /c\.x >= p\.x \+ r\.x/.test(petMain));
// 打包必须走 scripts/build.cjs：它把 electron / electron-builder 工具链的下载源
// 指到国内镜像（GitHub 直连 ETIMEDOUT，build 会整片红）。npm 脚本与 CI 都得用它。
const pkgJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
check("build / build:dir 都走 scripts/build.cjs（镜像源）", /scripts\/build\.cjs/.test(pkgJson.scripts.build) && /scripts\/build\.cjs/.test(pkgJson.scripts["build:dir"]));
check("build.cjs 不覆盖外层已设的镜像（CI 有自己的代理）", /if \(!env\[k\]\) env\[k\] = v/.test(readFileSync(join(ROOT, "scripts", "build.cjs"), "utf8")));
// 开发态窗是 `electron.exe <script> <port>` 起的，而开窗收在 pet-electron.cjs 的
// startWindow() 里、入口靠 --pi-pet-window 触发。少了它：宿主照常打「拉起窗 pid」，
// 窗进程也活着，却一扇窗不开（屏幕上什么都没有，状态永远「窗客户端 0」）。
check(
	"开发态 spawn 带 --pi-pet-window（不然窗永远不开）",
	/args = \[ELECTRON_SCRIPT, String\(port\), "--pi-pet-window"\]/.test(
		readFileSync(join(ROOT, "app", "window.cjs"), "utf8")
	)
);
// 窗共用默认 %APPDATA%\Electron profile 时，一只僵尸窗没退干净就把下一只的
// disk/GPU cache 抢没了（满屏 cache_util_win 拒绝访问，首帧慢、排查被带偏）。
check(
	"窗自己一个 userData profile（app.setPath 在 ready 之前）",
	/app\.setPath\("userData", path\.join\(homeDir\(\), "window-profile"\)\)/.test(petMain)
);
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
