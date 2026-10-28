import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("CV_DATA_DIR", ROOT / ".data")).resolve()
RUNS = DATA / "runs"
WEIGHTS = Path(os.environ.get("CV_MODEL_PATH", ROOT / "artifacts/cctv_yolov8n_v5/weights/best.pt")).resolve()
SAMPLE = ROOT / "samples/people-walking.mp4"
STATIC = ROOT / "people_counter/static"
MAX_UPLOAD_BYTES = int(os.environ.get("CV_MAX_UPLOAD_MB", "500")) * 1024 * 1024
DEVICE = os.environ.get("CV_DEVICE", "auto")
for directory in (DATA, RUNS):
    directory.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(DATA / "ultralytics"))
os.environ.setdefault("YOLO_AUTOINSTALL", "false")

