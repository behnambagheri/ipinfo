#!/bin/bash
# Run in a disposable distribution container as root. Never use on a workstation.
set -euo pipefail
format=${1:?Pass deb, rpm, or archlinux}
package=${2:?Pass the package filename}
test_home=$(mktemp -d)
trap 'rm -rf "$test_home"' EXIT
export HOME="$test_home" XDG_CONFIG_HOME="$test_home/config"
install_package() {
  case "$format" in
    deb) apt-get install -y --no-install-recommends ${1:+--reinstall} "$package" ;;
    # Rocky's base image already has the CLI dependencies. Avoid fetching large
    # unrelated repository indexes for this local-file installation test.
    rpm) dnf "${1:-install}" -y --disablerepo='*' --setopt=install_weak_deps=False "$package" ;;
    archlinux) pacman -U --noconfirm "$package" ;;
    *) echo "Unsupported package format" >&2; exit 2 ;;
  esac
}
install_package
ipinfo --version
ipinfo --help | head -n 3
test "$(readlink /usr/bin/ipinfo)" = /opt/bea-ipinfo/ipinfo
test "$(readlink /usr/bin/ipinfo-gui)" = /opt/bea-ipinfo/IPinfo-GUI
test -s /usr/share/applications/bea-ipinfo.desktop
test -s /usr/share/icons/hicolor/scalable/apps/bea-ipinfo.svg
test "$(stat -c '%u:%g:%a' /opt/bea-ipinfo/chrome-sandbox)" = 0:0:4755
if ipinfo invalid >"$test_home/invalid.log" 2>&1; then echo "Invalid IP was accepted" >&2; exit 1; else test "$?" = 2; fi
ipinfo config --source ip.behnam.pro --timeout 2
settings="$XDG_CONFIG_HOME/ipinfo/settings.json"
cp "$settings" "$test_home/expected.json"
# Reinstall and remove using the native manager; preferences are user data.
install_package reinstall
test "$(<"$settings")" = "$(<"$test_home/expected.json")"
case "$format" in
  deb) apt-get remove -y bea-ipinfo ;;
  rpm) dnf remove -y --disablerepo='*' bea-ipinfo ;;
  archlinux) pacman -R --noconfirm bea-ipinfo ;;
esac
test ! -e /opt/bea-ipinfo/ipinfo
test ! -L /usr/bin/ipinfo
test ! -L /usr/bin/ipinfo-gui
test "$(<"$settings")" = "$(<"$test_home/expected.json")"
echo "Native $format install, CLI, package permissions, reinstall, removal, and settings-retention checks passed."
