#!/usr/bin/env node
/**
 * main.cjs — `pi-pet` 命令行
 *
 *   pi-pet start [--port N] [--no-window] [--insecure] [--force]   起宿主（默认动作）
 *   pi-pet serve                                                等价于 start --no-window
 *   pi-pet status                                               宿主/窗/生产者的现状
 *   pi-pet stop                                                 关窗 + 退宿主
 *   pi-pet restart [--size S]                                   换一扇窗（不重启服务）
 *   pi-pet feed <event> [tool]                                  发一条事件（thinking/tool_call…）
 *   pi-pet say <文本>                                            让宠物说一句话（只冒泡）
 *   pi-pet add [size]                                           加一只（maxPets>1 才有效）
 *   pi-pet port                                                 只打印端口（给脚本用）
 *   pi-pet config [k=v ...]                                     看/改本地配置
 *   pi-pet token                                                打印 REST 鉴权 token
 *   pi-pet doctor                                               自检：资产/依赖/端口/窗
 *
 * 退出码：0 正常；1 宿主没在跑而你要求它跑；2 参数错；3 依赖/资产缺失；4 端口问题。
 *
 * 设计取向：**能被人从命令行/脚本直接调**。`status` / `port` / `feed` 都只输出可解析的内容，
 * 不掺日志（宿主自己的日志在 home/log.txt 与 stderr）。
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { ENDPOINTS, SIZES, VERSION } = require("./protocol.cjs");
const { HOME, PATHS, PKG_ROOT, readConfig, writeConfig, readCtrl, readPortFile, log } = require("./paths.cjs");
const { readState, readToken, pidAlive } = require("./single.cjs");
const { findRunning } = require("./host.cjs");

/* ============================== 参数 ============================== */

/** 开关：出现即 true，**不**吃掉下一个参数（`--insecure start` 的 start 仍是命令）。 */
const BOOL_FLAGS = new Set([
	"no-window",
	"window",
	"insecure",
	"force",
	"json",
	"quiet",
	"help",
	"version",
]);

/** 带值选项：吃掉下一个参数；`--text=…` / `--text …` 两种写法都认。 */
const VALUE_FLAGS = new Set(["port", "text", "task", "detail", "summary", "ms", "size"]);

/** 带连字符的选项名 → camelCase 键（`--no-window` → flags.noWindow）。 */
const DASH_TO_CAMEL = { "no-window": "noWindow" };

/** 这几个的值当数字用，解析时就转掉，免得下游拿到字符串 "4000"。 */
const NUMERIC_FLAGS = new Set(["port", "ms"]);

/** 短选项 → 长名。`-p 4000` 与 `--port 4000` 等价。 */
const SHORT_FLAGS = { "-p": "port", "-q": "quiet", "-h": "help", "-v": "version" };

/**
 * 解析命令行。
 *
 * 关键点（踩过的坑）：**带值的选项必须显式声明**。以前除了 `--port` 之外一律
 * `flags[k] = true` 且不吞下一个 token，于是
 *   `say "过来玩" --ms 6000` → flags={ms:true}、positional 多出一个 "6000"
 *     → 气泡文字变成「过来玩 6000」、ms 变成 Number(true)=1；
 *   `feed thinking --text=修复登录` → flags={"text=修复登录":true}
 *     → body.text 永远拿不到，任务名**静默丢失**。
 * 声明了 BOOL/VALUE 两张表之后，值一律落到 flags[k]，位置参数不再被污染。
 *
 * @returns {{flags: object, positional: string[], missing: string[]}}
 *   `missing` = 写了选项却没给值（或值不是数字）的键，调用方报「参数错」（退出码 2）。
 */
function parseArgs(argv) {
	const flags = {};
	const positional = [];
	const missing = [];

	/** 落值：数字选项当场转，转不动（NaN）就记 missing，别把 NaN 传到下游。 */
	const setValue = (key, raw) => {
		if (NUMERIC_FLAGS.has(key)) {
			const n = Number(raw);
			if (!Number.isFinite(n)) {
				missing.push(key);
				return;
			}
			flags[key] = n;
			return;
		}
		flags[key] = raw;
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];

		// 短选项：-p / -q / -h / -v，值紧跟或用 = 都行
		if (SHORT_FLAGS[a]) {
			const key = SHORT_FLAGS[a];
			if (VALUE_FLAGS.has(key)) {
				const next = argv[i + 1];
				if (next !== undefined && !(next.startsWith("-") && !/^-?\d+(\.\d+)?$/.test(next))) {
					setValue(key, next);
					i++;
				} else {
					missing.push(key);
				}
			} else {
				flags[key] = true;
			}
			continue;
		}
		if (a.length > 1 && a[0] === "-" && !a.startsWith("--") && /^-[a-zA-Z]$/.test(a)) {
			// 未知短选项当开关，别把后面的词吞了
			flags[a.slice(1)] = true;
			continue;
		}

		if (a.startsWith("--") && a.length > 2) {
			const body = a.slice(2);
			const eq = body.indexOf("=");
			const rawKey = eq === -1 ? body : body.slice(0, eq);
			const key = DASH_TO_CAMEL[rawKey] || rawKey;
			if (eq !== -1) {
				// `--text=修复登录`：通用 key=value，值原样保留（数字选项才转）
				setValue(key, body.slice(eq + 1));
			} else if (BOOL_FLAGS.has(key) || BOOL_FLAGS.has(rawKey)) {
				flags[key] = true;
			} else if (VALUE_FLAGS.has(key) || VALUE_FLAGS.has(rawKey)) {
				const next = argv[i + 1];
				// 负数是合法值（--ms -1），只有「像选项」才当缺值
				const looksLikeOption = next !== undefined && next.startsWith("-") && !/^-?\d+(\.\d+)?$/.test(next);
				if (next !== undefined && !looksLikeOption) {
					setValue(key, next);
					i++;
				} else {
					missing.push(key);
				}
			} else {
				// 未知长选项：保持老行为（true，不吞值），值留在 positional 上，用户看得见
				flags[key] = true;
			}
			continue;
		}

		positional.push(a);
	}
	return { flags, positional, missing };
}

const HELP = `pi-pet ${VERSION} — 桌面宠物宿主（独立应用）

  start [--port N] [--no-window] [--insecure] [--force]   起宿主 + 窗（默认动作）
  serve                                                 只起服务，不起窗
  status                                                现状（宿主/窗/生产者）
  stop                                                  关窗并退宿主
  restart [--size small|normal|large]                   换一扇窗，不重启服务
feed <thinking|agent_start|agent_idle|tool_call|done|say> [tool|文本] [--text T] [--task T] [--detail T] [--summary T] [--title T]
  say "文本" [--ms 6000]                              让宠物说一句话（只冒泡）
  add [size]                                            加一只（maxPets > 1 才有效）
  port                                                  只打印端口
  config [key=value ...]                                查看/修改本地配置
  token                                                 打印 REST 鉴权 token
  doctor                                                自检

环境变量：PI_PET_HOME（数据目录）、PI_PET_PORT、PI_PET_ELECTRON、PI_PET_INSECURE=1
          PI_PET_DEBUG=1（宿主日志更啰嗦：窗的 renderer console 转到 stderr）
`;

/* ============================== 小工具 ============================== */

function out(text) {
	process.stdout.write(`${text}\n`);
}

function httpJson(port, method, pathname, body, token) {
	return new Promise((resolve) => {
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: pathname,
				method,
				timeout: 2000,
				headers: {
					...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
			},
			(res) => {
				let buf = "";
				res.setEncoding("utf8");
				res.on("data", (c) => {
					buf += c;
					if (buf.length > 1 << 20) req.destroy();
				});
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode, body: JSON.parse(buf) });
					} catch {
						resolve({ status: res.statusCode, body: null, raw: buf });
					}
				});
			},
		);
		req.on("timeout", () => {
			req.destroy();
			resolve({ status: 0, body: null, error: "timeout" });
		});
		req.on("error", (err) => resolve({ status: 0, body: null, error: err.code || err.message }));
		if (payload) req.write(payload);
		req.end();
	});
}

/** 探活必须核 role：状态文件是任何进程都能写的普通文件，光看「写着有宠物」就信 = 把脏数据当宠物。 */
async function probeHealth(port, timeoutMs = 1500) {
	const started = Date.now();
	return new Promise((resolve) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path: ENDPOINTS.health, method: "GET", timeout: timeoutMs },
			(res) => {
				let buf = "";
				res.setEncoding("utf8");
				res.on("data", (c) => {
					buf += c;
					if (buf.length > 1 << 20) req.destroy();
				});
				res.on("end", () => {
					try {
						const parsed = JSON.parse(buf);
						resolve(parsed && parsed.role === "pi-pet-host" ? { ...parsed, rttMs: Date.now() - started } : null);
					} catch {
						resolve(null);
					}
				});
			},
		);
		req.on("timeout", () => {
			req.destroy();
			resolve(null);
		});
		req.on("error", () => resolve(null));
		req.end();
	});
}

function fmtUptime(state) {
	if (!state || !state.startedAt) return "?";
	const s = Math.max(0, Math.floor((Date.now() - Number(state.startedAt)) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** 一次 HTTP 应答翻成人话。以前只打 `res.body || res.error`，而 404 是 text/plain：
 *  body 解析失败 → null → 打出来的永远是那个刺眼的 `undefined`。 */
function describeRes(res) {
	if (!res) return "无应答";
	if (res.status === 0) return `连不上宿主（${res.error || "无响应"}）`;
	if (res.body && typeof res.body === "object" && (res.body.error || res.body.hint)) {
		return `HTTP ${res.status}：${res.body.error}${res.body.hint ? `（${res.body.hint}）` : ""}`;
	}
	const raw = String(res.raw || "").trim().replace(/\s+/g, " ");
	if (raw) return `HTTP ${res.status}：${raw.slice(0, 120)}`;
	return `HTTP ${res.status}`;
}

/**
 * 探这个宿主支持哪些面。
 *
 * 两个探测都是**只读**的（GET、不改任何状态）：
 *   GET /control 不带 action → 本仓库宿主回 400 + action 清单；没有这个端点的宿主回 404。
 *   GET /event 不带 type    → 本仓库宿主回 400 "unknown event"；旧宿主回 404。
 * 状态文件是**任何进程都能写的普通文件**，`findRunning()` 又会把旧版 pi 扩展
 * 起的那套宿主也当成「有宠物在跑」——不探能力，喊 say/restart 就只会丢一个裸 404 给用户。
 */
async function probeCaps(port, token) {
	const [ctl, evt] = await Promise.all([
		httpJson(port, "GET", ENDPOINTS.control, undefined, token),
		httpJson(port, "GET", ENDPOINTS.event, undefined, token),
	]);
	const auth = ctl.status !== 401 && evt.status !== 401;
	return {
		control: ctl.status === 400 && !!(ctl.body && ctl.body.hint),
		event: evt.status === 400 || evt.status === 200,
		auth,
		actions: ctl.body && typeof ctl.body.hint === "string" ? ctl.body.hint : "",
	};
}

/** 状态文件是谁写的：自己 home 里的就是本仓库宿主，别的就是外来（旧 pi 扩展 / 别的版本）。 */
function isForeign(file) {
	try {
		return path.resolve(file) !== path.resolve(PATHS.state);
	} catch {
		return false;
	}
}

/** 需要的那面这个宿主没有：说清楚「是谁在跑、它只支持什么、怎么换」，别丢裸 404。 */
function reportMissing(need, ctx) {
	const what = need === "control" ? "控制面（say / restart / add / pause / show…）" : "事件面（feed）";
	out(`✗ 这个宿主没有${what}`);
	out(`  正在跑：pid ${ctx.health.pid || ctx.pid} :${ctx.port}  状态文件 ${ctx.file}`);
	if (ctx.foreign) out("  来源：外来状态文件（不是本仓库起的宿主，findRunning 把它也当成了宠物）");
	if (ctx.caps.actions) out(`  它的控制面只有：${ctx.caps.actions}`);
	else if (!ctx.caps.auth) out(`  它要 token，但本机没读到（${PATHS.token}）—— 它不是本仓库起的`);
	out("  换成本仓库的宿主：pi-pet stop（会把旧的 taskkill 掉） → pi-pet start");
	return 1;
}

/* ============================== 子命令 ============================== */

async function cmdStatus(flags) {
	const found = findRunning();
	if (!found) {
		if (flags.json) return out(JSON.stringify({ ok: false, running: false }, null, 2));
		out("宠物宿主：没在跑");
		out(`  数据目录 ${PATHS.home}`);
		out("  起一个：pi-pet start");
		return 1;
	}
	const { state, file } = found;
	const health = await probeHealth(Number(state.port));
	const alive = pidAlive(Number(state.pid));
	const foreign = isForeign(file);
	const caps = health ? await probeCaps(Number(state.port), readToken()) : null;
	if (flags.json) {
		return out(
			JSON.stringify(
				{
					ok: true,
					running: true,
					// 状态文件说在、/health 探不通 = 假活（详见 DESIGN.md「已知坑」第 2 条）
					reachable: !!health,
					foreign,
					stateFile: file,
					caps,
					state,
					health,
				},
				null,
				2,
			),
		);
	}
	out(`宠物宿主：pid ${state.pid} :${state.port}  活 ${fmtUptime(state)}  探活 ${health ? `${health.rttMs}ms` : "不通"}`);
	out(`  来源：${foreign ? "外来状态文件（不是本仓库起的宿主）" : `本仓库（${PATHS.home}）`}`);
	if (caps) {
		out(`  能力：控制面 ${caps.control ? "有" : "没有"}  事件面 ${caps.event ? "有" : "没有"}  鉴权 ${caps.auth ? "通过" : "被拒"}`);
		if (!caps.control) out("    → say / restart / add / pause 在这个宿主上不可用（旧宿主只有 /health /ws /feed）");
	}
	out(`  窗：pid ${state.windowPid || 0}  状态 ${state.windowState}  重启 ${state.restarts || 0} 次  ${health && health.windowConnected ? "（已连上）" : "（未连上）"}`);
	out(`  生产者：${health ? health.feeds : "?"} 个会话  窗客户端：${health ? health.clients : "?"} 个`);
if (health && health.feedsBySource && Object.keys(health.feedsBySource).length) {
		for (const [k, v] of Object.entries(health.feedsBySource)) out(`    - ${k} × ${v}`);
	}
	// 每会话一条的气泡：谁在执行中、谁跑完了（v1.4）
	if (health && Array.isArray(health.sessionBubbles) && health.sessionBubbles.length) {
		for (const b of health.sessionBubbles) {
			out(`    · ${b.title} ${b.status === "done" ? "已完成" : "执行中"}${b.text ? `：${b.text}` : ""}（${b.sid}）`);
		}
	}
	out(`  意图：${JSON.stringify(readCtrl())}`);
	if (health && health.pkg && path.resolve(String(health.pkg)) !== path.resolve(PKG_ROOT)) {
		// 两份 checkout（开发用的那份 vs pi 装在 ~/.pi/agent/git/… 的那份）：改错份 = 改了没反应。
		out(`  ⚠ 宿主跑的是另一份代码：${health.pkg}`);
		out(`    你在 ${PKG_ROOT} —— 改这里不生效；改完 npm run sync，再 pi-pet restart`);
	}
	out(`  状态文件：${file}`);
	if (!alive) out("  ⚠ 状态文件里的 pid 已经不在了（陈旧状态），直接 pi-pet start 会重新拉起");
	if (alive && !health) out("  ⚠ 进程在但 /health 探不通：窗可能活着却收不到事件，建议 pi-pet restart");
	return alive && health ? 0 : 1;
}

async function cmdStart(flags) {
	const { start } = require("./host.cjs");
	const res = await start({
		port: flags.port,
		noWindow: flags.noWindow,
		insecure: flags.insecure,
		force: flags.force,
	});
	if (!res.started) {
		if (res.reason === "already-running" || res.reason === "locked") {
			const e = res.existing || {};
			out(
				res.reason === "locked"
					? `✗ 单例锁被占（pid ${e.pid}）：已经有一只宠物了，本进程不起第二个`
					: `已经在跑了（pid ${e.pid} :${e.port}）—— pi-pet status 看详情`,
			);
			out("  要用新的一只：先 pi-pet stop，或 pi-pet start --force（会先关掉旧的）");
			return keepAlive(res);
		}
		if (res.reason === "no-ws") {
			out("✗ WebSocket 服务端不可用（app/wsserver.cjs 加载失败）");
			return 3;
		}
		out(`✗ 起不来：${res.reason}${res.error ? `（${res.error}）` : ""}`);
		return 4;
	}
	if (flags.quiet) {
		out(res.port);
	} else {
		out(`pi-pet 宿主已起：http://127.0.0.1:${res.port}  pid ${res.pid}`);
		out(`  数据目录 ${PATHS.home}`);
		out(`  鉴权 token：${PATHS.token}`);
		out(`  端口文件 ${PATHS.port}（脚本读这一行就知道连哪个端口）`);
	}
	return keepAlive(res);
}

/** 宿主起来后不退出：Ctrl+C 才走（这样 `pi-pet start` 就是一个前台应用）。 */
function keepAlive(res) {
	return new Promise((resolve) => {
		if (!res || !res.started) {
			resolve(0);
			return;
		}
		const stop = () => {
			res.shutdown(0);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		res.server.on("close", () => resolve(0));
		// 兜底：状态写一次，让 status 立刻看得到
		try {
			require("./single.cjs").writeState(res.state);
		} catch {
			/* ignore */
		}
	});
}

async function cmdStop() {
	const found = findRunning();
	if (!found) {
		out("宠物宿主：本来就没在跑");
		return 0;
	}
	const { state, file } = found;
	const token = readToken();
	// 优先走控制面（优雅：先告诉窗自己关），不通再 taskkill（硬杀）
	const res = await httpJson(Number(state.port), "POST", ENDPOINTS.control, { action: "shutdown" }, token);
	if (res.status === 200) {
		out(`已请宿主退出（pid ${state.pid}）`);
		return 0;
	}
	if (process.platform === "win32") {
		require("node:child_process").spawn("taskkill", ["/pid", String(state.pid), "/f", "/t"], {
			stdio: "ignore",
			windowsHide: true,
		});
	} else {
		try {
			process.kill(Number(state.pid), "SIGTERM");
		} catch {
			/* 已经没了 */
		}
	}
	out(`已硬杀宿主（pid ${state.pid}，控制面没应答：${res.error || res.status}；状态文件 ${file}）`);
	return 0;
}

/**
 * 找到宿主、探活、探能力，然后把 {health, token, caps, file, foreign, port, pid} 交给 fn。
 * @param {"control"|"event"} need 这次命令要哪一面；没有就直接报「不支持」，不发请求。
 */
async function withHost(need, fn) {
	const found = findRunning();
	if (!found) {
		out("✗ 宠物宿主没在跑（pi-pet start）");
		return 1;
	}
	const health = await probeHealth(Number(found.state.port));
	if (!health) {
		out(`✗ 宿主在（pid ${found.state.pid}）但 /health 探不通，什么都做不了（pi-pet restart 或 pi-pet stop）`);
		return 1;
	}
	const token = readToken();
	const caps = await probeCaps(health.port, token);
	const ctx = { health, token, caps, file: found.file, foreign: isForeign(found.file), port: health.port, pid: found.state.pid };
	if (need === "control" && !caps.control) return reportMissing("control", ctx);
	if (need === "event" && !caps.event) return reportMissing("event", ctx);
	return fn(ctx);
}

async function cmdFeed(positional, flags) {
	const type = positional[0];
if (!type) {
		out("用法：pi-pet feed <thinking|agent_start|agent_idle|done|say|shutdown> [tool|文本]");
		out("     pi-pet feed tool_call bash");
		out('     pi-pet feed thinking --text="修复登录"     （带任务名 → 气泡会写「「修复登录」思考中…」）');
		out('     pi-pet feed done --text="改完 3 个文件"      （完成气泡）');
		out('     pi-pet feed thinking --title="修复登录"     （会话标题 → 宠物按会话一个一个泡）');
		out('     pi-pet say "过来玩"                         （只冒泡，不改状态）');
		return 2;
	}
	return withHost("event", async (ctx) => {
		const body = { type };
		const rest = positional.slice(1);
		// feed say "文本"：第一个非 flag 位置参数就是气泡文字
		if (type === "say") {
			body.text = rest.join(" ") || flags.text;
		} else if (rest[0]) {
			// 第二个位置参数只对两种类型有意义：tool_call 的工具名、add_pet 的尺寸。
			// 其余类型（旧代码一律当 size）收了也是白收，丢掉更安全。
			if (type === "tool_call") body.tool = rest[0];
			else if (type === "add_pet" && SIZES.includes(rest[0])) body.size = rest[0];
		}
// title = 会话标题（v1.4）：宠物按会话一个一个泡气泡，气泡上写它
		for (const k of ["text", "task", "detail", "summary", "title", "ms"]) {
			if (flags[k] !== undefined) body[k] = flags[k];
		}
		const res = await httpJson(ctx.port, "POST", ENDPOINTS.event, body, ctx.token);
		if (res.status !== 200) {
			out(`✗ 没发出去：${describeRes(res)}`);
			return 1;
		}
const bits = [type];
		if (body.tool) bits.push(`(${body.tool})`);
		if (body.text) bits.push(`「${body.text}」`);
		if (body.title) bits.push(`标题「${body.title}」`);
		out(`✓ ${bits.join(" ")} → 窗（${res.body.sent} 个客户端）`);
		return 0;
	});
}

/** 手动说一句（只冒泡，不改动画状态）。 */
async function cmdSay(positional, flags) {
	const text = positional.join(" ") || flags.text;
	if (!text) {
		out('用法：pi-pet say "文本" [--ms 6000]');
		return 2;
	}
	return withHost("control", async (ctx) => {
		const res = await httpJson(ctx.port, "POST", ENDPOINTS.control, { action: "say", text, ms: Number(flags.ms) || 0 }, ctx.token);
		if (res.status !== 200) {
			out(`✗ ${(res.body && res.body.error) || describeRes(res)}`);
			return 1;
		}
		out(`✓ ${res.body.detail || "已发送"}`);
		return 0;
	});
}

async function cmdAdd(positional) {
	const size = positional[0] && SIZES.includes(positional[0]) ? positional[0] : "normal";
	return withHost("control", async (ctx) => {
		const res = await httpJson(ctx.port, "POST", ENDPOINTS.control, { action: "add-pet", size }, ctx.token);
		if (res.status !== 200) {
			out(`✗ ${(res.body && res.body.error) || describeRes(res)}`);
			return 1;
		}
		out(`✓ ${res.body.detail}`);
		return 0;
	});
}

async function cmdRestart(flags) {
	if (flags.size !== undefined && !SIZES.includes(flags.size)) {
		out(`✗ --size 只能是 ${SIZES.join(" / ")}（收到 ${JSON.stringify(flags.size)}）`);
		return 2;
	}
	return withHost("control", async (ctx) => {
		const res = await httpJson(ctx.port, "POST", ENDPOINTS.control, { action: "restart-window", size: flags.size }, ctx.token);
		if (res.status !== 200) {
			out(`✗ ${(res.body && res.body.error) || describeRes(res)}`);
			return 1;
		}
		out(`✓ ${res.body.detail}（size=${flags.size || readCtrl().size || "normal"}）`);
		return 0;
	});
}

async function cmdPort() {
	const found = findRunning();
	if (found && found.state.port) {
		out(String(found.state.port));
		return 0;
	}
	// state.json 没（硬杀、或旧版宿主只写端口文件）时，端口文件 + 探活还能救回来：
	// 端口文件是硬杀后唯一不会消失的线索，但必须探活，不然会把一个死端口报给脚本。
	const port = readPortFile();
	if (port && (await probeHealth(port, 800))) {
		out(String(port));
		return 0;
	}
	out("");
	return 1;
}

function cmdToken() {
	const t = readToken();
	if (!t) {
		out("还没有 token（本仓库的宿主没起过）：pi-pet start");
		const found = findRunning();
		if (found && isForeign(found.file)) {
			out(`  注意：现在跑的是外来宿主（状态文件 ${found.file}），它不认本仓库的 token`);
			out("  想要能用的 token：pi-pet stop 换成本仓库的宿主，再 pi-pet start");
		}
		return 1;
	}
	out(t);
	return 0;
}

function cmdConfig(positional) {
	if (positional.length === 0) {
		out(JSON.stringify(readConfig(), null, 2));
		out(`# 文件：${PATHS.config}`);
		return 0;
	}
	const patch = {};
	for (const kv of positional) {
		const i = kv.indexOf("=");
		if (i < 0) {
			out(`✗ 参数要写成 key=value：${kv}`);
			return 2;
		}
		const k = kv.slice(0, i);
		const v = kv.slice(i + 1);
		if (v === "true" || v === "false") patch[k] = v === "true";
		else if (/^\d+$/.test(v)) patch[k] = Number(v);
		else patch[k] = v;
	}
	const next = writeConfig(patch);
	out(JSON.stringify(next, null, 2));
	return 0;
}

async function cmdDoctor() {
	const lines = [];
	let bad = 0;
	const ok = (label, value, good = true) => {
		lines.push(`${good ? "✓" : "✗"} ${label}：${value}`);
		if (!good) bad++;
	};

	ok("版本", `pi-pet ${VERSION}`);
// 包身份：报出 sha，用户才能确认自己跑的不是旧 exe（当前 HEAD，落盘给 doctor 读）
	try {
		const b = require("./stamp.cjs").current({ persist: true });
		const head = (() => {
			try {
				return require("node:child_process").execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PKG_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			} catch {
				return "";
			}
		})();
		const stale = head && b.sha !== head;
		ok("包身份", `${b.sha}${b.dirty ? " (dirty)" : ""} · ${b.thumbs} 段素材 @ ${b.builtAt}` + (stale ? ` —— 比仓库 HEAD(${head}) 旧，重跑 npm run build` : ""), !stale);
	} catch {
		lines.push("· 包身份：无 build.cjs（源码目录直跑，或跑一次 npm run build 生成）");
	}
	ok("包根目录", PKG_ROOT, fs.existsSync(PKG_ROOT));
	const assets = path.join(PKG_ROOT, "pi", "assets");
	ok("窗脚本", path.join(assets, "pet-electron.cjs"), fs.existsSync(path.join(assets, "pet-electron.cjs")));
	ok("素材目录", path.join(PKG_ROOT, "assets", "thumb"), fs.existsSync(path.join(PKG_ROOT, "assets", "thumb")));
	ok("配置", path.join(PKG_ROOT, "assets", "config.jsonc"), fs.existsSync(path.join(PKG_ROOT, "assets", "config.jsonc")));
	try {
		// 零依赖：WebSocket 服务端是自带的（app/wsserver.cjs）。以前这里查的是 `ws` 包，
		// 那是宿主独立化之前的遗留 —— 打完 exe 的目录里根本没有 node_modules，
		// doctor 会在成品里永远报「✗ ws 依赖不可解析」，把自检的结论带歪。
		const { attachWebSocket } = require("./wsserver.cjs");
		const okWs = typeof attachWebSocket === "function";
		ok("WebSocket 服务端", okWs ? "内置（零依赖）" : "attachWebSocket 不是函数", okWs);
	} catch (err) {
		ok("WebSocket 服务端", `不可用（${err.message}）`, false);
	}
	try {
		const { resolveElectronBin } = require("./window.cjs");
		const bin = resolveElectronBin();
		ok("electron", bin || "没找到（会退回 npx，首次约 100MB）", !!bin);
	} catch (err) {
		ok("electron", `查找失败：${err.message}`, false);
	}

	const found = findRunning();
	if (!found) {
		lines.push("· 宿主：没在跑（pi-pet start）");
	} else {
		const health = await probeHealth(Number(found.state.port));
		ok("宿主", `pid ${found.state.pid} :${found.state.port}，/health ${health ? "通" : "不通"}`, !!health);
		if (health) {
			ok("窗", `${health.windowState}（${health.windowConnected ? "已连上" : "没连上"}）`, health.windowConnected);
			lines.push(`· 生产者：${health.feeds} 个会话`);
		}
	}
	lines.push(`· 数据目录：${HOME}`);
	out(lines.join("\n"));
	return bad === 0 ? 0 : 1;
}

/* ============================== 入口 ============================== */

async function main() {
	const argv = process.argv.slice(2);
	const { flags, positional, missing } = parseArgs(argv);
	if (missing.length) {
		// 缺值/值非法要当场报，别带着半个 flag 往下跑（--ms 没值 → 气泡 1ms 后消失）
		out(`✗ 参数缺值：${[...new Set(missing)].map((k) => `--${k}`).join(" ")}`);
		out("  写法：`--k 值` 或 `--k=值`");
		return 2;
	}
	const cmd = positional.shift() || "start";

	if (flags.help) {
		out(HELP);
		return 0;
	}
	if (flags.version) {
		out(VERSION);
		return 0;
	}

	// `--window` 显式反转 `--no-window`（两者先后顺序不影响）
	if (flags.window) delete flags.noWindow;

	switch (cmd) {
		case "start":
			return cmdStart(flags);
		case "serve":
			// serve 默认无头；写了 --window 就以显式 flag 为准
			if (!flags.window) flags.noWindow = true;
			return cmdStart(flags);
		case "status":
			return cmdStatus(flags);
		case "stop":
			return cmdStop();
		case "restart":
			return cmdRestart(flags);
		case "feed":
			return cmdFeed(positional, flags);
		case "say":
			return cmdSay(positional, flags);
		case "add":
			return cmdAdd(positional);
		case "port":
			return cmdPort();
		case "token":
			return cmdToken();
		case "config":
			return cmdConfig(positional);
		case "doctor":
			return cmdDoctor();
		default:
			out(`未知命令：${cmd}`);
			out(HELP);
			return 2;
	}
}

if (require.main === module) {
	main()
		.then((code) => {
			process.exitCode = code || 0;
		})
		.catch((err) => {
			out(`✗ pi-pet 崩了：${err && err.stack ? err.stack : err}`);
			process.exitCode = 1;
		});
}

module.exports = { main, parseArgs, probeCaps, probeHealth, httpJson };
