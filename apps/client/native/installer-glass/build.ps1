$ErrorActionPreference = "Stop"

function Get-PeOffset($reader, $sectionTable, $sectionCount, [uint32] $rva) {
    for ($index = 0; $index -lt $sectionCount; $index++) {
        $reader.BaseStream.Position = $sectionTable + 40 * $index + 12
        $virtualAddress = $reader.ReadUInt32()
        $rawSize = $reader.ReadUInt32()
        $rawOffset = $reader.ReadUInt32()
        if ($rva -ge $virtualAddress -and ($rva - $virtualAddress) -lt $rawSize) {
            return [long] $rawOffset + ($rva - $virtualAddress)
        }
    }
    throw "PE RVA 0x$($rva.ToString('X')) is outside the file-backed sections."
}

function Assert-InstallerGlassDll([string] $path) {
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($path))
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Installer UI DLL has no DOS signature." }
        $reader.BaseStream.Position = 0x3C
        $pe = $reader.ReadUInt32()
        $reader.BaseStream.Position = $pe
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x014C) {
            throw "Installer UI DLL must be an x86 PE file (machine 0x014C)."
        }
        $sectionCount = $reader.ReadUInt16()
        $reader.BaseStream.Position = $pe + 20
        $optionalSize = $reader.ReadUInt16()
        $characteristics = $reader.ReadUInt16()
        $optional = $pe + 24
        if (($characteristics -band 0x2000) -eq 0 -or $optionalSize -lt 104 -or $reader.ReadUInt16() -ne 0x010B) {
            throw "Installer UI output must be a PE32 DLL."
        }

        $sectionTable = $optional + $optionalSize
        $reader.BaseStream.Position = $optional + 92
        if ($reader.ReadUInt32() -eq 0) { throw "Installer UI DLL has no PE data directories." }
        $exportRva = $reader.ReadUInt32()
        if ($exportRva -eq 0) { throw "Installer UI DLL has no export table." }
        $export = Get-PeOffset $reader $sectionTable $sectionCount $exportRva
        $reader.BaseStream.Position = $export + 20
        $functionCount = $reader.ReadUInt32()
        $nameCount = $reader.ReadUInt32()
        if ($functionCount -ne 2 -or $nameCount -ne 2) {
            throw "Installer UI DLL must export exactly two named functions."
        }
        $reader.BaseStream.Position = $export + 32
        $names = Get-PeOffset $reader $sectionTable $sectionCount ($reader.ReadUInt32())
        $expected = @("AttachInstallerGlass", "DetachInstallerGlass")
        for ($index = 0; $index -lt $expected.Count; $index++) {
            $reader.BaseStream.Position = $names + 4 * $index
            $reader.BaseStream.Position = Get-PeOffset $reader $sectionTable $sectionCount ($reader.ReadUInt32())
            $name = [Text.StringBuilder]::new()
            for ($byte = $reader.ReadByte(); $byte -ne 0; $byte = $reader.ReadByte()) {
                [void] $name.Append([char] $byte)
            }
            if ($name.ToString() -cne $expected[$index]) {
                throw "Unexpected installer UI export '$name'. Expected '$($expected[$index])'."
            }
        }
    } finally {
        $reader.Dispose()
    }
}

$zig = Get-Command zig -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$zig) { throw "Installer UI requires Zig on PATH." }
$exe = Get-Item -LiteralPath $zig.Source
if ($exe.LinkTarget) {
    $exe = $exe.ResolveLinkTarget($true)
} elseif ($exe.Target) {
    $exe = Get-Item -LiteralPath $exe.Target
}

$outDir = Join-Path $PSScriptRoot "..\..\resources\installer"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stage = Join-Path $outDir ([guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $source = Join-Path $PSScriptRoot "LuminaGlassUI.cc"
    $definition = Join-Path $stage "LuminaGlassUI.def"
    $candidate = Join-Path $stage "LuminaGlassUI.dll"
    $output = Join-Path $outDir "LuminaGlassUI.dll"
    @("EXPORTS", "    AttachInstallerGlass", "    DetachInstallerGlass") |
        Set-Content -LiteralPath $definition -Encoding ascii
    & $exe.FullName c++ -target x86-windows-gnu -shared -O2 -std=c++17 -DUNICODE -D_UNICODE `
        -static-libgcc -static-libstdc++ -Wno-unused-command-line-argument `
        $source $definition -o $candidate -luser32 -lgdi32 -lgdiplus -ldwmapi -luxtheme -lcomctl32 -lmsimg32 -lole32
    if ($LASTEXITCODE -ne 0) { throw "Installer UI compilation failed ($LASTEXITCODE)." }

    Assert-InstallerGlassDll $candidate
    Move-Item -LiteralPath $candidate -Destination $output -Force
    Write-Output "Verified x86 PE32 DLL (0x014C): AttachInstallerGlass, DetachInstallerGlass"
} finally {
    Get-ChildItem -LiteralPath $stage -File | Remove-Item -Force
    Remove-Item -LiteralPath $stage
}
