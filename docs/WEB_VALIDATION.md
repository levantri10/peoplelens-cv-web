# Kiểm tra bản web public

Ngày 28/10/2026.

## Các kiểm tra đã thực hiện

- Export model person-only `best.pt` từ artifact sang ONNX FP32 opset 17, input `[1,3,640,640]`, output `[1,5,8400]`.
- ONNX checker hợp lệ. So sánh ONNX native với PyTorch trên tensor của video mẫu đạt `allclose(rtol=0.002, atol=0.003)`. Chênh lệch tuyệt đối lớn nhất khoảng 0,00548 trên các tọa độ output chưa NMS.
- Chạy **ONNX Runtime Web 1.31.1, CPU/WASM thực** trong Node.js trên cùng input; chênh lệch tuyệt đối với Python ONNX khoảng **0,0006714**. Phát hiện 2 người trên ảnh mẫu đầu; ảnh đen trả số người bằng 0. Đây là xác nhận tương thích WASM, không phải test trình duyệt.
- **7 bài kiểm thử JavaScript qua**: global assignment, giữ ID hai người di chuyển, khôi phục bằng detection confidence thấp, mất dấu/TTL/reset ID, NMS và letterbox, xuất số 0, và kiểm tra đường dữ liệu không có upload/persistent storage.
- `npm run build` thành công, tạo website tĩnh trong `dist/`. Runtime vendor được host cùng origin, khóa theo package-lock.
- CSP giữ `connect-src 'self'`; cho phép tạo hàm động vì binding Embind trong WASM asyncify của runtime dùng `new Function`. Không tải script từ CDN ngoài.
- Đã kiểm tra cú pháp JavaScript và đối chiếu các ID HTML được controller tham chiếu.

## Phạm vi chưa xác minh

Môi trường UI không có browser khả dụng, nên chưa chạy kiểm thử tương tác trên Chrome/Edge, WebGPU thực, quyền camera vật lý hoặc MediaRecorder thực. Cần thử trên thiết bị truy cập URL public. CPU/WASM đã được kiểm chứng bằng runtime web thật trong Node; điều đó không thay thế test browser.

Không suy ra độ chính xác đếm video từ kết quả mẫu: ảnh đầu vẫn có người bị bỏ sót. Chưa có ground truth video, IDF1/HOTA hoặc benchmark đa thiết bị. Model, độ sáng/góc camera, ngưỡng confidence và tần suất lấy mẫu đều ảnh hưởng kết quả.

## Các bước thử trên website

1. Mở URL public bằng Chrome/Edge qua HTTPS và chọn video mẫu.
2. Chờ tải model/runtime, kiểm tra chip GPU/CPU thực, bbox, ID, số người và biểu đồ.
3. Chọn video cá nhân, dùng Network panel xác nhận chỉ có GET asset, không có video/frame được gửi lên server.
4. Thử CPU trực tiếp, chỉnh ngưỡng trước phiên mới, tải CSV/JSONL và kiểm tra timestamp/count.
5. Chọn Webcam, cấp quyền, nhận diện rồi nhấn Dừng; camera phải tắt.
6. Thử tùy chọn WebM nếu trình duyệt hỗ trợ. Đóng/tải lại tab và xác nhận lịch sử không tồn tại.

Video và dữ liệu được giữ trong RAM của tab, tối đa 5 phiên; không có database, API inference hay endpoint upload trên deployment public.

