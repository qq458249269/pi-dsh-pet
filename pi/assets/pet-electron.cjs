/**
 * pet-electron.cjs — Electron 主进程
 *
 * 启动方式：宿主（app/host.cjs）用 `electron pet-electron.cjs <port>` 拉起。
 * 职责：开一扇**只包住宠物的小**透明置顶窗，加载宿主提供的 http://127.0.0.1:<port>。
 *
 * ⚠️⚠️ 千万别把这扇窗改回「全屏」。全屏透明置顶窗是桌面宠物的头号性能杀手：
 *   ① 它每产生一帧，DWM 都得把**整块桌面**重新合成一遍（连着下面所有窗口一起），
 *      也就是在跟别的程序抢合成预算 —— 症状就是「桌宠一开，浏览器/IDE 的后台
 *      窗口就不刷新了」。窗口小 10 倍，单帧填充率就小 10 倍。
 *   ② 全屏意味着它跟**每一扇**窗都相交，Windows 于是没法把任何后台窗口判成
 *      「被遮住了」，那些窗口就一直满速画，没人帮它们降频。
 *   所以：窗 = 宠物的小舞台（pet.js 那边按窗口尺寸算漫游/气泡夹取，不变），
 *   想把宠物放到屏幕别处就**搬窗**（拖宠物 = 搬窗，见 pet:window-move）。
 *
 * 鼠标命中：窗里大部分是空的，但**只有宠物那块能被点到**（别处的点击要落到下面的窗口上）。
 *   Windows/Linux 用 setShape() 把整窗的命中区裁成宠物的包围盒，渲染进程每次动一动
 *   （漫游 / 换位置 / 冒气泡）就把新包围盒经 preload 送过来。
 *   ⚠️ 别再用「鼠标进命中框 → setIgnoreMouseEvents(false)」那套：虽然窗小了，但一关
 *   穿透这一块（连气泡）的点击就被吃掉。老 Electron 没有 setShape 时才退回那套（见下）。
 *
 * 右键菜单：渲染进程把「当前状态/只数/命中信息」发过来，主进程在这里拼原生菜单，
 * 菜单项的动作**全部走宿主的控制面**（POST /control，带 token）——
 * 也就是说菜单和 pi/dsh/curl 用的是同一套 API，宿主是唯一的状态持有者。
 *
 * 用法：npx electron pet-electron.cjs <port>
 *        （打包版里不需要这么起：`pi-dsh-pet.exe --pi-pet-window <port>` 会 require 本文件）
 */

const { app, BrowserWindow, Menu, dialog, shell, clipboard, screen, ipcMain, powerMonitor } = require("electron");
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

// ---- 别让 Windows 把「被遮住了」当成「不用画了」 ----
// 症状：宠物走过的地方留下旧画面（残影/脏区），鼠标点一下或把窗口激活到前台就好了。
// 病根：Chromium 按 Windows 的遮挡判定做节流 —— 这扇窗 focusable:false + 置顶 + 每帧搬，
//   经常被判成 occluded，于是**不再产生帧**；屏幕上的像素就一直停在上一次合成。
//   （注意：这是「不刷新」，不是 pet.js 的冻住开关 —— 那个已在 pet.js 里关掉。）
// disable-features 里多个项用逗号连着写，分两次 appendSwitch 会互相覆盖掉。
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,WinUseBrowserSpellChecker");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}

// PI_PET_SOFTWARE_COMPOSITE=1：关 GPU 合成走软件合成。透明置顶窗的「残留旧画面」
// 如果来自合成器（而不是没人重绘），软件合成往往就没有它。
// 代价：VP9 视频转软解 + 每帧 CPU 填充 —— 这扇窗小，实测影响有限。
// 先当排查开关用（能稳定就不开；真的省不下来再定）。
if (process.env.PI_PET_SOFTWARE_COMPOSITE === "1") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  console.error("[pi-dsh-pet] 软件合成（PI_PET_SOFTWARE_COMPOSITE=1）");
}

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

/** 调宿主的控制面。所有菜单项的动作都走这里，不在 Electron 侧另搞一套状态。
 *  timeoutMs：更新类动作（git fetch / npm i -g）要另给，默认 2.5s 不够。 */
function callHost(action, body, token, timeoutMs) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ action, ...(body || {}) }), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/control",
        method: "POST",
        timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 2500,
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

/**
 * 窗的落点记忆（home/stage.json）：{x, y}，窗左上角的屏幕坐标。
 * 搬过窗（拖宠物）就记住，下次启动还在那儿 —— 不然每次都弹回右下角。
 */
function readStagePos(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "stage.json"), "utf8"));
    const x = Math.round(Number(j && j.x));
    const y = Math.round(Number(j && j.y));
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  } catch {
    /* 没有 / 坏了就用默认角落 */
  }
  return null;
}

function writeStagePos(home, pos) {
  try {
    fs.writeFileSync(path.join(home, "stage.json"), JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
  } catch (err) {
    // 落盘失败不打断用户（这次不记住，下次还是默认角落而已）
    console.error("[pi-dsh-pet] 窗位置没记住：", err && err.message);
  }
}

app.whenReady().then(() => {
  const { home } = readTokenAndHome();
  // 舞台尺寸：先按常规档摆，渲染进程拿到配置后会报准数（pet:window-size）。
  const STAGE = { w: 620, h: 560 };

  // 默认摆在主屏右下角（宠物在舞台里也是靠下的，观感上就是「趴在右下角」）。
  const wa0 = screen.getPrimaryDisplay().workArea;
  const saved = readStagePos(home);
  const start = saved && screen.getAllDisplays().length
    ? (() => {
        const d = screen.getDisplayNearestPoint({ x: saved.x + 20, y: saved.y + 20 });
        const w = d.workArea;
        // 显示器拔过/分辨率变过时旧坐标可能整个跑到屏幕外 → 夹回来
        return {
          x: Math.min(Math.max(saved.x, w.x - STAGE.w + 60), w.x + w.width - 60),
          y: Math.min(Math.max(saved.y, w.y - 40), w.y + w.height - 40),
        };
      })()
    : { x: wa0.x + wa0.width - STAGE.w - 24, y: wa0.y + wa0.height - STAGE.h - 8 };

// 透明置顶浮层：**只有宠物这么点大**，不是全屏（见文件头「别改回全屏」）。
  // setIgnoreMouseEvents 让点击穿透到下面的窗口；命中框由渲染进程动态开/关。
  //
  // ⚠️ PI_PET_TOPMODE：置顶/透明路径的三种排法（都是为治「窗周围一片别的软件的画面
  //   被锁住、鼠标点一下才刷新」）。前面的重画类修法全试过仍复现后，才轮到动**合成路径**。
  //   0 = 默认（transparent + alwaysOnTop）
  //   1 = alwaysOnTop 走 'screen-saver' 层级（DWM 另一条合成路径）
  //   2 = 干脆不置顶，每 1.5s showInactive() 把自己顶上来一次
  //   3 = **不透明**：窗用实底色，放弃逐像素透明（最难看，但 DWM 没有透明层可留快照）
  const TOPMODE = Number(process.env.PI_PET_TOPMODE || 0) || 0;
  const win = new BrowserWindow({
    width: STAGE.w,
    height: STAGE.h,
    x: start.x,
    y: start.y,
    frame: false,
    transparent: TOPMODE !== 3,
    backgroundColor: TOPMODE === 3 ? "#0e0e12" : undefined,
    alwaysOnTop: TOPMODE !== 2,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // ⚠️⚠️ 后台节流得关（症状：宽动画换成窄动画后，窗口空出来的那两条侧边会**锁住**
      //   不重画**，屏幕上留着上一段的旧画面；鼠标点一下/把窗激活到前台才恢复）。
      //   病根：这扇窗 focusable:false + 置顶，Chromium 常判它「看不见/在后台」，
      //   于是不再驱动重绘 —— 而窗口缩小后新空出来的那块区域**没人去清**，
      //   旧像素就一直停在那里。进程级的三个开关（disable-backgrounding-occluded-windows /
      //   disable-renderer-backgrounding / CalculateNativeWinOcclusion，见文件上方）
      // 压的是浏览器进程那一层，这一条是**渲染进程自己的**节流开关，两边都得关。
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // ---- 窗的落点：自己记一份，别信 win.getPosition() ----
  //
  // ⚠️ 踩过的坑（症状：宿主说「窗已连上」，屏幕上却什么都没有）：
  //   渲染进程加载完立刻报 `pet:window-size`，而这一刻窗**还没真正映射**（loadURL 之后、
  //   ready-to-show 之前），`win.getPosition()` 返回的是 **[NaN, NaN]**。把它塞进
  //   setBounds，Chromium 就把整扇窗塌成 (0,0) 处一个 **32x39** 的残骸：
  //     [pi-dsh-pet] 舞台窗 → 620x560 @ NaN,NaN
  //     [pi-dsh-pet] hit-region 收到 [{"x":-296,"y":-176,…}]   ← 视口只剩 32x39，宠物跑到框外
  //   窗还活着、WS 还连着、服务一切正常，只是**画不出来**（32x39 的视口装不下 400px 的宠物）。
  // 所以：落点以「我们自己记的这份」为准，getPosition() 只在它是有限数的时候才采信；
  // 所有喂给 setBounds/setPosition 的数都过一遍有限性检查。
  let stagePos = { x: Math.round(start.x), y: Math.round(start.y) };
  /** 记住落点（move/resize 事件带来的 bounds 是真整数，比 getPosition() 可靠）。 */
  function rememberPos(pos) {
    const x = Math.round(Number(pos && pos.x !== undefined ? pos.x : pos && pos[0]));
    const y = Math.round(Number(pos && pos.y !== undefined ? pos.y : pos && pos[1]));
    if (Number.isFinite(x) && Number.isFinite(y)) stagePos = { x, y };
    return stagePos;
  }
  /** 读窗当前落点：getPosition() 读不到（NaN）就退回自己记的那份。 */
  function currentPos() {
    try {
      const p = win.getPosition();
      return rememberPos({ x: p && p[0], y: p && p[1] });
    } catch {
      return { x: stagePos.x, y: stagePos.y };
    }
  }
// 窗被别人搬了/改了大小（用户拖、多屏变化、系统贴靠）也同步过来
win.on("move", (_e, b) => rememberPos(b));

  // ---- PI_PET_TOPMODE 1/2：换一条置顶路径（见上面 TOPMODE 的说明）----
  if (TOPMODE === 1) {
    win.setAlwaysOnTop(true, "screen-saver");
    console.error("[pi-dsh-pet] TOPMODE=1：alwaysOnTop 走 screen-saver 层级");
  }
  if (TOPMODE === 2) {
    // 不置顶 = 不占置顶通道；靠定时把自己顶上来。showInactive 不抢焦点，
    // 代价：别的窗盖上来时会有最多 1.5s 的延迟才被顶回去（用户能看见）。
    setInterval(() => {
      if (win.isDestroyed() || !win.isVisible()) return;
      try {
        win.showInactive();
      } catch {
        /* 窗刚关/正在关，忽略 */
      }
    }, 1500).unref?.();
    console.error("[pi-dsh-pet] TOPMODE=2：不置顶，每 1.5s showInactive 顶一次");
  }
  // ⚠️ resize 除了记落点，还得把形状**重新裁一遍**（§9.21）：形状是 Win32 的窗口区域，
  //   窗一变（启动时按配置长大、往上长、显示器/DPI 变化）Chromium 可能按旧尺寸重建它，
  //   甚至丢掉 —— 形状一丢 = 整窗点得动，下面软件的点击全被透明区吃掉，
  //   而这正是「窗一变大就点不到别的软件」的那种症状。一次 resize 一次 SetWindowRgn，
  //   稀罕事件，不心疼（漫游那才叫频，那边有 60ms 节流）。
  win.on("resize", (_e, b) => {
    rememberPos(b);
    resyncShape();
  });

// ---- 命中区：把整窗的鼠标命中裁到宠物身上 ----
// ⚠️⚠️ 形状裁剪**默认关闭**（PI_PET_SHAPE=1 才开）。
  //   实测定案（PI_PET_NO_SHAPE=1 不锁，开着就锁）：病根就是 Win32 的 SetWindowRgn ——
  //   窗口区域一收窄，窗就**不再覆盖**那块屏幕，Win32 不会因为「这块不再被覆盖」去让
  //   DWM 重新合成底下的窗口，没人给脏区，屏幕上就留着**其他软件当时的画面**
  //   （宠物本体照常动、周围一圈被锁住，鼠标点一下才恢复）。
  //   让出前先盖满整窗逼它重合成（见 applyShape 里的 SHAPE_DIRTY_FIX）实测**无效**，
  //   收窄就是收窄。所以默认走**开关式穿透**：setIgnoreMouseEvents 动态开关（早就实现着，
  //   见 pet:passthrough），不用窗口区域，就没有那片没人合成的像素。
  //   代价：光标不在宠物/气泡上时，整窗都穿透不了 —— 也就是宠物旁边的透明区会吃掉点击。
  //   想要精确命中区（宁可容忍锁帧）的人可以 PI_PET_SHAPE=1 切回去。
  const SHAPE_OK = process.env.PI_PET_SHAPE === "1" && typeof win.setShape === "function";
  let shapeBroken = false;
  let gotRegion = false;

  /**
   * 改完窗/形状后叫它整窗重画一次（`webContents.invalidate()` = 排一次全窗重绘）。
   *
   * 症状：窗两侧空出来的透明长方形**锁住不重画**，屏幕上留着上一段动画的旧画面，
   *   鼠标点一下或把窗激活到前台才恢复。病根与 backgroundThrottling 无关（那个已关）：
   *   改形状/改尺寸只让 Win32 那边的窗口区域变，**Chromium 不认为内容脏**，
   *   于是没有重绘指令 → 空区新内容没机会写上去，旧像素就一直停着。
   *
   * 为什么要合并（repaintPending）：漫游时形状 20fps、搬窗也是每次都来，
   *   每次都排一次全窗重绘 = 每帧整窗填充，白白跟别的窗口抢合成预算。
   *   16ms 内的请求攒成一次就够 —— 反正这一帧内本来也只画一次。
   */
  let repaintPending = false;
function nudgeRepaint() {
    if (repaintPending || win.isDestroyed()) return;
    repaintPending = true;
    setTimeout(() => {
      repaintPending = false;
      if (win.isDestroyed()) return;
      try {
        win.webContents.invalidate();
      } catch (err) {
        // 老内核没这 API：静默回落（那时的行为就是今天的样子，不是新问题）
      }
}, 16);
  }

  /**
   * 兼底：每 400ms 一次整窗重画（仅当窗可见）。
   * 为什么要兼底：命中区上报会把**同一块矩形**去重（SHAPE_EPS 量化），宠物在原地
   * 眨眼/播待机动画时压根不上报 —— 可那些帧一样会把窗里的像素重新画一遍，
   * 周围那片区域该擦还是得擦。400ms 一次 = 620×560 约 1.4MB 的拷贝，可以忽略。
   * ponytail: 若证实「只有内容变脏时才需要」就把这个兼底去掉（拿事件驱动换这点开销）；
   *   升级路径 = 主进程统计 invalidate 实际次数，超过 ~10/s 就收掉计时器。
   */
  const REPINT_TICK_MS = Number(process.env.PI_PET_REPAINT_MS) || 400;
  setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return;
    nudgeRepaint();
  }, REPINT_TICK_MS).unref?.();
/** SetWindowRgn 是重活：改一次形状就要让 DWM 把这扇窗这块地方重新合成一遍
   *  （也就是又一次跟别的窗口抢合成预算）。所以两头都掐着：
   *    ① 量化到 2px —— 亚像素抖动不重画（不动的宠物不该一直重画）；
   *    ② 两次之间至少隔 SHAPE_GAP_MS —— 漫游时渲染进程 20fps 的上报不能变成
   *       20 次 SetWindowRgn；被节流的那次**攒最新的一份**（落点不能丢）。 */
  const SHAPE_EPS = 2;
  const SHAPE_GAP_MS = 60;
let shapeKey = "";
  let lastShape = null;
  /** 上一次形状的总面积（px²）：变小 = 这次让出了像素，得先盖满整窗逼 DWM 重合成。 */
  let prevShapeArea = 0;
  // PI_PET_SHAPE_DIRTY=0 可关掉这个兼底（只用来 A/B：确认锁帧确实来自 SetWindowRgn）
  const SHAPE_DIRTY_FIX = process.env.PI_PET_SHAPE_DIRTY !== "0";
  /**
   * 窗变过之后把上一次的形状原样重裁一遍（窗变尺寸时形状本身不用改，
   *   但 Win32 那边的窗口区域得重新盖到新窗上）。
   * 同时清掉 shapeKey：这样渲染进程下一次哪怕报一模一样的矩形，也真的会重裁
   * （不然会被去重吃掉，“重放”就白做了）。
   */
  function resyncShape() {
    if (!SHAPE_OK || shapeBroken || win.isDestroyed()) return;
    if (!lastShape || !lastShape.length) return;
    shapeKey = "";
    shapePending = null;
    if (shapeTimer) {
      clearTimeout(shapeTimer);
      shapeTimer = null;
    }
    applyShape(lastShape);
  }
  let shapeAt = 0;
  let shapeTimer = null;
  let shapePending = null;
  let shapeApplied = false;

  /** 真的裁形状。失败（老内核 / 非法形状）就永久退回开关式穿透，别反复抛。 */
function applyShape(list) {
    if (!SHAPE_OK || shapeBroken || win.isDestroyed()) return;
    // 窗都看不见了，裁形状没意义（后面有上报时自然会补上）。
    // ⚠️ 但「一次都没裁过」的时候不能跳：跳过就等于没有形状 = 整窗点不动，
    //   而上面已经记下 shapeKey，同一份形状会被去重掉，永远补不回来。
    if (shapeApplied && !win.isVisible()) return;
try {
// ⚠️⚠️ 让出像素时必须**先把整窗盖满、再收回去**（已实测：病根就在 SetWindowRgn）。
      //   症状：宠物走过的地方，屏幕上留着**其他软件当时的画面**（宠物本体照常动，
      //   周围一圈被锁住，鼠标点一下才恢复）。PI_PET_NO_SHAPE=1 时完全不锁 —— 定案。
      //   原因：窗口区域一旦收窄，窗就**不再覆盖**那块屏幕，但 Win32 不会因为
      //   「这块不再被覆盖」去让 DWM 重新合成底下的窗口 —— 没人给它脏区，
      //   合成缓存里就留着上一次的内容。而 invalidate() 对这片无用（它已经不属于本窗）。
      //   先盖满整窗（SetWindowRgn 变更本身会把整窗标脏）再收回去，那片就重新合成了。
      //   只在「面积变小」时多做一次：漫游中形状基本只增不减，别白付两次 SetWindowRgn。
      const area = (list) => list.reduce((s, r) => s + Math.max(0, r.width) * Math.max(0, r.height), 0);
      if (SHAPE_DIRTY_FIX && prevShapeArea > area(list)) {
        try {
          const b = win.getBounds();
          win.setShape([{ x: 0, y: 0, width: b.width, height: b.height }]);
        } catch {
          /* 拿不到 bounds 就跳过这一步，退回原来的单次设置 */
        }
      }
      prevShapeArea = area(list);
      win.setShape(list);
      shapeAt = Date.now();
      shapeApplied = true;
      lastShape = list; // 窗变尺寸后要重放的就是它（见 resyncShape）
      nudgeRepaint(); // 形状变了 → 整窗重画一次，别让空出来的侧边锁住（见 nudgeRepaint）
    } catch (err) {
      shapeBroken = true;
      console.error("[pi-dsh-pet] setShape 失败，退回开关式穿透：", err && err.message);
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  if (SHAPE_OK) {
    // 窗口一直收事件；「谁能点到」交给 setShape。开始先给一个 1×1 的点，
    // 免得渲染进程还没算出包围盒时这整块透明窗把点击吃了。
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
    // ⚠️ 宠物在窗**里面**动（漫游/拖/冒气泡，每帧都报）时，窗外没变、形状多半也没变，
    //   但窗里宠物原来占的那块像素刚变成透明 —— 那片区域必须被重画，
    //   否则屏幕上留着的是**窗移动前下面那些软件的画面**（本体照常动，周围的桌面被锁住，
    //   鼠标点一下才刷新）。命中区上报就是「窗里内容动了」的最廉价信号。
    // 16ms 内合并（见 nudgeRepaint），漫游 20fps 不会变成 20 次全窗填充。
    nudgeRepaint();
if (!SHAPE_OK || shapeBroken || win.isDestroyed()) return;
    // ⚠️ 夹进窗内（§9.21）：不能只 Math.max(0, x) —— 那样只是把左上角推回 0 而宽高不变，
    //   整块形状会「平移」到窗角上（宠物贴边/漫游出界时报的就是这种），透明区就点不动了。
    let winW = 0;
    let winH = 0;
    try {
      const cb = win.getContentBounds();
      winW = Number(cb && cb.width) || 0;
      winH = Number(cb && cb.height) || 0;
    } catch {
      /* 窗还没映射：量不到就不夹 */
    }
    // 量化到 SHAPE_EPS 的网格：1px 的抖动不值得让 DWM 重算一次全屏
    const list = (Array.isArray(rects) ? rects : [])
      .map((r) => {
        const x0 = Math.max(0, Math.round(Number(r && r.x) || 0));
        const y0 = Math.max(0, Math.round(Number(r && r.y) || 0));
        const x1 = Math.min(winW || Infinity, x0 + Math.ceil(Number(r && r.width) || 0));
        const y1 = Math.min(winH || Infinity, y0 + Math.ceil(Number(r && r.height) || 0));
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      })
      .map((r) => ({
        x: Math.round(r.x / SHAPE_EPS) * SHAPE_EPS,
        y: Math.round(r.y / SHAPE_EPS) * SHAPE_EPS,
        width: Math.max(SHAPE_EPS, Math.round(r.width / SHAPE_EPS) * SHAPE_EPS),
        height: Math.max(SHAPE_EPS, Math.round(r.height / SHAPE_EPS) * SHAPE_EPS),
      }))
      .filter((r) => r.width > 0 && r.height > 0);
    if (!list.length) return; // 没算出来就保持上一次，别把窗弄没了
    gotRegion = true;
    const key = list.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join("|");
    if (key === shapeKey) return; // 与上一次量化后一样：省掉一次跨进程 + 一次 SetWindowRgn
    shapeKey = key;
    const wait = SHAPE_GAP_MS - (Date.now() - shapeAt);
    if (wait <= 0) {
      if (shapeTimer) {
        clearTimeout(shapeTimer);
        shapeTimer = null;
      }
      shapePending = null;
      applyShape(list);
      return;
    }
    // 空档没到：攒着（取**最新**的一份，漫游的落点不能被旧的盖掉），到点再裁
    shapePending = list;
    if (shapeTimer) return;
    shapeTimer = setTimeout(() => {
      shapeTimer = null;
      const next = shapePending;
      shapePending = null;
      applyShape(next);
    }, wait);
  });

  // 兜底：没有 setShape（或它坏了）时，渲染进程仍用老协议开关穿透
  ipcMain.on("pet:passthrough", (_event, on) => {
    if ((SHAPE_OK && !shapeBroken) || win.isDestroyed()) return; // 命中由 shape 管，别再开关
    if (on) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });

  // ---- 舞台窗：尺寸 / 搬动 / 收工 ----
  //
  // 以前窗是全屏的，漫游和拖拽都在窗里进行。现在窗只包住宠物：想把它放到屏幕别处，
  // 就是**搬窗**（拖宠物 → 主进程搬窗，宠物在窗里的相对位置不变，所以看起来跟着手走）。
  // 这样单帧填充率小一个数量级，DWM 的合成压力也跟着小一个数量级。
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  /** 窗当前的内容尺寸 {w,h}（拿不到就 0）。
   *  ⚠️ getContentBounds() 在现代 Electron 返回**对象** {x,y,width,height}，老版本返回
   *     数组 [x,y,w,h] —— 两种都认。写死 cb[2]/cb[3] 的话现代版上永远是 undefined，
   *     于是「已经是这个大小了」那类判断全部失效（见 §9.21）。 */
  function contentSize() {
    try {
      const cb = win.getContentBounds();
      return {
        w: Number(cb && (cb.width !== undefined ? cb.width : cb[2])) || 0,
        h: Number(cb && (cb.height !== undefined ? cb.height : cb[3])) || 0,
      };
    } catch {
      return { w: 0, h: 0 };
    }
  }

  /** 把窗夹在某块屏的工作区里（至少露出 minVis）。pos 是期望的左上角。
   *  ⚠️ NaN 一律当「不知道」处理：Math.min/max 遇到 NaN 会把整条式子变成 NaN，
   *     而 NaN 坐标喂给 setBounds 就是上面那个 32x39 残骸窗。 */
  function clampToDisplay(pos, minVis) {
    const p = {
      x: Number.isFinite(Number(pos && pos.x)) ? Number(pos.x) : stagePos.x,
      y: Number.isFinite(Number(pos && pos.y)) ? Number(pos.y) : stagePos.y,
    };
    const vis = {
      w: Math.max(1, Math.min(Number(minVis && minVis.w) || STAGE.w, 6000)),
      h: Math.max(1, Math.min(Number(minVis && minVis.h) || STAGE.h, 6000)),
    };
    const d = screen.getDisplayNearestPoint({ x: p.x + 40, y: p.y + 40 });
    const w = d.workArea;
    return {
      x: Math.round(Math.min(Math.max(p.x, w.x - vis.w + 60), w.x + w.width - vis.w)),
      y: Math.round(Math.min(Math.max(p.y, w.y - vis.h + 60), w.y + w.height - vis.h)),
    };
  }

  /**
   * 真的把窗摆到某个位置/尺寸，并在**当场**核对一次。
   *
   * ⚠️ 只改**尺寸**，左上角不动：宠物在窗里的偏移是常量（贴边角就是这么摆的），
   *   窗左上不动 → 宠物在屏幕上不跳一像素，透明区也还是原来那几块（形状跟着重裁）。
   *   早先试过「按宠物贴住的角挪窗」（§9.21）：高度差里只有一部分来自头顶偏移，
   *   按高度差挪会把宠物挪走 40px、窗还挂到屏幕外头 —— 量过就废了。
   *
   * 为什么要核对：上面那个坑的可怕之处是 setBounds **不报错** —— NaN 坐标被静默接受，
   * 窗塌成 32x39，宿主/WS/菜单全都正常，只有屏幕上没有宠物。所以摆完必须量一下：
   * 量出来不是我们要的（差了 1px 以上，或者压根量不到有限数），就再摆一次并打日志。
   * 只重试一次，绝不循环。
   */
function applyBounds(width, height) {
    // 只改尺寸，**左上角不动**：宠物在窗里的偏移是常量（贴边角），窗左上不动，
    // 它在屏幕上的位置就一像素也不动。锚哪条边去挪窗反而会把宠物挪走（§9.21 实测）。
    const at = clampToDisplay(currentPos(), { w: width, h: height });
    const bounds = { x: at.x, y: at.y, width, height };
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) {
      console.error(`[pi-dsh-pet] 落点算不出来（${bounds.x},${bounds.y}），放弃改窗`);
      return false;
    }
try {
      win.setBounds(bounds);
      rememberPos(at);
      nudgeRepaint(); // 尺寸变了 → 空出来的那圈必须重画（见 nudgeRepaint）
    } catch (err) {
      console.error("[pi-dsh-pet] setBounds 失败：", err && err.message);
      return false;
    }
    const got = win.getBounds();
    const ok =
      Number.isFinite(got && got.width) && Math.abs(got.width - width) <= 1 && Math.abs(got.height - height) <= 1;
    if (ok) {
      console.error(`[pi-dsh-pet] 舞台窗 → ${width}x${height} @ ${bounds.x},${bounds.y}`);
      return true;
    }
    // 摆完不是我们要的样子（多半被什么东西改回去了：贴靠、多屏变化、或上面那种静默塌陷）
    console.error(
      `[pi-dsh-pet] 窗没摆成（要 ${width}x${height}，实际 ${got && got.width}x${got && got.height} @ ${got && got.x},${got && got.y}）→ 重摆一次`,
    );
    try {
      win.setBounds({ x: bounds.x, y: bounds.y, width, height });
    } catch {
      /* 重试也失败就算了，别把主进程搞崩 */
    }
    return false;
  }

  // 渲染进程报上来的舞台尺寸（它知道配置里最大的宠物 + 气泡要多少地方）
  //
  // 宽度下限 380：小于它动画就展示不全（见 pet.js 的 MIN_PET_SIZE）。
  // 渲染进程那边已经算好了窗宽（§9.24：max(动画宽, 气泡基准宽) + 余量），这里只扣一道底，
  // 免得哪次配置写小了、或者别的客户端直接报一个 100x100 上来，把窗抽成一条缝。
  const MIN_STAGE_W = 380;
  ipcMain.on("pet:window-size", (_event, m = {}) => {
    if (win.isDestroyed()) return;
    const w = Math.round(Math.min(Math.max(num(m.w, STAGE.w), MIN_STAGE_W), 6000));
    const h = Math.round(Math.min(Math.max(num(m.h, STAGE.h), 200), 6000));
    const cur = contentSize();
    if (w === cur.w && h === cur.h) return; // 已经是这个大小了
    applyBounds(w, h);
  });

  // 拖宠物 = 搬窗。dx/dy 是**屏幕坐标**里「从本次按下那下」算起的位移（不是每帧增量）：
  // 增量的话窗被夹在屏幕边时，宠物会越拖越落后于光标，松手才「啪」地弹回来。
  // ⚠️⚠️ 必须是**屏幕**位移（渲染进程拿 e.screenX/e.screenY 算），不能是 clientX/Y：
  //   clientX/Y 是**窗内**坐标 = 光标屏幕位置 - 窗原点，而窗正跟着拖拽一起动 ——
  //   每读到的 clientX 已经把「上一帧窗走过的距离」扣掉了。当成「从按下那下算起的绝对
  //   位移」用，每次就只补一半：匀速拖 300px 窗只走 150px（跟手比 0.50，还一格一格抖）。
  //   实测（真光标直线拖 300px，窗落点 5ms 采样）见 DESIGN.md §9.20。
  let windowDrag = null;
  ipcMain.on("pet:window-move", (_event, m = {}) => {
    if (win.isDestroyed()) return;
    const dx = num(m.dx, 0);
    const dy = num(m.dy, 0);
    if (!dx && !dy) return;
if (!windowDrag) {
// getPosition() 在窗没映射时会给 [NaN, NaN]（见上面 stagePos 的注释）→ 用自己记的。
      // ⚠️ currentPos() 返回的是 stagePos **本身**，要挂 w/h 就得先拷一份，别把
      //   两个用途（窗落点 / 本次拖拽的尺寸缓存）搅在同一个对象上。
      const cs0 = contentSize();
      windowDrag = Object.assign({}, currentPos(), { w: cs0.w, h: cs0.h });
    }
// 宠物在窗里的位置（渲染进程量好的）：用它选显示器（宠物跟着窗走，得按宠物落哪块屏算）
    const il = num(m.left, 0);
    const it = num(m.top, 0);
    const want = { x: windowDrag.x + dx, y: windowDrag.y + dy };
    const d = screen.getDisplayNearestPoint({ x: want.x + il + 20, y: want.y + it + 20 });
    const w = d.workArea;
    // ⚠️ 夹的是**整扇窗**进这块屏的工作区，不是「宠物别出屏」（早先夹的是后者：窗可以
    //   挂到屏外 il-6，宠物就能贴屏幕边，代价是窗有一截在屏外 —— 而气泡是按**窗**夹的
    //   （clampBubble 不知道屏幕），于是窗挂出去多少、气泡就在屏外看不见多少：
    //   实测窗顶挂出 120px 时，110px 的气泡有 90px 在屏外（§9.22）。
    //   代价要知道：宠物离屏边至少「它在窗里贴着的那条边」那么多（左右 200、顶上 150），
    //   拖到边上就顶住了 —— 这是「留白是宠物的禁区」这个选择的必然结果（§9.23）。
const cs = { w: num(windowDrag.w, 0), h: num(windowDrag.h, 0) };
    if (!cs.w || !cs.h) return; // 窗的尺寸都量不到就别搬：算出来的落点不可信
    const loX = w.x;
    const hiX = w.x + w.width - cs.w;
    const loY = w.y;
    const hiY = w.y + w.height - cs.h;
    // 窗比屏还宽/高时区间会翻过来（lo > hi）：这时靠上/靠左摆，别让 min/max 选到反的一头
    const pos = {
      x: Math.round(loX > hiX ? loX : Math.min(Math.max(want.x, loX), hiX)),
      y: Math.round(loY > hiY ? loY : Math.min(Math.max(want.y, loY), hiY)),
    };
    // 已经被夹在屏幕边上时 want 还在变、pos 却不动：这种「搬不动」的 move 全部丢掉。
    // 不丢也不会错，但是白白的 SetWindowPos + DWM 重合成，而且在边上会跟系统的
    // 窗口动画抢位置 —— 看上去就是拖着宠物在屏幕边上「哆嗦」。
    if (pos.x === stagePos.x && pos.y === stagePos.y) return;
win.setPosition(pos.x, pos.y);
    rememberPos(pos);
    nudgeRepaint(); // 搬完家重画一次（见 nudgeRepaint）
  });

  // 松手：记下窗的落点，下次启动还在这儿
  ipcMain.on("pet:window-drag-end", () => {
    if (!windowDrag || win.isDestroyed()) {
      windowDrag = null;
      return;
    }
    windowDrag = null;
    writeStagePos(home, currentPos());
  });

  // ---- 屏幕工作区：推给渲染进程一份（§9.25）----
  //
  // 拖宠物时「能不能贴到屏幕边」是两个自由度的事：屏幕位置 = 窗的位置 + 宠物在窗里的位置。
  // 主进程只管第一个（把整扇窗夹在屏内，§9.23），第二个自由度主进程看不见 ——
  // 于是窗一夹住，宠物就停在离屏边「它在窗里贴着的那条边」那么远（头顶 150、底下 60、
  // 左右 32），也就是「拖到边上还差一大块、贴不上」。
  // 修法在渲染进程（pet.js 的 slideTo）：拿这份工作区算出窗被夹住的**差额**，
  // 把差额挪到宠物在窗里的位置上。**不新增每帧 IPC**，只在这里推一次列表。
  function pushDisplays() {
    if (win.isDestroyed() || !webContentsSend) return;
    let list = [];
    try {
      list = screen.getAllDisplays().map((d) => ({
        bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
        workArea: { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
      }));
    } catch {
      return; // 量不到就保持上一次那份
    }
    webContentsSend("pet:displays", list);
  }
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) {
    try {
      screen.on(ev, pushDisplays);
    } catch {
      /* 平台/版本没这个事件：忽略 */
    }
  }
  // 渲染进程一订阅就要一份（did-finish-load 那次推送早于 pet.js 的 init，会漏掉）
  ipcMain.on("pet:displays-get", (e) => {
    if (win && !win.isDestroyed() && e.sender === win.webContents) pushDisplays();
  });

  // 加载完 5s 还没拿到包围盒 = 渲染进程没起来（配置拉失败、pet.js 报错…）。
  // 这时候宁可让整窗不可命中，也别让它当一整块矩形拦在屏幕最上层：
  // ⚠️ 这里**不能**用 setShape([]) —— 传空数组 = “恢复默认矩形”，正好是反效果
  //（整块透明窗把下面所有窗口的点击全吃掉，必须把鼠标移出那块 1×1 才恢复）。
  // 「整窗不收鼠标事件」只有 setIgnoreMouseEvents(true) 这一条路。
  win.webContents.once("did-finish-load", () => {
    pushDisplays(); // 渲染进程一上来就要有工作区（贴边靠它，§9.25）
    setTimeout(() => {
      if (gotRegion || shapeBroken || win.isDestroyed()) return;
      console.error("[pi-dsh-pet] 5s 内没收到命中区（渲染进程没起来？）→ 整窗穿透，别挡屏幕");
      win.setIgnoreMouseEvents(true, { forward: true });
    }, 5000);
  });

  // 给渲染进程回话的快捷方式（“说点什么…”）
  webContentsSend = (channel, ...args) => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  };

  // ---- 睡 / 醒：这扇窗看不见的时候，别再产生新帧 ----
  //
  // 为什么这么要紧：它是透明置顶的，每产生一帧，DWM 就得把它下面的桌面那块
  // 重新合成一遍（连着下面的窗口一起）。于是「一直在动」= 一直在跟别的程序抢
  // 合成预算 —— 症状就是「桌宠一开，浏览器/IDE 的后台窗口就不刷新了」。
  // 看不见的时候（最小化 / 屏保锁屏 / 挂起）画面没人看，就该彻底停下来。
  function sendPower(sleep) {
    if (win.isDestroyed()) return;
    if (webContentsSend) webContentsSend("pet:power", sleep === true);
  }
  win.on("hide", () => sendPower(true));
  win.on("show", () => sendPower(false));
  win.on("minimize", () => sendPower(true));
  win.on("restore", () => sendPower(false));
  // 锁屏/挂起是最容易忘的一档：屏幕都黑了你还在满速解码 WebM。
  // powerMonitor 的事件**按平台不一样**（lock/unlock 只有 Windows/macOS），
  // 拿不到 / 不支持就当没这回事（窗口事件已经盖住大部分场景）。
  [
    ["suspend", true],
    ["lock-screen", true],
    ["resume", false],
    ["unlock-screen", false],
  ].forEach(([ev, sleep]) => {
    try {
      powerMonitor.on(ev, () => sendPower(sleep));
    } catch {
      /* 这个平台/这个 Electron 版本没有这事件 */
    }
  });

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
  ipcMain.on("pet:say-ask", () => askSay());

  // 渲染进程：输入框收工（Enter / Esc / 点别处 / 失焦）→ 把键盘焦点还给下面的窗口
  ipcMain.on("pet:say-input-end", () => setInputMode(false));

  // 渲染进程 → 主进程：用户手动说的话。走宿主 /control（主进程有 token）
  ipcMain.on("pet:say-submit", async (_event, text) => {
    const t = String(text == null ? "" : text).trim();
    if (!t) return;
    const { token, home } = readTokenAndHome();
    const res = await callHost("say", { text: t }, token);
if (!res || res.ok !== true) {
        await showDialog({
          type: "warning",
          message: "没能说出来",
        detail: failureDetail(home, res, "宿主没应答"),
        buttons: ["好"],
      });
    }
  });

  // 渲染进程 → 主进程：记住拖拽落点（下次启动还在那儿）
  // 失败不弹窗：这是后台落盘，弹窗只会打断用户（位置仍能用默认角落）。
  ipcMain.on("pet:save-position", async (_event, payload = {}) => {
    const id = String(payload.id || "").trim();
    const rx = Number(payload.rx);
    const ry = Number(payload.ry);
    if (!id || !Number.isFinite(rx) || !Number.isFinite(ry)) return;
    const { token } = readTokenAndHome();
const res = await callHost("set-position", { id, rx, ry, w: Number(payload.w), h: Number(payload.h) }, token);
    if (!res || res.ok !== true) {
      console.error(`[pi-dsh-pet] 位置没记住（${id}）：${res ? res.error : "no response"}`);
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
        await showDialog({
          type: "warning",
          message: "操作没成功",
          detail: failureDetail(home, res, `宿主（127.0.0.1:${port}）没应答或拒绝了`),
          buttons: ["好"],
        });
      }
    };

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
        // ⚠️ 必须走 askSay（开输入模式 + 激活窗），不能自己 send：窗平时 focusable:false，
        //    只 send 的话渲染进程那句 input.focus() 会被系统丢掉 —— 框出来了却打不进字，
        //    而关框只有 Enter / Esc 两条路（都走键盘），于是框还永远关不掉。
        click: () => askSay(),
      },
{ label: "换一只（重启窗）", click: () => run("restart-window") },
      {
        label: "检查更新…",
        // 查/装都走宿主的 check-update / do-update（更新逻辑全在 app/updater.cjs，
        // 宿主是唯一的状态持有者 —— 菜单和 pi/dsh/curl 用的是同一套 API）。
        // ⚠️ 超时给到 240s：git fetch / npm i -g 慢起来很常见（菜单这边别自己先放弃了）。
        click: () => checkUpdate(),
      },
      // ⚠️ 这里原来还有一档「尺寸（换窗后生效）」子菜单（小/中/大），已按用户意见拿掉：
      //    换尺寸要重启整扇窗，代价远大于收益，而且最小档还得为了气泡不被裁而顶着下限。
      //    想换尺寸仍然可以走 API：/control {action:"set-ctrl", size, restartNonce}
      //    （或 pi 里的 `/pet small|large`）。
      { label: "添加一只（maxPets>1 时可用）", enabled: maxPets > 1, click: () => run("add-pet", { size: currentSize }) },
      { type: "separator" },
      { label: "隐藏宠物（服务保留）", enabled: ctrl.window !== false, click: () => run("hide-window") },
      { label: "在浏览器里打开", click: () => shell.openExternal(url) },
      { label: "复制服务地址", click: () => clipboard.writeText(url) },
      { label: "打开数据文件夹", click: () => shell.openPath(home) },
      {
        label: "关于",
        click: async () => {
          const version = pkgVersion();
          const stAbout = await hostState(token);
          const up = (stAbout && stAbout.state && stAbout.state.update) || {};
          const detail = [
            `pi-dsh-pet ${version}`,
            up.current ? `提交：${up.current}` : "",
            up.mode
              ? `装法：${up.mode === "git" ? "git 检出（可自动更新）" : up.mode === "npm" ? "npm" : "打包版 / 解压即用（不能自动更新）"}`
              : "",
            up.lastCheck ? `上次查更新：${new Date(up.lastCheck).toLocaleString()}` : "",
            `服务：${url}`,
            `宿主 pid：${(st && st.state && st.state.pid) || "?"}，运行 ${Math.round((Date.now() - ((st && st.state && st.state.startedAt) || Date.now())) / 1000)}s`,
            `数据目录：${home}`,
            "",
            "左键：互动　拖拽：移动　右键：菜单",
          ]
            .filter(Boolean)
            .join("\n");
try {
            await showDialog({ type: "info", message: "桌面宠物", detail, buttons: ["好"] });
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

// ---- 所有弹窗的唯一出口 ----
  //
  // 直接调 dialog.showMessageBox 会出「第一次点菜单里的「检查更新…」什么都没出来，
  // 第二次点才弹」这种症状（同一族的坑下面 setInputMode 也写着：从原生菜单里叫出来，
  // 菜单刚收起、系统还没把激活交回来，第一下常被吞掉）。三件事一起做才稳：
  //   ① 延后一拍再弹：原生菜单正在收尾时创建的模态框，Windows 有时直接吞掉它。
  //   ② **带父窗 win**：无父窗的是「应用级」模态，窗平时 focusable:false → 本进程不是
  //      前台进程，那盒子就弹不到你眼前（压在别的程序底下，看着像没弹）。
  //   ③ 弹窗期间把这扇窗临时变成可聚焦并激活，弹完还原（借 setInputMode 的那套手法）。
  // 排队：连点两下不会叠出两个盒子（第二个等第一个关掉）。
  let dialogBusy = null;
  function showDialog(opts) {
    const mine = async () => {
      await new Promise((r) => setTimeout(r, 80)); // ① 等菜单收干净
      if (win.isDestroyed()) return { response: -1, checkboxChecked: false };
      const held = dialogBusy; // ②③ 期间借一下可聚焦
      if (!inputMode) {
        try {
          if (process.platform === "darwin") win.setFocusableOnMac(true);
          else win.setFocusable(true);
        } catch {
          /* 拿不到就算了，盒子照样能弹 */
        }
        try { win.focus(); } catch { /* 同上 */ }
      }
      try {
        return await dialog.showMessageBox(win, opts);
      } finally {
        if (!inputMode && dialogBusy === held && !win.isDestroyed()) {
          try {
            if (process.platform === "darwin") win.setFocusableOnMac(false);
            else win.setFocusable(false);
            win.blur();
          } catch {
            /* 同上 */
          }
        }
      }
    };
    const prev = dialogBusy || Promise.resolve();
    dialogBusy = prev.then(mine, mine);
    return dialogBusy;
  }

  // ---- 检查更新（菜单项 → 宿主 check-update / do-update） ----
  //
  // 为什么不自己跑 git：更新逻辑在 app/updater.cjs，宿主是唯一的状态持有者；
  // 窗只管问 + 把结果写成人话对话框（顺便提醒宿主自己的代码要 pi-pet restart）。
  // 超时给到 4 分钟：npm i -g / git pull 慢起来很常见，窗这边别自己先放弃了。
  async function checkUpdate() {
    const { token, home } = readTokenAndHome();
    const note = (u) => (u && u.note ? `\n\n${u.note}` : "");
    const lines = (u) => {
      const modeText =
        u.mode === "git"
          ? "git 检出（可自动更新）"
          : u.mode === "npm"
            ? "npm"
            : u.mode === "portable"
              ? "单文件 exe（可自动下载替换）"
              : "打包版 / 解压即用（不能自动更新）";
      return [
        `当前：${u.version || "?"}${u.current ? `（提交 ${u.current}）` : ""}`,
        u.latest ? `最新：${u.latest}${u.behind ? `（落后 ${u.behind} 个提交）` : ""}` : "",
        `装法：${modeText}`,
        note(u).trim(),
      ]
        .filter(Boolean)
        .join("\n");
    };
let res = null;
    try {
      res = await callHost("check-update", {}, token, 240000);
    } catch (err) {
      res = null;
    }
    const u = (res && res.update) || {};
    if (!res || res.ok !== true) {
      await showDialog({
        type: "warning",
        message: "检查更新失败",
        detail: failureDetail(home, res, "宿主没应答或查不了更新") + (u.note ? `\n\n${u.note}` : ""),
        buttons: ["好"],
      });
      return;
    }
if (!u.hasUpdate) {
      await showDialog({ type: "info", message: "已经是最新", detail: lines(u), buttons: ["好"] });
      return;
    }
    const canApply = u.mode === "git" || u.mode === "portable" || (u.mode === "npm" && u.global === true);
    const buttons = canApply ? ["现在更新", "以后再说"] : ["好"];
    const { response } = await showDialog({
      type: canApply ? "question" : "info",
      message: "有新版本",
      detail: `${lines(u)}\n\n更新完会自动换一扇窗（渲染层立刻用上新代码）。\n宿主自己的代码要下次 \`pi-pet restart\` 才换。${
        u.mode === "portable" ? "\n\n单文件版会重新下载 exe，退出后自动覆盖，下次双击生效。" : ""
      }`,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });
    if (buttons[response] !== "现在更新") return;
    const ap = await callHost("do-update", {}, token, u.mode === "portable" ? 1500000 : 300000);
    const au = (ap && ap.update) || {};
    await showDialog({
      type: ap && ap.ok === true ? "info" : "warning",
      message: ap && ap.ok === true ? "更新完成" : "没更成",
      detail: (ap && ap.detail) || (au.note || "宿主没应答"),
      buttons: ["好"],
    });
  }

  // ---- 输入模式：只在输入框开着的那一小会儿让窗可聚焦 ----
  // 窗平时 focusable:false —— 点宠物也不把你正在打字的窗口抢走。但那样的窗**拿不到
  // 键盘焦点**：DOM 里的 input.focus() 会被系统丢掉，于是键既打不进框、也关不掉框
  //（框还一直挂在屏幕上，因为关框只有 Esc 和 Enter 两条路，都走键盘）。
  let inputMode = false;
  let inputModeAt = 0;

  /** 真的把这扇窗激活（可聚焦 ≠ 已激活，DOM 焦点要后者才留得住）。 */
  function focusWindow() {
    if (!inputMode || win.isDestroyed()) return;
    try { win.focus(); } catch { /* ignore */ }
    try { win.webContents.focus(); } catch { /* ignore */ }
  }

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
      return;
    }
    // 从原生菜单里叫出来时，菜单刚收起、系统还没把激活交回来，第一下 focus() 常被吞掉。
    // 补几遍（inputMode 一关，focusWindow 自己就停了）。
    focusWindow();
    [50, 160, 320].forEach((ms) => setTimeout(focusWindow, ms));
  }

  /**
   * 叫出「说点什么…」输入框 —— **所有入口都只能走这里**（右键菜单项、渲染进程请求）。
   *
   * 漏一步就复现「框出来了却打不进字」：窗平时 focusable:false（点宠物不抢你正在打字的
   * 窗口），不先开输入模式，渲染进程那句 input.focus() 会被系统直接丢掉。
   */
  function askSay() {
    setInputMode(true);
    focusWindow();
    if (webContentsSend) webContentsSend("pet:say-ask");
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

  // ⚠️ 级别用 floating（默认置顶）而不是 screen-saver：screen-saver 级会强行压到
  //    全屏/其他置顶程序之上，系统对它的处理也更重。桌面宠物只需要“压着普通窗口”。
  win.on("ready-to-show", () => win.setAlwaysOnTop(true, "floating"));

  app.on("window-all-closed", () => app.quit());
});
