# Builds the desktop app into ..\dist\Dokkan Team Builder\ and a zip to share.
# Self-contained: the friend needs neither .NET nor Node installed (WebView2 comes with Windows 10/11).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$out  = Join-Path $dist 'Dokkan Team Builder'
$zip  = Join-Path $dist 'Dokkan-Team-Builder-win-x64.zip'

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null

dotnet publish (Join-Path $PSScriptRoot 'DokkanTeamBuilder.csproj') -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none -o $out
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

# The page's server: code + page + a copy of Node. No box, no cache: each user's data stays in their AppData.
$app = Join-Path $out 'app'
New-Item -ItemType Directory -Force (Join-Path $app 'lib'), (Join-Path $app 'public') | Out-Null
Copy-Item (Join-Path $root 'server.js') $app
Copy-Item (Join-Path $root 'lib\*.js') (Join-Path $app 'lib')
Copy-Item (Join-Path $root 'public\index.html') (Join-Path $app 'public')
New-Item -ItemType Directory -Force (Join-Path $app 'data') | Out-Null
Copy-Item (Join-Path $root 'data\*.json') (Join-Path $app 'data')   # Festival of Battles enemy stats
Copy-Item (Get-Command node).Source (Join-Path $app 'node.exe')
Copy-Item (Join-Path $PSScriptRoot 'README-friend.txt') (Join-Path $out 'README.txt')

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $out -DestinationPath $zip -CompressionLevel Optimal
"Built: $out"
"Zip:   $zip ({0:N0} MB)" -f ((Get-Item $zip).Length / 1MB)
