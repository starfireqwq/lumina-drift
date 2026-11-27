# Lumina Drift Paint

**繁體中文** · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md)

Lumina Drift Paint 是一款免費開源的專業繪圖與多人即時繪茶軟體。你可以離線作畫，也可以跨裝置在同一張畫布上同步創作。支援數位筆壓感、進階圖層、筆刷匯入與插件。

[下載最新版本](https://github.com/starfireqwq/lumina-drift/releases/latest) · [版本更新紀錄](docs/CHANGELOG.md) · [插件說明](docs/PLUGINS.md)

![Lumina Drift Paint 的多人繪茶與畫布介面](docs/images/screenshot.jpg)

## 核心功能

- **專業工具組、筆刷引擎與圖層系統**。14 個主工具分類（含獨立文字、漫畫、動畫與橡皮擦工具集）與輔助工具集支援經典展開模式、重複按快捷鍵循環切換，並記住各子工具設定；填充組整合單一油漆桶、智能填色（圍住塗抹／間隙補塗）與套索塗抹，橡皮擦提供 5 款獨立預設與四段抗鋸齒。筆刷引擎支援雙筆刷、色彩動態、水彩濕邊、減色顏料混色、多筆尖輪播、手抖修正、`.sut`／`.brushset` 深度還原匯入與 `.abr`（v6.2）筆刷組匯出。提供 8 色圖層色標、非破壞性草稿染色、「用紙」底色切換、快速遮色片（`Q`）、色域選取、向量橡皮擦，以及 4K～8K+ 大畫布 Tile GPU LRU 記憶體池化與高畫素大圖保護機制。
- **尺規系統、輔助面板與變形工具**。內建集中線／放射狀尺規、曲線／貝茲特殊尺規、圖層綁定尺規與純 2D 1/2/3 點透視空間網格。浮動工具面板可縮為圖標小球並磁吸合併成橫／直向膠囊 Dock；另有即時畫布導覽器（支援視口紅框、垂直翻轉與自訂 `Shift`／`Ctrl+Shift` 滾輪旋轉角度）、子視圖（Sub View）多參考圖、色彩歷史（支援 `.aco`／`.gpl`）、迷你混色盤、桌面快顯輪盤（Pop-up Palette）、快速形狀（QuickShape）、操控變形（Puppet Warp）與四方連續平鋪（Wrap-Around）。
- **非破壞性調整、圖層樣式、自動動作與動畫排版**。提供 6 種即時調整圖層（HSL、色階、色調曲線、色彩平衡、漸層對應、亮度／對比）與 4 種非破壞性圖層樣式（銳利／水彩邊界、陰影、外發光、色彩覆蓋），支援剪裁遮色片、圖層／群組蒙版與群組隔離。自動動作（Auto Actions）可錄製、單步復原並透過 `.lumina-action` 分享。富文本支援局部樣式、本機字型掃描與檢索、固定方塊換行、描邊置後、陰影與橫／直排快速切換及標點避頭尾；2D 動畫時間軸支援音訊波形檢視、拖曳對齊與 MP4／WebM 音軌混音匯出，另有漫畫分格與對話氣泡。
- **商業印刷色彩管理與檔案互通**。本機即時預覽 CMYK 軟校樣與超色域警告（支援自訂 `.icc`／`.icm`），並支援真 4 通道 CMYK 分色匯出（Baseline TIFF 6.0 與 CMYK PSD），內建 GCR／UCR 黑版設定、即時總墨量（TAC）超限預覽警告與自動限墨。支援讀寫 `.lumina`、匯入／匯出 Krita（`.kra`）與 Photoshop（`.psd`），並可匯出 OpenRaster（`.ora`）、多圖層 PNG ZIP、WebP、透明 PNG 與 JPEG（可嵌入 RGB ICC 描述檔）。
- **縮時回放、多人繪茶 2.0 與跨裝置支援**。可用 1×～64× 回放作畫過程並匯出 WebM／MP4 縮時影片。桌面版可一鍵本機開房，支援跟隨繪師視角（含旋轉／鏡像／DPI 同步）、接龍分格認領（Grid Slots）、房間共用色票盤與共用參考圖板，同一區域網路的手機和平板可透過瀏覽器加入。完整支援觸控手勢與 Apple Pencil、Wacom、Surface Pen、S-Pen 壓感，提供深淺色主題、六大介面表面材質（含流光霓虹雙流波動微調）與繁中、簡中、英、日四語介面。

## 下載與安裝

- **Windows**（安裝版 Setup、免安裝可攜版 Portable）
- **macOS**（Apple Silicon `arm64`、Intel `x64`）
- **Android**（APK）
- **Web**（網頁版 ZIP）

請到 [GitHub Releases](https://github.com/starfireqwq/lumina-drift/releases/latest) 下載適合你裝置的版本。

## 插件支援

開啟畫布後，在上方選單選擇 **插件 → 管理插件…**，即可安裝和管理 `.lumina-plugin` 插件。請參閱[插件說明](docs/PLUGINS.md)。

## 自架伺服器與 Docker 快速啟動

```bash
docker compose up -d
docker compose logs -f
docker compose down
```

啟動後，在瀏覽器開啟 `http://localhost:3000`。

## 隱私權聲明與授權

[隱私權聲明](apps/client/installer/LICENSE.txt)說明離線作品與協作資料如何處理。

原始碼採用 [MIT 授權](LICENSE)。第三方元件的授權請見 [THIRD_PARTY_NOTICES.txt](apps/client/public/THIRD_PARTY_NOTICES.txt)。使用者作品的權利歸創作者所有。
