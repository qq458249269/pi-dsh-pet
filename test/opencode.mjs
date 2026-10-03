/**
 * opencode 侧适配的集成测试：用假 PluginInput 驱动 opencode/pi-pet.ts，看状态有没有真的
 * 变成 思考中 / 执行中 / 空闲，以及 pet 工具的 say/status 走不走得通。
 * 跑：npm run test:opencode
 */
console.log("pi-dsh-pet opencode 适配测试\n");
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "pi-pet-oc-"));
const PORT = 47901;
const host = spawn(process.execPath, [join(ROOT, "bin", "pi-pet.cjs"), "serve", "--port", String(PORT)], {
  env: { ...process.env, PI_PET_HOME: HOME, PI_PET_SKIP_FOREIGN: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = "";
for (let i = 0; i < 40; i++) {
  try {
    const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    if (h.role) {
      token = readFileSync(join(HOME, "token"), "utf8").trim();
      break;
    }
  } catch {}
  await sleep(150);
}
// 插件自己只会读 PI_PET_HOME / %APPDATA%，测试就指到临时目录（和真实 dsh 测试同思路）
process.env.PI_PET_HOME = HOME;

// 假窗
const win = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const frames = [];
win.addEventListener("message", (e) => frames.push(String(e.data)));
await new Promise((r) => win.addEventListener("open", r));

const { default: plugin } = await import("../opencode/pi-pet.ts");
const hooks = await plugin({
  project: { id: "test", worktree: ROOT },
  directory: ROOT,
  worktree: ROOT,
  client: { app: { log: async () => {} } },
});
await sleep(300);

const fire = (event) => hooks.event({ event });
const MESSAGE = { id: "msg_1", role: "assistant", sessionID: "ses_1", time: { created: Date.now() } };

await fire({ type: "message.updated", properties: { info: MESSAGE } });
await sleep(200);
// 同一条消息 opencode 会反复推 message.updated：只该播一次「思考中」
await fire({ type: "message.updated", properties: { info: MESSAGE } });
await sleep(150);
await fire({
  type: "message.part.updated",
  properties: { part: { id: "prt_1", type: "tool", tool: "bash", state: { status: "running", input: { command: "npm test" } } } },
});
await sleep(200);
await fire({ type: "session.idle", properties: { sessionID: "ses_1" } });
await sleep(200);

const tool = (command) => hooks.tool.pet.execute({ command }, { agent: "build", sessionID: "ses_1" });
const sayOut = await tool("say 你今天摸鱼了吗");
await sleep(200);
const statusOut = await tool("status");
const badOut = await tool("frobnicate");

// 宿主起来时会补发 power 帧（开机状态不是事件），断言位置前先滤掉
const anim = frames.filter((f) => !f.startsWith('{"type":"bubble"') && !f.startsWith('{"type":"power"'));
const bubbles = frames.filter((f) => f.startsWith('{"type":"bubble"')).map((f) => JSON.parse(f).text);
const st = await (
  await fetch(`http://127.0.0.1:${PORT}/state`, { headers: { authorization: `Bearer ${token}` } })
).json();

let total = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  total++;
  if (cond) console.log("  ✓ " + name);
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
};

ok("thinking → 思考中", anim[0] === "thinking", JSON.stringify(anim));
ok("同一消息重复更新只播一次", anim.filter((f) => f === "thinking").length === 1, JSON.stringify(anim));
ok("tool running → 执行中 + detail", anim[1] === '{"type":"tool_call","tool":"bash"}' && bubbles.includes("执行中：npm test"), JSON.stringify(anim) + " " + JSON.stringify(bubbles));
ok("session.idle → 回空闲", anim[2] === "agent_idle", JSON.stringify(anim));
ok("pet 工具 say → 气泡", bubbles.includes("你今天摸鱼了吗") && String(sayOut).includes("已说话"), JSON.stringify(bubbles));
ok("pet 工具 status 报出端口", String(statusOut).includes(`:${PORT}`), String(statusOut));
ok("pet 工具认得非法命令", String(badOut).includes("用法"), String(badOut));
ok("会话名存在 /state 里", st.bus.feedsBySource["opencode"] === 1, JSON.stringify(st.bus));

hooks.dispose();
await fetch(`http://127.0.0.1:${PORT}/control`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: '{"action":"shutdown"}',
});
await sleep(600);
console.log(failed === 0 ? `
opencode 适配测试通过：${total} 通过 / 0 失败` : `
有失败：${total - failed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);