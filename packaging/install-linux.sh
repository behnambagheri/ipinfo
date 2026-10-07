#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
install_dir="$data_home/IPinfo"
bin_dir="$HOME/.local/bin"
mkdir -p "$install_dir" "$bin_dir" "$data_home/applications"
if [ "$source_dir" != "$install_dir" ]; then cp -a "$source_dir/." "$install_dir/"; fi
ln -sfn "$install_dir/ipinfo" "$bin_dir/ipinfo"
ln -sfn "$install_dir/IPinfo-GUI" "$bin_dir/ipinfo-gui"
# Quoted desktop-entry paths support spaces; escape backslashes and quotation marks.
escaped_dir=$(printf '%s' "$install_dir" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g; s/%/%%/g')
cat > "$data_home/applications/ipinfo.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=IPinfo
Comment=IP and network diagnostics from two sources
Exec="$escaped_dir/IPinfo-GUI"
Icon=$install_dir/ipinfo.svg
Terminal=false
Categories=Network;Utility;
EOF
printf 'Installed IPinfo GUI and CLI. Add %s to your PATH if needed.\n' "$bin_dir"
