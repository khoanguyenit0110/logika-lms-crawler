# Logika LMS Playwright Crawler

Crawler này dùng để capture hàng loạt trang `lms.logikaschool.com/task-preview/...` thành file ZIP.

Mỗi URL/task sẽ xuất ra 1 file ZIP trong `output/`.

```text
output/
  task-26864_levels-10_2026-...zip
```

Bên trong ZIP:

```text
capture.json
screenshots/
  level_01.png
  level_02.png
html/
  level_01.html
  level_02.html
assets/
  level_01_asset_01_xxx.png
  level_02_asset_01_yyy.gif
```

## Cài đặt

Yêu cầu máy đã có Node.js.

```bash
npm install
npm run install-browser
```

## Login LMS lần đầu

Chạy:

```bash
npm run login
```

Một cửa sổ Chromium sẽ mở ra.

1. Login vào LMS như bình thường.
2. Sau khi login xong, quay lại Terminal.
3. Bấm Enter để lưu session.

Crawler dùng profile riêng trong folder:

```text
.playwright-profile/
```

Những lần sau không cần login lại nếu session còn hạn.

## Thêm URL cần crawl

Mở file:

```text
urls.txt
```

Mỗi dòng nhập 1 URL LMS:

```text
https://lms.logikaschool.com/task-preview/26864?task=26864&level=1&track=1
https://lms.logikaschool.com/task-preview/21714?task=21714&level=1&track=1
```

## Chạy crawler

```bash
npm run crawl
```

Kết quả nằm trong:

```text
output/
```

## Chạy 1 URL trực tiếp

```bash
node src/crawler.js one "https://lms.logikaschool.com/task-preview/26864?task=26864&level=1&track=1"
```

## Cấu hình nhanh

Windows PowerShell:

```powershell
$env:HEADLESS="false"
$env:VIEWPORT_WIDTH="1600"
$env:VIEWPORT_HEIGHT="900"
$env:FULL_PAGE_SCREENSHOT="false"
npm run crawl
```

macOS/Linux:

```bash
HEADLESS=false VIEWPORT_WIDTH=1600 VIEWPORT_HEIGHT=900 FULL_PAGE_SCREENSHOT=false npm run crawl
```

## Crawler đang làm gì?

Với mỗi URL:

1. Mở trang LMS.
2. Detect top level row.
3. Click từng level.
4. Skip rating/feedback page như `Did you like the lesson?`.
5. Đợi DOM và assets ổn định.
6. Chụp screenshot.
7. Lưu HTML snapshot.
8. Tải relative assets:
   - `src`
   - `srcset`
   - `data-src`
   - `data-original`
   - `data-lazy-src`
   - `poster`
   - `data`
   - CSS `url(...)`
9. Gom vào ZIP.

## Lưu ý

- Đây là crawler để backup/replicate UI, không phải clone logic LMS.
- Scratch activity sẽ được capture bằng screenshot + text + assets, không export Scratch project chạy thật.
- Screenshot là source chính để replicate UI.
- `capture.json` là metadata để viewer đọc lại.
- `assets/` là file thật crawler tải từ relative source của LMS.
- Nếu một asset fetch quá lâu, crawler sẽ bỏ qua và ghi lỗi vào JSON.
