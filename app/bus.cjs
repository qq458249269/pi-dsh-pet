/**
 * bus.cjs — 事件汇聚 + **状态机**（WS /ws + WS /feed）
 *
 * 三条通道，一个方向：
 *
 *   pi 扩展 ┐
 *   dsh 插件 ┼─ WS /feed ─▶ [ 本模块 ] ─ WS /ws ─▶ Electron 窗（pet.js）
 *   curl     ┘             （状态机/闸门）           （只渲染，不发命令）
 *
 * ── 为什么中间要有这一层 ──────────────────────────────────────
 *   1. **机器级单只闸门**：`add_pet*` 会让窗里再加一只。放在窗那侧拦不住（窗是唯一
 *      消费者），放在某个 pi 进程里也拦不住别的进程 —— 必须在这层。
 *   2. **状态动画维持（不重复播放）**：见下面「状态机」一节，这是本模块的主要职责。
 *   3. **多会话汇聚**：一只宠物跟所有会话动，而窗只认一个端口。
 *
 * ── 状态机：为什么不能「收到就转发」──────────────────────────
 *   上游 pi 扩展为了表示「持续思考中」，每 2s 重发一次 `thinking`；而窗侧
 *   `playOverride()` 每次收到消息都会 `switchTo()` **重新起播**。于是老行为是
 *   「深度思考碎碎念」每 2 秒从头播一次，看起来像卡住抽搐。
 *
 *   修法在服务端（**不改 pet.js**，那是协议红线）：
 *     · 每个生产者（source）各有一份状态：idle / thinking / coding(工具组)
 *     · 窗的当前状态 = 所有会话里「最近活跃的那个忙碌会话」；全 idle → idle
 *     · 只有**状态真的变了**才广播。同一个 thinking 反复来 = 不动（窗里那圈
 *       动画自己在循环，pet.js 的 override 是 loop 的，不需要靠重播维持）
 *     · 会话崩在忙碌态（pi 被 taskkill）→ STALE_BUSY_MS 后自动回落 idle
 *     · 窗重连时立刻补发当前状态（不必等下一个事件才动起来）
 *
 *   这同时解决多会话：A 会话结束、B 还在写代码 → 宠物继续写代码，而不是跟着 A 变待机。
 */

"use strict";

const { ENDPOINTS, EVENTS, SIZES, parseIncoming, bubbleFrame } = require("./protocol.cjs");
const { log } = require("./paths.cjs");

/** 一个「agent 正在忙」的最长持续时间：超过就当会话卡住，强制放回空闲动画。 */
const STALE_BUSY_MS = Number(process.env.PI_PET_BUSY_TTL_MS || 120_000);

/** 忙碌期间多久发一次气泡续期帧（只发气泡，不碰动画 → 不会重播）。 */
const BUBBLE_REFRESH_MS = 10_000;

/** 手动 `say` 默认停留多久。 */
const SAY_DEFAULT_MS = 6000;

/** 「完成：…」文案在空闲后还留多久。 */
const DONE_TEXT_MS = 30_000;

/* ============================== 气泡文案 ============================== */

/**
 * 把状态翻成人话。生产者可以带 task/detail/summary，不带就只说状态。
 *   thinking → 「登录修复」思考中…   /  思考中…
 *   coding   → 执行中：npm test        /  执行中：bash
 *   done     → 完成：改完 3 个文件      /  执行完成 ✓
 *   idle     → 待命中…
 */
function stateText(state, { task = "", tool = "", detail = "", summary = "" } = {}) {
	switch (state) {
		case STATE.THINKING:
			return task ? `「${task}」思考中…` : "思考中…";
		case STATE.CODING:
			return `执行中：${detail || tool || "…"}`;
		case "done":
			return summary ? `完成：${summary}` : "执行完成 ✓";
		default:
			return summary || "待命中…";
	}
}

/**
 * 工具 → 状态分组。只用于**去重**（判断「是不是同一个动画」），动画名由窗侧
 * pet.js 的 TOOL_ANIM_MAP 决定，宿主不重复那份映射。分组与 pet.js 保持一致：
 *   写代码组：bash / read / edit / write / code
 *   搜寻组  ：grep / find / fd / glob
 *   其余    ：各自成一组（换工具 = 换状态 = 允许重播）
 */
const TOOL_GROUP = {
	bash: "code",
	code: "code",
	read: "code",
	edit: "code",
	write: "code",
	grep: "search",
	find: "search",
	fd: "search",
	glob: "search",
};

const STATE = {
	IDLE: "idle",
	THINKING: "thinking",
	CODING: "coding",
};

/** 某个会话当前状态的「去重键」：同键 = 同一个动画 = 不重播。 */
function stateKey(st) {
	if (!st || st.state === STATE.IDLE) return STATE.IDLE;
	if (st.state === STATE.THINKING) return STATE.THINKING;
	return `${STATE.CODING}:${st.group || "other"}`;
}

function createBus(hooks = {}) {
	/** 窗的 WS 客户端（正常只有 1 个：那只宠物）。 */
	const windowClients = new Set();
	/** 生产者 WS：ws → { id, source }。 */
	const feedSockets = new Map();
	/** 每个来源的当前状态：id → { id, source, state, group, tool, at, transport } */
	const sessions = new Map();

	/** 窗当前被驱动的状态键（null = 还没发过任何状态）。 */
	let currentKey = null;
	/** 窗当前状态的线格式消息（重连时原样补发）。 */
	let currentMessage = null;
	/** 窗当前气泡文案（重连时补发）。 */
	let currentBubble = null;
	let lastBubbleAt = 0;
	/** 最近一次「完成」：done 事件带回来的文案，空闲后短时间内还显示它。 */
	let lastDone = null;
	let port = 0;
	let seq = 0;

	/* ============================== 广播 ============================== */

	function broadcast(msg) {
		let sent = 0;
		for (const ws of windowClients) {
			try {
				if (ws.readyState === 1) {
					ws.send(msg);
					sent++;
				}
			} catch {
				/* 单个客户端坏了不影响别人 */
			}
		}
		return sent;
	}

	/**
	 * 机器级单只的最后一道闸：`add_pet*` 会让**窗里**再加一只。
	 * 任何生产者（包括老版 pi 扩展手敲 `/pet` 冒出来的那条路）都得先过这里。
	 */
	function canAddPet(maxPets) {
		return Number.isInteger(maxPets) && maxPets > 1;
	}

	/* ============================== 状态机 ============================== */

	function touch(id, patch) {
		const prev = sessions.get(id) || { id, source: id, state: STATE.IDLE, group: null, tool: null, at: 0, transport: "ws" };
		const next = { ...prev, ...patch, at: Date.now() };
		sessions.set(id, next);
		return next;
	}

	function dropSession(id) {
		const st = sessions.get(id);
		sessions.delete(id);
		if (st && st.state !== STATE.IDLE) log(`会话 ${st.source} 离开（还在忙碌）→ 重算窗状态`);
		return st;
	}

	/**
	 * 算出窗此刻该处于什么状态：**最近活跃的忙碌会话**说了算；一个都没有 = idle。
	 * 只有一个会话时这就是它自己；多会话时相当于「谁最后动谁说话，但没人动就待机」。
	 */
	function resolveTarget() {
		let best = null;
		for (const st of sessions.values()) {
			if (st.state === STATE.IDLE) continue;
			if (!best || st.at > best.at) best = st;
		}
		if (!best) {
			// 刚做完一轮：短时间内还留「完成：…」而不是立刻跳回「待命中…」
			const fresh = lastDone && Date.now() - lastDone.at < DONE_TEXT_MS ? lastDone.summary : "";
			return {
				key: STATE.IDLE,
				message: EVENTS.agentIdle,
				text: stateText(fresh ? "done" : STATE.IDLE, { summary: fresh }),
				session: null,
			};
		}
		if (best.state === STATE.THINKING) {
			return {
				key: STATE.THINKING,
				message: EVENTS.thinking,
				text: stateText(STATE.THINKING, best),
				session: best,
			};
		}
		return {
			key: `${STATE.CODING}:${best.group || "other"}`,
			message: JSON.stringify({ type: EVENTS.toolCall, tool: best.tool }),
			text: stateText(STATE.CODING, best),
			session: best,
		};
	}

	/**
	 * 推进状态机。返回 true = 状态变了、已广播；false = 重复状态，静默丢弃。
	 * 重复的 `thinking`（上游每 2s 一发）就走这里被吃掉，动画在窗里自己循环。
	 *
	 * 每次真变化发**两帧**：先 v1 裸字符串（老窗认这个），再 bubble 帧（新窗认这个）。
	 * 两帧分开是兼容性要求，不是偷懒。
	 */
	function drive() {
		const target = resolveTarget();
		// 同状态但文案变了（比如任务名从“修复登录”变成“修复登录+注册”）也算变化
		if (target.key === currentKey && target.text === currentBubble) return false;
		const animChanged = target.key !== currentKey;
		currentKey = target.key;
		currentMessage = target.message;
		currentBubble = target.text;
		lastBubbleAt = Date.now();
		if (animChanged) {
			seq++;
			broadcast(target.message);
		}
		broadcast(bubbleFrame(target.text, { sticky: target.key !== STATE.IDLE }));
		if (animChanged) {
			log(
				`状态 → ${target.key}` +
					(target.session ? `（来自 ${target.session.source}）` : "（都空闲了）") +
					` seq=${seq} 窗客户端 ${windowClients.size}`,
			);
		} else {
			log(`只更新气泡文案 → ${target.text}`);
		}
		return true;
	}

	/**
	 * 忙的时候定期发气泡续期（sticky）。为什么需要：宿主去重之后，状态不变时**不再发帧**，
	 * 而窗侧气泡是带计时的 → 不续期的话，“思考中…”会在 10s 后凭空消失。续期帧只带
	 * 文字，窗侧把它当成“把计时器按回去”，不碰动画 → 也不会造成重播。
	 */
	function refreshBubbles() {
		if (!currentBubble || currentKey === STATE.IDLE) return false;
		if (Date.now() - lastBubbleAt < BUBBLE_REFRESH_MS) return false;
		lastBubbleAt = Date.now();
		return broadcast(bubbleFrame(currentBubble, { sticky: true })) > 0;
	}

	/** 手动说话：只冒泡，不改状态（右键菜单 / pi-pet say / POST /event {"type":"say"}）。 */
	function say(text, ms = SAY_DEFAULT_MS) {
		const t = String(text == null ? "" : text).trim();
		if (!t) return { ok: false, error: "空文本" };
		const sent = broadcast(bubbleFrame(t, { sticky: false, ms: ms > 0 ? ms : SAY_DEFAULT_MS }));
		log(`手动气泡：「${t}」（${sent} 个窗）`);
		return { ok: true, detail: `已说：${t}`, sent };
	}

	/** 生产者上行。`sourceId` 用来把同一个人的多条连接归到一个会话状态里。 */
	function ingest(raw, source = "unknown", maxPets = 1, sourceId = null, paused = false) {
		const ev = parseIncoming(raw);
		if (!ev) {
			log(`丢弃无法识别的帧（来源 ${source}）：${String(raw).slice(0, 80)}`);
			return { ok: false, reason: "unrecognized" };
		}
		const wire = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
		if (ev.type === EVENTS.addPet && !(Number.isInteger(maxPets) && maxPets > 1)) {
			log(`拦下 add_pet（maxPets=${maxPets}）`);
			return { ok: false, reason: "max-pets" };
		}
		// 命令类（shutdown / add_pet）不参与状态机，原样转发
		if (ev.type === EVENTS.shutdown || ev.type === EVENTS.addPet) {
			const sent = broadcast(ev.size && SIZES.includes(ev.size) ? `${EVENTS.addPet}:${ev.size}` : wire);
			return { ok: true, sent, stateOnly: false };
		}

		// 手动说话：只冒泡，不碰状态机
		if (ev.type === EVENTS.say) return say(ev.text, ev.ms);

		// 状态类事件：进状态机，由它决定要不要重播
		// 暂停（右键菜单里的「暂停响应」）时状态类一律不入状态机 —— 宠物继续自己玩，
		// 但不再跟着 agent 状态变。命令类（shutdown/add_pet）不受影响。
		const id = sourceId || `src:${source}`;
		if (paused) {
			log(`已暂停响应，丢弃状态事件 ${ev.type}（来源 ${source}）`);
			return { ok: true, sent: 0, stateOnly: true, changed: false, paused: true };
		}
		if (ev.type === EVENTS.agentIdle || ev.type === EVENTS.done) {
			// done 携带完成文案；普通 idle 不携带
			touch(id, { state: STATE.IDLE, group: null, tool: null, source, summary: ev.summary || "" });
		} else if (ev.type === EVENTS.thinking) {
			touch(id, { state: STATE.THINKING, group: null, tool: null, source, task: ev.task || "", summary: "" });
		} else {
			touch(id, {
				state: STATE.CODING,
				group: TOOL_GROUP[ev.tool] || "other",
				tool: ev.tool || "",
				detail: ev.detail || "",
				source,
				summary: "",
			});
		}

		// done 不走 idle 那个默认文案，而是「完成：…」
		if (ev.type === EVENTS.done) lastDone = { summary: ev.summary || "", at: Date.now() };
		else if (ev.type === EVENTS.thinking) lastDone = null;
		const changed = drive();
		return { ok: true, sent: changed ? windowClients.size : 0, stateOnly: true, changed, state: currentKey };
	}

	/** 会话卡死 / 进程被硬杀：超过 TTL 没动静就当它不存在，重算窗状态。 */
	function reapStaleSessions() {
		const now = Date.now();
		let reaped = 0;
		for (const [id, st] of [...sessions]) {
			if (st.state !== STATE.IDLE && now - st.at > STALE_BUSY_MS) {
				log(`会话 ${st.source} 忙碌超时（${Math.round((now - st.at) / 1000)}s 没动静，可能被硬杀了）→ 丢弃`);
				sessions.delete(id);
				reaped++;
			}
		}
		if (reaped > 0) drive();
		return reaped;
	}

	/* ============================== WS 接入 ============================== */

	/**
	 * 处理一条 WS 连接（由 app/wsserver.cjs 送来）。
	 * /ws    = 窗（只听，不发；免鉴权）
	 * /feed  = 生产者（pi 扩展 / dsh 插件 / 脚本；要 token）
	 *
	 * hooks 是**活的对象**：宿主会先把 bus 建起来，再把 onStateChange/maxPets/paused
	 * 填进去（它们彼此有依赖，见 host.cjs）。所以每次都现读，不能在 createBus 时抓死。
	 */
	function handleConnection(conn, req) {
		{
			const onStateChange = hooks.onStateChange || (() => {});
			const maxPets = hooks.maxPets || (() => 1);
			const paused = hooks.paused || (() => false);
			const url = new URL(conn.url || (req && req.url) || "/", "http://127.0.0.1");
			const p = url.pathname;
			const source = url.searchParams.get("source") || "unknown";

			if (p === ENDPOINTS.ws) {
				windowClients.add(conn);
				log(`窗接上了（当前 ${windowClients.size} 个客户端）`);
				// 补发当前状态与气泡：窗重连（换窗 / 崩了重开）后立刻就是对的
				if (currentMessage) {
					conn.send(currentMessage);
					if (currentBubble) conn.send(bubbleFrame(currentBubble, { sticky: currentKey !== STATE.IDLE }));
				}
				conn.on("close", () => {
					windowClients.delete(conn);
					log(`窗断开（剩 ${windowClients.size} 个）`);
					onStateChange();
				});
				onStateChange();
				return;
			}

			if (p === ENDPOINTS.feed) {
				// 同一来源可以有多条连接（多会话同标签），状态按 source 归一
				const id = `ws:${source}`;
				feedSockets.set(conn, { id, source });
				if (!sessions.has(id)) touch(id, { state: STATE.IDLE, source });
				log(`会话接入事件汇聚（当前 ${feedSockets.size} 个连接，来源 ${source}）`);
				conn.on("message", (data, isBinary) => {
					if (isBinary) return;
					try {
						ingest(String(data), source, maxPets(), id, paused());
					} catch (err) {
						log(`转发出错：${err.message}`);
					}
				});
				conn.on("close", () => {
					feedSockets.delete(conn);
					// 这条来源的**所有**连接都没了才清掉它的状态（多连接时别把别人踢下线）
					const stillHere = [...feedSockets.values()].some((s) => s.id === id);
					if (!stillHere) {
						dropSession(id);
						drive();
					}
					log(`会话离开（剩 ${feedSockets.size} 个连接）`);
					onStateChange();
				});
				onStateChange();
				return;
			}
		}
	}

	function stats() {
		const bySource = {};
		for (const s of feedSockets.values()) bySource[s.source] = (bySource[s.source] || 0) + 1;
		const busySessions = [...sessions.values()].filter((s) => s.state !== STATE.IDLE);
		return {
			clients: windowClients.size,
			feeds: feedSockets.size,
			feedsBySource: bySource,
			state: currentKey || STATE.IDLE,
			stateSeq: seq,
			bubble: currentBubble,
			busySessions: busySessions.map((s) => ({ source: s.source, state: s.state, tool: s.tool, ms: Date.now() - s.at })),
		};
	}

	return {
		setPort: (p) => {
			port = p;
		},
		getPort: () => port,
		windowClients,
		feedSockets,
		sessions,
		broadcast,
		ingest,
		say,
		refreshBubbles,
		drive,
		handleConnection,
		stats,
		reapStaleSessions,
		getStateKey: () => currentKey,
		reset: () => {
			sessions.clear();
			feedSockets.clear();
			currentKey = null;
			currentMessage = null;
			currentBubble = null;
			lastDone = null;
		},
	};
}

module.exports = { createBus, STALE_BUSY_MS, BUBBLE_REFRESH_MS, SAY_DEFAULT_MS, DONE_TEXT_MS, TOOL_GROUP, STATE, stateText };
