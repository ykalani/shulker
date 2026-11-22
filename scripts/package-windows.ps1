param(
    [Parameter(Mandatory)] [string] $Staging,
    [Parameter(Mandatory)] [string] $Destination
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$Staging = [IO.Path]::GetFullPath($Staging, (Get-Location).Path)
$Destination = [IO.Path]::GetFullPath($Destination, (Get-Location).Path)
$nodeVersion = '26.13.1'
$nodeBase = "https://nodejs.org/dist/v$nodeVersion"
$version = (Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json).version
New-Item -ItemType Directory -Force -Path $Staging, $Destination | Out-Null

function Get-DistributionFile([string] $Name) {
    $path = Join-Path $Staging $Name
    if (!(Test-Path -LiteralPath $path)) {
        Invoke-WebRequest -Uri "$nodeBase/$Name" -OutFile $path
    }
    return $path
}

Push-Location -LiteralPath $repo
try {
    npm run build
    if ($LASTEXITCODE) { throw 'TypeScript build failed.' }
    $bundle = Join-Path $Staging 'bundle.cjs'
    & node (Join-Path $repo 'node_modules/esbuild/bin/esbuild') 'bin/shulker.cjs' --bundle --platform=node --target=node26 --format=cjs "--outfile=$bundle"
    if ($LASTEXITCODE) { throw 'Bundling failed.' }

    $checksums = Get-Content -LiteralPath (Get-DistributionFile 'SHASUMS256.txt')
    foreach ($arch in 'x64', 'arm64') {
        $runtime = "node-v$nodeVersion-win-$arch"
        $archive = Get-DistributionFile "$runtime.zip"
        $pattern = '^([a-f0-9]{64})\s+\*?' + [regex]::Escape("$runtime.zip") + '$'
        $checksum = $checksums | Where-Object { $_ -match $pattern } | Select-Object -First 1
        if (!$checksum -or (Get-FileHash -LiteralPath $archive).Hash -ne ($checksum -split '\s+')[0]) {
            throw "Node.js checksum verification failed for $arch."
        }
        tar.exe -xf $archive -C $Staging
        if ($LASTEXITCODE) { throw "Could not extract $runtime." }
        $buildDir = Join-Path $Staging "package-$arch"
        New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
        $binary = Join-Path $buildDir 'shulker.exe'
        $config = Join-Path $Staging "sea-$arch.json"
        @{
            main = $bundle
            output = $binary
            useCodeCache = $false
            execArgvExtension = 'none'
            disableExperimentalSEAWarning = $true
        } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding utf8NoBOM
        & (Join-Path $Staging "$runtime/node.exe") --build-sea $config
        if ($LASTEXITCODE) { throw "Could not build the $arch executable." }
        $reported = & $binary --version
        if ($LASTEXITCODE -or $reported -ne $version) { throw "Version check failed for $arch." }
        Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $buildDir 'LICENSE.txt')
        Copy-Item -LiteralPath (Join-Path $Staging "$runtime/LICENSE") -Destination (Join-Path $buildDir 'NODE-LICENSE.txt')
        $files = 'shulker.exe', 'LICENSE.txt', 'NODE-LICENSE.txt' | ForEach-Object { Join-Path $buildDir $_ }
        $zip = Join-Path $Destination "shulker-win-$arch.zip"
        Compress-Archive -LiteralPath $files -DestinationPath $zip -Force
        Get-FileHash -LiteralPath $zip
    }
} finally {
    Pop-Location
}
