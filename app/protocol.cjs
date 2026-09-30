/**
 * protocol.cjs — 协议唯一真源
 *
 * 这个文件是「谁对谁说话」的字典：宿主、pi 扩展、dsh 插件、curl、文档都从这里抄，
 * 不要在任何别处硬编码消息字符串。
 *
 * ── 拓扑（独立化后的方向，与旧版相反）────────────────────────────
 *   旧：pi 进程 = 服务端  ←→  Electron 窗（客户端）   ← 窗的命绑在 pi 上
 *   新：pi-dsh-pet 进程 = 服务端 + 窗宿主
 *         ├── WS /ws     ← Electron 窗（只负责渲染；pet.js 不用改）
 *         ├── WS /feed   ← pi 扩展 / dsh 插件（事件生产者）
 *         └── REST       ← curl / 任意脚本
 *
 * ── 消息格式（v1：裸字符串，**不要自创**）─────────────────────────
 *   下行 → 窗： "agent_start" | "thinking" | "agent_idle"
 *               {"type":"tool_call","tool":"bash"}
 *               "add_pet" | "add_pet:<size>" | "shutdown"
 *   上行 ← 生产者：同上（宿主只做闸门与节流，不改内容）
 *
 *   裸字符串是 `pi/assets/pet.js` 的现状（EVENT_ANIM_MAP / onmessage），
 *   改格式 = 破坏所有已装版本的窗。这里只做**校验与透传**，不做富化。
 *
 * ── v1.1 增量（向后兼容：老窗收到会直接忽略）────────────────────
 *   下行 → 窗： {"type":"bubble","text":"「登录修复」思考中…","sticky":true,"ms":0}
 *               气泡文字。sticky=true = 状态还在，持续续期（不会被计时器收掉）。
 *   上行 ← 生产者（可带文字，缺了也有默认文案）：
 *               {"type":"thinking","task":"登录修复"}
 *               {"type":"tool_call","tool":"bash","detail":"npm test","task":"登录修复"}
 *               {"type":"done","summary":"改完 3 个文件"}     → 动画回到空闲 + 完成气泡
 *               {"type":"say","text":"过来玩","ms":6000}    → 只冒泡，不改状态
 *   关键点：**动画帧仍然是 v1 裸字符串**，文字走**另起一帧 bubble**。
 *   这样老版本窗（不认识 bubble）照常动，新窗多一个气泡，两边都能用同一个宿主。
 *
 * ── 未来 v2（envelope）─────────────────────────────────────────
 *   若要带 source/session/ts，正确做法是 pet.js 的 onmessage 先 JSON.parse，
 *   认不出对象再退回按裸字符串处理（向后兼容），而不是让服务端单方面改格式。
 *   v2 的形状已在此备好：`envelope()`，但默认**不发**。
 */

"use strict";

/** 协议版本。宿主状态文件与 /health 都会报它，客户端据此判断兼容性。 */
const VERSION = 1;

/** 角色名：客户端探 /health 时**必须**核这个，否则会把同端口的别的进程误当宿主。 */
const ROLE = "pi-pet-host";

const ENDPOINTS = {
	/** 窗的 WS：只收不发。**故意不鉴权**——pet.js 在 Electron 里发不了自定义头，
	 *  而连上来最多只能收到动画事件，构不成命令。（能发命令的是 /feed 与 REST，那些要 token。） */
	ws: "/ws",
	/** 生产者的 WS：pi 扩展 / dsh 插件连这里喂事件。需要 token。 */
	feed: "/feed",
	health: "/health",
	state: "/state",
	event: "/event",
	control: "/control",
};

/** 窗侧认识的无参事件（裸字符串）。tool_call 是唯一带 JSON 的。 */
const EVENTS = {
	/** agent 开始一轮思考 */
	agentStart: "agent_start",
	/** 思考中（节流后反复发，让宠物持续「碎碎念」；宿主会自己去重） */
	thinking: "thinking",
	/** agent 空闲，回到随机动画链 */
	agentIdle: "agent_idle",
	/** 加一只宠物（size 可选：small/normal/large） */
	addPet: "add_pet",
	/** 通知窗自己关掉（宿主退出前发） */
	shutdown: "shutdown",
	/** 带 JSON 的工具调用 */
	toolCall: "tool_call",
	/** 一轮做完（v1.1：动画同 agent_idle，额外带完成文案） */
	done: "done",
	/** 只冒泡、不改状态（v1.1；手动输入也走这个） */
	say: "say",
	/** 下行给窗的气泡帧（v1.1） */
	bubble: "bubble",
};

/** 窗侧的尺寸档位，与 pet.js 的 SIZE_MAP 对齐。 */
const SIZES = ["small", "normal", "large"];

/** maxPets 的天花板：再多每只都要一个渲染进程，没意义。 */
const MAX_PETS_CEILING = 8;

/** 工具名 → 动画名由**窗侧**（pet.js TOOL_ANIM_MAP）决定，宿主不关心、不校验。 */

/** `add_pet` / `add_pet:<size>` —— 机器级单只闸门要认得的前缀。 */
function isAddPet(msg) {
	return typeof msg === "string" && (msg === EVENTS.addPet || msg.startsWith(EVENTS.addPet + ":"));
}

/** 判断一个裸字符串是不是协议内的已知事件（用于日志与 /health 统计，不用于拦截）。 */
function isKnownEvent(msg) {
	if (typeof msg !== "string" || msg === "") return false;
	if (msg === EVENTS.agentStart || msg === EVENTS.thinking || msg === EVENTS.agentIdle) return true;
	if (msg === EVENTS.shutdown || isAddPet(msg)) return true;
	if (msg === EVENTS.addPet) return true;
	try {
		const obj = JSON.parse(msg);
		return !!obj && typeof obj === "object" && obj.type === EVENTS.toolCall && typeof obj.tool === "string";
	} catch {
		return false;
	}
}

/**
 * 归一化上行消息：允许两种入参
 *   1) 裸字符串 `"thinking"` —— v1 客户端的原生格式，直接透传；
 *   2) 对象 `{ type: "tool_call", tool: "bash" }` / `{ type: "thinking" }` —— REST 友好。
 * 返回**窗侧认识的线格式**字符串；无法识别返回 null（调用方应记一笔并丢弃，不要瞎转）。
 */
function normalizeIncoming(raw) {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "string") {
		const msg = raw.trim();
		return msg === "" ? null : msg;
	}
	if (typeof raw !== "object") return null;

	const type = typeof raw.type === "string" ? raw.type.trim() : "";
	if (type === "") return null;

	if (type === EVENTS.toolCall) {
		const tool = typeof raw.tool === "string" ? raw.tool : "";
		return tool === "" ? null : JSON.stringify({ type: EVENTS.toolCall, tool });
	}
	if (type === EVENTS.addPet) {
		const size = typeof raw.size === "string" && SIZES.includes(raw.size) ? raw.size : "";
		return size ? `${EVENTS.addPet}:${size}` : EVENTS.addPet;
	}
	// 其余按已知事件名透传（不认识的事件名一律拒掉，避免往窗里灌垃圾）
	if (type === EVENTS.agentStart || type === EVENTS.thinking || type === EVENTS.agentIdle || type === EVENTS.shutdown) {
		return type;
	}
	return null;
}

/** v2 预留：把一条已归一化的消息包成 envelope。**默认不发**，见文件头说明。 */
function envelope(msg, source) {
	let parsed = { type: msg };
	if (typeof msg === "string" && msg.startsWith("{")) {
		try {
			parsed = JSON.parse(msg);
		} catch {
			/* 不是 JSON 就当裸事件 */
		}
	}
	return { v: VERSION, type: parsed.type, tool: parsed.tool, source: source || null, ts: Date.now() };
}

/* ============================== v1.1：带文字的事件 ============================== */

/** 截断：气泡一行最多这么多字符，超了加省略号（免得长 prompt 把气泡撑爆）。 */
const TEXT_MAX = 42;

function clampText(text, max = TEXT_MAX) {
	const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
	if (!s) return "";
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const str = (v) => (typeof v === "string" ? v : "");

/**
 * 把生产者发来的东西解析成「宿主内部事件」。
 * 返回 { type, tool, task, detail, summary, text, ms } 或 null（不认识）。
 * 字符串入参走 v1 路径：裸事件名 / v1 的 tool_call JSON。
 */
function parseIncoming(raw) {
	// 裸字符串
	if (typeof raw === "string") {
		const s = raw.trim();
		if (!s) return null;
		if (s === EVENTS.agentStart || s === EVENTS.thinking) return { type: EVENTS.thinking };
		if (s === EVENTS.agentIdle) return { type: EVENTS.agentIdle };
		if (s === EVENTS.shutdown) return { type: EVENTS.shutdown };
		if (s === EVENTS.addPet || s.startsWith(EVENTS.addPet + ":")) {
			return { type: EVENTS.addPet, size: s.slice(EVENTS.addPet.length + 1) || "" };
		}
		if (s.startsWith("{")) {
			try {
				return parseIncoming(JSON.parse(s));
			} catch {
				return null;
			}
		}
		return null;
	}
	if (!raw || typeof raw !== "object") return null;

	const type = str(raw.type);
	switch (type) {
		case EVENTS.agentStart:
		case EVENTS.thinking:
			return { type: EVENTS.thinking, task: clampText(raw.task || raw.text) };
		case EVENTS.toolCall:
			return {
				type: EVENTS.toolCall,
				tool: str(raw.tool),
				detail: clampText(raw.detail),
				task: clampText(raw.task),
			};
		case EVENTS.done:
			return { type: EVENTS.done, summary: clampText(raw.summary || raw.text) };
		case EVENTS.agentIdle:
			return { type: EVENTS.agentIdle, summary: clampText(raw.summary) };
		case EVENTS.say:
			return { type: EVENTS.say, text: clampText(raw.text, 80), ms: Number(raw.ms) || 0 };
		case EVENTS.addPet:
			return { type: EVENTS.addPet, size: str(raw.size) };
		case EVENTS.shutdown:
			return { type: EVENTS.shutdown };
		default:
			return null;
	}
}

/** 拼一个气泡帧（下行 → 窗）。`sticky` = 状态还在，宿主会持续续期。 */
function bubbleFrame(text, { sticky = false, ms = 0 } = {}) {
	return JSON.stringify({ type: EVENTS.bubble, text: clampText(text, 80), sticky, ms: ms > 0 ? ms : 0 });
}

module.exports = {
	VERSION,
	ROLE,
	ENDPOINTS,
	EVENTS,
	SIZES,
	MAX_PETS_CEILING,
	TEXT_MAX,
	isAddPet,
	isKnownEvent,
	normalizeIncoming,
	envelope,
	parseIncoming,
	bubbleFrame,
	clampText,
};
