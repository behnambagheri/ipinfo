import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hosts } from "./diagnostics.mjs";

export const defaults = { source: "auto", timeout: 5 };
export function settingsPath() {
  const base = process.platform === "win32" ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, process.platform === "linux" ? "ipinfo" : "IPinfo", "settings.json");
}
export function validateSettings(value) {
  if (!value || !["auto", ...hosts].includes(value.source)) throw new Error("Source must be auto, ip.bea.sh, or ip.behnam.pro.");
  if (!Number.isInteger(value.timeout) || value.timeout < 1 || value.timeout > 30) throw new Error("Timeout must be a whole number from 1 to 30 seconds.");
  return { source: value.source, timeout: value.timeout };
}
export async function loadSettings(path = settingsPath()) {
  try { return validateSettings({ ...defaults, ...JSON.parse(await readFile(path, "utf8")) }); }
  catch (error) { if (error.code === "ENOENT") return { ...defaults }; throw new Error("Could not read IPinfo settings. Fix or remove the settings file."); }
}
export async function saveSettings(value, path = settingsPath()) {
  const validated = validateSettings(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
  return validated;
}
