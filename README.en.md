# Lumina Drift Paint

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · **English** · [日本語](README.ja.md)

Lumina Drift Paint is a free, open-source app for professional digital painting and real-time collaborative drawing. Work offline or share a live canvas across devices with pressure-sensitive input, advanced layer controls, brush imports, and plugins.

[Download the latest release](https://github.com/starfireqwq/lumina-drift/releases/latest) · [Changelog](docs/CHANGELOG.md) · [Plugin guide](docs/PLUGINS.md)

![The Lumina Drift Paint canvas and collaborative drawing interface](docs/images/screenshot.jpg)

## Core features

- **Drawing tools, brush engine, and layer workflow.** Subtools are organized into 14 main categories (including dedicated Text, Comic, Animation, and a 5-preset Eraser toolset with 4-level anti-aliasing) with an optional classic layout, shortcut cycling, and per-subtool memory, alongside 3 unified fill subtools (Paint Bucket, Smart Fill combining Enclose & Gap Fill, and Lasso Fill). The brush engine supports Dual Brush, color dynamics, wet edges, subtractive pigment mixing, multi-tip cycling, stroke stabilization, deep `.sut` / `.brushset` import, and `.abr` (v6.2) single/group export. Layer tools include 8-color panel tags, non-destructive draft tinting, Paper background switching, Quick Mask (`Q`), Color Range selection, a three-mode vector eraser, and Tile GPU LRU pooling with OOM/WebGL guards for 4K–8K+ canvases.
- **Rulers, workspace aids, and deformation.** Draw with radial/focus-line rulers, curve/Bézier special rulers, layer-scoped rulers, and pure 2D 1/2/3-point perspective grids. Collapse floating panels into magnetized icon pills or a horizontal/vertical capsule dock, and work with the live Canvas Navigator (red viewport box, vertical flip, customizable `Shift` / `Ctrl+Shift` wheel rotation steps), multi-image Sub View references, color history (`.aco`/`.gpl`), mini Mixing Pad, desktop Pop-up Palette, QuickShape, Puppet Warp, and seamless Wrap-Around painting.
- **Non-destructive adjustments, layer effects, Auto Actions, and animation.** Combine six live adjustment layers (HSL, Levels, Curves, Color Balance, Gradient Map, Brightness/Contrast) with four non-destructive layer effects (crisp/watercolor border, drop shadow, outer glow, color overlay), clipping masks, layer/group masks, and group isolation. Record single-undo Auto Actions (`.lumina-action`), format rich vertical/horizontal text with local font scanning and a searchable picker, create comic panels and speech balloons, and edit 2D animations with an interactive audio waveform timeline and mixed-audio MP4/WebM export.
- **Print color management and file compatibility.** Preview local CMYK soft proofs and gamut warnings with optional `.icc`/`.icm` profiles, and export true 4-channel CMYK Baseline TIFF 6.0 and CMYK PSD files with configurable GCR/UCR black generation, live Total Area Coverage (TAC) heatmaps, and ink limiting. Open and save `.lumina`, import and export Krita (`.kra`) and Photoshop (`.psd`), and export OpenRaster (`.ora`), layered PNG ZIP, WebP, transparent PNG, or JPEG with embedded RGB ICC profiles.
- **Time-lapse, Multiplayer Collab 2.0, and cross-device support.** Replay artwork at 1×–64× and export WebM/MP4 time-lapse videos. Host a local room in one click with Follow Camera (syncing pan, zoom, rotation, flip, and DPI), Grid Slots claiming, Room Swatches, and a Shared Reference Board while phones and tablets on the same network join from a browser. Includes touch gestures, pressure support (Apple Pencil, Wacom, Surface Pen, S-Pen), dark/light themes, six UI surface materials (including customizable dual-stream Lumina Glow), and Traditional Chinese, Simplified Chinese, English, and Japanese UI.

## Download and install

- **Windows** (Setup installer or Portable build)
- **macOS** (Apple Silicon `arm64` or Intel `x64`)
- **Android** (APK)
- **Web** (ZIP)

Download the build for your device from [GitHub Releases](https://github.com/starfireqwq/lumina-drift/releases/latest).

## Plugins

Open a canvas and choose **Plugins → Manage Plugins…** from the top menu to install and manage `.lumina-plugin` packages. See the [plugin guide](docs/PLUGINS.md).

## Self-hosting with Docker

```bash
docker compose up -d
docker compose logs -f
docker compose down
```

Once the server is running, open `http://localhost:3000` in your browser.

## Privacy and licensing

The [privacy notice](apps/client/installer/LICENSE.txt) explains how the app handles offline artwork and collaboration data.

The source code is available under the [MIT license](LICENSE). See [THIRD_PARTY_NOTICES.txt](apps/client/public/THIRD_PARTY_NOTICES.txt) for third-party licenses. Creators retain the rights to their artwork.
