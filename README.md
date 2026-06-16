# 退貨助手（iPhone PWA 網頁 App）

手機鏡頭掃描物流編號 → 本地存檔（IndexedDB）→ 帶到電腦匯入 ERP。
iPhone 用 Safari 開網址後「**加入主畫面**」，就變成一個 icon、點下去全螢幕像 App。純收集，不做核對。

## 功能
- **雙模式掃描**：模式 A 二維碼（BarcodeDetector，iOS 自動後備 jsQR，正方框）／模式 B 物流編號 OCR（Tesseract，嚴格 TW＋13 碼，**直式長條框**）。右下 FAB 切換。
- **防重掃**：同一編號自動略過（紅框＋提示音）。掃到新的→綠框＋提示音。
- **掃描清單**：每筆顯示「#序號 編號 時間」，可單筆刪除。
- **複製清單／匯出 CSV／清除全部**。

## 部署（GitHub Pages）
把本資料夾**所有檔案**上傳到 repo（`index.html / app.js / style.css / sw.js / manifest.webmanifest / icon-192.png / icon-512.png`）→ Settings → Pages → `main` `/(root)` → Save，等 1–2 分鐘。
> `icons/` 子資料夾為舊版重複檔，不影響運作（可留可刪）。

## iPhone 安裝
Safari 開 `https://你的帳號.github.io/scan-return/` → 分享 → **加入主畫面** → 從桌面 icon 開啟 → 「開啟鏡頭」允許相機。
> 條碼後備與 OCR 函式庫從 CDN 載入，第一次需有網路。

## 與公司 ERP（USale）的銜接
本 PWA 不直接連 ERP。流程：手機掃描收集 →「複製清單／匯出 CSV」帶到電腦 → 電腦上用 Tampermonkey 腳本（`usale-return-helper.user.js`，在上層 ClaudeCode\ 資料夾）填入 USale 搜尋框查詢，退貨人工確認。
