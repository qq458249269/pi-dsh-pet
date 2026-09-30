/**
 * pet-electron.cjs 的 preload —— 给 pet.js 用的最小桥
 *
 * 上下文隔离开着，渲染进程拿不到 electron 模块，所以这几件事必须由主进程做：
 *   setPassthrough  鼠标是否在命中框上（决定整窗透不穿透）
 *   openMenu        右键菜单（菜单项的动作走宿主控制面，主进程负责弹）
 *   say / onAskSay  手动输入气泡：主进程叫出输入框 → 渲染进程提交 → 主进程调宿主
 *   closeWindow     宿主退出 / WS 断了 → 关窗
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__petElectron__", {
  /** 让点击穿透窗口（默认 true） */
  setPassthrough: (on) => ipcRenderer.send("pet:passthrough", on),
  /** 弹右键菜单；info 里的 state/pets 由渲染进程提供（主进程只管菜单本身） */
  openMenu: (info) => ipcRenderer.send("pet:menu", info || {}),
  /** 手动说话：交给主进程 → 宿主 /control say → 全窗都看得到 */
  say: (text) => ipcRenderer.send("pet:say-submit", String(text == null ? "" : text)),
  /** 主进程叫输入框（右键菜单的「说点什么…」） */
  onAskSay: (cb) => ipcRenderer.on("pet:say-ask", () => cb()),
  /** 关闭 Electron 窗口（WS 断了、宿主说 shutdown 时调用） */
  closeWindow: () => ipcRenderer.send("pet:close"),
});
