IPinfo includes a graphical app and a standalone `ipinfo` command in every download.

- macOS: separate Apple Silicon-only (`arm64`) and Universal (`arm64` + `x86_64`) native app and CLI builds, each with DMG and ZIP downloads. Homebrew selects the smaller Apple Silicon build on ARM Macs and the Universal build on Intel Macs.
- Linux: combined portable archives and native Debian, RPM, and Arch packages for AMD64 and ARM64. Install the downloaded native package with apt, dnf, or pacman.
- Windows: combined portable ZIPs for AMD64 and ARM64, a Scoop manifest, and WinGet submission manifests.
- The CLI works on servers without a graphical environment or a Node.js installation.
- Auto checks both services concurrently, shows only ip.bea.sh when results match, and shows both when they differ.
- Requests have a five-second per-service timeout by default. Unavailable services are reported without losing successful results.
- GUI and CLI share saved source and timeout settings. Select Auto, ip.bea.sh, or ip.behnam.pro.
- `ipinfo [IP_ADDRESS]` supports IPv4 and IPv6, `--json`, `--source`, and `--timeout`.
- `ipinfo config --source auto --timeout 5` saves shared preferences.

Verify downloads against the included SHA256SUMS. Windows packages are unsigned.
Linux graphical mode requires a desktop, standard GTK/NSS/audio libraries, and Chromium sandbox support; command-line mode does not.
Native Linux packages install both commands and a desktop-menu entry. GUI libraries are optional on servers.
Scoop installs both commands and a Start menu shortcut. WinGet provides both commands; launch the GUI with `ipinfo-gui`.
The WinGet identifier is reserved in the prepared manifests only; installation by name requires acceptance into Microsoft's registry. No project apt/dnf/pacman repository is published by this workflow.
