import { runCLI } from "./cli.mjs";

// esbuild replaces the version when creating the standalone executable.
runCLI(process.argv.slice(2), { version: IPINFO_VERSION }).then((code) => { process.exitCode = code; }).catch(() => {
  console.error("The lookup could not be completed.");
  process.exitCode = 1;
});
