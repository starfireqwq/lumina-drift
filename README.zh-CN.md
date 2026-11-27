# Lumina Drift Paint

[繁體中文](README.md) · **简体中文** · [English](README.en.md) · [日本語](README.ja.md)

Lumina Drift Paint 是一款免费开源的专业绘画与多人实时共绘软件。你可以离线绘画，也可以跨设备在同一张画布上同步创作。软件支持数位笔压感、高级图层、笔刷导入和插件。

[下载最新版本](https://github.com/starfireqwq/lumina-drift/releases/latest) · [版本更新记录](docs/CHANGELOG.md) · [插件说明](docs/PLUGINS.md)

![Lumina Drift Paint 的多人共绘和画布界面](docs/images/screenshot.jpg)

## 核心功能

- **专业工具组、笔刷引擎与图层系统**。14 个主工具分类（含独立文字、漫画、动画与橡皮擦工具集）与辅助工具集支持经典展开模式、重复按快捷键循环切换，并记住各子工具设置；填充组整合单一油漆桶、智能填色（包围涂抹／间隙补涂）与套索涂抹，橡皮擦提供 5 款独立预设与四段抗锯齿。笔刷引擎支持双笔刷、色彩动态、水彩湿边、减色颜料混色、多笔尖轮播、抖动修正、`.sut`／`.brushset` 深度还原导入及 `.abr`（v6.2）笔刷组导出。提供 8 色图层色标、非破坏性草稿染色、“纸张”底色切换、快速蒙版（`Q`）、色域选取、矢量橡皮擦，以及 4K～8K+ 大画布 Tile GPU LRU 显存池化与超大画布保护机制。
- **标尺系统、辅助面板与变形工具**。内置集中线／放射状标尺、曲线／贝塞尔特殊标尺、图层绑定标尺与纯 2D 1/2/3 点透视空间网格。浮动工具面板可缩为图标小球并磁吸合并成横／纵向胶囊 Dock；另有实时画布导航器（支持视口红框、垂直翻转与自定义 `Shift`／`Ctrl+Shift` 滚轮旋转角度）、子视图（Sub View）多参考图、颜色历史（支持 `.aco`／`.gpl`）、迷你混色盘、桌面弹出调色盘（Pop-up Palette）、快速形状（QuickShape）、操控变形（Puppet Warp）与四方连续平铺（Wrap-Around）。
- **非破坏性调整、图层样式、自动动作与动画排版**。提供 6 种实时调整图层（HSL、色阶、色调曲线、色彩平衡、渐变映射、亮度／对比度）与 4 种非破坏性图层样式（锐利／水彩边界、阴影、外发光、色彩叠加），支持剪贴蒙版、图层／组蒙版及组隔离。自动动作（Auto Actions）可录制、一步撤销并通过 `.lumina-action` 分享。富文本支持局部样式、本地字体扫描检索、固定文本框换行、描边置于填充之后、阴影与横／竖排快速切换及标点避头尾；2D 动画时间轴支持音频波形显示、拖拽对齐与 MP4／WebM 音轨混音导出，另有漫画分格与对话气泡。
- **商业印刷色彩管理与文件互通**。本地实时预览 CMYK 软打样与超色域警告（支持自定义 `.icc`／`.icm`），并支持真 4 通道 CMYK 分色导出（Baseline TIFF 6.0 与 CMYK PSD），内置 GCR／UCR 黑版参数、实时总墨量（TAC）超限预览警告与自动限墨。支持读写 `.lumina`、导入／导出 Krita（`.kra`）和 Photoshop（`.psd`），并可导出 OpenRaster（`.ora`）、多图层 PNG ZIP、WebP、透明 PNG 及 JPEG（可嵌入 RGB ICC 配置文件）。
- **延时回放、多人共绘 2.0 与跨设备支持**。可用 1×～64× 回放绘画过程并导出 WebM／MP4 延时视频。桌面版可一键本地开房，支持跟随画师视角（含旋转／镜像／DPI 同步）、接龙分格认领（Grid Slots）、房间共享色板与共享参考图板，同一局域网的手机和平板可通过浏览器加入。完整支持触控手势与 Apple Pencil、Wacom、Surface Pen、S-Pen 压感，提供深浅主题、六大界面表面材质（含流光霓虹双流波动微调）与繁中、简中、英、日四语界面。

## 下载与安装

- **Windows**（安装版 Setup、免安装便携版 Portable）
- **macOS**（Apple Silicon `arm64`、Intel `x64`）
- **Android**（APK）
- **Web**（网页版 ZIP）

请前往 [GitHub Releases](https://github.com/starfireqwq/lumina-drift/releases/latest) 下载适合你设备的版本。

## 插件支持

打开画布后，在顶部菜单选择 **插件 → 管理插件…**，即可安装和管理 `.lumina-plugin` 插件。请参阅[插件说明](docs/PLUGINS.md)。

## 自建服务器与 Docker 快速启动

```bash
docker compose up -d
docker compose logs -f
docker compose down
```

启动后，在浏览器打开 `http://localhost:3000`。

## 隐私声明与许可证

[隐私声明](apps/client/installer/LICENSE.txt)介绍如何处理离线作品和协作数据。

源代码采用 [MIT 许可证](LICENSE)。第三方组件的许可证请参阅 [THIRD_PARTY_NOTICES.txt](apps/client/public/THIRD_PARTY_NOTICES.txt)。用户作品的权利归创作者所有。
