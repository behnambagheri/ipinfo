$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:LOCALAPPDATA 'Programs\IPinfo'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
if ([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath($destination)) {
    Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $destination -Recurse -Force
}
$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $destination) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $destination).TrimStart(';'), 'User')
}
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'IPinfo.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startMenu)
$shortcut.TargetPath = Join-Path $destination 'IPinfo-GUI.exe'
$shortcut.WorkingDirectory = $destination
$shortcut.Save()
Write-Host 'Installed IPinfo GUI and CLI. Restart your terminal to use ipinfo.'
