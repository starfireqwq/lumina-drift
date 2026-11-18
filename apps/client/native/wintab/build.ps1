$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "wintab.cc"
$outDir = Join-Path $PSScriptRoot "..\..\resources\wintab"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$output = Join-Path $outDir "wintab.node"

$zig = Get-Command zig -ErrorAction SilentlyContinue
if ($zig) {
    $exe = Get-Item -LiteralPath $zig.Source
    if ($exe.LinkTarget) {
        $exe = $exe.ResolveLinkTarget($true)
    } elseif ($exe.Target) {
        $exe = Get-Item -LiteralPath $exe.Target
    }
    $lib = Join-Path $exe.DirectoryName "lib"
    $obj = Join-Path $outDir "wintab.obj"
    $kernelDef = Join-Path $outDir "kernel32.def"
    $kernelLib = Join-Path $outDir "kernel32.lib"
    $crtDef = Join-Path $outDir "msvcrt.def"
    $crtLib = Join-Path $outDir "msvcrt.lib"
    $userDef = Join-Path $outDir "user32.def"
    $userLib = Join-Path $outDir "user32.lib"
    # This bridge only needs the Windows system DLLs. Use Zig's LLVM tools directly
    # so compilation does not create or relink a full MinGW runtime inside the cache.
    & $exe.FullName clang -target x86_64-windows-gnu -fms-extensions -fno-exceptions -fno-rtti -O2 -std=c++17 -c `
        -isystem "$lib\include" -isystem "$lib\libc\include\x86_64-windows-gnu" -isystem "$lib\libc\include\any-windows-any" $source -o $obj
    if ($LASTEXITCODE -ne 0) { throw "WinTab bridge object compilation failed ($LASTEXITCODE)." }
    @('LIBRARY kernel32.dll', 'EXPORTS', 'LoadLibraryExW', 'GetLastError', 'GetProcAddress', 'GetModuleHandleW',
        'FreeLibrary', 'GetTickCount', 'GetProcessHeap', 'HeapAlloc', 'HeapFree', 'AcquireSRWLockExclusive',
        'ReleaseSRWLockExclusive', 'CreateThread', 'CreateEventW', 'SetEvent', 'WaitForSingleObject', 'CloseHandle',
        'GlobalAddAtomW', 'GlobalDeleteAtom') |
        Set-Content -LiteralPath $kernelDef -Encoding ascii
    @('LIBRARY msvcrt.dll', 'EXPORTS', 'memcpy', 'memset', '_fltused') |
        Set-Content -LiteralPath $crtDef -Encoding ascii
    & $exe.FullName dlltool -m i386:x86-64 -d $kernelDef -l $kernelLib
    if ($LASTEXITCODE -ne 0) { throw "WinTab kernel32 import library generation failed ($LASTEXITCODE)." }
    & $exe.FullName dlltool -m i386:x86-64 -d $crtDef -l $crtLib
    if ($LASTEXITCODE -ne 0) { throw "WinTab msvcrt import library generation failed ($LASTEXITCODE)." }
    @('LIBRARY user32.dll', 'EXPORTS', 'RegisterClassW', 'CreateWindowExW', 'DefWindowProcW', 'DestroyWindow',
        'SetTimer', 'KillTimer', 'GetMessageW', 'DispatchMessageW', 'PostQuitMessage', 'PostMessageW', 'GetForegroundWindow',
        'RegisterRawInputDevices', 'GetRawInputData', 'SetThreadDpiAwarenessContext', 'SetPropW', 'PostThreadMessageW',
        'GetMessageTime') |
        Set-Content -LiteralPath $userDef -Encoding ascii
    & $exe.FullName dlltool -m i386:x86-64 -d $userDef -l $userLib
    if ($LASTEXITCODE -ne 0) { throw "WinTab user32 import library generation failed ($LASTEXITCODE)." }
    & $exe.FullName lld-link /dll /noentry /machine:x64 /nodefaultlib "/out:$output" $obj $kernelLib $crtLib $userLib
} elseif (Get-Command cl -ErrorAction SilentlyContinue) {
    $obj = Join-Path $outDir "wintab.obj"
    & cl /nologo /O2 /EHsc /std:c++17 /LD "/Fo$obj" $source /link user32.lib "/OUT:$output"
} else {
    throw "WinTab bridge requires Zig or the x64 MSVC compiler."
}
if ($LASTEXITCODE -ne 0) { throw "WinTab bridge compilation failed ($LASTEXITCODE)." }
