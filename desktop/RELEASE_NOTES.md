IPinfo includes a graphical app and a standalone `ipinfo` command in every download.

- macOS: universal native app and CLI for Apple Silicon and Intel; DMG, ZIP, and Homebrew cask.
- Linux: one combined portable archive for AMD64 and one for ARM64.
- Windows: one combined portable ZIP for AMD64 and one for ARM64.
- The CLI works on servers without a graphical environment or a Node.js installation.
- Auto checks both services concurrently, shows only ip.bea.sh when results match, and shows both when they differ.
- Requests have a five-second per-service timeout by default. Unavailable services are reported without losing successful results.
- GUI and CLI share saved source and timeout settings. Select Auto, ip.bea.sh, or ip.behnam.pro.
- `ipinfo [IP_ADDRESS]` supports IPv4 and IPv6, `--json`, `--source`, and `--timeout`.
- `ipinfo config --source auto --timeout 5` saves shared preferences.

Verify downloads against the included SHA256SUMS. Windows packages are unsigned.
Linux graphical mode requires a desktop, standard GTK/NSS/audio libraries, and Chromium sandbox support; command-line mode does not.
