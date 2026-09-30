/**
 * pet-electron.cjs — Electron 主进程
 *
 * 启动方式：宿主（app/host.cjs）用 `electron pet-electron.cjs <port>` 拉起。
 * 职责：开一扇全屏透明置顶窗，加载宿主提供的 http://127.0.0.1:<port>。
 *
 * 鼠标命中：窗是全屏的，但**只有宠物那块能被点到**（别处的点击要落到下面的窗口上）。
 *   Windows/Linux 用 setShape() 把整窗的命中区裁成宠物的包围盒，渲染进程每次动一动
 *   （漫游 / 拖拽 / 换位置 / 冒气泡）就把新包围盒经 preload 送过来。
 *   ⚠️ 别再用「鼠标进命中框 → setIgnoreMouseEvents(false)」那套：窗是全屏的，一关穿透
 *   整块屏幕的点击都被这扇透明窗吃掉，下面所有窗口都点不动（卡死），必须把鼠标移出
 *   宠物才恢复。老 Electron 没有 setShape 时才退回那套（见下）。
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

/** 数据目录（拿不到 token 时用它报错）：优先 paths.cjs，再按平台惯例算一遍。 */
function homeDir() {
  try {
    return require(path.join(PKG_ROOT, "app", "paths.cjs")).PATHS.home;
  } catch {
    /* 被打包成 asar / 被单独拷走时的兜底 */
  }
  if (process.env.PI_PET_HOME) return process.env.PI_PET_HOME;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "pi-dsh-pet");
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "pi-dsh-pet");
  }
  return path.join(os.homedir(), ".pi-dsh-pet");
}

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

/**
 * token 与数据目录。
 *
 * 口径：**宿主经 PI_PET_TOKEN 环境变量给的才是权威的**（app/window.cjs 拉起窗时塞进去的）。
 * 以前只认 home/token 文件：那个文件没了、或临时 home 把它盖了、或窗的 PI_PET_HOME 和
 * 宿主不是同一个时，窗读出来是空串，而且静默当没事 —— 结果菜单里每个动作都被 401 拒掉，
 * 用户只看到一句「操作没成功：unauthorized」，完全指不到「token 没读到」上。
 * 文件只当兜底；两条都空时把路径报出来，别再装哑巴。
 */
function readTokenAndHome() {
  const fromEnv = String(process.env.PI_PET_TOKEN || "").trim();
  if (fromEnv) return { token: fromEnv, home: homeDir(), fromEnv: true };
  const home = homeDir();
  let token = "";
  try {
    token = fs.readFileSync(path.join(home, "token"), "utf8").trim();
  } catch {
    /* 拿不到就是拿不到（下面 failureDetail 会把它说清楚） */
  }
  if (process.env.PI_PET_DEBUG === "1") {
    console.error(`[pi-dsh-pet] 没收到 PI_PET_TOKEN，兜底读 ${path.join(home, "token")} → ${token ? "有" : "空"}`);
  }
  return { token, home, fromEnv: false };
}

/** 失败弹窗里那句人话：401 必须指向「token 没读到」，别让人对着 unauthorized 猜。 */
function failureDetail(home, res, what) {
  const why = res ? res.error || "unknown" : "no response";
  const lines = [`${what}：${why}`];
  if (!res || why === "unauthorized") {
    lines.push(
      "",
      "宿主不认这扇窗的 token —— 鉴权 token 没读到（窗本来是从 PI_PET_TOKEN 环境变量拿的）。",
      `兜底路径：${path.join(home, "token")}`,
      "常见原因：数据目录被换过（PI_PET_HOME）、或那个 token 文件被删了。",
      "解法：`pi-pet stop` 再 `pi-pet start`（会重新生成 token 并交给窗）。",
    );
  }
  return lines.join("\n");
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

  // ---- 命中区：把整窗的鼠标命中裁到宠物身上 ----
  const SHAPE_OK = typeof win.setShape === "function" && process.env.PI_PET_NO_SHAPE !== "1";
  let shapeBroken = false;
  let gotRegion = false;

  if (SHAPE_OK) {
    // 窗口一直收事件；「谁能点到」交给 setShape。开始先给一个 1×1 的点，
    // 免得渲染进程还没算出包围盒时整屏透明窗把点击全吃了。
    // （PI_PET_NO_SHAPE=1 只用来排查「形状模式是不是坏了」，别在正常运行时开）
    win.setIgnoreMouseEvents(false);
    try {
      win.setShape([{ x: 0, y: 0, width: 1, height: 1 }]);
    } catch {
      /* 极端环境下失败就等第一次上报 */
    }
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  // 渲染进程：新的命中包围盒（窗口坐标）
  ipcMain.on("pet:hit-region", (_event, rects) => {
    if (process.env.PI_PET_DEBUG === "1") {
      console.error(`[pi-dsh-pet] hit-region 收到 ${JSON.stringify(rects)}（shape=${SHAPE_OK} broken=${shapeBroken}）`);
    }
    if (!SHAPE_OK || shapeBroken || win.isDestroyed()) return;
    // 宠物漫游/拖拽时每 50ms 一帧，别拿非法形状去砸 SetWindowRgn
    const list = (Array.isArray(rects) ? rects : [])
      .map((r) => ({
        x: Math.max(0, Math.floor(Number(r && r.x) || 0)),
        y: Math.max(0, Math.floor(Number(r && r.y) || 0)),
        width: Math.ceil(Number(r && r.width) || 0),
        height: Math.ceil(Number(r && r.height) || 0),
      }))
      .filter((r) => r.width > 0 && r.height > 0);
    if (!list.length) return; // 没算出来就保持上一次，别把窗弄没了
    gotRegion = true;
    try {
      win.setShape(list);
    } catch (err) {
      // 不支持 / 形状非法：永久退回开关式穿透，别反复抛
      shapeBroken = true;
      console.error("[pi-dsh-pet] setShape 失败，退回开关式穿透：", err && err.message);
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // 兜底：没有 setShape（或它坏了）时，渲染进程仍用老协议开关穿透
  ipcMain.on("pet:passthrough", (_event, on) => {
    if ((SHAPE_OK && !shapeBroken) || win.isDestroyed()) return; // 命中由 shape 管，别再开关
    if (on) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });

  // 加载完 5s 还没拿到包围盒 = 渲染进程没起来（配置拉失败、pet.js 报错…）。
  // 这时候宁可让整窗不可命中，也别让它当一整块矩形拦在屏幕最上层：
  // ⚠️ 这里**不能**用 setShape([]) —— 传空数组 = “恢复默认矩形”，正好是反效果
  //（整屏透明窗把下面所有窗口的点击全吃掉，必须把鼠标移出那块 1×1 才恢复）。
  // 「整窗不收鼠标事件」只有 setIgnoreMouseEvents(true) 这一条路。
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (gotRegion || shapeBroken || win.isDestroyed()) return;
      console.error("[pi-dsh-pet] 5s 内没收到命中区（渲染进程没起来？）→ 整窗穿透，别挡屏幕");
      win.setIgnoreMouseEvents(true, { forward: true });
    }, 5000);
  });

  // 给渲染进程回话的快捷方式（“说点什么…”）
  webContentsSend = (channel) => {
    if (!win.isDestroyed()) win.webContents.send(channel);
  };

  // PI_PET_DEBUG=1：把渲染进程的 console 转到主进程 stderr。
  // 平时窗是 detached + stdio:"ignore" 的，渲染进程报什么都没人看得见，
  // 调 pet.js 时只能靠猜 —— 有了这个开关就能直接看到它抛了什么。
  // 两个 Electron 版本的 console-message 签名不一样（老的传 level/message，
  // 新的第一个参数是 event 对象），两种都收。
  if (process.env.PI_PET_DEBUG === "1") {
    win.webContents.on("console-message", (...args) => {
      const ev = args.length >= 2 && args[0] && typeof args[0] === "object" ? args[0] : null;
      const level = ev ? ev.level : args[0];
      const message = ev ? ev.message : args[1];
      const line = ev ? ev.lineNumber : args[2];
      const source = ev ? ev.sourceId : args[3];
      console.error(`[pet.js:${level}] ${message} (${source}:${line})`);
    });
  }

  // 渲染进程：宿主退出 / WS 断了 → 自己关
  ipcMain.on("pet:close", () => app.quit());

  // 渲染进程：“说点什么…” → 把输入框叫到宠物头上（输入框长在气泡里）
  ipcMain.on("pet:say-ask", () => {
    // ⚠️ 顺序要紧：先让窗可聚焦，再叫渲染进程 focus()。反过来 focus 就落在一扇
    // focusable:false 的窗上，DOM 焦点会被系统丢掉（打不进字、Esc 也关不掉）。
    setInputMode(true);
    if (webContentsSend) webContentsSend("pet:say-ask");
  });

  // 渲染进程：输入框收工（Enter / Esc / 点别处 / 失焦）→ 把键盘焦点还给下面的窗口
  ipcMain.on("pet:say-input-end", () => setInputMode(false));

  // 渲染进程 → 主进程：用户手动说的话。走宿主 /control（主进程有 token）
  ipcMain.on("pet:say-submit", async (_event, text) => {
    const t = String(text == null ? "" : text).trim();
    if (!t) return;
    const { token, home } = readTokenAndHome();
    const res = await callHost("say", { text: t }, token);
    if (!res || res.ok !== true) {
      dialog.showMessageBox({
        type: "warning",
        message: "没能说出来",
        detail: failureDetail(home, res, "宿主没应答"),
        buttons: ["好"],
      });
    }
  });

  // 渲染进程：右键菜单
  ipcMain.on("pet:menu", async (_event, info = {}) => {
    // 菜单开着的时候输入框必然已经废了（原生菜单自己拿走了焦点）：顺手收掉，
    // 不然用户会对着一个打不了字、也关不掉的框干瞪眼。
    if (inputMode) {
      if (webContentsSend) webContentsSend("pet:say-cancel");
      setInputMode(false);
    }
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
          detail: failureDetail(home, res, `宿主（127.0.0.1:${port}）没应答或拒绝了`),
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

  // ---- 输入模式：只在输入框开着的那一小会儿让窗可聚焦 ----
  // 窗平时 focusable:false —— 点宠物也不把你正在打字的窗口抢走。但那样的窗**拿不到
  // 键盘焦点**：DOM 里的 input.focus() 会被系统丢掉，于是键既打不进框、也关不掉框
  //（框还一直挂在屏幕上，因为关框只有 Esc 和 Enter 两条路，都走键盘）。
  let inputMode = false;
  let inputModeAt = 0;

  function setInputMode(on) {
    if (inputMode === on || win.isDestroyed()) return;
    inputMode = on;
    if (on) inputModeAt = Date.now();
    try {
      if (process.platform === "darwin") win.setFocusableOnMac(on);
      else win.setFocusable(on);
    } catch (err) {
      console.error("[pi-dsh-pet] 切可聚焦失败：", err && err.message);
    }
    if (!on) {
      // 先 blur 再撤可聚焦：不可聚焦的窗交不出焦点，下面那个窗口才拿得回去
      try { win.blur(); } catch { /* ignore */ }
    } else {
      // 光「可聚焦」还不够，得真的把它激活，DOM 焦点才留得住
      try { win.focus(); } catch { /* ignore */ }
    }
  }

  // 兜底：输入框开着的时候焦点跑掉了（用户点了别的程序）→ 叫渲染进程把框收掉。
  // 别让一个打不了字又关不掉的框永远挂在屏幕上。
  win.on("blur", () => {
    if (!inputMode || win.isDestroyed()) return;
    if (Date.now() - inputModeAt < 800) return; // 刚叫出来的那一下不算（原生菜单收起时的失焦）
    if (webContentsSend) webContentsSend("pet:say-cancel");
    setInputMode(false);
  });

  // 窗被收起来/关掉时复位，免得下次调用被 inputMode 卡住
  win.on("hide", () => { inputMode = false; });
  win.on("closed", () => { inputMode = false; });

  win.loadURL(url);

  win.on("ready-to-show", () => win.setAlwaysOnTop(true, "screen-saver"));

  app.on("window-all-closed", () => app.quit());
});
