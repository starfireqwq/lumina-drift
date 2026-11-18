#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <string.h>

// WinTab reference: LOGCONTEXTA and the PACKET fields selected below, in bit order.
constexpr UINT kInterface = 1, kDeviceCount = 4, kDefaultSystemContext = 4;
constexpr UINT kDevices = 100, kNormalPressure = 15;
constexpr UINT kSystem = 0x0001, kMessages = 0x0004;
constexpr UINT kMessageBase = 0x7ff0; // WT_PACKET
constexpr DWORD kPacketStatus = 0x0002, kPacketSerial = 0x0010; // PK_STATUS, PK_SERIAL_NUMBER
constexpr DWORD kQueueError = 0x0002, kInverted = 0x0010; // TPS_QUEUE_ERR, TPS_INVERT
constexpr DWORD kPacketFields = kPacketStatus | 0x0004 | kPacketSerial | 0x0020 | 0x0040 | 0x0080 | 0x0100 | 0x0400;
constexpr DWORD kTip = 1;
constexpr uint32_t kContactFlag = 1, kEraserFlag = 2, kGapFlag = 4, kDownFlag = 8;
constexpr uint32_t kNewestInMessage = 16;
constexpr uint32_t kNeedsCapacity = 0x80000000;

struct LogContext {
  char name[40];
  UINT options, status, locks, messageBase, device, packetRate;
  DWORD packetData, packetMode, moveMask, buttonDownMask, buttonUpMask;
  LONG inX, inY, inZ, inWidth, inHeight, inDepth;
  LONG outX, outY, outZ, outWidth, outHeight, outDepth;
  DWORD sensitivityX, sensitivityY, sensitivityZ;
  BOOL systemMode;
  int systemX, systemY, systemWidth, systemHeight;
  DWORD systemSensitivityX, systemSensitivityY;
};
struct Axis { LONG min, max; UINT units; DWORD resolution; };
struct Packet { UINT status; DWORD time; UINT serial, cursor; DWORD buttons; LONG x, y; UINT pressure; };

// Buffer layout shared with electron/winTab.ts. Fixed-width fields keep the ABI independent of Electron.
struct Sample {
  int32_t x, y;
  uint32_t age, cursor, pressure, flags, serial, capturedAge, messageAge;
};
constexpr size_t kMaxPackets = 64;
struct Command {
  uint32_t action, result;
  uint64_t window;
};
static_assert(sizeof(void*) == 8 && sizeof(LogContext) == 172 && sizeof(Packet) == 32 &&
              sizeof(Command) == 16 && sizeof(Sample) == 36);

// Each input thread owns its queue's writer. The capture process drains short
// batches under the lock and returns before doing JS or IPC work.
class SampleQueue {
 public:
  void Push(Sample sample) {
    AcquireSRWLockExclusive(&lock);
    if (length == kCapacity) {
      --length;
      head = (head + 1) % kCapacity;
      items[head].flags |= kGapFlag;
    }
    items[(head + length++) % kCapacity] = sample;
    ReleaseSRWLockExclusive(&lock);
  }

  uint32_t Read(Sample* result) {
    AcquireSRWLockExclusive(&lock);
    const DWORD now = GetTickCount();
    const auto count = length < kMaxPackets ? length : kMaxPackets;
    for (size_t i = 0; i < count; ++i) {
      result[i] = items[(head + i) % kCapacity];
      if (result[i].age != UINT32_MAX) result[i].age = now - result[i].age;
      result[i].capturedAge = now - result[i].capturedAge;
    }
    head = (head + count) % kCapacity;
    length -= count;
    ReleaseSRWLockExclusive(&lock);
    return static_cast<uint32_t>(count);
  }

  void Clear() {
    AcquireSRWLockExclusive(&lock);
    head = length = 0;
    ReleaseSRWLockExclusive(&lock);
  }

 private:
  static constexpr size_t kCapacity = 2048;
  SRWLOCK lock = SRWLOCK_INIT;
  Sample items[kCapacity] = {};
  size_t head = 0, length = 0;
};

using Info = UINT(WINAPI*)(UINT, UINT, LPVOID);
using Open = HANDLE(WINAPI*)(HWND, LogContext*, BOOL);
using Close = BOOL(WINAPI*)(HANDLE);
using GetPackets = int(WINAPI*)(HANDLE, int, LPVOID);
using GetPacket = BOOL(WINAPI*)(HANDLE, UINT, LPVOID);
using QueueSizeSet = BOOL(WINAPI*)(HANDLE, int);
using Overlap = BOOL(WINAPI*)(HANDLE, BOOL);

static HMODULE driver = nullptr;
static HANDLE context = nullptr;
static Close closeContext = nullptr;
static GetPackets getPackets = nullptr;
static GetPacket getPacket = nullptr;
static Axis pressure = {};

static void CloseTablet() {
  if (context) closeContext(context);
  context = nullptr;
  if (driver) FreeLibrary(driver);
  driver = nullptr;
}

static uint32_t OpenTablet(HWND window) {
  CloseTablet();
  driver = LoadLibraryExW(L"wintab32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!driver) return GetLastError() == ERROR_MOD_NOT_FOUND ? 1 : 2;
  auto info = reinterpret_cast<Info>(GetProcAddress(driver, "WTInfoA"));
  auto open = reinterpret_cast<Open>(GetProcAddress(driver, "WTOpenA"));
  closeContext = reinterpret_cast<Close>(GetProcAddress(driver, "WTClose"));
  getPackets = reinterpret_cast<GetPackets>(GetProcAddress(driver, "WTPacketsGet"));
  getPacket = reinterpret_cast<GetPacket>(GetProcAddress(driver, "WTPacket"));
  if (!info || !open || !closeContext || (!getPackets && !getPacket) || !info(0, 0, nullptr)) return 2;

  UINT devices = 0;
  LogContext settings = {};
  if (info(kInterface, kDeviceCount, &devices) != sizeof(devices) || !devices ||
      info(kDefaultSystemContext, 0, &settings) != sizeof(settings)) return 2;
  const UINT device = settings.device < devices ? settings.device : 0;
  if (info(kDevices + device, kNormalPressure, &pressure) != sizeof(pressure) ||
      pressure.max <= pressure.min) return 3;
  if (settings.systemWidth <= 0 || settings.systemHeight <= 0) return 4;

  settings.options |= kSystem | kMessages;
  settings.messageBase = kMessageBase;
  settings.packetData = kPacketFields;
  settings.moveMask = kPacketFields & ~kPacketSerial;
  settings.packetMode = 0;
  settings.buttonDownMask = settings.buttonUpMask = kTip;
  settings.outX = settings.systemX;
  // The sign of ExtY reverses the axis; OrgY remains the low screen coordinate.
  settings.outY = settings.systemY;
  settings.outWidth = settings.systemWidth;
  settings.outHeight = -settings.systemHeight;
  context = open(window, &settings, TRUE);
  if (!context) return 4;
  auto overlap = reinterpret_cast<Overlap>(GetProcAddress(driver, "WTOverlap"));
  if (overlap) overlap(context, TRUE);
  auto resizeQueue = reinterpret_cast<QueueSizeSet>(GetProcAddress(driver, "WTQueueSizeSet"));
  if (resizeQueue) {
    for (int size = 512; size > 0; size /= 2) {
      if (resizeQueue(context, size)) return 0;
    }
    return 4;
  }
  return 0;
}

static uint32_t ReadPackets(Sample* samples, bool single, UINT serial) {
  if (!context) return 0;
  Packet packets[kMaxPackets];
  const int count = single ? (getPacket && getPacket(context, serial, packets) ? 1 : 0)
    : getPackets ? getPackets(context, kMaxPackets, packets) : 0;
  if (count <= 0 || count > static_cast<int>(kMaxPackets)) return 0;
  const DWORD now = GetTickCount();
  for (int i = 0; i < count; ++i) {
    const auto& p = packets[i];
    const double level = (static_cast<double>(p.pressure) - pressure.min) /
      (static_cast<double>(pressure.max) - pressure.min);
    const auto value = static_cast<uint32_t>((level < 0 ? 0 : level > 1 ? 1 : level) * 1000000.0);
    const auto contact = (p.buttons & kTip) || value ? kContactFlag : 0u;
    const auto eraser = (p.status & kInverted) ? kEraserFlag : 0u;
    const auto gap = (p.status & kQueueError) ? kGapFlag : 0u;
    samples[i] = {p.x, p.y, p.time ? p.time : UINT32_MAX, p.cursor, value, contact | eraser | gap, p.serial, now};
  }
  return static_cast<uint32_t>(count);
}

static SampleQueue tabletQueue, mouseQueue;
static HWND tabletWindow = nullptr;
static HANDLE tabletThread = nullptr, mouseThread = nullptr;
static DWORD mouseThreadId = 0;
static volatile LONG tabletRequest = 0, tabletApplied = 0, tabletStatus = 5, tabletChanged = 0;
static volatile LONG mouseStatus = 0;
constexpr UINT kConfigureTablet = WM_APP + 1;
constexpr UINT kConfigureMouse = WM_APP + 2;
static void DrainTablet(bool hasSerial = false, UINT serial = 0) {
  Sample samples[kMaxPackets];
  uint32_t total = 0;
  for (int batch = 0; batch < 8; ++batch) {
    const auto count = ReadPackets(samples, false, 0);
    for (uint32_t i = 0; i < count; ++i) tabletQueue.Push(samples[i]);
    total += count;
    if (count < kMaxPackets) break;
  }
  if (!total && hasSerial && ReadPackets(samples, true, serial)) tabletQueue.Push(samples[0]);
}

static LRESULT CALLBACK TabletWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case kConfigureTablet: {
      CloseTablet();
      tabletQueue.Clear();
      const auto result = lParam ? OpenTablet(window) : 6u;
      if (result) {
        KillTimer(window, 1);
        CloseTablet();
      } else {
        SetTimer(window, 1, 50, nullptr);
      }
      InterlockedExchange(&tabletStatus, result);
      InterlockedExchange(&tabletApplied, static_cast<LONG>(wParam));
      return 0;
    }
    case WM_TIMER:
      DrainTablet();
      return 0;
    case kMessageBase:
      if (context && reinterpret_cast<HANDLE>(lParam) == context) DrainTablet(true, static_cast<UINT>(wParam));
      return 0;
    case kMessageBase + 6:
      InterlockedExchange(&tabletChanged, 1);
      return 0;
    case WM_CLOSE:
      CloseTablet();
      DestroyWindow(window);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

static DWORD WINAPI RunTablet(LPVOID opaque) {
  auto ready = static_cast<HANDLE>(opaque);
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const auto instance = GetModuleHandleW(nullptr);
  const wchar_t name[] = L"LuminaWinTabInput";
  WNDCLASSW windowClass = {};
  windowClass.hInstance = instance;
  windowClass.lpfnWndProc = TabletWindowProc;
  windowClass.lpszClassName = name;
  RegisterClassW(&windowClass);
  const auto window = CreateWindowExW(WS_EX_TOOLWINDOW, name, nullptr, WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, instance, nullptr);
  tabletWindow = window;
  SetEvent(ready);
  if (!window) return 1;

  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) DispatchMessageW(&message);
  return 0;
}

static bool ConfigureTablet(bool enabled) {
  if (!tabletThread && enabled) {
    auto ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!ready) return false;
    tabletThread = CreateThread(nullptr, 0, RunTablet, ready, 0, nullptr);
    if (tabletThread) WaitForSingleObject(ready, INFINITE);
    CloseHandle(ready);
  }
  if (!tabletWindow) return false;
  return PostMessageW(tabletWindow, kConfigureTablet, InterlockedIncrement(&tabletRequest), enabled) != FALSE;
}

struct MouseStartup { HWND owner; HANDLE ready; };

static DWORD WINAPI RunMouse(LPVOID opaque) {
  const auto startup = *static_cast<MouseStartup*>(opaque);
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const auto window = CreateWindowExW(0, L"STATIC", nullptr, 0, 0, 0, 0, 0, HWND_MESSAGE,
    nullptr, GetModuleHandleW(nullptr), nullptr);
  SetEvent(startup.ready);
  if (!window) {
    InterlockedExchange(&mouseStatus, -1);
    return 1;
  }
  MSG message;
  HANDLE activeDevice = nullptr;
  uint32_t serial = 0, stroke = 0;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == kConfigureMouse) {
      const bool focused = message.wParam != 0;
      const RAWINPUTDEVICE device = {1, 2, focused ? RIDEV_INPUTSINK : RIDEV_REMOVE, focused ? window : nullptr};
      const bool registered = RegisterRawInputDevices(&device, 1, sizeof(device)) != FALSE;
      InterlockedExchange(&mouseStatus, registered && focused ? 1 : -1);
      activeDevice = nullptr;
      mouseQueue.Clear();
    } else if (message.message == WM_INPUT) {
      RAWINPUT raw = {};
      UINT size = sizeof(raw);
      if (GetForegroundWindow() != startup.owner) activeDevice = nullptr;
      else if (InterlockedCompareExchange(&mouseStatus, 0, 0) == 1 &&
          GetRawInputData(reinterpret_cast<HRAWINPUT>(message.lParam), RID_INPUT, &raw, &size,
            sizeof(RAWINPUTHEADER)) == sizeof(raw) && raw.header.dwType == RIM_TYPEMOUSE && raw.header.hDevice &&
          (raw.data.mouse.ulExtraInformation & 0xffffff00) != 0xff515700) {
        const auto buttons = raw.data.mouse.usButtonFlags;
        const bool down = !activeDevice && (buttons & RI_MOUSE_LEFT_BUTTON_DOWN);
        if (down) {
          activeDevice = raw.header.hDevice;
          ++stroke;
        }
        if (raw.header.hDevice == activeDevice) {
          const bool up = (buttons & RI_MOUSE_LEFT_BUTTON_UP) != 0;
          if (down || up || raw.data.mouse.lLastX || raw.data.mouse.lLastY) {
            const auto flags = up ? 0u : kContactFlag | (down ? kDownFlag : 0u);
            // The queued screen coordinate preserves Windows pointer acceleration.
            mouseQueue.Push({message.pt.x, message.pt.y, message.time, stroke, 500000, flags, ++serial, GetTickCount()});
          }
          if (up) activeDevice = nullptr;
        }
      }
      DefWindowProcW(message.hwnd, message.message, message.wParam, message.lParam);
      continue;
    }
    DispatchMessageW(&message);
  }
  DestroyWindow(window);
  return 0;
}

static uint32_t ReadInkPointer(UINT32 pointerId, Sample* samples, size_t capacity, bool latestOnly) {
  using ReadPenInfo = BOOL(WINAPI*)(UINT32, POINTER_PEN_INFO*);
  using ReadPenHistory = BOOL(WINAPI*)(UINT32, UINT32*, POINTER_PEN_INFO*);
  static ReadPenInfo readPenInfo = nullptr;
  static ReadPenHistory readPenHistory = nullptr;
  if (!readPenInfo) readPenInfo = reinterpret_cast<ReadPenInfo>(
    GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetPointerPenInfo"));
  POINTER_PEN_INFO latest;
  if (!readPenInfo || !readPenInfo(pointerId, &latest)) return 0;
  const UINT32 historyCount = latest.pointerInfo.historyCount;
  if (!latestOnly && historyCount > capacity) return kNeedsCapacity | historyCount;

  // The window thread is the only caller. Reuse storage for ordinary coalesced messages.
  static POINTER_PEN_INFO local[kMaxPackets];
  POINTER_PEN_INFO* allocated = nullptr;
  auto* history = &latest;
  UINT32 count = 1;
  if (!latestOnly && historyCount > 1) {
    if (!readPenHistory) readPenHistory = reinterpret_cast<ReadPenHistory>(
      GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetPointerPenInfoHistory"));
    auto* buffer = local;
    if (readPenHistory && historyCount > kMaxPackets) {
      allocated = static_cast<POINTER_PEN_INFO*>(HeapAlloc(GetProcessHeap(), 0, historyCount * sizeof(POINTER_PEN_INFO)));
      buffer = allocated;
    }
    UINT32 available = historyCount;
    if (readPenHistory && buffer && readPenHistory(pointerId, &available, buffer) && available == historyCount) {
      history = buffer;
      count = available;
    }
  }
  const DWORD now = GetTickCount();
  const DWORD messageAge = now - static_cast<DWORD>(GetMessageTime());
  for (UINT32 i = 0; i < count; i++) {
    const auto& info = history[count - i - 1]; // Windows returns newest first.
    const auto& pointer = info.pointerInfo;
    const auto contact = (pointer.pointerFlags & POINTER_FLAG_INCONTACT) &&
      !(pointer.pointerFlags & POINTER_FLAG_CANCELED) ? kContactFlag : 0u;
    const auto eraser = (info.penFlags & (PEN_FLAG_INVERTED | PEN_FLAG_ERASER)) ? kEraserFlag : 0u;
    const auto pressure = (info.penMask & PEN_MASK_PRESSURE) ? info.pressure * 1000000u / 1024u : 0u;
    const auto gap = history == &latest && historyCount > 1 ? kGapFlag : 0u;
    const auto flags = contact | eraser | gap | (i + 1 == count ? kNewestInMessage : 0u);
    samples[i] = {pointer.ptPixelLocationRaw.x, pointer.ptPixelLocationRaw.y, now - pointer.dwTime,
                  pointerId, pressure, flags, pointer.frameId, 0, messageAge};
  }
  if (allocated) HeapFree(GetProcessHeap(), 0, allocated);
  return count;
}

// Only the stable Node-API Buffer/function entrypoints are needed. Electron exports them from
// its executable on Windows, so no Electron-specific SDK or import library is needed at build time.
using Env = struct napi_env__*;
using Value = struct napi_value__*;
using CallbackInfo = struct napi_callback_info__*;
using GetCallbackInfo = int(__cdecl*)(Env, CallbackInfo, size_t*, Value*, Value*, void**);
using GetBufferInfo = int(__cdecl*)(Env, Value, void**, size_t*);
using CreateFunction = int(__cdecl*)(Env, const char*, size_t, Value(__cdecl*)(Env, CallbackInfo), void*, Value*);
using SetProperty = int(__cdecl*)(Env, Value, const char*, Value);

static GetCallbackInfo getCallbackInfo = nullptr;
static GetBufferInfo getBufferInfo = nullptr;

static Value __cdecl Execute(Env env, CallbackInfo info) {
  size_t argc = 1, length = 0;
  Value argument = nullptr;
  void* data = nullptr;
  if (getCallbackInfo(env, info, &argc, &argument, nullptr, nullptr) != 0 || argc != 1 ||
      getBufferInfo(env, argument, &data, &length) != 0 ||
      length < sizeof(Command) + kMaxPackets * sizeof(Sample)) return nullptr;
  Command cmd = {};
  memcpy(&cmd, data, sizeof(cmd));
  auto* samples = reinterpret_cast<Sample*>(static_cast<char*>(data) + sizeof(Command));
  const size_t capacity = (length - sizeof(Command)) / sizeof(Sample);
  switch (cmd.action) {
    case 0: cmd.result = ConfigureTablet(true); break;
    case 1: cmd.result = tabletQueue.Read(samples); break;
    case 2: ConfigureTablet(false); break;
    case 3: cmd.result = ReadInkPointer(cmd.result, samples, capacity, false); break;
    case 4: cmd.result = InterlockedCompareExchange(&tabletRequest, 0, 0) == InterlockedCompareExchange(&tabletApplied, 0, 0)
      ? InterlockedCompareExchange(&tabletStatus, 0, 0) : 5; break;
    case 5: cmd.result = ReadInkPointer(cmd.result, samples, capacity, true); break;
    case 6: cmd.result = 0x41544c36; break; // Bridge version.
    case 7:
      if (!mouseThread && cmd.result) {
        MouseStartup startup = {reinterpret_cast<HWND>(cmd.window), CreateEventW(nullptr, FALSE, FALSE, nullptr)};
        if (startup.ready) {
          mouseThread = CreateThread(nullptr, 0, RunMouse, &startup, 0, &mouseThreadId);
          if (mouseThread) WaitForSingleObject(startup.ready, INFINITE);
          CloseHandle(startup.ready);
        }
        if (!mouseThread) InterlockedExchange(&mouseStatus, -1);
      }
      if (mouseThreadId) {
        InterlockedExchange(&mouseStatus, 0);
        if (!PostThreadMessageW(mouseThreadId, kConfigureMouse, cmd.result, 0)) InterlockedExchange(&mouseStatus, -1);
      }
      break;
    case 8: cmd.result = mouseQueue.Read(samples); break;
    case 9: cmd.result = InterlockedCompareExchange(&mouseStatus, 0, 0); break;
    case 10: cmd.result = InterlockedExchange(&tabletChanged, 0); break;
    case 11:
      if (tabletWindow) PostMessageW(tabletWindow, WM_CLOSE, 0, 0);
      if (mouseThreadId) PostThreadMessageW(mouseThreadId, WM_QUIT, 0, 0);
      if (tabletThread) CloseHandle(tabletThread);
      if (mouseThread) CloseHandle(mouseThread);
      break;
    case 12: {
      constexpr wchar_t property[] = L"MicrosoftTabletPenServiceProperty";
      constexpr uintptr_t gestures = 0x00000001 | 0x00000008 | 0x00000010 | 0x00010000;
      const auto atom = GlobalAddAtomW(property);
      cmd.result = SetPropW(reinterpret_cast<HWND>(cmd.window), property, reinterpret_cast<HANDLE>(gestures));
      if (atom) GlobalDeleteAtom(atom);
      break;
    }
  }
  memcpy(data, &cmd, sizeof(cmd));
  return argument;
}

extern "C" __declspec(dllexport) Value __cdecl napi_register_module_v1(Env env, Value exports) {
  auto host = GetModuleHandleW(nullptr);
  getCallbackInfo = reinterpret_cast<GetCallbackInfo>(GetProcAddress(host, "napi_get_cb_info"));
  getBufferInfo = reinterpret_cast<GetBufferInfo>(GetProcAddress(host, "napi_get_buffer_info"));
  auto create = reinterpret_cast<CreateFunction>(GetProcAddress(host, "napi_create_function"));
  auto set = reinterpret_cast<SetProperty>(GetProcAddress(host, "napi_set_named_property"));
  Value execute = nullptr;
  if (getCallbackInfo && getBufferInfo && create && set &&
      create(env, "execute", 7, Execute, nullptr, &execute) == 0) set(env, exports, "execute", execute);
  return exports;
}
