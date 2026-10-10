/**
 * dsh 侧适配的集成测试：用假 cordis ctx 驱动 dsh/pi-pet.mjs，看状态有没有真的
 * 变成 思考中 / 执行中。真实 dsh 事件名未在真机验证，这里只验「适配层自己对不对」。
 * 跑：npm run test:dsh
 */
console.log("pi-dsh-pet dsh 适配测试\n");
import { apply } from "../dsh/pi-pet.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "pi-pet-dsh-"));
const PORT = 47900;
const host = spawn(process.execPath, [join(ROOT,"bin","pi-pet.cjs"),"serve","--port",String(PORT)], {env:{...process.env,PI_PET_HOME:HOME,PI_PET_SKIP_FOREIGN:"1"}, stdio:["ignore","ignore","inherit"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let token="";
for(let i=0;i<40;i++){ try{ const h=await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); if(h.role){ token=readFileSync(join(HOME,"token"),"utf8").trim(); break; } }catch{} await sleep(150); }
// 假窗
const win = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const frames=[]; win.addEventListener("message",e=>frames.push(String(e.data)));
await new Promise(r=>win.addEventListener("open",r));
const handlers = new Map();
const logs = [];
const ctx = { logger: { info: (m)=>{ logs.push(String(m)); console.log("[dsh]",m); } }, on: (e,f)=>{ if(handlers.has(e)) throw new Error("dup"); handlers.set(e,f); } };
// 刻意**不传** PI_PET_PORT / PI_PET_TOKEN：真实 dsh 插件不会知道端口是多少（47653 被占时
// 宿主会退到随机口），它只该靠读宿主写的 <home>/port + <home>/token 找到宿主。
const plugin = apply(ctx, { env: { PI_PET_HOME: HOME }, source: "dsh-fake" });
await sleep(300);
console.log("订阅到的事件:", [...handlers.keys()].join(", "));
handlers.get("agent/status")({ status: "thinking" });
await sleep(200);
handlers.get("tool/call")({ tool: "bash", args: { command: "npm test" } });
await sleep(200);
handlers.get("agent/status")({ status: "idle" });
await sleep(200);
// 窗接上来时宿主会补发一次「省电模式当前值」（power 帧），它是开机状态而不是事件，
// 所以从事件序列里滤掉 —— 否则下面按 anim[0]/[1] 的位置断言会把它算成第一个事件。
// v1.4 的会话气泡帧（session）是**另一条**通道，也不进 anim（它变不代表状态机动了）。
const anim = frames.filter((f) => !f.startsWith('{"type":"bubble"') && !f.startsWith('{"type":"power"') && !f.startsWith('{"type":"session"'));
const bubbles = frames.filter((f) => f.startsWith('{"type":"bubble"')).map((f) => JSON.parse(f).text);
const sessions = frames.filter((f) => f.startsWith('{"type":"session"') && !f.includes('"remove"')).map((f) => JSON.parse(f));
const st = (await (await fetch(`http://127.0.0.1:${PORT}/state`, { headers: { authorization: `Bearer ${token}` } })).json());
const ok = (name, cond, extra = "") => {
  total++;
  if (cond) console.log("  ✓ " + name);
  else { failed++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
};
let total = 0, failed = 0;
ok("宿主起来时写了 <home>/port（一行就是端口）", readFileSync(join(HOME, "port"), "utf8").trim() === String(PORT));
// 真实 dsh 插件不会知道端口是多少（47653 被占时宿主会退到随机口），只靠读这两个文件
ok("没给 PI_PET_PORT/TOKEN 也连上了（读 port/token 文件）", logs.some((l) => l.includes(`已接入宠物宿主 :${PORT}`) && /端口来自.*[\\/]port/.test(l)), logs.join(" | "));
ok("thinking → 思考中", anim[0] === "thinking", JSON.stringify(anim));
// 省电帧：窗接上来就该收到一次（老窗不认识也无害），并且能靠 /control 切
ok("窗接上来补发 power 帧（默认 false）", frames.some((f) => f === '{"type":"power","sleep":false}'), JSON.stringify(frames));
ok("工具调用 → 执行中 + detail", anim[1] === '{"type":"tool_call","tool":"bash"}' && bubbles.includes("执行中：npm test"), JSON.stringify(bubbles));
ok("done → 回空闲", anim[2] === "agent_idle", JSON.stringify(anim));
// v1.4：这个会话自己的那条气泡（同一条 sid 从执行中 → 已完成，标题是它自己的）
ok("每会话一条气泡（执行中 → 已完成）", sessions.length >= 3 && sessions.every((s) => s.source === "dsh-fake") && sessions[0].status === "running" && sessions[sessions.length - 1].status === "done" && sessions[0].title === "pi-dsh-pet" && sessions[1].text === "npm test", JSON.stringify(sessions));
ok("会话名存在 /state 里", st.bus.feedsBySource["dsh-fake"] === 1, JSON.stringify(st.bus));
console.log("bus:", JSON.stringify(st.bus));
plugin.dispose();
await fetch(`http://127.0.0.1:${PORT}/control`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:'{"action":"shutdown"}'});
await sleep(600);
console.log(failed === 0 ? `
dsh 适配测试通过：${total} 通过 / 0 失败` : `
有失败：${total - failed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
