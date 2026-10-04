/**
 * server.cjs — HTTP 静态资源 + 控制面
 *
 * 两条完全不同的用途共用一个 127.0.0.1 端口：
 *
 *   ① 喂窗：GET / /pet.js /pet.css /config.jsonc /thumb/*.webm
 *      —— 透明窗里加载的就是它。走 http:// 而不是 file:// 是刻意的：
 *      素材路径、fetch(/config.jsonc)、WebSocket 相对地址全都按同源来写。
 *   ② 喂人：GET /health /state，POST /event /control
 *      —— 「暴露端口被 pi 和 dsh 调用」说的就是这一面。
 *
 * 鉴权：②里除了 /health（探活用，必须免鉴权）都要 token。
 *      ①完全免鉴权 —— pet.js 在 Electron 渲染进程里发不了自定义请求头，
 *      而它能做的最多是收到动画事件，构不成命令。
 */

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { ENDPOINTS, ROLE, VERSION, SIZES, MAX_PETS_CEILING } = require("./protocol.cjs");
const { ASSETS_DIR, CONFIG_JSONC, THUMB_DIR, log } = require("./paths.cjs");
/** 打包身份（git sha / 素材数）。源码目录跑时这个文件也在（npm run build 会先生成）。 */
let BUILD = {};
try {
	// 每次宿主启动都核一遍当前 HEAD：拉了新提交却还报旧 sha，比不报更坏
	BUILD = require("./stamp.cjs").current({ persist: true });
} catch {
	/* 没 stamp 就不报这个字段，不影响功能 */
}
const { tokenMatches } = require("./single.cjs");
const { attachWebSocket } = require("./wsserver.cjs");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".webm": "video/webm",
	".json": "application/json; charset=utf-8",
	".jsonc": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
};

/** 素材目录的硬编码表：只暴露这些，不做通配静态服务。 */
const STATIC_FILES = {
	"/pet.js": () => path.join(ASSETS_DIR, "pet.js"),
	"/pet.css": () => path.join(ASSETS_DIR, "pet.css"),
	"/pet.html": () => path.join(ASSETS_DIR, "pet.html"),
	"/config.jsonc": () => CONFIG_JSONC,
	"/config": () => CONFIG_JSONC,
};

/** 防目录穿越：拼完必须仍在 root 之内。 */
function safeAsset(root, rel) {
	if (!rel || rel.includes("..")) return undefined;
	const candidate = path.normalize(path.join(root, rel));
	return candidate.startsWith(root) ? candidate : undefined;
}

function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
	});
	res.end(text);
}

/**
 * 发一个文件。
 *
 * `maxAge` 分两档：代码/配置一律 no-store，素材（91 个 thumb webm）才允许缓存。
 * 之前一刀切 `public, max-age=3600`，害处有两个：
 *   1. 改完 pi/assets/pet.js 再 `pi-pet restart`，窗拿到的**还是磁盘上那份旧 JS**，
 *      缓存不失效 → 改了没反应，排查时最容易怀疑成「代码没跑到」；
 *   2. 用户升级后开着的窗也会拿旧代码跑一小时。
 * 素材是本地磁盘读，缓存省不下多少，但体积大、名字带哈希语义之外的稳定引用，保留缓存。
 */
function sendFile(res, filePath, { maxAge = 0 } = {}) {
	fs.stat(filePath, (err, st) => {
		if (err || !st.isFile()) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("not found");
			return;
		}
		res.writeHead(200, {
			"content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
			"content-length": st.size,
			"cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
		});
		fs.createReadStream(filePath).pipe(res);
	});
}

/** 读一个小的 JSON body，带上限（控制面不需要大包）。 */
function readBody(req, limit = 64 * 1024) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => resolve(null));
	});
}

/** token 从三个地方收，优先级从高到低：Authorization 头 > ?token= > X-Pet-Token。 */
function extractToken(req, url) {
	const auth = req.headers.authorization || "";
	if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
	return url.searchParams.get("token") || req.headers["x-pet-token"] || "";
}

function createServer(ctx) {
	/**
	 * ctx = {
	 *   bus, state,           状态与事件总线
	 *   token, insecure,      鉴权
	 *   ctrl(),               读当前意图（maxPets 等）
	 *   control(action, arg), 执行控制动作，返回 {ok, detail}
	 *   onWsConnection(conn, req),  WS 进来的连接交给 bus 处理
	 * }
	 */
	async function handleRequest(req, res) {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		const p = decodeURIComponent(url.pathname);

		// WS 端点走 upgrade，这里先挡一下，免得被当成静态资源 404
		if (p === ENDPOINTS.ws || p === ENDPOINTS.feed) {
			res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
			res.end("upgrade required");
			return;
		}

		/* ---------------- 免鉴权：探活与静态资源 ---------------- */

		if (p === ENDPOINTS.health) {
			const bus = ctx.bus.stats();
			sendJson(res, 200, {
				...ctx.state,
				ok: true,
				role: ROLE,
				version: VERSION,
				// 谁在问都能看到「我连的是哪个包」：跑旧 exe 而不自知的头号原因
				build: BUILD.sha ? `${BUILD.sha}${BUILD.dirty ? " (dirty)" : ""} · ${BUILD.thumbs} 段素材` : "unknown",
				heartbeatAt: Date.now(),
				...bus,
				windowConnected: bus.clients > 0,
				maxPets: Number(ctx.ctrl().maxPets) || 1,
			});
			return;
		}

		if (p === "/" || p === "/index.html") return sendFile(res, STATIC_FILES["/pet.html"]());
		if (STATIC_FILES[p]) return sendFile(res, STATIC_FILES[p]());
		if (p.startsWith("/thumb/")) {
			const file = safeAsset(THUMB_DIR, p.slice("/thumb/".length));
			if (!file) {
				res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end("bad thumb path");
				return;
			}
			return sendFile(res, file, { maxAge: 3600 });
		}

		/* ---------------- 要鉴权：控制面 ---------------- */

		const needsAuth = p === ENDPOINTS.state || p === ENDPOINTS.event || p === ENDPOINTS.control;
		if (needsAuth && !ctx.insecure && !tokenMatches(extractToken(req, url), ctx.token)) {
			// 顺手给一句人话提示，省得对方对着 401 猜
			sendJson(res, 401, {
				ok: false,
				error: "unauthorized",
				hint: "带 token：Authorization: Bearer <token> 或 ?token=<token>（token 在 " + ctx.tokenPath + "）",
			});
			return;
		}

		if (p === ENDPOINTS.state) {
			sendJson(res, 200, { ok: true, state: ctx.state, ctrl: ctx.ctrl(), bus: ctx.bus.stats() });
			return;
		}

		if (p === ENDPOINTS.event && req.method === "POST") {
			const body = await readBody(req);
			if (body === null) return sendJson(res, 400, { ok: false, error: "bad json body" });
			// 同一来源必须落在**同一个会话**上：老协议是全局单状态，REST 又没有连接概念，
			// 所以不传 source 的请求一律归到 src:http（不然每次请求都新建一个会话，
			// 上一个会话卡在 thinking，宠物会一直显示思考中）。传了 source 的按来源分开。
			const label = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "http";
			// 暂停只挡状态类，命令类照走（和 WS /feed 走同一套 ingest）
			const result = ctx.bus.ingest(
				body,
				label,
				Number(ctx.ctrl().maxPets) || 1,
				`src:${label}`,
				ctx.ctrl().paused === true,
			);
			if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason });
			return sendJson(res, 200, { ok: true, sent: result.sent, state: result.state || undefined });
		}

		if (p === ENDPOINTS.control && req.method === "POST") {
			const body = await readBody(req);
			if (body === null) return sendJson(res, 400, { ok: false, error: "bad json body" });
			const action = typeof body.action === "string" ? body.action : "";
			if (!action) return sendJson(res, 400, { ok: false, error: "action required" });
			// ⚠️ 必须 await：control 可能是 Promise（check-update 要跑 git fetch/pull，
			//    同步 spawnSync 会把宿主这个 HTTP 服务卡住几分钟）。
			const result = await ctx.control(action, body);
			return sendJson(res, result && result.ok ? 200 : 400, result);
		}

		if (p === ENDPOINTS.control && req.method === "GET") {
			// 让 GET 也能改（curl 友好）：?action=add_pet&size=small
			const result = await ctx.control(url.searchParams.get("action") || "", {
				action: url.searchParams.get("action") || "",
				size: url.searchParams.get("size") || undefined,
			});
			return sendJson(res, result && result.ok ? 200 : 400, result);
		}

		if (p === ENDPOINTS.event && req.method === "GET") {
			// 极简形态：GET /event?type=thinking  —— 粘在浏览器地址栏就能用
			const type = url.searchParams.get("type") || "";
			// ⚠️ 不带 type 的 GET 不是一条事件，是 CLI 的**能力探测**（app/main.cjs 的
			//    probeCaps：靠「回 400」判断这个宿主到底有没有事件面）。别把它喂进
			//    bus.ingest —— 那儿会打一行「丢弃无法识别的帧」，而 pi 扩展在 /feed 掉线时
			//    每 2s 探一次宿主能力，于是日志被探测刷屏（.start.log 里那片 http:GET 就是它）。
			if (!type.trim()) {
				return sendJson(res, 400, {
					ok: false,
					error: "unknown event",
					hint: "带上 type 试试：GET /event?type=thinking",
				});
			}
			const result = ctx.bus.ingest(
				{ type, tool: url.searchParams.get("tool") || "" },
				"http:GET",
				Number(ctx.ctrl().maxPets) || 1,
			);
			if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason });
			return sendJson(res, 200, { ok: true, sent: result.sent });
		}

		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("pi-pet: not found");
	}

	const server = http.createServer((req, res) => {
		handleRequest(req, res).catch((err) => {
			log(`请求处理出错：${err && err.stack ? err.stack : err}`);
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end("internal error");
		});
	});

	// WS 升级全部交给自带的 RFC6455 服务端（零依赖）。
	// /feed 要 token（它是**上行**通道，能指挥宠物）；/ws 免（见文件头）——
	// pet.js 在渲染进程里发不了自定义头，所以这两条不能同等待遇。
	const ws = attachWebSocket(server, {
		shouldAccept: (pathname, req) => {
			if (pathname !== ENDPOINTS.ws && pathname !== ENDPOINTS.feed) return 404;
			if (pathname === ENDPOINTS.feed && !ctx.insecure) {
				const url = new URL(req.url || "/", "http://127.0.0.1");
				if (!tokenMatches(extractToken(req, url), ctx.token)) return 401;
			}
			return true;
		},
		onConnection: (conn, req) => ctx.onWsConnection(conn, req),
	});

	return { server, handleRequest, ws };
}

/** 端口：优先期望值（全局共享的固定端口），被占就退一个随机空闲端口，真实端口写进状态文件。 */
function listen(server, preferredPort, attempts = 20) {
	const randomPort = () => 10240 + Math.floor(Math.random() * (49151 - 10240));
	return new Promise((resolve, reject) => {
		const tryPort = (port, left) => {
			const onError = (err) => {
				server.removeListener("error", onError);
				if (err && err.code === "EADDRINUSE" && left > 0) {
					log(`端口 ${port} 被占 → 换一个`);
					tryPort(randomPort(), left - 1);
					return;
				}
				reject(err);
			};
			server.once("error", onError);
			server.listen(port, "127.0.0.1", () => {
				server.removeListener("error", onError);
				resolve(server.address().port);
			});
		};
		tryPort(preferredPort || randomPort(), attempts);
	});
}

module.exports = { createServer, listen, safeAsset, sendJson, MIME, SIZES, MAX_PETS_CEILING };
