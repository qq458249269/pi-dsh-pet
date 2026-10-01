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
/** 位置帧（v1.2，不带动画也不带气泡；滤掉以免被当成动画帧计数） */
const isPositions = (f) => f.startsWith("{\"type\":\"positions\"");
/** 动画帧（把气泡/位置帧滤掉）：thinking / agent_idle / tool_call / add_pet / shutdown */
const animFrames = (frames) => frames.filter((f) => !isBubble(f) && !isPositions(f));
const bubbleFrames = (frames) => frames.filter(isBubble).map((f) => JSON.parse(f).text);
const positionFrames = (frames) => frames.filter(isPositions).map((f) => JSON.parse(f).map);

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
	const extTs = readFileSync(join(ROOT, "pi", "extensions", "index.ts"), "utf8");
/** 从两处源码里抠出 {small,normal,large} 的数字（逗号连起来的字符串，便于直接比） */
	const sizeOf = (src, re) => (src.match(re) || []).slice(1).join(",");
	const MIN_SIZE = Number(sizeOf(petJs, /SIZE_MAP = \{ small: (\d+)/));
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
	// ⑤ 节奏参数可配，且两个默认值都写在 config.jsonc 里
	//    ⚠️ 默认值 = 用户口径的「每段动画播放时间延长 5 秒」：2.6s+5s / 6s+5s / 45s+5s。
	//    这里把三个数都钉住：改小回去就等于「动画又被切一半」，那就是回归。
	check("timing 段带 minPlayMs / idleDwellMs（+5s 后的值）", /"minPlayMs"\s*:\s*7600/.test(cfg) && /"idleDwellMs"\s*:\s*11000/.test(cfg));
	check("timing 缺省/写错都有兜底", /function readTiming\(raw\)/.test(petJs) && /TIMING_DEFAULT = \{ minPlayMs: 7600, idleDwellMs: 11000, idleSleepMs: \d+ \}/.test(petJs));
	check("timing 段带 idleSleepMs（空闲多久冻住）", /"idleSleepMs"\s*:\s*\d+/.test(cfg) && /num\("idleSleepMs"/.test(petJs));
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
	// ③ 唤醒口子齐：WS / 主进程（最小化、锁屏）/ 页签隐藏 / 鼠标
	check("活动唤醒有定时器（noteActivity/armIdle）", /function noteActivity\(\)/.test(petJs) && /function armIdle\(\)/.test(petJs) && /setTimeout\(function \(\)[\s\S]{0,120}goSleep\(\)/.test(petJs));
check("最小化/锁屏/挂起 → 睡（pet:power）", /onPower: \(cb\) => ipcRenderer\.on\("pet:power"/.test(pre) && /win\.on\("minimize", \(\) => sendPower\(true\)\)/.test(elec) && /\["lock-screen", true\]/.test(elec));
	check("页签隐藏也睡", /document\.addEventListener\("visibilitychange"[\s\S]{0,200}goSleep\(\)/.test(petJs));
	check("WS 有 power 帧处理", /obj\.type === "power"[\s\S]{0,200}applyPowerFrame/.test(petJs));
	// ④ 手动省电：落盘 + 菜单 + 只加不改的协议帧
	check("省电模式落盘（换窗/重启还在）", /powerSave: false/.test(pathsSrc) && /case "power-save"/.test(hostSrc) && /setPower\(on\)/.test(busSrc));
	check("窗接上来时补发 power 帧", /conn\.send\(powerFrame\(power\(\) === true\)\)/.test(busSrc));
	check("菜单里有「省电模式」", /label: "省电模式[^\"]*"/.test(elec));
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
check("位置存的是比例不是像素", /customPos = \{ rx: [^}]*innerWidth, ry: [^}]*innerHeight/.test(petJs));
}

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
check("菜单更新走宿主（check-update / do-update）", /callHost\("check-update"/.test(elecSrc) && /callHost\("do-update"/.test(elecSrc));
check("菜单更新请求的超时给到分钟级（git fetch / npm i 很慢）", /callHost\("check-update", \{\}, token, 240000\)/.test(elecSrc));
check("自动更新不需要用户点（宿主自己拉）", /PI_PET_NO_UPDATE=1 → 不自动检查更新/.test(updSrc));
// ⚠️ 这里不真调 do-update：测试跑在这棵真仓库上，pull 会动工作区。
check("do-update 不会用空串盖掉刚查到的版本/提交", /if \(!s\[k\]\) delete s\[k\]/.test(hostSrc));

// ---------------------------------------------------------------- 舞台窗（小窗，别改回全屏）
console.log("\n舞台窗（只包住宠物，不是全屏）…");
check("主进程不再按屏幕大小开窗", !/workAreaSize/.test(elecSrc));
check("窗落点落在工作区里（默认右下角 + 记住上次）", /workArea/.test(elecSrc) && /stage\.json/.test(elecSrc));
check("拖宠物 = 搬窗（位移从按下那下算起）", /queueWinMove\(dx, dy, dragState\.inset\)/.test(petSrc) && /windowDrag\.x \+ dx/.test(elecSrc));
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
check("舞台窗 = 高度定死 + 宽度自适应内容（不再有强制窗宽和 200 留白）", /var STAGE_PAD_X = 32/.test(petSrc) && /var BUBBLE_W_MAX = 820/.test(petSrc) && /var w = maxW \+ sidePad \* 2/.test(petSrc) && !/MIN_STAGE_W/.test(petSrc) && !/BUBBLE_BASE_W/.test(petSrc));
// 窗不许为气泡撑宽：窗一比「动画 + 余量」宽，气泡（封顶 = 窗宽-16）就比动画宽很多，
//   居中时必被 clampBubble 推到贴一边（实测 592 宽居中于 462 动画：左探 196 / 右探 16）。
check("气泡宁窄勿歪（封顶 = 窗宽-16，窗宽只跟动画走）", /Math\.min\(Math\.max\(240, Math\.round\(winW\) - 16\), BUBBLE_W_MAX\)/.test(petSrc));
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
check("气泡宽度跟着窗宽走（--bubble-max-w = 窗宽 - 16），最多 6 行", /max-width: min\(var\(--bubble-max-w, 544px\), calc\(100vw - 16px\)\)/.test(petCss) && /-webkit-line-clamp: 6/.test(petCss) && !/max-width: min\(420px/.test(petCss) && !/max-width: min\(560px/.test(petCss));
// ⚠️ 气泡必须 border-box：--bubble-max-w 说的是**外框**宽，而 max-width 默认按内容盒算，
//   差着 24px padding + 2px border。算错的后果不是不好看，是气泡比窗还宽 ⇒ 左右两个
//   8px 边距永远夹不住，clampBubble 每次把它往另一边推 10px（实测 -12 → -22 来回甩）。
check("气泡 border-box（max-width 按外框算，夹取才夹得住）", /\.pet-bubble \{[\s\S]{0,2400}box-sizing: border-box/.test(petCss));
// ⚠️ 气泡的宽度上限只许有一个出处：窗宽算一次 → CSS 变量 → pet.css 读它。
//   写死过一次（pet.css 560 / pet.js 按窗宽 620），多出来的留白就白留了（§9.22）。
check("气泡上限只有一个出处（stageSize → --bubble-max-w → pet.css）", /function stageSize\(/.test(petSrc) && /function applyBubbleMaxWidth\(/.test(petSrc) && /applyBubbleMaxWidth\(s\.w\)/.test(petSrc) && /Math\.round\(winW\) - 16/.test(petSrc) && !/560px/.test(petCss));
check("气泡高度由 clampBubble 按头顶空间写（不再写死三行）", /var room = Math\.max\(24, Math\.round\(cr\.top - BUBBLE_CHROME_H\)\)/.test(petSrc) && /bubble\.style\.maxHeight = room \+ "px"/.test(petSrc) && /bubble\.style\.webkitLineClamp = String\(lines\)/.test(petSrc));
check("行数按空间收（空间不够就少几行，而不是把话抽掉）", /Math\.min\(6, Math\.floor\(\(room - 14\) \/ BUBBLE_LINE_H\)\)/.test(petSrc) && /var BUBBLE_LINE_H = 18\.85/.test(petSrc));
// 「说点什么」输入框在气泡**底部**（bubbleText 之后 append），封整个气泡会把框裁掉 → 只封文字
check("输入态只封文字、给输入框留出 44px（不然框被裁掉没法打字）", /bubble\.classList\.contains\("with-input"\)[\s\S]{0,700}bubbleText\.style\.maxHeight = Math\.max\(20, room - BUBBLE_INPUT_H\)/.test(petSrc) && /var BUBBLE_INPUT_H = 44/.test(petSrc));
// 气泡刚 show 出来那下量到的是旧布局：下一帧要再夹一次，否则右缘探出窗边被切（实测 38px）
check("气泡下一帧再夹一次（刚 show 时量的是上一段文案的布局）", /requestAnimationFrame\(function \(\) \{ self\.clampBubble\(\); \}\)/.test(petSrc));
check("窗一变就重新夹气泡（高度/宽度都变了）", /window\.addEventListener\("resize"[\s\S]{0,600}clampBubbles\(\)/.test(petSrc));

// ------------------------------------------------ 留白是宠物的禁区（§9.23）
// 症状：「上下高度不够 气泡无法完全显示」。量出来的根：位置记忆里 ry=0.2764627…
//   套上去正好把宠物钉在窗顶（top=0）—— 头顶 0 留白，气泡被压成 846x24 的一条、字全裁没了。
// 修法：站位记忆套回来时，宠物在**窗里**也必须给气泡留出舞台（左右 24、顶 150、底 60）。
//   漫游/拖动不夹（clampPos 仍按 0 起夹）：漫游只改 left 不改 top，横向窗里还有几十 px 可夹。
check("站位记忆也要给气泡留舞台（宠物不许贴到窗顶/窗边）", /function stageKeepIn\(/.test(petSrc) && /stageKeepIn\(cp\.rx \* window\.innerWidth - halfW, cp\.ry \* window\.innerHeight - halfH, self\.size, cfg\)/.test(petSrc) && /var loY = topOffsetOf\(cfg\)/.test(petSrc) && /var hiY = H - petH - bottomPadOf\(cfg\)/.test(petSrc) && /var loX = STAGE_PAD_X/.test(petSrc) && !/Math\.max\(cp\.ry \* window\.innerHeight - halfH, 0\)/.test(petSrc));
// 窗比「宠物 + 两侧留白」还窄时区间会翻过来（多开时窗按最大的那只算）：
//   这时取中间值，不然照样贴边、同样没头顶。
check("窗太窄时留白区间取中间（不翻车成贴边）", /if \(hiX < loX\) loX = hiX = Math\.max\(0, \(W - size\) \/ 2\)/.test(petSrc) && /if \(hiY < loY\) loY = hiY = Math\.max\(0, \(H - petH\) \/ 2\)/.test(petSrc));
// 夹完把内存里的落点也改回实际值：不改的话漫游起点（读 customPos）会先跳一下再走
check("夹取后回写 customPos（漫游起点和 DOM 一致）", /self\.customPos\.rx = \(keep\.left \+ halfW\) \/ window\.innerWidth/.test(petSrc));
// 窗高公式和站位区间共用同一份 corner 算法（又一份算法就又一处对不上，§9.22 的教训）
check("窗底留白 corner 算法只有一份（stageSize 与 stageKeepIn 共用）", /function bottomPadOf\(/.test(petSrc) && /botPad = Math\.max\(botPad, bottomPadOf\(cfg\)\)/.test(petSrc) && !/botPad = Math\.max\(botPad, Math\.max\(mY, STAGE_PAD_BOTTOM\)\)/.test(petSrc));

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
check("合帧只留最新位置（旧的丢掉，不会排队追）", /movePending = \{ dx: dx, dy: dy, inset: inset \}[\s\S]{0,200}if \(!moveRaf\) moveRaf/.test(petSrc));
check("位移仍然从按下那下算起（合帧不累积误差）", /var p = screenPoint\(e\)[\s\S]{0,900}var dx = p\.x - dragState\.psx[\s\S]{0,900}queueWinMove\(dx, dy, dragState\.inset\)/.test(petSrc));
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
