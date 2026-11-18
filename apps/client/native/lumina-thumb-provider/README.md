# Lumina Drift `.lumina` Windows Explorer Thumbnail Provider (`IThumbnailProvider`)

This directory contains the native x64 C++ Windows Shell Extension (`LuminaThumbProvider.dll`) that enables Windows File Explorer (`explorer.exe`) and the Windows Desktop to display live artwork thumbnails for `.lumina` project files, just like `.clip` (Clip Studio Paint), `.kra` (Krita), and `.psd` (Photoshop).

## Architecture
- **COM Interfaces**: `IInitializeWithStream` + `IThumbnailProvider` + `IClassFactory`
- **CLSID**: `{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}`
- **ShellEx Handler**: `HKCU\Software\Classes\.lumina\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}`
- **Zero External Dependencies**: Locates the uncompressed `preview.png` (`512×512` max) inside the `.lumina` ZIP stream and decodes it via Windows Imaging Component (`IWICImagingFactory`) into a 32-bit premultiplied BGRA `HBITMAP`.

## Building & Registering
```powershell
powershell -ExecutionPolicy Bypass -File apps/client/native/lumina-thumb-provider/build-thumb-provider.ps1 -Register
```
