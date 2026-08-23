/**
 * pi-dsh-pet — Electron main process
 *
 * Launched by the pi extension via `npx electron pet-electron.cjs PORT`.
 * Creates a transparent, always-on-top, frameless window with the pet.
 *
 * Mouse-passthrough: clicks on transparent areas pass through to windows
 * below. The preload script bridges pet.js mouse-enter/leave events so we
 * toggle setIgnoreMouseEvents per-frame.
 *
 * Usage:
 *   npx electron pet-electron.cjs <port>
 */

const { app, BrowserWindow, screen, ipcMain } = require("electron");
const path = require("path");

const port = parseInt(process.argv[2], 10);
if (!port || isNaN(port)) {
  console.error("Usage: electron pet-electron.cjs <port>");
  process.exit(1);
}

const url = `http://127.0.0.1:${port}`;

app.whenReady().then(() => {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  // Fullscreen transparent overlay: pet can roam anywhere on screen.
  // setIgnoreMouseEvents lets clicks pass through everywhere except the hitbox.
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // By default, clicks pass through. The renderer will tell us when the
  // mouse enters the pet hitbox — then we capture events for dragging.
  win.setIgnoreMouseEvents(true, { forward: true });

  // IPC: renderer tells us to toggle passthrough
  ipcMain.on("pet:passthrough", (_event, on) => {
    if (on) {
      win.setIgnoreMouseEvents(true, { forward: true });
    } else {
      win.setIgnoreMouseEvents(false);
    }
  });

  // IPC: renderer tells us to close (WS lost → pi exited)
  ipcMain.on("pet:close", () => {
    app.quit();
  });

  win.loadURL(url);

  // Keep window on top after load
  win.on("ready-to-show", () => {
    win.setAlwaysOnTop(true, "screen-saver");
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
});