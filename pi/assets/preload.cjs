/**
 * pi-dsh-pet — Electron preload script
 *
 * Exposes a minimal API so pet.js can tell the main process whether the
 * mouse is over the pet hitbox. When over → capture clicks (dragging).
 * When not → passthrough to windows below.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__petElectron__", {
  /** Let clicks pass through the window (default: true) */
  setPassthrough: (on) => ipcRenderer.send("pet:passthrough", on),
  /** Close the Electron window (called when WS reconnects fail) */
  closeWindow: () => ipcRenderer.send("pet:close"),
});