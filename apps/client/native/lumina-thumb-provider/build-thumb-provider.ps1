param(
    [switch]$Register
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cppPath = Join-Path $scriptDir "LuminaThumbProvider.cpp"
$defPath = Join-Path $scriptDir "LuminaThumbProvider.def"
$outDir = Join-Path $scriptDir "..\..\resources"
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}
$dllPath = [System.IO.Path]::GetFullPath((Join-Path $outDir "LuminaThumbProvider.dll"))

# Locate Zig or MSVC cl.exe or MinGW g++
$zigCmd = Get-Command zig -ErrorAction SilentlyContinue
if (-not $zigCmd) {
    $wingetZig = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter "zig.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wingetZig) {
        $zigExe = $wingetZig.FullName
    }
} else {
    $zigExe = $zigCmd.Source
}

if ($zigExe) {
    Write-Host "[LuminaThumbProvider] Compiling x64 COM Shell Extension via Zig C++ ($zigExe)..."
    & $zigExe c++ -target x86_64-windows-gnu -shared -O2 -std=c++17 `
        $cppPath $defPath -o $dllPath `
        -lole32 -lwindowscodecs -lshlwapi -lgdi32 -luuid -lshell32 -ladvapi32
    if ($LASTEXITCODE -ne 0) {
        throw "Zig C++ compilation failed with exit code $LASTEXITCODE"
    }
} elseif (Get-Command cl -ErrorAction SilentlyContinue) {
    Write-Host "[LuminaThumbProvider] Compiling x64 COM Shell Extension via MSVC cl.exe..."
    & cl /nologo /O2 /EHsc /LD $cppPath /link /DEF:$defPath /OUT:$dllPath ole32.lib windowscodecs.lib shlwapi.lib gdi32.lib uuid.lib shell32.lib advapi32.lib
    if ($LASTEXITCODE -ne 0) {
        throw "MSVC compilation failed with exit code $LASTEXITCODE"
    }
} else {
    throw "Neither zig nor cl.exe found. Install Zig via: winget install -e --id zig.zig"
}

Write-Host "[LuminaThumbProvider] Successfully built: $dllPath ($((Get-Item $dllPath).Length) bytes)"

if ($Register) {
    Write-Host "[LuminaThumbProvider] Registering COM Shell Extension in HKCU..."
    & regsvr32.exe /s $dllPath
    Write-Host "[LuminaThumbProvider] Registered .lumina IThumbnailProvider successfully."
}
