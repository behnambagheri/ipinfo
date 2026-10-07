import { app, BrowserWindow, clipboard, ipcMain, shell, session } from "electron";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { canonicalIP, check, hosts, compare } from "./diagnostics.mjs";
import { loadSettings, saveSettings, defaults, validateSettings } from "./settings.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const page = join(directory, "index.html");
let window;
// Deterministic UI checks run the packaged app on each native CI runner.
const smoke = process.argv.includes("--smoke-test");
let fixture = "match";
let settings = { ...defaults };
let settingsError;
if (!smoke) {
  try { settings = await loadSettings(); } catch (error) { settingsError = error.message; }
}
function smokeReport() {
  return compare((settings.source === "auto" ? hosts : [settings.source]).map((host, index) => fixture === "error" && index === 1
    ? { host, error: "The request timed out. Refresh to try again." }
    : { host, data: { ip: fixture === "different" && index === 1 ? "8.8.8.8" : "1.2.3.4", country: "Australia", asn_org: "Test network" } }));
}
function authorized(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Unsupported request.");
}

// Do not await ready at module scope: Electron waits for the ESM entry point
// to finish loading before emitting ready.
async function start() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle("ipinfo:check", async (event, ip) => {
    authorized(event);
    if (ip !== undefined && (typeof ip !== "string" || !canonicalIP(ip))) throw new Error("Invalid IP address.");
    return smoke ? smokeReport() : check(ip, settings);
  });
  ipcMain.handle("ipinfo:settings", (event) => {
    authorized(event);
    if (settingsError) throw new Error(settingsError);
    return settings;
  });
  ipcMain.handle("ipinfo:save-settings", async (event, value) => {
    authorized(event);
    settings = smoke ? validateSettings(value) : await saveSettings(value);
    settingsError = undefined;
    return settings;
  });
  ipcMain.handle("ipinfo:copy", (event, text) => {
    authorized(event);
    if (typeof text !== "string" || text.length > 150000) throw new Error("Invalid text.");
    return clipboard.writeText(text);
  });
  ipcMain.handle("ipinfo:open", (event, host) => {
    authorized(event);
    if (!hosts.includes(host)) throw new Error("Unknown service.");
    return shell.openExternal(`https://${host}/`);
  });
  function createWindow() {
    window = new BrowserWindow({
      width: 1000, height: 800, minWidth: 520, minHeight: 520, show: !smoke,
      title: "IPinfo", icon: join(directory, "icon.png"), autoHideMenuBar: true,
      webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.loadFile(page);
  }
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on("window-all-closed", () => app.quit());

  if (smoke) {
    const deadline = setTimeout(() => { console.error("GUI smoke test timed out."); app.exit(1); }, 30000);
    try {
      const waitFor = async (expression) => {
        for (let attempt = 0; attempt < 150; attempt++) {
          if (await window.webContents.executeJavaScript(expression)) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("GUI state did not match the expected result.");
      };
      await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
      await waitFor('document.querySelectorAll("#results section").length === 1 && !document.getElementById("refresh").disabled');
      fixture = "different";
      await window.webContents.executeJavaScript('document.getElementById("refresh").click()');
      await waitFor('document.querySelectorAll("#results section").length === 2 && !document.getElementById("refresh").disabled');
      fixture = "error";
      await window.webContents.executeJavaScript('document.getElementById("refresh").click()');
      await waitFor('!!document.querySelector(".alert-error") && !document.getElementById("refresh").disabled');
      await window.webContents.executeJavaScript('document.getElementById("copy").click()');
      await waitFor('document.getElementById("status").textContent === "Results copied."');
      if (!(await clipboard.readText()).includes("ip.behnam.pro")) throw new Error("Clipboard was not updated.");
      await window.webContents.executeJavaScript('document.getElementById("address").value = "invalid"; document.getElementById("refresh").click()');
      await waitFor('document.getElementById("status").textContent.startsWith("Enter a valid")');
      await window.webContents.executeJavaScript('document.getElementById("address").value = ""; document.getElementById("source").value = "ip.behnam.pro"; document.getElementById("timeout").value = "2"; document.getElementById("refresh").click()');
      await waitFor('document.querySelectorAll("#results section").length === 1 && document.querySelector("#results section").dataset.host === "ip.behnam.pro" && !document.getElementById("refresh").disabled');
      if (settings.source !== "ip.behnam.pro" || settings.timeout !== 2) throw new Error("GUI settings were not saved.");
      console.log("GUI smoke test passed: matching, different, failed, copy, invalid input, and source settings.");
      clearTimeout(deadline); app.exit(0);
    } catch (error) { console.error(error.message); clearTimeout(deadline); app.exit(1); }
  }
}
start().catch((error) => { console.error(error.message); app.exit(1); });
