/**
 * pi-dsh-pet — Pi extension entry point
 *
 * Starts an HTTP+WebSocket server on a random localhost port at session start.
 * Serves the pet page, WebM assets, and relays pi agent events to the browser
 * so the pet reacts in real time (thinking → 深度思考碎碎念, bash → 写代码, etc.).
 *
 * Commands:
 *   /pet       — launch pet in transparent Electron window
 *   /pet-stop  — close Electron window + stop server
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Server as WsServer } from 'ws';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';

// ---- Paths (fileURLToPath needed on Windows; new URL(...).pathname adds leading /) ----
const __filename = fileURLToPath(import.meta.url);
const PI_DIR = dirname(dirname(__filename)); // dsh-pet/pi/
const PACKAGE_ROOT = dirname(PI_DIR); // dsh-pet/
const ASSETS_DIR = join(PI_DIR, 'assets');
const PET_THUMB = join(PACKAGE_ROOT, 'assets', 'thumb');
const PET_CONFIG = join(PACKAGE_ROOT, 'assets', 'config.jsonc');

// ---- MIME ----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
};

// ---- Global state (one server per session) ----
let port = 0;
let serverActive = false;
let httpSvr: HttpServer | null = null;
let wss: WsServer | null = null;
let broadcast: ((msg: string) => void) | null = null;

// ---- Helpers ----

/** Encode an asset path to prevent path traversal */
function safeAsset(root: string, rel: string): string | undefined {
  if (!rel || rel.includes('..')) return undefined;
  const candidate = normalize(join(root, rel));
  if (!candidate.startsWith(root)) return undefined;
  return candidate;
}

/** Stream a file as HTTP response */
async function sendFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const st = await stat(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': mime,
      'content-length': st.size,
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// ---- Electron launcher (npx electron → transparent always-on-top window) ----

let electronProc: ChildProcess | null = null;
const ELECTRON_SCRIPT = join(ASSETS_DIR, 'pet-electron.cjs');

function launchElectron(port: number): void {
  if (electronProc && electronProc.exitCode === null) {
    console.log('[pi-dsh-pet] Pet is already running.');
    return;
  }

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const env = { ...process.env };

  // Use npmmirror for users in mainland China (GitHub + S3 are inaccessible)
  if (isWin && !env.ELECTRON_MIRROR) {
    env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
    env.NPM_CONFIG_REGISTRY = 'https://registry.npmmirror.com';
  }

  console.log(`[pi-dsh-pet] Launching Electron (port ${port})…`);
  const npxArgs = ['--yes', 'electron', ELECTRON_SCRIPT, String(port)];
  electronProc = spawn(cmd, npxArgs, {
    cwd: PACKAGE_ROOT,
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
    shell: isWin,
    env,
  });
  electronProc.unref();

  electronProc.on('error', (err) => {
    console.error('[pi-dsh-pet] Electron failed:', err.message);
    electronProc = null;
  });

  electronProc.on('exit', (code) => {
    if (code !== 0) console.error('[pi-dsh-pet] Electron exited with code', code);
    electronProc = null;
  });
}

function killElectron(): void {
  if (electronProc && electronProc.exitCode === null) {
    console.log('[pi-dsh-pet] Closing pet…');
    if (process.platform === 'win32') {
      // shell:true → proc.pid is cmd.exe; taskkill /t kills whole tree
      try {
        execSync(`taskkill /pid ${electronProc.pid} /f /t`, { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    } else {
      electronProc.kill();
    }
    electronProc = null;
  }
}

// ---- Port finder ----

/** Find a random free port between 10240 and 49151 */
function findFreePort(): number {
  return randomInt(10240, 49152);
}

// ---- HTTP request handler ----
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  // WebSocket upgrade — handled by ws library, ignore here
  if (pathname === '/ws' && req.headers.upgrade?.toLowerCase() === 'websocket') {
    req.destroy();
    return;
  }

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port }));
    return;
  }

  // Config
  if (pathname === '/config.jsonc' || pathname === '/config') {
    await sendFile(res, PET_CONFIG);
    return;
  }

  // Thumb assets (webm)
  if (pathname.startsWith('/thumb/')) {
    const rel = pathname.slice('/thumb/'.length);
    const file = safeAsset(PET_THUMB, rel);
    if (!file) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad path');
      return;
    }
    await sendFile(res, file);
    return;
  }

  // Pet page and static assets
  if (pathname === '/' || pathname === '/index.html') {
    const html = await readFile(join(ASSETS_DIR, 'pet.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (pathname === '/pet.js') {
    await sendFile(res, join(ASSETS_DIR, 'pet.js'));
    return;
  }

  if (pathname === '/pet.css') {
    await sendFile(res, join(ASSETS_DIR, 'pet.css'));
    return;
  }

  // 404
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('pi-dsh-pet: not found');
}

// ---- Start HTTP+WS server ----
async function startServer(): Promise<number> {
  let p = 0;
  const server = createServer(handleRequest);

  // Find a free port
  for (let i = 0; i < 20; i++) {
    p = findFreePort();
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') resolve();
        else reject(err);
      });
      server.listen(p, '127.0.0.1', () => resolve());
    });
    if (server.listening) break;
  }

  if (!server.listening) {
    throw new Error('pi-dsh-pet: could not find a free port');
  }

  httpSvr = server;

  // Attach WebSocket server
  const WebSocket = (await import('ws')).WebSocketServer;
  wss = new WebSocket({ noServer: true });

  const clients = new Set<import('ws').WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  broadcast = (msg: string) => {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/ws') {
      wss?.handleUpgrade(req, socket, head, (ws) => {
        wss?.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  return p;
}

/** Stop the HTTP server + WebSocket server */
function stopServer(): void {
  if (httpSvr) {
    httpSvr.close();
    httpSvr = null;
  }
  wss?.close();
  wss = null;
  broadcast = null;
  serverActive = false;
  port = 0;
}

// ---- Pi extension ----
export default function (pi: ExtensionAPI) {
  // ---- Lifecycle ----
  pi.on('session_start', async (_event, ctx) => {
    if (serverActive) return; // already running from a previous session
    try {
      port = await startServer();
      serverActive = true;
      ctx.ui.notify(`pet server on :${port}  — /pet to open`, 'info');
    } catch (e) {
      ctx.ui.notify(`pet server start failed: ${(e as Error).message}`, 'error');
    }
  });

  // Pet survives session boundaries — only shut down when the pi process exits.
  process.on('exit', () => {
    killElectron();
    stopServer();
  });

  // ---- Agent events → WebSocket ----
  let thinkingThrottle: ReturnType<typeof setInterval> | null = null;

  pi.on('agent_start', () => {
    broadcast?.('agent_start');
  });

  pi.on('agent_settled', () => {
    if (thinkingThrottle) {
      clearInterval(thinkingThrottle);
      thinkingThrottle = null;
    }
    broadcast?.('agent_idle');
  });

  pi.on('turn_start', () => {
    // Send "thinking" at most once per 2s during active agent turns
    if (!thinkingThrottle) {
      broadcast?.('thinking');
      thinkingThrottle = setInterval(() => {
        broadcast?.('thinking');
      }, 2000);
    }
  });

  pi.on('turn_end', () => {
    // Throttle keeps running during multi-turn tool-call sequences
  });

  pi.on('tool_call', (event) => {
    broadcast?.(JSON.stringify({ type: 'tool_call', tool: event.toolName }));
  });

  // ---- Commands ----
  pi.registerCommand('pet', {
    description: 'Open desktop pet in Electron',
    handler: async (_args, ctx) => {
      if (!serverActive || !port) {
        try {
          port = await startServer();
          serverActive = true;
        } catch (e) {
          ctx.ui.notify(`pet server start failed: ${(e as Error).message}`, 'error');
          return;
        }
      }
      ctx.ui.notify('Launching pet…  First run downloads Electron (~100MB), please wait', 'info');
      launchElectron(port);
    },
  });

  pi.registerCommand('pet-stop', {
    description: 'Close pet window',
    handler: async (_args, ctx) => {
      killElectron();
      ctx.ui.notify('Pet closed', 'info');
    },
  });
}
