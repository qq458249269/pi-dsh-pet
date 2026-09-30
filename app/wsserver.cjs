/**
 * wsserver.cjs — 极简 WebSocket 服务端（RFC 6455 子集，零依赖）
 *
 * 为什么要自己写：这是个**独立应用**，交付形态是一个 exe / `npm i -g`。
 * 带一个原生依赖（ws → 依赖链里有 bufferutil/utf-8-validate 编译件）会让打包和
 * 跨机器复现都变脆。这里只实现本项目真正需要的那部分：
 *
 *   ✓ 握手（Sec-WebSocket-Accept = base64(sha1(key + GUID))）
 *   ✓ 收：文本帧、二进制帧、分片续帧、ping/pong、close
 *   ✓ 发：文本帧（服务端不掩码）、pong、close
 *   ✓ 心跳：30s 一次 ping，pong 或任何数据都算活着
 *   ✗ permessage-deflate（我们只发很小的帧，压缩没意义）
 *   ✗ 掩码校验以外的严格协议合规（客户端都是自己人）
 *
 * 帧格式回顾：
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *   +-+-+-+-+-------+-+-------------+-------------------------------+
 *   |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
 *   |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
 *   |N|V|V|V|       |S|             |   (if payload len==126/127)   |
 *   | |1|2|3|       |K|             |                               |
 *   +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
 */

"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

/** RFC 6455 固定 GUID */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** 单帧上限：防止有人往 /feed 里灌 100MB */
const MAX_FRAME = 1 << 20;
/** 心跳间隔 */
const PING_MS = 30_000;

const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" };

/**
 * 一个 WebSocket 连接。
 * 事件：message(text, isBinary) | close(code) | error(err) | pong()
 */
class WsConnection extends EventEmitter {
	constructor(socket, request) {
		super();
		this.socket = socket;
		this.request = request;
		this.readyState = 1; // OPEN
		this.url = request.url || "/";
		this.isAlive = true;
		this._buf = Buffer.alloc(0);
		this._fragments = [];
		this._fragmentOp = 0;

		socket.on("data", (chunk) => this._onData(chunk));
		socket.on("close", () => this._finish(1006));
		socket.on("error", (err) => {
			this.emit("error", err);
			this._finish(1006);
		});
		socket.setNoDelay(true);
	}

	get remoteAddress() {
		return this.socket.remoteAddress;
	}

	/** 发文本（服务端 → 客户端不掩码） */
	send(text) {
		if (this.readyState !== 1) return false;
		return this._write(0x1, Buffer.from(String(text), "utf8"));
	}

	sendJSON(obj) {
		return this.send(JSON.stringify(obj));
	}

	ping() {
		if (this.readyState !== 1) return false;
		return this._write(0x9, Buffer.alloc(0));
	}

	close(code = 1000, reason = "") {
		if (this.readyState !== 1) return;
		const body = Buffer.alloc(2 + Buffer.byteLength(reason));
		body.writeUInt16BE(code, 0);
		body.write(reason, 2, "utf8");
		this._write(0x8, body);
		this.readyState = 3; // CLOSING
		// 给对端一点时间看到 close 帧，然后硬断
		setTimeout(() => {
			try {
				this.socket.destroy();
			} catch {
				/* ignore */
			}
		}, 50);
	}

	_finish(code) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit("close", code);
		this.removeAllListeners("data");
	}

	_write(opcode, payload) {
		const len = payload.length;
		let header;
		if (len < 126) {
			header = Buffer.alloc(2);
			header[1] = len;
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[1] = 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		header[0] = 0x80 | opcode; // FIN + opcode
		try {
			this.socket.write(Buffer.concat([header, payload]));
			return true;
		} catch {
			return false;
		}
	}

	_onData(chunk) {
		this.isAlive = true;
		this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
		// 一次 data 里可能有多帧
		for (;;) {
			const frame = this._readFrame();
			if (!frame) return;
			this._handleFrame(frame);
			if (this.readyState !== 1) return;
		}
	}

	/** 从缓冲区里切出一帧；不够就返回 null 等下一段 */
	_readFrame() {
		const b = this._buf;
		if (b.length < 2) return null;
		const fin = (b[0] & 0x80) !== 0;
		const opcode = b[0] & 0x0f;
		const masked = (b[1] & 0x80) !== 0;
		let len = b[1] & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (b.length < offset + 2) return null;
			len = b.readUInt16BE(offset);
			offset += 2;
		} else if (len === 127) {
			if (b.length < offset + 8) return null;
			const big = b.readBigUInt64BE(offset);
			if (big > BigInt(MAX_FRAME)) {
				this.close(1009, "too big");
				return null;
			}
			len = Number(big);
			offset += 8;
		}
		if (len > MAX_FRAME) {
			this.close(1009, "too big");
			return null;
		}
		let mask = null;
		if (masked) {
			if (b.length < offset + 4) return null;
			mask = b.subarray(offset, offset + 4);
			offset += 4;
		}
		if (b.length < offset + len) return null; // 等更多数据
		const payload = Buffer.from(b.subarray(offset, offset + len));
		if (mask) {
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
		}
		this._buf = b.subarray(offset + len);
		return { fin, opcode, payload };
	}

	_handleFrame({ fin, opcode, payload }) {
		switch (opcode) {
			case 0x0: // 续帧
				this._fragments.push(payload);
				if (fin) {
					const full = Buffer.concat(this._fragments);
					const op = this._fragmentOp;
					this._fragments = [];
					this._fragmentOp = 0;
					if (op === 0x1) this.emit("message", full.toString("utf8"), false);
				}
				return;
			case 0x1: // text
			case 0x2: // binary
				if (!fin) {
					this._fragmentOp = opcode;
					this._fragments = [payload];
					return;
				}
				if (opcode === 0x1) this.emit("message", payload.toString("utf8"), false);
				else this.emit("message", payload, true);
				return;
			case 0x8: // close
				this.readyState = 3;
				try {
					this.socket.end();
				} catch {
					/* ignore */
				}
				this.emit("close", 1000);
				return;
			case 0x9: // ping
				this._write(0xa, payload);
				return;
			case 0xa: // pong
				this.emit("pong");
				return;
			default:
				this.close(1002, "bad opcode");
		}
	}
}

/**
 * 挂到一个 http.Server 上。
 * `shouldAccept(pathname, req)`：true = 接；false/其他 = 404；数字 = 用该状态码拒绝
 *（401 用来区分「端点存在但 token 不对」）。`onConnection(conn, req)` 处理新连接。
 */
function attachWebSocket(httpServer, { shouldAccept = null, onConnection, pingMs = PING_MS } = {}) {
	const conns = new Set();

	httpServer.on("upgrade", (req, socket) => {
		// 只接 WebSocket 升级
		if (String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
			socket.destroy();
			return;
		}
		const key = req.headers["sec-websocket-key"];
		const version = String(req.headers["sec-websocket-version"] || "");
		if (!key || (version && version !== "13")) {
			socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		const pathname = String(req.url || "/").split("?")[0];
		const verdict = shouldAccept ? shouldAccept(pathname, req) : true;
		if (verdict !== true) {
			const status = typeof verdict === "number" ? verdict : 404;
			socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] || "Rejected"}\r\nConnection: close\r\n\r\n`);
			socket.destroy();
			return;
		}
		const accept = crypto
			.createHash("sha1")
			.update(`${key}${WS_GUID}`)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);

		const conn = new WsConnection(socket, req);
		conns.add(conn);
		conn.on("close", () => conns.delete(conn));
		if (onConnection) onConnection(conn, req);
	});

	// 心跳：ping 出去没回来说明对面已经死了（半开连接最会骗人）
	const timer = setInterval(() => {
		for (const c of [...conns]) {
			if (c.readyState !== 1) {
				conns.delete(c);
				continue;
			}
			if (!c.isAlive) {
				try {
					c.socket.destroy();
				} catch {
					/* ignore */
				}
				conns.delete(c);
				continue;
			}
			c.isAlive = false;
			c.ping();
		}
	}, pingMs);
	timer.unref?.();

	httpServer.on("close", () => {
		clearInterval(timer);
		for (const c of [...conns]) {
			try {
				c.socket.destroy();
			} catch {
				/* ignore */
			}
		}
		conns.clear();
	});

	return { conns, close: () => clearInterval(timer) };
}

module.exports = { attachWebSocket, WsConnection };
