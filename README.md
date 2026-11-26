# Lumina Drift Paint

**繁體中文** · [简体中文](README.zh-CN.md) · [English](README.en.md) · [日本語](README.ja.md)

Lumina Drift Paint 是一款免費開源的專業繪圖與多人即時繪茶軟體。你可以離線作畫，也可以跨裝置在同一張畫布上同步創作。支援數位筆壓感、進階圖層、筆刷匯入與插件。

[下載最新版本](https://github.com/starfireqwq/lumina-drift/releases/latest) · [版本更新紀錄](docs/CHANGELOG.md) · [插件說明](docs/PLUGINS.md)

![Lumina Drift Paint 的多人繪茶與畫布介面](docs/images/screenshot.jpg)

## 核心功能

- **專業工具組與繪畫引擎**。11 個主工具分類與輔助工具組支援經典展開模式、重複按快捷鍵循環切換，並記住各子工具的設定。5 種填充工具包括間隙填充筆、圍住塗抹、套索塗抹，以及參照其他圖層和僅參照編輯圖層的油漆桶。支援矩形與橢圓選框、多邊形套索、筆刷手抖修正、OKLab 減色混色、即時濾鏡與圖層蒙版。向量橡皮擦可擦至交點、局部擦除或刪除整條筆畫。
- **繪圖輔助面板與變形工具**。子視圖（Sub View）可載入多張參考圖、縮放、翻轉、旋轉與自動吸色。色彩歷史可固定色票並匯入或匯出 `.aco` 和 `.gpl`，另有迷你混色盤及桌面快顯輪盤（Pop-up Palette）。快速形狀（QuickShape）可將筆畫吸附成規整形狀，操控變形（Puppet Warp）可用釘點調整圖像，四方連續平鋪（Wrap-Around）可跨邊界繪製無縫圖樣。
- **非破壞性調整、自動動作與排版**。6 種即時調整圖層涵蓋 HSL、色階、色調曲線、色彩平衡、漸層對應與亮度／對比，支援剪裁遮色片、圖層與群組蒙版及群組隔離。自動動作（Auto Actions）可錄製和播放，整段播放可一次復原，也可用 `.lumina-action` 分享。富文本文字支援局部樣式、固定方塊自動換行、描邊置後、陰影和直排標點避頭尾。另有 2D 動畫時間軸、漫畫分格與對話氣泡。
- **印刷色彩管理與檔案互通**。在本機預覽 CMYK 軟校樣與超色域警告，可匯入自訂 `.icc` 或 `.icm` 描述檔。匯出 PNG、JPEG 或 PSD 時可嵌入 RGB ICC 描述檔。支援讀寫 `.lumina` 專案、匯入與匯出 Krita（`.kra`）和 Adobe Photoshop（`.psd`），並可匯出 OpenRaster（`.ora`）、多圖層 PNG ZIP、透明 PNG 或 JPEG。
- **縮時回放、多人繪茶與跨裝置支援**。可用 1×、4×、16× 或 64× 回放作畫過程，並匯出 WebM 或 MP4 縮時影片。桌面版可一鍵在本機開房，讓同一區域網路的手機和平板透過瀏覽器加入。支援觸控手勢，以及 Apple Pencil、Wacom 數位板、Surface Pen 和 S-Pen 等裝置的壓感輸入。介面可切換深色與淺色主題，提供繁體中文、簡體中文、英文和日文。

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
