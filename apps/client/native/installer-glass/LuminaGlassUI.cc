#include <windows.h>
#include <commctrl.h>
#include <objidl.h>
#include <gdiplus.h>
#include <richedit.h>
#include <uxtheme.h>
#include <algorithm>

using namespace Gdiplus;

// Keep the x86 callee-cleanup ABI while giving NSIS undecorated entry points.
extern "C" __declspec(dllexport) void __stdcall AttachInstallerGlass(
    HWND hwndParent, const wchar_t* iconPngPath) __asm__("_AttachInstallerGlass");
extern "C" __declspec(dllexport) void __stdcall DetachInstallerGlass()
    __asm__("_DetachInstallerGlass");

namespace {

constexpr UINT_PTR kSubclass = 1;
constexpr UINT_PTR kAnimationTimer = 0x4C47;
constexpr UINT kRefresh = WM_APP + 0x4C;
constexpr wchar_t kControlProperty[] = L"LuminaDrift.InstallerGlass.Control";
constexpr COLORREF kText = RGB(232, 238, 255);
constexpr COLORREF kMuted = RGB(175, 186, 213);
constexpr COLORREF kDisabled = RGB(134, 145, 175);
constexpr COLORREF kEdit = RGB(14, 19, 36);
constexpr DWORD kDarkMode = 20;
constexpr DWORD kLegacyDarkMode = 19;
constexpr DWORD kCorner = 33;
constexpr DWORD kBorder = 34;
constexpr DWORD kCaption = 35;
constexpr COLORREF kDwmDefault = 0xFFFFFFFF;

enum class Control : DWORD_PTR {
    None, Dialog, Header, Divider, Branding, WizardImage, Label, Button, GroupBox,
    Progress, RichEdit, Details
};

struct Glass {
    HWND parent = nullptr;
    HBRUSH editBrush = nullptr;
    ULONG_PTR gdiplus = 0;
    Bitmap* icon = nullptr;
    HDC backdrop = nullptr;
    HBITMAP backdropBitmap = nullptr;
    HGDIOBJ originalBitmap = nullptr;
    SIZE backdropSize{};
    HMODULE dwm = nullptr;
    HRESULT (WINAPI* setDwm)(HWND, DWORD, LPCVOID, DWORD) = nullptr;
    bool animatedBorder = false;
    UINT_PTR timer = 0;
    ULONGLONG start = 0;
    float phase = 0;
    float scale = 1;
} glass;

LRESULT CALLBACK GlassProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);

bool IsClass(HWND hwnd, const wchar_t* expected) {
    wchar_t name[32];
    return GetClassNameW(hwnd, name, ARRAYSIZE(name)) && lstrcmpiW(name, expected) == 0;
}

RECT InParent(HWND hwnd) {
    RECT rect{};
    GetClientRect(hwnd, &rect);
    MapWindowPoints(hwnd, glass.parent, reinterpret_cast<POINT*>(&rect), 2);
    return rect;
}

RECT WindowInParent(HWND hwnd, HWND parent) {
    RECT rect{};
    GetWindowRect(hwnd, &rect);
    MapWindowPoints(nullptr, parent, reinterpret_cast<POINT*>(&rect), 2);
    return rect;
}

RectF Bounds(const RECT& rect) {
    return RectF(static_cast<REAL>(rect.left), static_cast<REAL>(rect.top),
                 static_cast<REAL>(rect.right - rect.left), static_cast<REAL>(rect.bottom - rect.top));
}

void UpdateScale() {
    HDC dc = GetDC(glass.parent);
    if (dc) {
        glass.scale = GetDeviceCaps(dc, LOGPIXELSX) / 96.0f;
        ReleaseDC(glass.parent, dc);
    }
    using GetDpi = UINT (WINAPI*)(HWND);
    const auto getDpi = reinterpret_cast<GetDpi>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
    if (getDpi) {
        const UINT dpi = getDpi(glass.parent);
        if (dpi) glass.scale = dpi / 96.0f;
    }
}

Color LightColor(float phase, BYTE alpha = 255) {
    constexpr BYTE rgb[][3] = {{139, 92, 246}, {59, 130, 246}, {6, 182, 212}, {236, 72, 153}};
    const int step = static_cast<int>(phase);
    const float fraction = phase - step;
    const auto& left = rgb[step % 4];
    const auto& right = rgb[(step + 1) % 4];
    const auto mix = [fraction](BYTE a, BYTE b) { return static_cast<BYTE>(a + (b - a) * fraction); };
    return Color(alpha, mix(left[0], right[0]), mix(left[1], right[1]), mix(left[2], right[2]));
}

void LightStops(LinearGradientBrush& brush, BYTE alpha = 255) {
    const Color colors[] = {LightColor(glass.phase, alpha), LightColor(glass.phase + 1, alpha),
                            LightColor(glass.phase + 2, alpha), LightColor(glass.phase + 3, alpha)};
    const REAL stops[] = {0, 0.34f, 0.68f, 1};
    brush.SetInterpolationColors(colors, stops, ARRAYSIZE(stops));
}

void Wash(Graphics& graphics, const RectF& rect, const Color& color) {
    GraphicsPath path;
    path.AddEllipse(rect);
    PathGradientBrush brush(&path);
    brush.SetCenterColor(color);
    const Color transparent(0, color.GetR(), color.GetG(), color.GetB());
    INT count = 1;
    brush.SetSurroundColors(&transparent, &count);
    graphics.FillPath(&brush, &path);
}

void PaintBackdrop(Graphics& graphics, const RectF& outer) {
    LinearGradientBrush base(outer, Color(255, 11, 15, 30), Color(255, 19, 24, 48),
                             LinearGradientModeForwardDiagonal);
    graphics.FillRectangle(&base, outer);
    const REAL w = outer.Width;
    const REAL h = outer.Height;
    Wash(graphics, RectF(-w * .50f, -h * .48f, w * 1.50f, h * 1.2f), Color(43, 139, 92, 246));
    Wash(graphics, RectF(w * .15f, -h * .25f, w * 1.25f, h * 1.4f), Color(29, 6, 182, 212));
    Wash(graphics, RectF(w * .36f, h * .41f, w, h), Color(35, 236, 72, 153));
}

void ReleaseBackdrop() {
    if (!glass.backdrop) return;
    SelectObject(glass.backdrop, glass.originalBitmap);
    DeleteObject(glass.backdropBitmap);
    DeleteDC(glass.backdrop);
    glass.backdrop = nullptr;
}

void CopyBackdrop(HDC dc, const RECT& area, const RectF& outer) {
    const int width = static_cast<int>(outer.Width);
    const int height = static_cast<int>(outer.Height);
    if (!glass.backdrop || width != glass.backdropSize.cx || height != glass.backdropSize.cy) {
        ReleaseBackdrop();
        glass.backdrop = CreateCompatibleDC(dc);
        glass.backdropBitmap = glass.backdrop ? CreateCompatibleBitmap(dc, width, height) : nullptr;
        if (glass.backdropBitmap) {
            glass.originalBitmap = SelectObject(glass.backdrop, glass.backdropBitmap);
            glass.backdropSize = {width, height};
            Graphics graphics(glass.backdrop);
            PaintBackdrop(graphics, outer);
        } else {
            if (glass.backdrop) DeleteDC(glass.backdrop);
            glass.backdrop = nullptr;
        }
    }
    if (glass.backdrop) {
        BitBlt(dc, 0, 0, area.right - area.left, area.bottom - area.top,
               glass.backdrop, area.left, area.top, SRCCOPY);
    } else {
        Graphics graphics(dc);
        graphics.TranslateTransform(-static_cast<REAL>(area.left), -static_cast<REAL>(area.top));
        PaintBackdrop(graphics, outer);
    }
}

void PaintDivider(HDC dc, const RectF& bounds) {
    Graphics graphics(dc);
    SolidBrush line(Color(146, 91, 111, 169));
    graphics.FillRectangle(&line, bounds.X, bounds.Y, bounds.Width, glass.scale);
}

void PaintDividerWindow(HWND hwnd, HDC dc) {
    const RECT area = WindowInParent(hwnd, glass.parent);
    CopyBackdrop(dc, area, Bounds(InParent(glass.parent)));
    PaintDivider(dc, RectF(0, 0, static_cast<REAL>(area.right - area.left),
                         static_cast<REAL>(area.bottom - area.top)));
}

void PaintIcon(Graphics& graphics, const RectF& icon) {
    if (!glass.icon) return;
    const float scale = glass.scale;
    RectF halo = icon;
    halo.Inflate(3 * scale, 3 * scale);
    Wash(graphics, RectF(halo.X - 6 * scale, halo.Y - 6 * scale,
                         halo.Width + 12 * scale, halo.Height + 12 * scale), LightColor(glass.phase, 105));
    LinearGradientBrush light(halo, LightColor(glass.phase), LightColor(glass.phase + 2),
                              LinearGradientModeForwardDiagonal);
    LightStops(light, 152);
    Pen ring(&light, 1.3f * scale);
    graphics.DrawEllipse(&ring, halo);
    graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);
    graphics.DrawImage(glass.icon, icon, 0, 0, static_cast<REAL>(glass.icon->GetWidth()),
                       static_cast<REAL>(glass.icon->GetHeight()), UnitPixel);
}

void HeaderText(Graphics& graphics, HWND label, const RectF& bounds, bool title) {
    if (bounds.Width <= 0 || bounds.Height <= 0) return;
    wchar_t text[1024];
    const int length = GetWindowTextW(label, text, ARRAYSIZE(text));
    if (!length) return;
    const WORD language = PRIMARYLANGID(GetUserDefaultUILanguage());
    const wchar_t* face = language == LANG_CHINESE ? L"Microsoft JhengHei UI" : L"Segoe UI";
    Font font(face, (title ? 17.0f : 12.0f) * glass.scale,
              title ? FontStyleBold : FontStyleRegular, UnitPixel);
    StringFormat format;
    format.SetFormatFlags(StringFormatFlagsNoWrap);
    format.SetAlignment(StringAlignmentNear);
    format.SetLineAlignment(StringAlignmentCenter);
    format.SetTrimming(StringTrimmingEllipsisCharacter);
    SolidBrush ink(title ? Color(255, 244, 247, 255) : Color(255, 189, 200, 228));
    graphics.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
    graphics.DrawString(text, length, &font, bounds, &format, &ink);
}

HWND HeaderBackground() {
    HWND hwnd = GetDlgItem(glass.parent, 1034);
    return hwnd ? hwnd : GetDlgItem(glass.parent, 1046);
}

bool HasHeader() {
    return (GetWindowLongPtrW(GetDlgItem(glass.parent, 1037), GWL_STYLE) & WS_VISIBLE) != 0;
}

void PaintHeader(Graphics& graphics, const RectF& header) {
    if (header.Width <= 0 || header.Height <= 0) return;
    const float scale = glass.scale;
    SolidBrush panel(Color(215, 18, 22, 42));
    graphics.FillRectangle(&panel, header);

    const REAL size = (std::min)(46 * scale, header.Height - 8 * scale);
    const RectF icon(header.GetRight() - size - 16 * scale,
                     header.Y + (header.Height - size) / 2, size, size);
    if (size > 0) PaintIcon(graphics, icon);
    const REAL left = header.X + 16 * scale;
    const REAL available = (glass.icon ? icon.X : header.GetRight()) - left - 14 * scale;
    HeaderText(graphics, GetDlgItem(glass.parent, 1037),
               RectF(left, header.Y + header.Height * .08f, available, header.Height * .48f), true);
    HeaderText(graphics, GetDlgItem(glass.parent, 1038),
               RectF(left, header.Y + header.Height * .54f, available, header.Height * .36f), false);

    LinearGradientBrush light(header, LightColor(glass.phase), LightColor(glass.phase + 3),
                              LinearGradientModeHorizontal);
    LightStops(light);
    graphics.FillRectangle(&light, header.X, header.GetBottom() - 2 * scale, header.Width, 2 * scale);
}

void PaintFrame(Graphics& graphics, HWND hwnd, const RECT& area, const RectF& outer) {
    if (hwnd != glass.parent) {
        const RectF page = Bounds(area);
        Pen outline(Color(64, 171, 184, 231), glass.scale);
        graphics.DrawRectangle(&outline, page.X + .5f, page.Y + .5f,
                               page.Width - 1, page.Height - 1);
        return;
    }
    const HWND header = HeaderBackground();
    if (header && HasHeader()) PaintHeader(graphics, Bounds(InParent(header)));
    Pen edge(Color(56, 153, 173, 225), glass.scale);
    graphics.DrawRectangle(&edge, .5f, .5f, outer.Width - 1, outer.Height - 1);
}

void RoundedPath(GraphicsPath& path, const RectF& rect, REAL radius) {
    const REAL d = (std::min)(2 * radius, (std::min)(rect.Width, rect.Height));
    if (d <= 0) return;
    path.AddArc(rect.X, rect.Y, d, d, 180, 90);
    path.AddArc(rect.GetRight() - d, rect.Y, d, d, 270, 90);
    path.AddArc(rect.GetRight() - d, rect.GetBottom() - d, d, d, 0, 90);
    path.AddArc(rect.X, rect.GetBottom() - d, d, d, 90, 90);
    path.CloseFigure();
}

float ProgressValue(HWND hwnd) {
    PBRANGE range{};
    SendMessageW(hwnd, PBM_GETRANGE, FALSE, reinterpret_cast<LPARAM>(&range));
    const double span = static_cast<double>(range.iHigh) - range.iLow;
    const double position = static_cast<double>(SendMessageW(hwnd, PBM_GETPOS, 0, 0)) - range.iLow;
    return span > 0 ? static_cast<float>(std::clamp(position / span, 0.0, 1.0)) : 0;
}

void PaintProgress(Graphics& graphics, const RectF& area, float progress) {
    const float scale = glass.scale;
    RectF track = area;
    track.Inflate(-scale, -scale);
    if (track.Width <= 0 || track.Height <= 0) return;
    GraphicsPath path;
    RoundedPath(path, track, 6 * scale);
    SolidBrush surface(Color(255, 13, 18, 36));
    graphics.FillPath(&surface, &path);

    if (progress > 0) {
        const auto state = graphics.Save();
        graphics.SetClip(&path, CombineModeIntersect);
        const RectF fill(track.X, track.Y, track.Width * progress, track.Height);
        GraphicsPath filledPath;
        RoundedPath(filledPath, fill, 6 * scale);
        graphics.SetClip(&filledPath, CombineModeIntersect);
        LinearGradientBrush light(track, LightColor(glass.phase), LightColor(glass.phase + 2),
                                  LinearGradientModeHorizontal);
        LightStops(light);
        graphics.FillRectangle(&light, fill);

        const REAL width = track.Width * .27f;
        const REAL center = track.X - width / 2 + (track.Width + width) * glass.phase / 4;
        const RectF beam(center - width / 2, track.Y, width, track.Height);
        LinearGradientBrush shimmer(beam, Color(0, 255, 255, 255), Color(0, 255, 255, 255),
                                    LinearGradientModeHorizontal);
        const Color colors[] = {Color(0, 255, 255, 255), Color(100, 255, 255, 255), Color(0, 255, 255, 255)};
        const REAL stops[] = {0, .5f, 1};
        shimmer.SetInterpolationColors(colors, stops, ARRAYSIZE(stops));
        graphics.FillRectangle(&shimmer, beam);
        graphics.Restore(state);
    }
    Pen edge(Color(102, 162, 178, 226), scale);
    graphics.DrawPath(&edge, &path);
}

void DrawTextLabel(HDC dc, HWND hwnd, RECT& rect, UINT flags, COLORREF color,
                   const wchar_t* text, int length = -1) {
    const int saved = SaveDC(dc);
    const HFONT font = reinterpret_cast<HFONT>(SendMessageW(hwnd, WM_GETFONT, 0, 0));
    SelectObject(dc, font ? font : GetStockObject(DEFAULT_GUI_FONT));
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, color);
    DrawTextW(dc, text, length, &rect, flags);
    RestoreDC(dc, saved);
}

void PaintGroupBox(HDC dc, HWND hwnd, const RECT& local) {
    const float scale = glass.scale;
    const COLORREF color = IsWindowEnabled(hwnd) ? kText : kDisabled;
    const auto uiState = SendMessageW(hwnd, WM_QUERYUISTATE, 0, 0);
    const UINT flags = DT_SINGLELINE | (uiState & UISF_HIDEACCEL ? DT_HIDEPREFIX : 0);
    wchar_t text[1024];
    const int length = GetWindowTextW(hwnd, text, ARRAYSIZE(text));
    RECT title{};
    if (length) {
        DrawTextLabel(dc, hwnd, title, flags | DT_CALCRECT, color, text, length);
        OffsetRect(&title, local.left + static_cast<LONG>(12 * scale + .5f), local.top);
    }

    const REAL topY = local.top + (length ? (title.bottom - title.top) / 2.0f : scale);
    const RectF frame(local.left + scale, topY, local.right - local.left - 2 * scale,
                      local.bottom - topY - scale);
    if (frame.Width > 0 && frame.Height > 0) {
        Graphics graphics(dc);
        graphics.SetSmoothingMode(SmoothingModeAntiAlias);
        GraphicsPath path;
        RoundedPath(path, frame, 8 * scale);
        if (length) {
            const RectF gap(title.left - 5 * scale, static_cast<REAL>(title.top),
                            title.right - title.left + 10 * scale, static_cast<REAL>(title.bottom - title.top));
            graphics.SetClip(gap, CombineModeExclude);
        }
        SolidBrush surface(Color(28, 12, 18, 36));
        graphics.FillPath(&surface, &path);
        Pen edge(Color(92, 165, 190, 245), scale);
        graphics.DrawPath(&edge, &path);
    }
    if (length) DrawTextLabel(dc, hwnd, title, flags, color, text, length);
}

void PaintButton(Graphics& graphics, HWND hwnd, const RectF& area, LONG_PTR style, bool hovered) {
    const auto type = style & BS_TYPEMASK;
    const auto state = SendMessageW(hwnd, BM_GETSTATE, 0, 0);
    const float scale = glass.scale;
    const bool enabled = IsWindowEnabled(hwnd);
    const bool down = (state & BST_PUSHED) != 0;
    const bool push = type == BS_PUSHBUTTON || type == BS_DEFPUSHBUTTON;
    if (push) {
        RectF frame = area;
        frame.Inflate(-1.5f * scale, -1.5f * scale);
        if (frame.Width <= 0 || frame.Height <= 0) return;
        GraphicsPath path;
        RoundedPath(path, frame, 6 * scale);
        const Color top = !enabled ? Color(255, 29, 34, 54) : down ? Color(255, 29, 34, 65) :
                          hovered ? Color(255, 65, 71, 117) : Color(255, 44, 51, 86);
        LinearGradientBrush surface(frame, top, Color(255, 25, 30, 55), LinearGradientModeVertical);
        graphics.FillPath(&surface, &path);
        if (type == BS_DEFPUSHBUTTON && enabled) {
            LinearGradientBrush light(frame, LightColor(glass.phase), LightColor(glass.phase + 2),
                                      LinearGradientModeHorizontal);
            LightStops(light);
            Pen edge(&light, 1.4f * scale);
            graphics.DrawPath(&edge, &path);
        } else {
            Pen edge(Color(hovered && enabled ? 178 : 100, 162, 176, 216), scale);
            graphics.DrawPath(&edge, &path);
        }
        return;
    }

    const REAL size = (std::min)(13 * scale, area.Height - 2 * scale);
    if (size <= 0) return;
    const REAL x = (style & BS_LEFTTEXT) ? area.GetRight() - size - scale : area.X + scale;
    const RectF mark(x, area.Y + (area.Height - size) / 2, size, size);
    const bool radio = type == BS_RADIOBUTTON || type == BS_AUTORADIOBUTTON;
    const auto checked = SendMessageW(hwnd, BM_GETCHECK, 0, 0);
    const Color accent = enabled ? Color(255, 155, 175, 255) : Color(255, 106, 117, 151);
    SolidBrush surface(down || hovered ? Color(255, 48, 56, 94) : Color(255, 23, 29, 53));
    SolidBrush ink(accent);
    Pen edge(accent, scale);
    RectF inner = mark;
    inner.Inflate(-3.5f * scale, -3.5f * scale);
    if (radio) {
        graphics.FillEllipse(&surface, mark);
        graphics.DrawEllipse(&edge, mark);
        if (checked == BST_CHECKED) graphics.FillEllipse(&ink, inner);
    } else {
        GraphicsPath path;
        RoundedPath(path, mark, 3 * scale);
        graphics.FillPath(&surface, &path);
        graphics.DrawPath(&edge, &path);
        if (checked == BST_INDETERMINATE) graphics.FillRectangle(&ink, inner);
        if (checked == BST_CHECKED) {
            Pen check(accent, 1.65f * scale);
            check.SetLineJoin(LineJoinRound);
            const PointF points[] = {{mark.X + size * .22f, mark.Y + size * .51f},
                                     {mark.X + size * .43f, mark.Y + size * .72f},
                                     {mark.X + size * .79f, mark.Y + size * .30f}};
            graphics.DrawLines(&check, points, ARRAYSIZE(points));
        }
    }
}

void PaintControlText(HDC dc, HWND hwnd, Control control, RECT rect, float progress) {
    const auto style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    const auto uiState = SendMessageW(hwnd, WM_QUERYUISTATE, 0, 0);
    const bool enabled = IsWindowEnabled(hwnd);
    UINT flags = uiState & UISF_HIDEACCEL ? DT_HIDEPREFIX : 0;
    wchar_t text[1024];
    if (control == Control::Progress) {
        if (progress > 0) {
            const unsigned percent = static_cast<unsigned>(progress * 100 + .5f);
            wsprintfW(text, L"%u%%", percent);
            OffsetRect(&rect, 0, 1);
            DrawTextLabel(dc, hwnd, rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE, RGB(16, 22, 44), text);
            OffsetRect(&rect, 0, -1);
            DrawTextLabel(dc, hwnd, rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE, RGB(255, 255, 255), text);
        }
        return;
    }

    const int length = GetWindowTextW(hwnd, text, ARRAYSIZE(text));
    if (!length) return;
    if (control == Control::Button) {
        const auto type = style & BS_TYPEMASK;
        const bool push = type == BS_PUSHBUTTON || type == BS_DEFPUSHBUTTON;
        const int inset = static_cast<int>((push ? 7 : 19) * glass.scale + .5f);
        if (push || !(style & BS_LEFTTEXT)) rect.left += inset;
        if (push || (style & BS_LEFTTEXT)) rect.right -= inset;
        flags |= push ? DT_CENTER : DT_LEFT;
        flags |= style & BS_MULTILINE ? DT_WORDBREAK : DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS;
        DrawTextLabel(dc, hwnd, rect, flags, enabled ? kText : kDisabled, text, length);
        if (GetFocus() == hwnd && !(uiState & UISF_HIDEFOCUS)) {
            RECT focus = rect;
            InflateRect(&focus, 2, -3);
            DrawFocusRect(dc, &focus);
        }
        return;
    }

    const auto type = style & SS_TYPEMASK;
    if (type == SS_CENTER) flags |= DT_CENTER;
    if (type == SS_RIGHT) flags |= DT_RIGHT;
    if (style & SS_NOPREFIX) flags |= DT_NOPREFIX;
    if (type == SS_SIMPLE || type == SS_LEFTNOWORDWRAP) flags |= DT_SINGLELINE;
    else flags |= DT_WORDBREAK;
    if (style & SS_CENTERIMAGE) flags |= DT_SINGLELINE | DT_VCENTER;
    if (control == Control::Branding) flags = DT_SINGLELINE | DT_VCENTER | DT_LEFT | DT_NOPREFIX;
    DrawTextLabel(dc, hwnd, rect, flags,
                  enabled ? (control == Control::Branding ? kMuted : kText) : kDisabled, text, length);
}

void Render(HDC dc, HWND hwnd, Control control, const RECT& local) {
    const RECT area = InParent(hwnd);
    const RectF bounds = Bounds(area);
    const RectF outer = Bounds(InParent(glass.parent));
    if (outer.Width <= 0 || outer.Height <= 0) return;
    CopyBackdrop(dc, area, outer);
    if (control == Control::Divider) {
        PaintDivider(dc, Bounds(local));
        return;
    }
    if (control == Control::GroupBox) {
        PaintGroupBox(dc, hwnd, local);
        return;
    }
    const float progress = control == Control::Progress ? ProgressValue(hwnd) : 0.0f;
    {
        Graphics graphics(dc);
        graphics.SetSmoothingMode(SmoothingModeAntiAlias);
        graphics.TranslateTransform(-bounds.X, -bounds.Y);
        switch (control) {
        case Control::Dialog:
            PaintFrame(graphics, hwnd, area, outer);
            break;
        case Control::Header:
            if (HasHeader()) PaintHeader(graphics, Bounds(InParent(HeaderBackground())));
            break;
        case Control::WizardImage: {
            const REAL size = (std::min)(96 * glass.scale, bounds.Width * .67f);
            PaintIcon(graphics, RectF(bounds.X + (bounds.Width - size) / 2,
                                     bounds.Y + (bounds.Height - size) / 2, size, size));
            break;
        }
        case Control::Progress:
            PaintProgress(graphics, bounds, progress);
            break;
        case Control::Button: {
            POINT cursor{};
            const bool hover = GetCursorPos(&cursor) && WindowFromPoint(cursor) == hwnd;
            PaintButton(graphics, hwnd, bounds, GetWindowLongPtrW(hwnd, GWL_STYLE), hover);
            break;
        }
        default:
            break;
        }
    }
    if (control == Control::Label || control == Control::Branding || control == Control::Button ||
        control == Control::Progress) PaintControlText(dc, hwnd, control, local, progress);
}

void PaintWindow(HWND hwnd, Control control, HDC target) {
    RECT rect{};
    GetClientRect(hwnd, &rect);
    if (rect.right <= 0 || rect.bottom <= 0) return;
    const int saved = SaveDC(target);
    if (control == Control::Dialog) {
        for (HWND child = GetWindow(hwnd, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
            if (!IsWindowVisible(child)) continue;
            const RECT bounds = WindowInParent(child, hwnd);
            ExcludeClipRect(target, bounds.left, bounds.top, bounds.right, bounds.bottom);
        }
    } else if (control == Control::GroupBox) {
        for (HWND sibling = GetWindow(GetParent(hwnd), GW_CHILD); sibling; sibling = GetWindow(sibling, GW_HWNDNEXT)) {
            if (sibling == hwnd || !IsWindowVisible(sibling)) continue;
            if (IsClass(sibling, L"Button") && (GetWindowLongPtrW(sibling, GWL_STYLE) & BS_TYPEMASK) == BS_GROUPBOX) continue;
            const RECT bounds = WindowInParent(sibling, hwnd);
            RECT overlap{};
            if (IntersectRect(&overlap, &rect, &bounds)) {
                ExcludeClipRect(target, overlap.left, overlap.top, overlap.right, overlap.bottom);
            }
        }
    }
    HDC buffer = CreateCompatibleDC(target);
    HBITMAP bitmap = buffer ? CreateCompatibleBitmap(target, rect.right, rect.bottom) : nullptr;
    if (bitmap) {
        HGDIOBJ oldBitmap = SelectObject(buffer, bitmap);
        Render(buffer, hwnd, control, rect);
        BitBlt(target, 0, 0, rect.right, rect.bottom, buffer, 0, 0, SRCCOPY);
        SelectObject(buffer, oldBitmap);
        DeleteObject(bitmap);
    } else {
        Render(target, hwnd, control, rect);
    }
    if (buffer) DeleteDC(buffer);
    RestoreDC(target, saved);
}

void ColorRichEdit(HWND hwnd, bool apply) {
    SendMessageW(hwnd, EM_SETBKGNDCOLOR, !apply, kEdit);
    CHARFORMATW format{};
    format.cbSize = sizeof(format);
    format.dwMask = CFM_COLOR;
    format.dwEffects = apply ? 0 : CFE_AUTOCOLOR;
    format.crTextColor = RGB(224, 232, 248);
    SendMessageW(hwnd, EM_SETCHARFORMAT, SCF_ALL, reinterpret_cast<LPARAM>(&format));
}

void ColorDetails(HWND hwnd, bool apply) {
    const COLORREF background = apply ? kEdit : GetSysColor(COLOR_WINDOW);
    ListView_SetBkColor(hwnd, background);
    ListView_SetTextBkColor(hwnd, background);
    ListView_SetTextColor(hwnd, apply ? kText : GetSysColor(COLOR_WINDOWTEXT));
}

Control Identify(HWND hwnd) {
    if (IsClass(hwnd, L"#32770")) return Control::Dialog;
    if (IsClass(hwnd, PROGRESS_CLASSW)) return Control::Progress;
    if (IsClass(hwnd, L"RichEdit20W") || IsClass(hwnd, L"RICHEDIT50W")) return Control::RichEdit;
    if (IsClass(hwnd, WC_LISTVIEWW)) return Control::Details;
    const auto style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    if (IsClass(hwnd, L"Button")) {
        const auto type = style & BS_TYPEMASK;
        if (type == BS_GROUPBOX) return Control::GroupBox;
        if (type <= BS_AUTORADIOBUTTON && type != BS_USERBUTTON &&
            !(style & (BS_ICON | BS_BITMAP))) return Control::Button;
        return Control::None;
    }
    if (!IsClass(hwnd, L"Static")) return Control::None;
    if (GetParent(hwnd) == glass.parent) {
        switch (GetDlgCtrlID(hwnd)) {
        case 1034: case 1037: case 1038: case 1039: case 1046:
            return Control::Header;
        case 1035: case 1045:
            return Control::Divider;
        case 1028: case 1256:
            return Control::Branding;
        }
    }
    const auto type = style & SS_TYPEMASK;
    if (type <= SS_RIGHT || type == SS_SIMPLE || type == SS_LEFTNOWORDWRAP) return Control::Label;
    if (type == SS_BITMAP && glass.icon && GetParent(GetParent(hwnd)) == glass.parent) {
        RECT page{}, image{};
        GetClientRect(GetParent(hwnd), &page);
        GetClientRect(hwnd, &image);
        // MUI's finish-page bitmap occupies the left column for the full page height.
        if (image.right >= page.right / 4 && image.bottom >= page.bottom * 4 / 5) return Control::WizardImage;
    }
    return Control::None;
}

BOOL CALLBACK RefreshControl(HWND hwnd, LPARAM animate) {
    const auto attached = static_cast<Control>(reinterpret_cast<DWORD_PTR>(GetPropW(hwnd, kControlProperty)));
    if (attached == Control::None) {
        const Control control = Identify(hwnd);
        if (control == Control::None ||
            !SetWindowSubclass(hwnd, GlassProc, kSubclass, static_cast<DWORD_PTR>(control))) return TRUE;
        if (!SetPropW(hwnd, kControlProperty, reinterpret_cast<HANDLE>(static_cast<DWORD_PTR>(control)))) {
            RemoveWindowSubclass(hwnd, GlassProc, kSubclass);
            return TRUE;
        }
        if (control == Control::Progress || control == Control::GroupBox) SetWindowTheme(hwnd, L"", L"");
        if (control == Control::RichEdit) ColorRichEdit(hwnd, true);
        if (control == Control::Details) ColorDetails(hwnd, true);
        if (control == Control::Divider) RedrawWindow(hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_FRAME);
        else InvalidateRect(hwnd, nullptr, FALSE);
        return TRUE;
    }
    if (!animate || !IsWindowVisible(hwnd)) return TRUE;
    const bool defaultButton = attached == Control::Button && IsWindowEnabled(hwnd) &&
        (GetWindowLongPtrW(hwnd, GWL_STYLE) & BS_TYPEMASK) == BS_DEFPUSHBUTTON;
    if (attached == Control::Progress || (attached == Control::Header && HasHeader()) ||
        attached == Control::WizardImage || defaultButton) InvalidateRect(hwnd, nullptr, FALSE);
    return TRUE;
}

BOOL CALLBACK RestoreControl(HWND hwnd, LPARAM) {
    const auto data = reinterpret_cast<DWORD_PTR>(RemovePropW(hwnd, kControlProperty));
    if (!data) return TRUE;
    RemoveWindowSubclass(hwnd, GlassProc, kSubclass);
    switch (static_cast<Control>(data)) {
    case Control::Progress:
    case Control::GroupBox:
        SetWindowTheme(hwnd, nullptr, nullptr);
        break;
    case Control::RichEdit:
        ColorRichEdit(hwnd, false);
        break;
    case Control::Details:
        ColorDetails(hwnd, false);
        break;
    default:
        break;
    }
    return TRUE;
}

void FrameTick(HWND hwnd) {
    glass.phase = static_cast<float>((GetTickCount64() - glass.start) % 6400) / 1600;
    if (glass.animatedBorder) {
        const Color color = LightColor(glass.phase);
        const COLORREF border = RGB(color.GetR(), color.GetG(), color.GetB());
        glass.animatedBorder = SUCCEEDED(glass.setDwm(hwnd, kBorder, &border, sizeof(border)));
    }
    EnumChildWindows(hwnd, RefreshControl, TRUE);
    const HWND header = HeaderBackground();
    if (header && HasHeader()) {
        const RECT rect = InParent(header);
        InvalidateRect(hwnd, &rect, FALSE);
    }
}

LRESULT CALLBACK GlassProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR, DWORD_PTR data) {
    const auto control = static_cast<Control>(data);
    const bool root = hwnd == glass.parent;
    if (message == WM_NCDESTROY) {
        if (root) DetachInstallerGlass();
        else {
            RemovePropW(hwnd, kControlProperty);
            RemoveWindowSubclass(hwnd, GlassProc, kSubclass);
        }
        return DefSubclassProc(hwnd, message, wParam, lParam);
    }
    if (root) {
        switch (message) {
        case WM_TIMER:
            if (wParam == glass.timer) {
                FrameTick(hwnd);
                return 0;
            }
            break;
        case WM_PARENTNOTIFY:
            if (LOWORD(wParam) == WM_CREATE || LOWORD(wParam) == WM_DESTROY) {
                PostMessageW(hwnd, kRefresh, 0, 0);
            }
            break;
        case kRefresh: {
            EnumChildWindows(hwnd, RefreshControl, FALSE);
            const HWND header = HeaderBackground();
            if (header) {
                const RECT rect = InParent(header);
                InvalidateRect(hwnd, &rect, FALSE);
            }
            return 0;
        }
        case WM_DPICHANGED:
            UpdateScale();
            RedrawWindow(hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN);
            break;
        }
    }
    if (control == Control::Dialog) {
        if (message == WM_WINDOWPOSCHANGED && !root && (reinterpret_cast<WINDOWPOS*>(lParam)->flags & SWP_SHOWWINDOW)) {
            EnumChildWindows(hwnd, RefreshControl, FALSE);
            PostMessageW(glass.parent, kRefresh, 0, 0);
        }
        if (message == WM_CTLCOLORSTATIC || message == WM_CTLCOLOREDIT ||
            message == WM_CTLCOLORBTN || message == WM_CTLCOLORLISTBOX) {
            HDC dc = reinterpret_cast<HDC>(wParam);
            SetTextColor(dc, kText);
            const HWND child = reinterpret_cast<HWND>(lParam);
            if (message == WM_CTLCOLOREDIT || message == WM_CTLCOLORLISTBOX ||
                (message == WM_CTLCOLORSTATIC && IsClass(child, L"Edit"))) {
                SetBkColor(dc, kEdit);
                return reinterpret_cast<LRESULT>(glass.editBrush);
            }
            SetBkMode(dc, TRANSPARENT);
            return reinterpret_cast<LRESULT>(GetStockObject(HOLLOW_BRUSH));
        }
    }
    if (control == Control::RichEdit || control == Control::Details) {
        const LRESULT result = DefSubclassProc(hwnd, message, wParam, lParam);
        if (control == Control::RichEdit && (message == EM_STREAMIN || message == WM_SETTEXT)) {
            ColorRichEdit(hwnd, true);
        }
        return result;
    }
    // MUI uses a two-pixel static edge with no client area for its separators.
    if (control == Control::Divider && message == WM_NCPAINT) {
        HDC dc = GetWindowDC(hwnd);
        if (dc) {
            PaintDividerWindow(hwnd, dc);
            ReleaseDC(hwnd, dc);
        }
        return 0;
    }
    if (control == Control::Divider && message == WM_PRINT) {
        if (wParam) PaintDividerWindow(hwnd, reinterpret_cast<HDC>(wParam));
        return 0;
    }

    switch (message) {
    case WM_ERASEBKGND:
        return 1;
    case WM_PAINT: {
        PAINTSTRUCT paint;
        HDC dc = BeginPaint(hwnd, &paint);
        if (dc) PaintWindow(hwnd, control, dc);
        EndPaint(hwnd, &paint);
        return 0;
    }
    case WM_PRINTCLIENT:
        PaintWindow(hwnd, control, reinterpret_cast<HDC>(wParam));
        return 0;
    case WM_MOUSEMOVE:
        if (control == Control::Button) {
            TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE, hwnd, 0};
            TrackMouseEvent(&track);
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        break;
    case WM_MOUSELEAVE:
    case WM_ENABLE:
    case WM_SETTEXT:
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
    case WM_UPDATEUISTATE:
    case WM_SYSCOLORCHANGE:
    case WM_THEMECHANGED:
        InvalidateRect(hwnd, nullptr, FALSE);
        if (control == Control::Header && message == WM_SETTEXT) PostMessageW(glass.parent, kRefresh, 0, 0);
        break;
    }
    const LRESULT result = DefSubclassProc(hwnd, message, wParam, lParam);
    if ((control == Control::Button && (message == BM_SETSTYLE || message == BM_SETSTATE || message == BM_SETCHECK)) ||
        (control == Control::Progress && (message == PBM_SETPOS || message == PBM_DELTAPOS ||
                                        message == PBM_STEPIT || message == PBM_SETRANGE || message == PBM_SETRANGE32))) {
        InvalidateRect(hwnd, nullptr, FALSE);
    }
    return result;
}

void ApplyDwm(HWND hwnd) {
    glass.dwm = LoadLibraryW(L"dwmapi.dll");
    if (!glass.dwm) return;
    glass.setDwm = reinterpret_cast<decltype(glass.setDwm)>(GetProcAddress(glass.dwm, "DwmSetWindowAttribute"));
    if (!glass.setDwm) return;
    const BOOL dark = TRUE;
    if (FAILED(glass.setDwm(hwnd, kDarkMode, &dark, sizeof(dark)))) {
        glass.setDwm(hwnd, kLegacyDarkMode, &dark, sizeof(dark));
    }
    const DWORD round = 2;
    const COLORREF caption = RGB(12, 15, 28);
    glass.setDwm(hwnd, kCorner, &round, sizeof(round));
    glass.setDwm(hwnd, kCaption, &caption, sizeof(caption));
    glass.animatedBorder = true;
}

} // namespace

extern "C" __declspec(dllexport) void __stdcall AttachInstallerGlass(HWND hwndParent, const wchar_t* iconPngPath) {
    if (!IsWindow(hwndParent) || GetWindowThreadProcessId(hwndParent, nullptr) != GetCurrentThreadId() ||
        glass.parent == hwndParent) return;
    DetachInstallerGlass();
    GdiplusStartupInput startup;
    if (GdiplusStartup(&glass.gdiplus, &startup, nullptr) != Ok) return;
    glass.parent = hwndParent;
    glass.editBrush = CreateSolidBrush(kEdit);
    if (!glass.editBrush || !SetWindowSubclass(hwndParent, GlassProc, kSubclass, static_cast<DWORD_PTR>(Control::Dialog))) {
        DetachInstallerGlass();
        return;
    }
    if (iconPngPath && *iconPngPath) {
        glass.icon = Bitmap::FromFile(iconPngPath);
        if (glass.icon && glass.icon->GetLastStatus() != Ok) {
            delete glass.icon;
            glass.icon = nullptr;
        }
    }
    UpdateScale();
    ApplyDwm(hwndParent);
    glass.start = GetTickCount64();
    glass.timer = SetTimer(hwndParent, kAnimationTimer, 33, nullptr);
    FrameTick(hwndParent);
    InvalidateRect(hwndParent, nullptr, FALSE);
}

extern "C" __declspec(dllexport) void __stdcall DetachInstallerGlass() {
    const HWND hwnd = glass.parent;
    if (hwnd && GetWindowThreadProcessId(hwnd, nullptr) != GetCurrentThreadId()) return;
    if (hwnd) {
        if (glass.timer) KillTimer(hwnd, glass.timer);
        RemoveWindowSubclass(hwnd, GlassProc, kSubclass);
        EnumChildWindows(hwnd, RestoreControl, 0);
        if (glass.setDwm) {
            const BOOL dark = FALSE;
            const DWORD corner = 0;
            if (FAILED(glass.setDwm(hwnd, kDarkMode, &dark, sizeof(dark)))) {
                glass.setDwm(hwnd, kLegacyDarkMode, &dark, sizeof(dark));
            }
            glass.setDwm(hwnd, kCorner, &corner, sizeof(corner));
            glass.setDwm(hwnd, kBorder, &kDwmDefault, sizeof(kDwmDefault));
            glass.setDwm(hwnd, kCaption, &kDwmDefault, sizeof(kDwmDefault));
        }
        RedrawWindow(hwnd, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN);
    }
    if (glass.dwm) FreeLibrary(glass.dwm);
    if (glass.editBrush) DeleteObject(glass.editBrush);
    ReleaseBackdrop();
    delete glass.icon;
    if (glass.gdiplus) GdiplusShutdown(glass.gdiplus);
    glass = {};
}
