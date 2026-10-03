/**
 * pi-dsh-pet — opencode plugin (thin client)
 *
 * Self-contained on purpose: opencode loads every `*.ts` under
 * `.opencode/plugin(s)/` or `~/.config/opencode/plugin(s)/`, so a relative
 * `../../app/x.cjs` import would break the moment the file gets copied there.
 * The pet itself is a **standalone app** (`pi-pet start`, also shipped as a
 * single .exe). This plugin is only a producer:
 *
 *   opencode events ──▶ ws://127.0.0.1:<port>/feed?source=opencode  (up: state frames)
 *   pet tool         ──▶ POST /control                             (down: control plane)
 *
 * If no host is running the plugin starts one (detached, so the pet outlives
 * this opencode session) and never kills it.
 *
 * Install:
 *   node -e "require('fs').copyFileSync('opencode/pi-pet.ts', require('os').homedir()+'/.config/opencode/plugins/pi-pet.ts')"
 * (or copy the file to `<project>/.opencode/plugins/pi-pet.ts`)
 *
 * Commands: opencode has no client-side slash-command registry (commands are
 * markdown files that cost an LLM turn), so control lives in one `pet` tool the
 * agent can call — `show [small|normal|large]` / `hide` / `say <text>` / `status`.
 * ponytail: no `/pet`; add `command/pet.md` templates if you want slash commands
 * and don't mind burning a model call per use.
 */

import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Where the CLI is ----
const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = dirname(dirname(dirname(__filename))); // repo root (…/opencode/pi-pet.ts)
const LOCAL_CLI = join(PACKAGE_ROOT, 'bin', 'pi-pet.cjs');

/** 与 pi/assets/pet.js 的 SIZE_MAP 对齐（改一处就得改另一处）。
 *  ⚠️ 最小档别低于 380：舞台太窄时头顶气泡会被挤到屏幕边上，看着像被裁了一半。 */
const SIZE_MAP: Record<string, number> = { small: 380, normal: 400, large: 540 };
const SOURCE = 'opencode';

/* ============================== CLI plumbing ============================== */

/** [cmd, args] to run the CLI: the in-repo one if present, otherwise the PATH shim. */
function cliSpec(args: string[]): { cmd: string; argv: string[]; shell: boolean } {
  if (existsSync(LOCAL_CLI)) return { cmd: process.execPath, argv: [LOCAL_CLI, ...args], shell: false };
  // npm -g / exe install: on Windows this is a .cmd shim, which needs shell:true
  return { cmd: 'pi-pet', argv: args, shell: process.platform === 'win32' };
}

/** Is the CLI reachable at all? Keeps the plugin from stalling startup when it isn't. */
function hasCli(): boolean {
  if (existsSync(LOCAL_CLI)) return true;
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  return dirs.some((d) => ['pi-pet', 'pi-pet.cmd', 'pi-pet.exe'].some((n) => existsSync(join(d, n))));
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

/** Start the host detached: it must outlive this opencode process. */
function spawnCli(args: string[]): void {
  const { cmd, argv, shell } = cliSpec(args);
  try {
    const child = spawn(cmd, argv, { shell, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {
    /* the pet tool reports the failure; nothing else we can do here */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ============================== host discovery ============================== */

type HostInfo = { port: number; token: string; pid?: number };

/**
 * 宠物数据目录。规则必须和 app/paths.cjs 的 defaultHome() 逐字一致：
 * $PI_PET_HOME > %APPDATA%/pi-dsh-pet > ~/Library/Application Support/pi-dsh-pet > ~/.pi-dsh-pet
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
  if (!hasCli()) return null;
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
 * a fresh `opencode` session must be enough to get a pet, no manual `pi-pet start`.
 */
async function ensureHost(startTimeoutMs = 12000): Promise<HostInfo | null> {
  let host = await findHost();
  if (host) return host;
  if (!hasCli()) return null;
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
    notify?.('/feed 连接断开，2s 后重连');
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

/* ============================== event mapping ============================== */

/** 每个 assistant 消息只发一次「思考中」：opencode 的 message.updated 会为同一条消息反复触发。 */
const announced = new Set<string>();

function pickDetail(input: any): string | undefined {
  if (typeof input === 'string') return input;
  const v = input?.command ?? input?.filePath ?? input?.path ?? input?.pattern ?? input?.query ?? input?.description ?? input?.prompt;
  return v === undefined || v === null ? undefined : String(v);
}

function onBusEvent(event: any): void {
  try {
    const info = event?.properties?.info;
    if (event?.type === 'message.updated') {
      // 一条 assistant 消息从 created 到 completed 期间只播一次「思考中」
      if (info?.role === 'assistant' && info?.time?.created && !info?.time?.completed && !announced.has(info.id)) {
        announced.add(info.id);
        send({ type: 'thinking' });
      }
      return;
    }
    if (event?.type === 'message.part.updated') {
      const part = event?.properties?.part;
      if (part?.type === 'tool' && part?.state?.status === 'running') {
        send({ type: 'tool_call', tool: String(part.tool || 'other'), detail: pickDetail(part.state.input) });
      }
      return;
    }
    if (event?.type === 'session.idle') {
      announced.clear(); // 下一条 assistant 消息要能再播「思考中」
      send({ type: 'done' });
    }
  } catch {
    /* 一个畸形事件不该把桌宠插件带崩 */
  }
}

/* ============================== plugin ============================== */

export default async function ({ client }: { client?: any }) {
  const log = (msg: string, level = 'info') => {
    const line = `[pi-dsh-pet] ${msg}`;
    try {
      client?.app?.log?.({ body: { service: 'pi-dsh-pet', level, message: msg } });
    } catch {
      /* 老版本没有 client.app.log，console 兜底 */
    }
    console.log(line);
  };

  const host = await ensureHost();
  if (host) connect(host, log);
  else log('没找到宠物宿主，也拉不起来 — 装 npm i -g pi-dsh-pet，或手动 pi-pet start', 'warn');

  return {
    event: async ({ event }: { event: unknown }) => onBusEvent(event),

    tool: {
      pet: {
        description:
          '控制 pi-dsh-pet 桌宠。命令：`show [small|normal|large]` 显示/改尺寸、`hide` 藏窗（服务留着）、' +
          '`say <文字>` 让它说句话、`status` 看宿主在哪。用户提到桌宠/宠物/pet 时用它。',
        // 故意只留一个必填参数：opencode 把普通对象的每个键都算 required，
        // 多参数就得每回都编一个 size:"" 出来。
        args: {
          command: { type: 'string', description: 'show | show large | hide | say <文字> | status' },
        },
        async execute(args: { command?: string }) {
          const [rawAction = '', ...rest] = String(args?.command || '').trim().split(/\s+/).filter(Boolean);
          const action = rawAction.toLowerCase();
          const host = await ensureHost();
          if (!host) return '桌宠宿主没在跑，也拉不起来（pi-pet start 手动起一下，或 npm i -g pi-dsh-pet）';
          if (action === 'status') {
            let rtt = '?';
            try {
              const t0 = Date.now();
              await fetch(`http://127.0.0.1:${host.port}/health`);
              rtt = `${Date.now() - t0}ms`;
            } catch {
              rtt = '不通';
            }
            return `桌宠宿主 pid ${host.pid ?? '?'} :${host.port} 探活 ${rtt} ${everConnected ? '已接入' : '未接入'}`;
          }
          if (action === 'hide') {
            return (await control(host, 'hide-window')) ? '窗已隐藏（服务还在）' : '隐藏失败';
          }
          if (action === 'say') {
            const text = rest.join(' ');
            if (!text) return '用法：say 你今天摸鱼了吗';
            return (await control(host, 'say', { text })) ? `已说话：${text}` : '说话失败';
          }
          if (action === 'show' || action === 'open') {
            const size = (rest[0] || '').toLowerCase();
            if (size && !(size in SIZE_MAP)) return `尺寸只能是 ${Object.keys(SIZE_MAP).join(' / ')}`;
            if (size) await control(host, 'set-ctrl', { size });
            return (await control(host, 'show-window')) ? `桌宠已显示${size ? `（${size}）` : ''}` : '显示桌宠失败';
          }
          return '用法：show [small|normal|large] | hide | say <文字> | status';
        },
      },
    },

    // opencode 关掉/重载插件时只断我们的 socket，**绝不关宿主** —— 桌宠要活得比会话长。
    dispose() {
      if (retry) clearTimeout(retry);
      retry = null;
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