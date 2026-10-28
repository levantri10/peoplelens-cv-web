# Video mẫu kiểm thử

`people-walking.mp4`: trích 5 giây đầu từ [OpenCV vtest.avi](https://github.com/opencv/opencv/blob/4.x/samples/data/vtest.avi), video giám sát có người di chuyển, không có bbox vẽ sẵn.

Metadata kiểm tra: 768×576, 10 FPS, 50 frame, thời lượng 5 giây. Chuyển sang H.264, không có âm thanh. Đây là mẫu demo pipeline, chưa có ground truth theo frame để kết luận độ chính xác đếm.

SHA-256 của bản mẫu đã dùng: `efc26ee922e6aefed10e7251d4373fef36b903b9fe9935c0b831034758dd21ad`. Chạy lại công cụ có thể tạo byte khác nếu phiên bản encoder khác.

Nếu thiếu file, chạy `python tools/download_sample.py` từ môi trường đã cài.

