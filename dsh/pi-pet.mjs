/**
 * pi-dsh-pet —— dsh 侧适配（薄客户端）
 *
 * dsh 的插件是 cordis 风格：插件导出 `apply(ctx, config)`，用 `ctx.on(...)` 订阅事件。
 * 下面这版**只用最通用的那几类事件名**（status / pre-step / tool），并且做了兜底：
 * 事件名对不上就什么都不发（宠物照旧待命），绝不会把 dsh 弄崩。
 *
 * 装法：把本文件放到 dsh 能扫到插件的目录，然后在 dsh 配置里引用它，例如
 *   { "plugins": [["file:///abs/path/dsh/pi-pet.mjs", { "source": "dsh-main" }]] }
 * 或直接 `dsh plugin add <path>`。
 *
 * 零依赖：只用 node 内置的 globalThis.WebSocket（Node 22+ 自带）。
 * 宿主（桌宠服务）没跑时，这里只会安静地不工作 —— 想让它自己起来就先 `pi-pet start`，
 * 或者在 dsh 侧接上 spawn（见文件末尾注释）。
 *
 * ⚠️ 未在真机 dsh 上验证过：事件名按 dsh 0.1.0-rc.7 的文档写法猜的，接上后请用
 *    `dsh --verbose` 看有没有 "pi-pet: ..." 的日志再调。
 */

import { spawn } from 'node:child_process';

/** 事件名 → 我们要发的帧。多个别名都挂上，谁先来算谁的。 */
const EVENT_MAP = {
  'agent/status': (e) => {
    const s = e?.status ?? e?.state;
    if (s === 'idle' || s === 'done' || s === 'finished') return { type: 'done' };
    if (s === 'thinking' || s === 'busy' || s === 'running') return { type: 'thinking' };
    return null;
  },
  'agent/thinking': () => ({ type: 'thinking' }),
  'agent/start': () => ({ type: 'thinking' }),
  'agent/done': (e) => ({ type: 'done', summary: e?.summary }),
  'agent/finish': (e) => ({ type: 'done', summary: e?.summary }),

  'agent/pre-step': (e) => ({ type: 'thinking', task: pickTask(e) }),

  'tool/call': (e) => ({
    type: 'tool_call',
    tool: String(e?.tool ?? e?.toolName ?? e?.name ?? 'other'),
    detail: pickDetail(e),
  }),
  'tool/use': (e) => ({
    type: 'tool_call',
    tool: String(e?.tool ?? e?.toolName ?? e?.name ?? 'other'),
    detail: pickDetail(e),
  }),
};

function pickTask(e) {
  const t = e?.task ?? e?.prompt ?? e?.input ?? e?.message;
  return typeof t === 'string' ? t : undefined;
}

function pickDetail(e) {
  const a = e?.args ?? e?.input ?? e?.params;
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object') {
    const v = a.command ?? a.path ?? a.filePath ?? a.pattern ?? a.query;
    if (v !== undefined) return String(v);
  }
  return undefined;
}

/** 怎么找到宿主：环境变量优先，其次默认端口，最后读状态文件（由 CLI 代劳）。 */
function resolveHost(env, defaultPort) {
  const port = Number(env.PI_PET_PORT) || defaultPort;
  const token = env.PI_PET_TOKEN || '';
  return { port, token };
}

const DEFAULT_PORT = 47653;

export function apply(ctx, config = {}) {
  const env = config.env || process.env;
  const source = config.source || 'dsh';
  const autoStart = config.autoStart === true;
  const cli = config.cli || 'pi-pet';
  const log = (m) => {
    try {
      ctx?.logger?.info?.(`pi-pet: ${m}`);
    } catch {
      /* logger 形状可能不同，忽略 */
    }
  };

  let sock = null;
  let host = resolveHost(env, DEFAULT_PORT);

  const send = (frame) => {
    if (!frame) return;
    if (sock && sock.readyState === 1) {
      try {
        sock.send(JSON.stringify(frame));
      } catch {
        /* 断了就断了，close 里会重连 */
      }
    }
  };

  const connect = () => {
    if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
    if (typeof WebSocket === 'undefined') {
      log('这个 Node 没有全局 WebSocket，dsh 侧接不上（Node 22+ 自带才对）');
      return;
    }
    const url = `ws://127.0.0.1:${host.port}/feed?source=${encodeURIComponent(source)}&token=${encodeURIComponent(host.token)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log(`连接失败：${e?.message || e}`);
      if (autoStart) setTimeout(startThenConnect, 2000);
      return;
    }
    sock = ws;
    ws.addEventListener('open', () => log(`已接入宠物宿主 :${host.port}`));
    ws.addEventListener('close', () => {
      if (sock === ws) sock = null;
      setTimeout(connect, 3000); // 断线重连，端口不变（宿主会自己续心跳）
    });
    ws.addEventListener('error', () => {
      if (autoStart) setTimeout(startThenConnect, 2000);
    });
  };

  /** 没宿主就自己起一个（需要 pi-pet 在 PATH 上）。 */
  const startThenConnect = () => {
    try {
      const child = spawn(cli, ['start'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      log('正在拉起宠物宿主…');
    } catch (e) {
      log(`拉起失败：${e?.message || e}`);
    }
    setTimeout(connect, 4000);
  };

  // 订阅：事件名对不上就退化成无操作（不 throw）
  for (const [event, map] of Object.entries(EVENT_MAP)) {
    try {
      ctx.on(event, (e) => send(map(e)));
    } catch {
      /* 这个 dsh 没这个事件，跳过 */
    }
  }

  connect();

  return {
    name: 'pi-dsh-pet',
    dispose() {
      if (sock) {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        sock = null;
      }
    },
  };
}

export default { apply };
