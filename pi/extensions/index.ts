/**
 * pi-dsh-pet — pi extension (thin client)
 *
 * This file is intentionally **self-contained** (no relative imports): pi may load
 * extensions from the package dir or copy a single .ts file into
 * ~/.pi/agent/extensions/. A relative `../../app/x.cjs` import would break in the
 * second case, so the few lines of client code we need are inlined here.
 *
 * The pet itself is a **standalone app** (`pi-pet start`, also shipped as a
 * single .exe). This extension is only a producer:
 *
 *   pi events  ──▶  ws://127.0.0.1:<port>/feed?source=pi   (up: state frames)
 *   commands    ──▶  POST /control                         (down: control plane)
 *
 * If no host is running, the extension starts one (detached, so the pet outlives
 * this pi session). The host is never killed by the extension — that is the
 * whole point of moving it out of the extension: pi restarts no longer make the
 * pet flicker, and dsh can drive the very same pet at the same time.
 *
 * Commands:
 *   /pet [small|normal|large]  — show the window / resize / add a pet
 *   /pet-stop                  — hide the window (service keeps running)
 *   /pet-say <text>            — make the pet say something
 *   /pet-status                — where is the host, is it reachable
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Where the CLI is ----
const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = dirname(dirname(dirname(__filename))); // repo root (…/pi/extensions/index.ts)
const LOCAL_CLI = join(PACKAGE_ROOT, 'bin', 'pi-pet.cjs');

/** 与 pi/assets/pet.js 的 SIZE_MAP 对齐（改一处就得改另一处）。
 *  ⚠️ 最小档别低于 380：舞台太窄时头顶气泡会被挤到屏幕边上，看着像被裁了一半。 */
const SIZE_MAP: Record<string, number> = { small: 380, normal: 400, large: 540 };
const SOURCE = 'pi';

/* ============================== CLI plumbing ============================== */

/** [cmd, args] to run the CLI: the in-repo one if present, otherwise the PATH shim. */
function cliSpec(args: string[]): { cmd: string; argv: string[]; shell: boolean } {
  if (existsSync(LOCAL_CLI)) return { cmd: process.execPath, argv: [LOCAL_CLI, ...args], shell: false };
  // npm -g / exe install: on Windows this is a .cmd shim, which needs shell:true
  return { cmd: 'pi-pet', argv: args, shell: process.platform === 'win32' };
}

/** Run the CLI and resolve its stdout (empty string on failure — never throw). */
function runCli(args: string[], timeoutMs = 8000): Promise<string> {
  const { cmd, argv, shell } = cliSpec(args);
  return new Promise((resolve) => {
    try {
      execFile(cmd, argv, { shell, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        resolve(err ? '' : String(stdout));
      });
    } catch {
      resolve('');
    }
  });
}

/** Start the host detached: it must outlive this pi process. */
function spawnCli(args: string[]): void {
  const { cmd, argv, shell } = cliSpec(args);
  try {
    const child = spawn(cmd, argv, {
      shell,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* /pet will report the failure; nothing else we can do here */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ============================== host discovery ============================== */

type HostInfo = { port: number; token: string; pid?: number };

/**
 * 宠物数据目录。规则必须和 app/paths.cjs 的 defaultHome() 逐字一致：
 * $PI_PET_HOME > %APPDATA%/pi-dsh-pet > ~/Library/Application Support/pi-dsh-pet > ~/.pi-dsh-pet
 * （这里是内联的：本文件故意不 import ../../app/*，pi 可能把它单独拷到别处加载。）
 */
function petHome(): string {
  if (process.env.PI_PET_HOME) return process.env.PI_PET_HOME;
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'pi-dsh-pet');
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'pi-dsh-pet');
  return join(homedir(), '.pi-dsh-pet');
}

function readTrimmed(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** 宿主每次 listen 成功都会写这两个文件：<home>/port 一行端口号，<home>/token 是鉴权口令。 */
function readEndpointFiles(): HostInfo | null {
  const home = petHome();
  const port = Number(readTrimmed(join(home, 'port')));
  const token = readTrimmed(join(home, 'token'));
  if (!port || port < 1 || port > 65535 || !token) return null;
  return { port, token };
}

/** 探一下 /health：端口文件可能是硬杀后残留的（宿主没了，文件还在，端口也没人听）。 */
async function probeHealth(port: number, timeoutMs = 1000): Promise<{ pid?: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { role?: string; pid?: number };
    return body && body.role === 'pi-pet-host' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Ask the CLI where the host is. Returns null when it is not running.
 *
 * 优先读端口文件（~1ms，不用 spawn 进程）；读不到或探活失败再退回 `pi-pet status --json`
 * （它读 state.json + 心跳，能认出旧版/外部路径起的宿主）。两条路都拿不到才算没跑。
 */
async function findHost(): Promise<HostInfo | null> {
  const quick = readEndpointFiles();
  if (quick) {
    const health = await probeHealth(quick.port);
    if (health) return { ...quick, pid: Number(health.pid) || undefined };
  }
  const raw = await runCli(['status', '--json']);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data?.running) return null;
    const port = Number(data.state?.port);
    const token = String(data.state?.token ?? '');
    if (!port || !token) return null;
    return { port, token, pid: Number(data.state?.pid) || undefined };
  } catch {
    return null;
  }
}

/**
 * Make sure a host exists and answers. This is the "宿主没跑就自动拉起" path —
 * a fresh `pi` session must be enough to get a pet, no manual `pi-pet start`.
 */
async function ensureHost(startTimeoutMs = 12000): Promise<HostInfo | null> {
  let host = await findHost();
  if (host) return host;
  spawnCli(['start']);
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    host = await findHost();
    if (host) return host;
  }
  return null;
}

/* ============================== producer feed ============================== */

type Frame =
  | { type: 'thinking'; task?: string }
  | { type: 'tool_call'; tool: string; detail?: string; task?: string }
  | { type: 'done'; summary?: string }
  | { type: 'say'; text: string; ms?: number };

let sock: WebSocket | null = null;
let sockHost: HostInfo | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let everConnected = false;

/** Push one frame upstream. Silent no-op when we are not connected. */
function send(frame: Frame): void {
  if (sock && sock.readyState === 1) {
    try {
      sock.send(JSON.stringify(frame));
    } catch {
      /* socket died between the check and the send; the close handler reconnects */
    }
  }
}

/** (Re)connect the /feed socket. Keeps at most one live connection. */
function connect(host: HostInfo, notify?: (msg: string) => void): void {
  if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
  sockHost = host;
  const url = `ws://127.0.0.1:${host.port}/feed?source=${encodeURIComponent(SOURCE)}&token=${encodeURIComponent(host.token)}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect(notify);
    return;
  }
  sock = ws;
  ws.addEventListener('open', () => {
    everConnected = true;
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
  });
  ws.addEventListener('close', () => {
    if (sock === ws) sock = null;
    // A pet that silently stops reacting is worse than a noisy log line.
    console.log('[pi-dsh-pet] /feed 连接断开，2s 后重连');
    scheduleReconnect(notify);
  });
  ws.addEventListener('error', () => {
    /* close follows error; reconnection is handled there */
  });
}

/** Reconnect forever (2s), re-resolving the host each time — its port may change. */
function scheduleReconnect(notify?: (msg: string) => void): void {
  if (retry) return;
  retry = setTimeout(async () => {
    retry = null;
    const host = await ensureHost();
    if (host) connect(host, notify);
    else scheduleReconnect(notify);
  }, 2000);
  if (typeof retry.unref === 'function') retry.unref();
}

/* ============================== control plane ============================== */

async function control(host: HostInfo, action: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${host.port}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ action, ...extra }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ============================== extension ============================== */

export default function (pi: ExtensionAPI) {
  const notify = (ctx: { ui?: { notify?: (m: string, l?: string) => void } } | undefined, msg: string, level = 'info') => {
    try {
      ctx?.ui?.notify?.(msg, level);
    } catch {
      /* ui shape may differ across pi versions; the console is the fallback */
    }
    console.log(`[pi-dsh-pet] ${msg}`);
  };

  pi.on('session_start', async (_event, ctx) => {
    const host = await ensureHost();
    if (!host) {
      notify(ctx, '没能拉起宠物宿主（pi-pet start 失败？）— /pet-status 看诊断', 'error');
      return;
    }
    connect(host, (m) => notify(ctx, m));
    // The window is intentionally NOT auto-opened here: the standalone app owns
    // its own window lifetime, and opening it from every pi session used to be
    // the source of "pet popped up again" complaints. Use /pet.
  });

  // pi 会话结束（退出/重载/换会话）时只关掉我们的 socket，
  // **绝不关宿主** —— 桌宠要活得比 pi 会话长（dsh 也还在用它）。
  pi.on('session_shutdown', async () => {
    // Let the pet live: close only our feed socket, never the host.
    if (sock) {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      sock = null;
    }
  });

  /* ---- pi events → frames (v1.1 shapes; the host dedupes repeats) ---- */

  pi.on('agent_start', () => {
    send({ type: 'thinking' });
  });

  // pi 的 turn_start 只有 turnIndex，没有任务文本；任务名交给宿主那侧猜（/pet-say 可手填）
  pi.on('turn_start', () => {
    send({ type: 'thinking' });
  });

  // tool_call 给的是 toolName + input（bash 是 {command}，read/edit/write 是 {path}…）
  pi.on('tool_call', (event: any) => {
    const tool = String(event?.toolName ?? event?.tool ?? 'other');
    const input = event?.input;
    const detail =
      typeof input === 'string'
        ? input
        : (input?.command ?? input?.path ?? input?.filePath ?? input?.pattern ?? input?.description);
    send({ type: 'tool_call', tool, detail: detail === undefined ? undefined : String(detail) });
  });

  pi.on('agent_settled', () => {
    send({ type: 'done' });
  });

  /* ---- commands ---- */

  pi.registerCommand('pet', {
    description: 'Show the desktop pet (start the host if needed)',
    getArgumentCompletions: (prefix: string) => {
      const items = Object.keys(SIZE_MAP)
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: `${s} (${SIZE_MAP[s]}px)` }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const host = await ensureHost();
      if (!host) {
        notify(ctx, '宠物宿主起不来，先跑 pi-pet doctor 看看', 'error');
        return;
      }
      connect(host, (m) => notify(ctx, m));
      const size = (args || '').trim().toLowerCase();
      if (size && size in SIZE_MAP) await control(host, 'set-ctrl', { size });
      const ok = await control(host, 'show-window');
      notify(ctx, ok ? `桌宠已显示${size ? `（${size}）` : ''}` : '显示桌宠失败', ok ? 'info' : 'error');
    },
  });

  pi.registerCommand('pet-stop', {
    description: 'Hide the pet window (the service keeps running for dsh/other tools)',
    handler: async (_args, ctx) => {
      const host = await findHost();
      if (!host) {
        notify(ctx, '宠物宿主没在跑', 'error');
        return;
      }
      const ok = await control(host, 'hide-window');
      notify(ctx, ok ? '窗已隐藏（服务还在）' : '隐藏失败', ok ? 'info' : 'error');
    },
  });

  pi.registerCommand('pet-say', {
    description: 'Make the pet say something',
    handler: async (args, ctx) => {
      const text = (args || '').trim();
      if (!text) {
        notify(ctx, '用法：/pet-say 你今天摸鱼了吗', 'error');
        return;
      }
      const host = await findHost();
      if (!host) {
        notify(ctx, '宠物宿主没在跑', 'error');
        return;
      }
      const ok = await control(host, 'say', { text });
      notify(ctx, ok ? `已说话：${text}` : '说话失败', ok ? 'info' : 'error');
    },
  });

  pi.registerCommand('pet-status', {
    description: 'Where is the pet host, and is it reachable',
    handler: async (_args, ctx) => {
      const host = await findHost();
      if (!host) {
        notify(ctx, '宠物宿主没在跑（pi-pet status 也可以）', 'error');
        return;
      }
      let rtt = '?';
      try {
        const t0 = Date.now();
        await fetch(`http://127.0.0.1:${host.port}/health`);
        rtt = `${Date.now() - t0}ms`;
      } catch {
        rtt = '不通';
      }
      notify(ctx, `宠物宿主 pid ${host.pid ?? '?'} :${host.port}  探活 ${rtt}  ${everConnected ? '已接入' : '未接入'}`);
    },
  });
}
