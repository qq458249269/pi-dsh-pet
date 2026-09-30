/**
 * pet-electron.cjs — Electron 主进程
 *
 * 启动方式：宿主（app/host.cjs）用 `electron pet-electron.cjs <port>` 拉起。
 * 职责：开一扇全屏透明置顶窗，加载宿主提供的 http://127.0.0.1:<port>。
 *
 * 鼠标穿透：默认整窗穿透（点透明处等于点在下面的窗口上）。渲染进程在鼠标进入宠物
 * 命中框时通过 preload 告诉主进程「别穿透」，于是能点、能拖；离开再穿回去。
 *
 * 右键菜单：渲染进程把「当前状态/只数/命中信息」发过来，主进程在这里拼原生菜单，
 * 菜单项的动作**全部走宿主的控制面**（POST /control，带 token）——
 * 也就是说菜单和 pi/dsh/curl 用的是同一套 API，宿主是唯一的状态持有者。
 *
 * 用法：npx electron pet-electron.cjs <port>
 *        （打包版里不需要这么起：`pi-dsh-pet.exe --pi-pet-window <port>` 会 require 本文件）
 */

const { app, BrowserWindow, Menu, dialog, shell, clipboard, screen, ipcMain } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 端口从 argv[2] 读：两种起法都落在 argv[2]
//   electron pet-electron.cjs 47653
//   pi-dsh-pet.exe --pi-pet-window 47653
const port = parseInt(process.argv[2], 10);
if (!port || isNaN(port)) {
  console.error("Usage: electron pet-electron.cjs <port>");
  process.exit(1);
}

const url = `http://127.0.0.1:${port}`;
const PKG_ROOT = path.resolve(__dirname, "..", "..");

/** 主进程 → 渲染进程的单向通道（目前只有“叫出输入框”用得到） */
let webContentsSend = null;

/** 读宿主的状态与意图（菜单里要显示「几个会话在喂事件」「当前尺寸」）。
 *  走 /state（带 token）；宿主不通就返回 null，菜单降级成不含这些行的样子。 */
function hostState(token) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/state", method: "GET", timeout: 1200, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          buf += c;
          if (buf.length > 1 << 20) req.destroy();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** 调宿主的控制面。所有菜单项的动作都走这里，不在 Electron 侧另搞一套状态。 */
function callHost(action, body, token) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ action, ...(body || {}) }), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/control",
        method: "POST",
        timeout: 2500,
        headers: { "content-type": "application/json", "content-length": payload.length, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { buf += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { resolve(null); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

/** token 与数据目录：优先用 app/paths.cjs（单一真源），拿不到再自己算一遍。 */
function readTokenAndHome() {
  try {
    const { PATHS } = require(path.join(PKG_ROOT, "app", "paths.cjs"));
    let token = "";
    try { token = fs.readFileSync(PATHS.token, "utf8").trim(); } catch { /* 还没起过宿主 */ }
    return { token, home: PATHS.home };
  } catch {
    const home = process.env.PI_PET_HOME
      || (process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "pi-dsh-pet")
        : path.join(os.homedir(), ".pi-dsh-pet"));
    let token = "";
    try { token = fs.readFileSync(path.join(home, "token"), "utf8").trim(); } catch { /* ignore */ }
    return { token, home };
  }
}

function pkgVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version || "?"; }
  catch { return "?"; }
}

app.whenReady().then(() => {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  // 全屏透明浮层：宠物能在屏幕任何地方漫游。
  // setIgnoreMouseEvents 让点击穿透到下面的窗口；命中框由渲染进程动态开/关。
  const win = new BrowserWindow({
    width: sw,
    height: sh,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.setIgnoreMouseEvents(true, { forward: true });

  // 给渲染进程回话的快捷方式（“说点什么…”）
  webContentsSend = (channel) => {
    if (!win.isDestroyed()) win.webContents.send(channel);
  };

  // 渲染进程：鼠标进出命中框 → 切换穿透
  ipcMain.on("pet:passthrough", (_event, on) => {
    if (on) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });

  // 渲染进程：宿主退出 / WS 断了 → 自己关
  ipcMain.on("pet:close", () => app.quit());

  // 渲染进程：“说点什么…” → 把输入框叫到宠物头上（输入框长在气泡里）
  ipcMain.on("pet:say-ask", () => {
    if (webContentsSend) webContentsSend("pet:say-ask");
  });

  // 渲染进程 → 主进程：用户手动说的话。走宿主 /control（主进程有 token）
  ipcMain.on("pet:say-submit", async (_event, text) => {
    const t = String(text == null ? "" : text).trim();
    if (!t) return;
    const { token } = readTokenAndHome();
    const res = await callHost("say", { text: t }, token);
    if (!res || res.ok !== true) {
      dialog.showMessageBox({
        type: "warning",
        message: "没能说出来",
        detail: `宿主没应答：${res ? res.error || "unknown" : "no response"}`,
        buttons: ["好"],
      });
    }
  });

  // 渲染进程：右键菜单
  ipcMain.on("pet:menu", async (_event, info = {}) => {
    const { token, home } = readTokenAndHome();
    const st = await hostState(token);
    const ctrl = (st && st.ctrl) || {};
    const busStats = (st && st.bus) || {};
    const maxPets = Number(ctrl.maxPets) || 1;
    const paused = ctrl.paused === true;
    const currentSize = ctrl.size || "normal";
    const run = async (action, body) => {
      const res = await callHost(action, body, token);
      if (!res || res.ok !== true) {
        dialog.showMessageBox({
          type: "warning",
          message: "操作没成功",
          detail: `宿主（127.0.0.1:${port}）没应答或拒绝了：${res ? res.error || "unknown" : "no response"}`,
          buttons: ["好"],
        });
      }
    };

    const SIZES = [
      { id: "small", label: "小号 260px" },
      { id: "normal", label: "正常 400px" },
      { id: "large", label: "大号 540px" },
    ];

    const stateLabel = info.state || "待机（随机动画）";
    const menu = Menu.buildFromTemplate([
      { label: `当前：${stateLabel}`, enabled: false },
      {
        label: busStats.feeds ? `事件来源：${busStats.feeds} 个会话` : "事件来源：暂无（pi/dsh 未接入）",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "暂停响应",
        type: "checkbox",
        checked: paused,
        // 暂停 = 宠物继续自己玩，但不再跟着 agent 状态变。服务与端口照旧。
        click: () => run(paused ? "resume" : "pause"),
      },
      {
        label: "说点什么…",
        click: () => {
          if (webContentsSend) webContentsSend("pet:say-ask");
        },
      },
      { label: "换一只（重启窗）", click: () => run("restart-window") },
      {
        label: "尺寸（换窗后生效）",
        submenu: SIZES.map((s) => ({
          label: s.label,
          type: "radio",
          checked: currentSize === s.id,
          click: () => run("set-ctrl", { size: s.id, restartNonce: (Number(ctrl.restartNonce) || 0) + 1 }),
        })),
      },
      { label: "添加一只（maxPets>1 时可用）", enabled: maxPets > 1, click: () => run("add-pet", { size: currentSize }) },
      { type: "separator" },
      { label: "隐藏宠物（服务保留）", enabled: ctrl.window !== false, click: () => run("hide-window") },
      { label: "在浏览器里打开", click: () => shell.openExternal(url) },
      { label: "复制服务地址", click: () => clipboard.writeText(url) },
      { label: "打开数据文件夹", click: () => shell.openPath(home) },
      {
        label: "关于",
        click: () => {
          const version = pkgVersion();
          const detail = [
            `pi-dsh-pet ${version}`,
            `服务：${url}`,
            `宿主 pid：${(st && st.state && st.state.pid) || "?"}，运行 ${Math.round((Date.now() - ((st && st.state && st.state.startedAt) || Date.now())) / 1000)}s`,
            `数据目录：${home}`,
            "",
            "左键：互动　拖拽：移动　右键：菜单",
          ].join("\n");
          try {
            dialog.showMessageBox({ type: "info", message: "桌面宠物", detail, buttons: ["好"] });
          } catch {
            clipboard.writeText(detail);
          }
        },
      },
      { type: "separator" },
      // 必备项：把服务与窗一起退（宿主会广播 shutdown，窗自己收尾）
      { label: "退出桌宠（服务与窗口）", click: () => run("shutdown") },
    ]);

    menu.popup({ window: win });
  });

  win.loadURL(url);

  win.on("ready-to-show", () => win.setAlwaysOnTop(true, "screen-saver"));

  app.on("window-all-closed", () => app.quit());
});
