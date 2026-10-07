import { canonicalIP, check, jsonOutput, textOutput, safe } from "./diagnostics.mjs";
import { loadSettings, saveSettings, validateSettings } from "./settings.mjs";

export const usage = `Usage: ipinfo [--json] [--source SOURCE] [--timeout SECONDS] [IP_ADDRESS]
       ipinfo config [--source SOURCE] [--timeout SECONDS]

Auto checks ip.bea.sh and ip.behnam.pro concurrently.
Matching results show only ip.bea.sh; differing results show both.
With no address, each service detects your current public IP.

  ipinfo                          Show your current IP information
  ipinfo 1.2.3.4                   Look up an IPv4 address
  ipinfo 2606:4700:4700::1111       Look up an IPv6 address
  ipinfo --json 8.8.8.8            Print JSON for scripts
  ipinfo --help                    Show this help
  ipinfo --version                 Show the installed version
  ipinfo --source ip.bea.sh         Use just one source for this lookup
  ipinfo config --source auto      Save the default source for GUI and CLI
  ipinfo config --timeout 5        Save the per-service timeout (1–30 seconds)

Sources: auto (default), ip.bea.sh, ip.behnam.pro.
Default timeout: 5 seconds per service; Auto checks run concurrently.
Without options, ipinfo config prints the current shared settings.

Exit codes: 0 all selected checks succeeded, 1 a check failed, 2 invalid arguments.`;

export function parseOptions(args) {
  const options = {};
  const remaining = [...args];
  if (remaining[0] === "config") { options.config = true; remaining.shift(); }
  while (remaining.length) {
    const argument = remaining.shift();
    if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version") options.version = true;
    else if (argument === "--source" || argument === "--timeout") {
      const value = remaining.shift();
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      if (argument === "--source") options.source = value;
      else options.timeout = /^\d+$/.test(value) ? Number(value) : NaN;
    }
    else {
      if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
      if (options.ip) throw new Error("Provide at most one IP address.");
      options.ip = canonicalIP(argument);
      if (!options.ip) throw new Error("Provide a valid IPv4 or IPv6 address.");
    }
  }
  validateSettings({ source: options.source ?? "auto", timeout: options.timeout ?? 5 });
  if (options.config && (options.ip || options.json || options.help || options.version)) throw new Error("Use config with only --source and --timeout.");
  return options;
}

export async function runCLI(args, { version, lookup = check, readSettings = loadSettings, writeSettings = saveSettings, stdout = console.log, stderr = console.error }) {
  let options;
  try { options = parseOptions(args); }
  catch (error) { stderr(`${safe(error.message)}\n\n${usage}`); return 2; }
  if (options.help) { stdout(usage); return 0; }
  if (options.version) { stdout(`IPinfo ${version}`); return 0; }
  let settings;
  try {
    settings = { ...await readSettings(), ...Object.fromEntries(["source", "timeout"].filter((key) => options[key] !== undefined).map((key) => [key, options[key]])) };
    if (options.config) {
      if (options.source !== undefined || options.timeout !== undefined) await writeSettings(settings);
      stdout(JSON.stringify(settings, null, 2)); return 0;
    }
  } catch (error) { stderr(error.message); return 2; }
  const report = await lookup(options.ip, settings);
  stdout(options.json ? jsonOutput(report) : textOutput(report));
  return report.exitCode;
}
