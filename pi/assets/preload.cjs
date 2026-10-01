/**
 * pet-electron.cjs 的 preload —— 给 pet.js 用的最小桥
 *
 * 上下文隔离开着，渲染进程拿不到 electron 模块，所以这几件事必须由主进程做：
 *   setPassthrough  鼠标是否在命中框上（**仅在老 Electron（无 setShape）时生效**）
 *   setHitRegion    把整窗的命中区裁成宠物的包围盒（正常路径，见主进程注释）
 *   setWindowSize   舞台窗要多大（渲染进程知道配置里最大的宠物 + 气泡要多少地方）
 *   moveWindow      搬整扇窗（拖宠物 = 搬窗，见文件头「别改回全屏」）
 *   endWindowDrag   松手：让主进程记住窗的落点
 *   openMenu        右键菜单（菜单项的动作走宿主控制面，主进程负责弹）
 *   say / onAskSay  手动输入气泡：主进程叫出输入框 → 渲染进程提交 → 主进程调宿主
 *   savePosition    拖拽落点记忆（→ 宿主 /control set-position → home/positions.json）
*   sayInputEnd / onSayCancel  输入框的收工信号（关框后要把键盘焦点还给下面的窗口）
 *   closeWindow     宿主退出 / WS 断了 → 关窗
 *   onPower         主进程说「这扇窗现在看不见了（最小化 / 锁屏 / 挂起）」→ 渲染进程别再产生新帧
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__petElectron__", {
  /** 让点击穿透窗口（默认 true）。仅在主进程没有 setShape 时才会被采纳。 */
  setPassthrough: (on) => ipcRenderer.send("pet:passthrough", on),
  /** 命中区：[{x,y,width,height}]（窗口坐标）。空数组会被忽略，别用来「关窗」。 */
  setHitRegion: (rects) => ipcRenderer.send("pet:hit-region", Array.isArray(rects) ? rects : []),
/**
   * 舞台窗要多大（设备无关像素）。anchor = 往哪边长："top" = 往头顶长（气泡那边），
   * "bottom" = 往下长（老行为）。宠物在屏幕上的位置两种都不变。
   */
  setWindowSize: (w, h) => ipcRenderer.send("pet:window-size", { w: Number(w) || 0, h: Number(h) || 0 }),
  /** 搬窗：dx/dy 是**屏幕坐标**里「从本次按下那下」算起的位移（设备无关像素，
   *  与 getPosition/setPosition 同一套单位）；inset 是宠物在窗里的位置（left/top/width/height），
   *  主进程拿它把宠物夹在屏幕工作区里 —— 传增量的话窗被夹住时宠物会越拖越落后于光标。
   *  ⚠️ 必须是**屏幕**位移，不能是 clientX/Y 那种窗内位移：窗正跟着拖拽一起动，
   *    窗内坐标每帧都已经把「上一帧窗走过的距离」扣掉了，当成绝对位移用就只跟一半
   *    （实测跟手比 0.50，见 DESIGN.md §9.20）。 */
  moveWindow: (dx, dy, inset) => ipcRenderer.send("pet:window-move", {
    dx: Number(dx) || 0,
    dy: Number(dy) || 0,
    left: Number(inset && inset.left) || 0,
    top: Number(inset && inset.top) || 0,
    width: Number(inset && inset.width) || 0,
    height: Number(inset && inset.height) || 0,
  }),
  /** 松手（拖完）：主进程记住窗的落点，下次启动还在这儿 */
  endWindowDrag: () => ipcRenderer.send("pet:window-drag-end"),
  /** 弹右键菜单；info 里的 state/pets 由渲染进程提供（主进程只管菜单本身） */
  openMenu: (info) => ipcRenderer.send("pet:menu", info || {}),
  /** 手动说话：交给主进程 → 宿主 /control say → 全窗都看得到 */
  say: (text) => ipcRenderer.send("pet:say-submit", String(text == null ? "" : text)),
  /** 记住拖拽落点（比例 0~1）。主进程代写：渲染进程手里没有 token，写不了 /control */
savePosition: (id, rx, ry, w, h) => ipcRenderer.send("pet:save-position", { id: String(id == null ? "" : id), rx: Number(rx), ry: Number(ry), w: Number(w), h: Number(h) }),
  /** 主进程叫输入框（右键菜单的「说点什么…」） */
  onAskSay: (cb) => ipcRenderer.on("pet:say-ask", () => cb()),
  /** 输入框收工：告诉主进程把窗切回不可聚焦（别一直抢着键盘焦点） */
  sayInputEnd: () => ipcRenderer.send("pet:say-input-end"),
  /** 主进程强制收起输入框（焦点被别的程序抢走、或弹了右键菜单） */
  onSayCancel: (cb) => ipcRenderer.on("pet:say-cancel", () => cb()),
/** 关闭 Electron 窗口（WS 断了、宿主说 shutdown 时调用） */
  closeWindow: () => ipcRenderer.send("pet:close"),
  /** 主进程 → 渲染进程：睡(true) / 醒(false)。
   *  全屏透明置顶窗每一帧都要 DWM 重算整块桌面，所以「看不见的时候别产生帧」。 */
  onPower: (cb) => ipcRenderer.on("pet:power", (_e, sleep) => cb(sleep !== false)),
});
