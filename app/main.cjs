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
const { HOME, PATHS, PKG_ROOT, readConfig, writeConfig, readCtrl, log } = require("./paths.cjs");
const { readState, readToken, pidAlive } = require("./single.cjs");
const { findRunning } = require("./host.cjs");

/* ============================== 参数 ============================== */

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--no-window") flags.noWindow = true;
		else if (a === "--window") flags.noWindow = false;
		else if (a === "--insecure") flags.insecure = true;
		else if (a === "--force") flags.force = true;
		else if (a === "--json") flags.json = true;
		else if (a === "--quiet" || a === "-q") flags.quiet = true;
		else if (a === "--help" || a === "-h") flags.help = true;
		else if (a === "--version" || a === "-v") flags.version = true;
		else if (a === "--port" || a === "-p") flags.port = Number(argv[++i]);
		else if (a.startsWith("--port=")) flags.port = Number(a.slice(7));
		else if (a.startsWith("--")) flags[a.slice(2)] = true;
		else positional.push(a);
	}
	return { flags, positional };
}

const HELP = `pi-pet ${VERSION} — 桌面宠物宿主（独立应用）

  start [--port N] [--no-window] [--insecure] [--force]   起宿主 + 窗（默认动作）
  serve                                                 只起服务，不起窗
  status                                                现状（宿主/窗/生产者）
  stop                                                  关窗并退宿主
  restart [--size small|normal|large]                   换一扇窗，不重启服务
  feed <thinking|agent_start|agent_idle|tool_call|done|say> [tool|文本] [--text T] [--task T] [--detail T] [--summary T]
  say "文本" [--ms 6000]                              让宠物说一句话（只冒泡）
  add [size]                                            加一只（maxPets > 1 才有效）
  port                                                  只打印端口
  config [key=value ...]                                查看/修改本地配置
  token                                                 打印 REST 鉴权 token
  doctor                                                自检

环境变量：PI_PET_HOME（数据目录）、PI_PET_PORT、PI_PET_ELECTRON、PI_PET_INSECURE=1
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
	if (flags.json) {
		return out(
			JSON.stringify(
				{
					ok: true,
					running: true,
					// 状态文件说在、/health 探不通 = 假活（详见 DESIGN.md「已知坑」第 2 条）
					reachable: !!health,
					stateFile: file,
					state,
					health,
				},
				null,
				2,
			),
		);
	}
	out(`宠物宿主：pid ${state.pid} :${state.port}  活 ${fmtUptime(state)}  探活 ${health ? `${health.rttMs}ms` : "不通"}`);
	out(`  窗：pid ${state.windowPid || 0}  状态 ${state.windowState}  重启 ${state.restarts || 0} 次  ${health && health.windowConnected ? "（已连上）" : "（未连上）"}`);
	out(`  生产者：${health ? health.feeds : "?"} 个会话  窗客户端：${health ? health.clients : "?"} 个`);
	if (health && health.feedsBySource && Object.keys(health.feedsBySource).length) {
		for (const [k, v] of Object.entries(health.feedsBySource)) out(`    - ${k} × ${v}`);
	}
	out(`  意图：${JSON.stringify(readCtrl())}`);
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
			out("✗ 缺 ws 依赖：在包目录里跑 npm install");
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

async function withHost(fn) {
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
	return fn(health, readToken());
}

async function cmdFeed(positional) {
	const type = positional[0];
	if (!type) {
		out("用法：pi-pet feed <thinking|agent_start|agent_idle|done|say|shutdown> [tool|文本]");
		out("     pi-pet feed tool_call bash");
		out('     pi-pet feed thinking --text="修复登录"     （带任务名 → 气泡会写「「修复登录」思考中…」）');
		out('     pi-pet feed done --text="改完 3 个文件"      （完成气泡）');
		out('     pi-pet say "过来玩"                         （只冒泡，不改状态）');
		return 2;
	}
	return withHost(async (health, token) => {
		const body = { type };
		const rest = positional.slice(1);
		// feed say "文本"：第一个非 flag 位置参数就是气泡文字
		if (type === "say") {
			body.text = rest.filter((x) => !x.startsWith("--")).join(" ") || flags.text;
		} else {
			if (rest[0] && !rest[0].startsWith("--")) {
				if (type === "tool_call") body.tool = rest[0];
				else body.size = rest[0];
			}
		}
		for (const k of ["text", "task", "detail", "summary", "ms"]) {
			if (flags[k] !== undefined) body[k] = flags[k];
		}
		const res = await httpJson(health.port, "POST", ENDPOINTS.event, body, token);
		if (res.status !== 200) {
			out(`✗ 没发出去：${JSON.stringify(res.body || res.error)}`);
			return 1;
		}
		const bits = [type];
		if (body.tool) bits.push(`(${body.tool})`);
		if (body.text) bits.push(`「${body.text}」`);
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
	return withHost(async (health, token) => {
		const res = await httpJson(health.port, "POST", ENDPOINTS.control, { action: "say", text, ms: Number(flags.ms) || 0 }, token);
		if (res.status !== 200) {
			out(`✗ ${(res.body && res.body.error) || res.error || res.status}`);
			return 1;
		}
		out(`✓ ${res.body.detail || "已发送"}`);
		return 0;
	});
}

async function cmdAdd(positional) {
	const size = positional[0] && SIZES.includes(positional[0]) ? positional[0] : "normal";
	return withHost(async (health, token) => {
		const res = await httpJson(health.port, "POST", ENDPOINTS.control, { action: "add-pet", size }, token);
		if (res.status !== 200) {
			out(`✗ ${(res.body && res.body.error) || res.error || res.status}`);
			return 1;
		}
		out(`✓ ${res.body.detail}`);
		return 0;
	});
}

async function cmdRestart(flags) {
	return withHost(async (health, token) => {
		const res = await httpJson(health.port, "POST", ENDPOINTS.control, { action: "restart-window", size: flags.size }, token);
		if (res.status !== 200) {
			out(`✗ ${(res.body && res.body.error) || res.error || res.status}`);
			return 1;
		}
		out(`✓ ${res.body.detail}（size=${flags.size || readCtrl().size || "normal"}）`);
		return 0;
	});
}

function cmdPort() {
	const found = findRunning();
	if (!found || !found.state.port) {
		out("");
		return 1;
	}
	out(String(found.state.port));
	return 0;
}

function cmdToken() {
	const t = readToken();
	if (!t) {
		out("还没有 token（宿主没起过）：pi-pet start");
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
	ok("包根目录", PKG_ROOT, fs.existsSync(PKG_ROOT));
	const assets = path.join(PKG_ROOT, "pi", "assets");
	ok("窗脚本", path.join(assets, "pet-electron.cjs"), fs.existsSync(path.join(assets, "pet-electron.cjs")));
	ok("素材目录", path.join(PKG_ROOT, "assets", "thumb"), fs.existsSync(path.join(PKG_ROOT, "assets", "thumb")));
	ok("配置", path.join(PKG_ROOT, "assets", "config.jsonc"), fs.existsSync(path.join(PKG_ROOT, "assets", "config.jsonc")));
	try {
		require.resolve("ws");
		ok("ws 依赖", "可解析", true);
	} catch (err) {
		ok("ws 依赖", `不可解析（${err.message}）—— 在包目录里 npm install`, false);
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
	const { flags, positional } = parseArgs(argv);
	const cmd = positional.shift() || "start";

	if (flags.help) {
		out(HELP);
		return 0;
	}
	if (flags.version) {
		out(VERSION);
		return 0;
	}

	switch (cmd) {
		case "start":
			return cmdStart(flags);
		case "serve":
			flags.noWindow = true;
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

module.exports = { main, parseArgs, probeHealth, httpJson };
