# PeopleLens · nhận diện và đếm người ngay trên trình duyệt

Website dùng **YOLOv8n CCTV v5 + ByteTrack** để nhận diện, theo dõi và đếm người từ video hoặc webcam. Bản public là website tĩnh chạy trên Vercel; xử lý AI dùng **GPU/CPU của thiết bị người truy cập**.

## Quyền riêng tư và dữ liệu phiên

- Video được chọn bằng File API và Blob URL; **không có thao tác tải video lên server**.
- Khung hình chỉ chuyển giữa trang và Web Worker trong cùng trình duyệt. Không có inference API, tài khoản, analytics hoặc dịch vụ lưu trữ video.
- Video, ảnh xem trước và dữ liệu đếm chỉ nằm trong **RAM của tab**, không ghi localStorage, IndexedDB hay database. Tải lại/đóng trang sẽ mất dữ liệu; dùng nút tải xuống trước khi rời trang.
- Lịch sử giữ tối đa 5 phiên trong tab. Nút “Xóa dữ liệu phiên” thu hồi Blob URL và giải phóng model/nguồn video.
- Browser tải model ONNX và ONNX Runtime từ cùng website. HTTP cache của model/runtime là asset công khai, tách biệt với video người dùng.

## Tính năng

- Chọn/kéo thả video MP4, WebM, MOV tùy codec trình duyệt, hoặc mở webcam sau khi cấp quyền.
- Tự ưu tiên **WebGPU**, chuyển sang **CPU/WebAssembly** nếu không có hoặc không khởi tạo được WebGPU. Có thể chọn CPU trực tiếp.
- Model được cung cấp sẵn trên Vercel; lần đầu trình duyệt vẫn tải model và WASM để xử lý tại thiết bị. Trang hiển thị dung lượng tải. Nếu GPU khởi tạo quá 15 giây ở một bước, ứng dụng đóng Worker đó và chuyển sang CPU bằng Worker mới.
- Hiển thị bbox, track ID, số người, số track đang thấy, số người đồng thời cao nhất, FPS thực và biểu đồ theo thời gian.
- Ngưỡng đếm mặc định 0,32. ByteTrack dùng thêm bbox confidence thấp để khôi phục track; mỗi phiên bắt đầu với tracker mới.
- Tần suất phân tích tối đa 2/5/10 mẫu mỗi giây. Chỉ giữ một tác vụ inference đang chạy; thiết bị chậm lấy ít mẫu hơn, không tạo hàng đợi ảnh cũ.
- Tải CSV, JSONL và tóm tắt JSON. Tùy chọn ghi video WebM bằng MediaRecorder, hoàn toàn trong trình duyệt.
- Có video OpenCV mẫu 5 giây để thử nhanh.

`people_count` là số bbox person hiện thấy vượt ngưỡng chọn. `tracked_count` chỉ đếm các bbox đó có ID được xác nhận; bbox người mới chưa có ID vẫn được đếm. Track mất dấu không được cộng vào số người hiện tại. `unique_track_count` chỉ là số ID đã thấy, **không phải số khách duy nhất**.

## Chạy bản web cục bộ

Cần Node.js >=22.12:

```bash
npm ci
npm run dev
```

Mở URL localhost mà Vite in ra. Model ONNX đã nằm trong `web/public/models/`. Không cần Python, GPU server, CUDA hoặc API key để chạy bản web.

```bash
npm test
npm run build
npm run preview
```

`npm ci` tự chuẩn bị module/WASM của ONNX Runtime trong `web/public/ort/`. Thư mục này được sinh từ dependency khóa phiên bản, không commit lại binary vendor. Build tạo `dist/` để host tĩnh.

Webcam cần HTTPS hoặc localhost. Chrome/Edge mới có các API cần dùng; WebGPU phụ thuộc trình duyệt, driver và thiết bị, nên GPU không được bảo đảm trên mọi máy. Thông tin thiết bị thực đang dùng được hiển thị trên giao diện.

## Triển khai Vercel

Repo dùng Vite và có `vercel.json`: build `npm run build`, output `dist/`. Khi import repo vào Vercel, chọn root của repo và Node.js 24.x. Không có serverless function hoặc cấu hình database.

```bash
vercel link
vercel --prod
```

Các header COOP/COEP giữ ứng dụng tách biệt giữa các origin; CSP chỉ cho kết nối cùng origin, không dùng CDN/analytics bên ngoài. Runtime WASM dùng một luồng để tránh kẹt khi tạo Worker lồng nhau; GPU vẫn chạy bằng WebGPU. Bản production mở công khai trong cấu hình Vercel. Python và artifact train được loại khỏi nguồn upload Vercel bằng `.vercelignore`.

## Model và kiến trúc

```text
Vercel static assets ──► Browser: UI + Web Worker + ONNX Runtime
File video / webcam ──► ImageBitmap ──► YOLO ONNX ──► NMS ──► ByteTrack
                                                     └──► RAM: counts + CSV/JSONL/WebM
```

- Input model: FP32 RGB NCHW `[1,3,640,640]`, letterbox màu 114, chuẩn hóa `/255`.
- Output: `[1,5,8400]`, một lớp person. JavaScript thực hiện NMS IoU=0,7, tối đa 300 bbox.
- Model FP32 khoảng 12,75 MB, ONNX opset 17; manifest chứa SHA-256 và checksum checkpoint gốc.
- ByteTrack JavaScript có Kalman XYAH, Hungarian assignment, khớp hai tầng confidence, xác nhận track mới và bộ đệm lost track theo thời gian.
- Mỗi mẫu xuất thời gian video `timestamp_ms` lấy từ `video.currentTime`; webcam dùng thời gian monotonic của phiên. `recorded_at` là UTC trên thiết bị, không phải thời gian tuyệt đối camera gốc.
- Frame đưa vào inference có cạnh dài tối đa 1280; bbox ứng với `frame_width`/`frame_height` trong record.

Export lại model khi thay weights:

```powershell
.\.venv\Scripts\python.exe -m pip install 'onnx>=1.12,<2' 'onnxruntime>=1.20,<2'
.\.venv\Scripts\python.exe tools\export_web_model.py
```

Script kiểm tra ONNX và so sánh số với PyTorch trước khi ghi manifest. Cần `best.pt` gốc và video mẫu trong workspace; chúng không phải dữ liệu cần gửi lên Vercel.

## Kết quả và giới hạn

Xem [báo cáo kiểm tra bản web](docs/WEB_VALIDATION.md). Kiểm tra gồm tracking, xuất số 0, NMS/letterbox, dữ liệu phiên và inference ONNX Runtime Web WASM với model thật.

- Bản web lấy mẫu theo tốc độ thực, **không phân tích mọi frame của video gốc**. `frame_index` là thứ tự mẫu đã xử lý. Điều này khác pipeline Python xử lý từng frame.
- Model vẫn có thể bỏ sót/báo nhầm người. Báo cáo train có trùng ảnh giữa split; kết quả video mẫu không thay thế đánh giá có ground truth trên camera mục tiêu.
- Chưa đo IDF1/HOTA, đếm khách duy nhất, đếm vào/ra qua line hay ghép ID giữa camera.
- WebM ghi lại canvas theo thời gian xử lý, không giữ âm thanh và không bảo đảm trùng từng frame/thời lượng video gốc. Nếu trình duyệt không hỗ trợ ghi, vẫn tải được CSV/JSONL.
- Giới hạn 15.000 mẫu mỗi phiên và 125 MB cho WebM. Chạm giới hạn WebM sẽ ngừng ghi video, dữ liệu đếm tiếp tục; summary đánh dấu video một phần. Video bị dừng/lỗi giữa chừng chỉ xuất phần đã xử lý.
- Chưa có hợp đồng dữ liệu hoặc kết nối Backend theo phạm vi hiện tại.

## Cấu trúc

| Đường dẫn | Nội dung |
| --- | --- |
| `web/` | UI, worker inference, detector decode, ByteTrack và tests JavaScript |
| `web/public/models/` | Model ONNX thực + manifest |
| `web/public/samples/` | Video mẫu, không có dữ liệu người dùng |
| `web/public/licenses/` | Thông báo giấy phép dependency |
| `tools/export_web_model.py` | Export và kiểm chứng model web |
| `people_counter/` | Bản Python/FastAPI chạy cục bộ trước đó |
| `docs/LOCAL_PYTHON.md` | Hướng dẫn bản Python cục bộ |

Xem [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) cho model/Ultralytics, ONNX Runtime và ByteTrack.

