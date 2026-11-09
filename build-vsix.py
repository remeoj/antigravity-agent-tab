#!/usr/bin/env python3
"""Packages the Antigravity Agent Floating Window extension into a .vsix archive."""

import html
import json
import os
import zipfile

EXT_DIR = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(EXT_DIR, "package.json"), "r", encoding="utf-8") as f:
    PKG = json.load(f)

VERSION = PKG["version"]
DISPLAY_NAME = html.escape(PKG["displayName"])
DESCRIPTION = html.escape(PKG["description"])

CONTENT_TYPES_XML = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension="" ContentType="text/plain"/>
</Types>"""

VSIX_MANIFEST_XML = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="antigravity-agent-tab" Version="{VERSION}" Publisher="joemerramos" />
    <DisplayName>{DISPLAY_NAME}</DisplayName>
    <Description xml:space="preserve">{DESCRIPTION}</Description>
    <Tags>antigravity,agent,floating window,detach,side panel</Tags>
    <Categories>AI,Chat,Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>"""

FILES = [
    "package.json",
    "extension.js",
    "test/integration.test.js",
    "README.md",
    "LICENSE",
    "media/icon.png",
    "media/icon.svg",
    "media/activity-bar.svg",
]


def build():
    outputs = [
        os.path.join(EXT_DIR, f"antigravity-agent-tab-{VERSION}.vsix"),
        os.path.join(os.path.dirname(EXT_DIR), "antigravity-agent-tab.vsix"),
    ]
    for out_path in outputs:
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", CONTENT_TYPES_XML)
            zf.writestr("extension.vsixmanifest", VSIX_MANIFEST_XML)
            for rel in FILES:
                zf.write(os.path.join(EXT_DIR, rel), f"extension/{rel}")
        print(f"Built {out_path} ({os.path.getsize(out_path)} bytes)")


if __name__ == "__main__":
    build()
