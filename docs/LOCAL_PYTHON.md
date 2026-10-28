# Bản Python/FastAPI cục bộ

Bản này là tùy chọn chạy trên máy cài Python, tách khỏi bản web public. Nó xử lý video bằng PyTorch và ByteTrack Python, ghi output ở `.data/runs/`. Các file của bản này không được deploy lên Vercel.

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
.\.venv\Scripts\python.exe run.py
```

Mở `http://127.0.0.1:8000`. `setup.ps1` cần Python 3.12, model ZIP gốc hoặc biến `CV_MODEL_PATH` trỏ tới checkpoint person-only `best.pt`. ZIP và checkpoints không nằm trong Git repo. Tùy chọn `setup.ps1 -Gpu` cài PyTorch CUDA 12.8 nếu máy và driver phù hợp; mặc định dùng bản PyTorch có sẵn hoặc CPU.

Python server nhận video tải lên từ trình duyệt và lưu video cùng kết quả trên máy chạy server, khác bản web public chỉ giữ dữ liệu trong RAM của tab. Chỉ bind localhost theo mặc định. Không triển khai `run.py` trên Vercel.

Biến môi trường: `CV_MODEL_PATH`, `CV_DEVICE=auto|cpu|0`, `CV_DATA_DIR`, `CV_MAX_UPLOAD_MB=500`.

API tương tác tại `/docs`. Chỉ một nguồn chạy cùng lúc, có upload, video có bbox/ID, CSV/JSONL, Webcam WebSocket và hủy job. Webcam cần quyền camera và localhost/HTTPS. Video đầu ra H.264 không giữ âm thanh.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Tests cần weights và video `samples/people-walking.mp4`; dùng thư mục tạm và CPU, không bật webcam vật lý.

