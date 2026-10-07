"""Validate package-manager schemas against the actual combined Windows ZIPs."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request
import zipfile

import jsonschema
import yaml

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--assets", type=Path)
parser.add_argument("--manifests", type=Path, default=Path("dist/package-managers"))
arguments = parser.parse_args()
version = json.loads(Path("package.json").read_text())["version"]
identifier = "BehnamBagheri.IPinfo"
documents = {}
for filename in (arguments.manifests / "winget").rglob("*.yaml"):
    document = yaml.safe_load(filename.read_text())
    kind = document["ManifestType"]
    url = f"https://raw.githubusercontent.com/microsoft/winget-cli/master/schemas/JSON/manifests/v1.9.0/manifest.{kind}.1.9.0.json"
    with urllib.request.urlopen(url, timeout=30) as response:
        schema = json.load(response)
    jsonschema.validate(document, schema)
    assert document["PackageIdentifier"] == identifier
    assert document["PackageVersion"] == version
    assert kind not in documents, "Duplicate manifest type"
    documents[kind] = document
assert set(documents) == {"version", "defaultLocale", "installer"}
scoop = json.loads((arguments.manifests / "ipinfo.json").read_text())
with urllib.request.urlopen("https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/schema.json", timeout=30) as response:
    jsonschema.validate(scoop, json.load(response))
assert scoop["version"] == version
assert scoop["bin"] == ["ipinfo.exe", ["IPinfo-GUI.exe", "ipinfo-gui"]]
assert scoop["shortcuts"] == [["IPinfo-GUI.exe", "IPinfo"]]
installers = documents["installer"]["Installers"]
assert len(installers) == 2
assert {item["Architecture"] for item in installers} == {"x64", "arm64"}
assert set(scoop["architecture"]) == {"64bit", "arm64"}
for cpu, arch, scoop_arch in [("amd64", "x64", "64bit"), ("arm64", "arm64", "arm64")]:
    folder = f"IPinfo-{version}-windows-{cpu}"
    filename = folder + ".zip"
    archive = arguments.assets / filename if arguments.assets else Path("dist/desktop") / f"windows-{cpu}" / filename
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    installer = next(item for item in installers if item["Architecture"] == arch)
    expected_url = f"https://github.com/behnambagheri/ipinfo/releases/download/v{version}/{filename}"
    assert installer["InstallerUrl"] == expected_url
    assert installer["InstallerSha256"].lower() == digest
    assert scoop["architecture"][scoop_arch] == {"url": expected_url, "hash": digest, "extract_dir": folder}
    assert installer["NestedInstallerFiles"] == [
        {"RelativeFilePath": f"{folder}/ipinfo.exe", "PortableCommandAlias": "ipinfo"},
        {"RelativeFilePath": f"{folder}/IPinfo-GUI.exe", "PortableCommandAlias": "ipinfo-gui"},
    ]
    with zipfile.ZipFile(archive) as package:
        for required in ["ipinfo.exe", "IPinfo-GUI.exe", "resources/app.asar", "ffmpeg.dll", "icudtl.dat"]:
            assert f"{folder}/{required}" in package.namelist(), f"Missing runtime file: {required}"
print("Official WinGet/Scoop schemas, native architecture mappings, archive hashes, both launchers, and bundled GUI runtime verified.")
