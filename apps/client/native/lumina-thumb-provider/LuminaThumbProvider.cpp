// LuminaThumbProvider.cpp
// Native Windows Explorer IThumbnailProvider COM Shell Extension (x64) for .lumina project files
// CLSID: {8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <shlwapi.h>
#include <thumbcache.h>
#include <propsys.h>
#include <wincodec.h>
#include <shlobj.h>
#include <unknwn.h>
#include <cstdint>
#include <cstring>
#include <vector>
#include <algorithm>

// {8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}
static const CLSID CLSID_LuminaThumbProvider = {
    0x8e4a9d21, 0x5c7b, 0x4f3a, { 0x9b, 0x1e, 0x6d, 0x2c, 0x8a, 0x4f, 0x0e, 0x19 }
};

static HMODULE g_hInst = nullptr;
static long g_cDllRef = 0;

#pragma pack(push, 1)
struct ZipLocalFileHeader {
    uint32_t signature;      // 0x04034b50
    uint16_t versionNeeded;
    uint16_t flags;
    uint16_t compression;    // 0 = STORE
    uint16_t modTime;
    uint16_t modDate;
    uint32_t crc32;
    uint32_t compressedSize;
    uint32_t uncompressedSize;
    uint16_t fileNameLength;
    uint16_t extraFieldLength;
};

struct ZipCentralDirFileHeader {
    uint32_t signature;      // 0x02014b50
    uint16_t versionMadeBy;
    uint16_t versionNeeded;
    uint16_t flags;
    uint16_t compression;
    uint16_t modTime;
    uint16_t modDate;
    uint32_t crc32;
    uint32_t compressedSize;
    uint32_t uncompressedSize;
    uint16_t fileNameLength;
    uint16_t extraFieldLength;
    uint16_t fileCommentLength;
    uint16_t diskNumberStart;
    uint16_t internalFileAttrs;
    uint32_t externalFileAttrs;
    uint32_t localHeaderOffset;
};

struct ZipEndOfCentralDir {
    uint32_t signature;      // 0x06054b50
    uint16_t diskNumber;
    uint16_t startDiskNumber;
    uint16_t entriesOnDisk;
    uint16_t totalEntries;
    uint32_t centralDirSize;
    uint32_t centralDirOffset;
    uint16_t commentLength;
};
#pragma pack(pop)

static bool ExtractPreviewPngFromZip(const uint8_t* data, size_t size, const uint8_t** outPng, size_t* outPngSize) {
    if (!data || size < sizeof(ZipLocalFileHeader) || !outPng || !outPngSize) {
        return false;
    }

    // 1. Try Central Directory lookup from end of archive
    if (size >= sizeof(ZipEndOfCentralDir)) {
        size_t maxBack = std::min<size_t>(size, 65557);
        for (size_t back = sizeof(ZipEndOfCentralDir); back <= maxBack; ++back) {
            size_t pos = size - back;
            const auto* eocd = reinterpret_cast<const ZipEndOfCentralDir*>(data + pos);
            if (eocd->signature == 0x06054b50) {
                size_t cdOffset = eocd->centralDirOffset;
                size_t cdEnd = cdOffset + eocd->centralDirSize;
                if (cdEnd <= size) {
                    size_t cursor = cdOffset;
                    for (uint16_t i = 0; i < eocd->totalEntries && cursor + sizeof(ZipCentralDirFileHeader) <= cdEnd; ++i) {
                        const auto* cd = reinterpret_cast<const ZipCentralDirFileHeader*>(data + cursor);
                        if (cd->signature != 0x02014b50) break;
                        const char* namePtr = reinterpret_cast<const char*>(data + cursor + sizeof(ZipCentralDirFileHeader));
                        size_t nextCursor = cursor + sizeof(ZipCentralDirFileHeader) + cd->fileNameLength + cd->extraFieldLength + cd->fileCommentLength;
                        if (nextCursor > cdEnd) break;

                        if (cd->fileNameLength == 11 && _strnicmp(namePtr, "preview.png", 11) == 0 && cd->compression == 0) {
                            size_t lfhOffset = cd->localHeaderOffset;
                            if (lfhOffset + sizeof(ZipLocalFileHeader) <= size) {
                                const auto* lfh = reinterpret_cast<const ZipLocalFileHeader*>(data + lfhOffset);
                                if (lfh->signature == 0x04034b50) {
                                    size_t payloadOffset = lfhOffset + sizeof(ZipLocalFileHeader) + lfh->fileNameLength + lfh->extraFieldLength;
                                    size_t payloadSize = cd->uncompressedSize;
                                    if (payloadSize > 0 && payloadOffset + payloadSize <= size) {
                                        *outPng = data + payloadOffset;
                                        *outPngSize = payloadSize;
                                        return true;
                                    }
                                }
                            }
                        }
                        cursor = nextCursor;
                    }
                }
                break;
            }
        }
    }

    // 2. Fallback: Linear scan of Local File Headers for uncompressed preview.png
    size_t offset = 0;
    while (offset + sizeof(ZipLocalFileHeader) <= size) {
        const auto* hdr = reinterpret_cast<const ZipLocalFileHeader*>(data + offset);
        if (hdr->signature != 0x04034b50) {
            break;
        }
        const char* name = reinterpret_cast<const char*>(data + offset + sizeof(ZipLocalFileHeader));
        size_t dataOffset = offset + sizeof(ZipLocalFileHeader) + hdr->fileNameLength + hdr->extraFieldLength;
        if (dataOffset > size) break;

        if (hdr->fileNameLength == 11 && _strnicmp(name, "preview.png", 11) == 0 && hdr->compression == 0 && hdr->uncompressedSize > 8) {
            if (dataOffset + hdr->uncompressedSize <= size) {
                *outPng = data + dataOffset;
                *outPngSize = hdr->uncompressedSize;
                return true;
            }
        }
        if (hdr->compressedSize == 0) break;
        offset = dataOffset + hdr->compressedSize;
    }

    return false;
}

class CLuminaThumbProvider final : public IInitializeWithStream, public IThumbnailProvider {
public:
    CLuminaThumbProvider() : m_cRef(1), m_pStream(nullptr) {
        InterlockedIncrement(&g_cDllRef);
    }

    ~CLuminaThumbProvider() {
        if (m_pStream) {
            m_pStream->Release();
            m_pStream = nullptr;
        }
        InterlockedDecrement(&g_cDllRef);
    }

    // IUnknown
    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IThumbnailProvider)) {
            *ppv = static_cast<IThumbnailProvider*>(this);
        } else if (IsEqualIID(riid, IID_IInitializeWithStream)) {
            *ppv = static_cast<IInitializeWithStream*>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }

    IFACEMETHODIMP_(ULONG) AddRef() override {
        return InterlockedIncrement(&m_cRef);
    }

    IFACEMETHODIMP_(ULONG) Release() override {
        ULONG cRef = InterlockedDecrement(&m_cRef);
        if (cRef == 0) {
            delete this;
        }
        return cRef;
    }

    // IInitializeWithStream
    IFACEMETHODIMP Initialize(IStream* pstream, DWORD /*grfMode*/) override {
        if (!pstream) return E_INVALIDARG;
        if (m_pStream) {
            return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
        }
        m_pStream = pstream;
        m_pStream->AddRef();
        return S_OK;
    }

    // IThumbnailProvider
    IFACEMETHODIMP GetThumbnail(UINT cx, HBITMAP* phbmp, WTS_ALPHATYPE* pdwAlpha) override {
        if (!phbmp || !pdwAlpha) return E_POINTER;
        *phbmp = nullptr;
        *pdwAlpha = WTSAT_UNKNOWN;
        if (!m_pStream) return E_UNEXPECTED;

        STATSTG stat = {};
        HRESULT hr = m_pStream->Stat(&stat, STATFLAG_NONAME);
        if (FAILED(hr)) return hr;

        // Safety cap: 64 MB max read for shell thumbnail generation
        const ULONGLONG kMaxArchiveBytes = 64ULL * 1024ULL * 1024ULL;
        if (stat.cbSize.QuadPart == 0 || stat.cbSize.QuadPart > kMaxArchiveBytes) {
            return E_FAIL;
        }

        size_t fileSize = static_cast<size_t>(stat.cbSize.QuadPart);
        std::vector<uint8_t> buffer(fileSize);

        LARGE_INTEGER liZero = {};
        hr = m_pStream->Seek(liZero, STREAM_SEEK_SET, nullptr);
        if (FAILED(hr)) return hr;

        ULONG bytesRead = 0;
        hr = m_pStream->Read(buffer.data(), static_cast<ULONG>(fileSize), &bytesRead);
        if (FAILED(hr) || bytesRead < sizeof(ZipLocalFileHeader)) {
            return E_FAIL;
        }

        const uint8_t* pngData = nullptr;
        size_t pngSize = 0;
        if (!ExtractPreviewPngFromZip(buffer.data(), bytesRead, &pngData, &pngSize)) {
            return E_FAIL;
        }

        // Decode PNG via Windows Imaging Component (WIC)
        IWICImagingFactory* pFactory = nullptr;
        hr = CoCreateInstance(
            CLSID_WICImagingFactory,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&pFactory)
        );
        if (FAILED(hr)) return hr;

        IStream* pPngStream = SHCreateMemStream(pngData, static_cast<UINT>(pngSize));
        if (!pPngStream) {
            pFactory->Release();
            return E_OUTOFMEMORY;
        }

        IWICBitmapDecoder* pDecoder = nullptr;
        hr = pFactory->CreateDecoderFromStream(pPngStream, nullptr, WICDecodeMetadataCacheOnDemand, &pDecoder);
        if (SUCCEEDED(hr)) {
            IWICBitmapFrameDecode* pFrame = nullptr;
            hr = pDecoder->GetFrame(0, &pFrame);
            if (SUCCEEDED(hr)) {
                UINT srcW = 0, srcH = 0;
                hr = pFrame->GetSize(&srcW, &srcH);
                if (SUCCEEDED(hr) && srcW > 0 && srcH > 0) {
                    UINT dstW = srcW;
                    UINT dstH = srcH;
                    if (cx > 0 && (srcW > cx || srcH > cx)) {
                        if (srcW >= srcH) {
                            dstW = cx;
                            dstH = std::max<UINT>(1, (srcH * cx) / srcW);
                        } else {
                            dstH = cx;
                            dstW = std::max<UINT>(1, (srcW * cx) / srcH);
                        }
                    }

                    IWICBitmapScaler* pScaler = nullptr;
                    hr = pFactory->CreateBitmapScaler(&pScaler);
                    if (SUCCEEDED(hr)) {
                        hr = pScaler->Initialize(pFrame, dstW, dstH, WICBitmapInterpolationModeFant);
                        if (SUCCEEDED(hr)) {
                            IWICFormatConverter* pConverter = nullptr;
                            hr = pFactory->CreateFormatConverter(&pConverter);
                            if (SUCCEEDED(hr)) {
                                hr = pConverter->Initialize(
                                    pScaler,
                                    GUID_WICPixelFormat32bppPBGRA,
                                    WICBitmapDitherTypeNone,
                                    nullptr,
                                    0.0,
                                    WICBitmapPaletteTypeCustom
                                );
                                if (SUCCEEDED(hr)) {
                                    BITMAPINFO bmi = {};
                                    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
                                    bmi.bmiHeader.biWidth = static_cast<LONG>(dstW);
                                    bmi.bmiHeader.biHeight = -static_cast<LONG>(dstH); // Top-down DIB
                                    bmi.bmiHeader.biPlanes = 1;
                                    bmi.bmiHeader.biBitCount = 32;
                                    bmi.bmiHeader.biCompression = BI_RGB;

                                    BYTE* pBits = nullptr;
                                    HBITMAP hBmp = CreateDIBSection(nullptr, &bmi, DIB_RGB_COLORS, reinterpret_cast<void**>(&pBits), nullptr, 0);
                                    if (hBmp && pBits) {
                                        UINT stride = dstW * 4;
                                        UINT cbImage = stride * dstH;
                                        hr = pConverter->CopyPixels(nullptr, stride, cbImage, pBits);
                                        if (SUCCEEDED(hr)) {
                                            *phbmp = hBmp;
                                            *pdwAlpha = WTSAT_ARGB;
                                        } else {
                                            DeleteObject(hBmp);
                                        }
                                    } else {
                                        hr = E_OUTOFMEMORY;
                                    }
                                }
                                pConverter->Release();
                            }
                        }
                        pScaler->Release();
                    }
                }
                pFrame->Release();
            }
            pDecoder->Release();
        }

        pPngStream->Release();
        pFactory->Release();
        return hr;
    }

private:
    long m_cRef;
    IStream* m_pStream;
};

class CClassFactory final : public IClassFactory {
public:
    CClassFactory() : m_cRef(1) {
        InterlockedIncrement(&g_cDllRef);
    }

    ~CClassFactory() {
        InterlockedDecrement(&g_cDllRef);
    }

    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IClassFactory)) {
            *ppv = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    IFACEMETHODIMP_(ULONG) AddRef() override {
        return InterlockedIncrement(&m_cRef);
    }

    IFACEMETHODIMP_(ULONG) Release() override {
        ULONG cRef = InterlockedDecrement(&m_cRef);
        if (cRef == 0) {
            delete this;
        }
        return cRef;
    }

    IFACEMETHODIMP CreateInstance(IUnknown* pUnkOuter, REFIID riid, void** ppv) override {
        if (pUnkOuter) return CLASS_E_NOAGGREGATION;
        auto* pProvider = new (std::nothrow) CLuminaThumbProvider();
        if (!pProvider) return E_OUTOFMEMORY;
        HRESULT hr = pProvider->QueryInterface(riid, ppv);
        pProvider->Release();
        return hr;
    }

    IFACEMETHODIMP LockServer(BOOL fLock) override {
        if (fLock) {
            InterlockedIncrement(&g_cDllRef);
        } else {
            InterlockedDecrement(&g_cDllRef);
        }
        return S_OK;
    }

private:
    long m_cRef;
};

extern "C" BOOL WINAPI DllMain(HINSTANCE hInstance, DWORD dwReason, LPVOID /*lpReserved*/) {
    if (dwReason == DLL_PROCESS_ATTACH) {
        g_hInst = hInstance;
        DisableThreadLibraryCalls(hInstance);
    }
    return TRUE;
}

STDAPI DllCanUnloadNow() {
    return (g_cDllRef == 0) ? S_OK : S_FALSE;
}

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (!IsEqualCLSID(rclsid, CLSID_LuminaThumbProvider)) {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    auto* pFactory = new (std::nothrow) CClassFactory();
    if (!pFactory) return E_OUTOFMEMORY;
    HRESULT hr = pFactory->QueryInterface(riid, ppv);
    pFactory->Release();
    return hr;
}

static HRESULT SetRegStringValue(HKEY hRoot, const wchar_t* subKey, const wchar_t* valueName, const wchar_t* data) {
    HKEY hKey = nullptr;
    LSTATUS status = RegCreateKeyExW(hRoot, subKey, 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &hKey, nullptr);
    if (status != ERROR_SUCCESS) return HRESULT_FROM_WIN32(status);
    status = RegSetValueExW(
        hKey,
        valueName,
        0,
        REG_SZ,
        reinterpret_cast<const BYTE*>(data),
        static_cast<DWORD>((wcslen(data) + 1) * sizeof(wchar_t))
    );
    RegCloseKey(hKey);
    return HRESULT_FROM_WIN32(status);
}

STDAPI DllRegisterServer() {
    wchar_t szModule[MAX_PATH] = {};
    if (!GetModuleFileNameW(g_hInst, szModule, MAX_PATH)) {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    const wchar_t* clsidKey = L"Software\\Classes\\CLSID\\{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}";
    const wchar_t* inprocKey = L"Software\\Classes\\CLSID\\{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}\\InprocServer32";
    const wchar_t* shellExKey = L"Software\\Classes\\.lumina\\ShellEx\\{e357fccd-a995-4576-b01f-234630154e96}";

    HRESULT hr = SetRegStringValue(HKEY_CURRENT_USER, clsidKey, nullptr, L"Lumina Drift Thumbnail Provider");
    if (SUCCEEDED(hr)) {
        hr = SetRegStringValue(HKEY_CURRENT_USER, inprocKey, nullptr, szModule);
    }
    if (SUCCEEDED(hr)) {
        hr = SetRegStringValue(HKEY_CURRENT_USER, inprocKey, L"ThreadingModel", L"Apartment");
    }
    if (SUCCEEDED(hr)) {
        hr = SetRegStringValue(HKEY_CURRENT_USER, shellExKey, nullptr, L"{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}");
    }
    if (SUCCEEDED(hr)) {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    }
    return hr;
}

STDAPI DllUnregisterServer() {
    RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\CLSID\\{8E4A9D21-5C7B-4F3A-9B1E-6D2C8A4F0E19}");
    RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\.lumina\\ShellEx\\{e357fccd-a995-4576-b01f-234630154e96}");
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
    return S_OK;
}
