"""Extract only the trained best.pt when the full bundle is not extracted."""
import hashlib
import os
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
target = Path(os.environ.get("CV_MODEL_PATH", ROOT / "artifacts/cctv_yolov8n_v5/weights/best.pt")).resolve()
if not target.is_file():
    archive = ROOT / "cctv_yolov8n_v5_artifacts.zip"
    if not archive.is_file():
        raise SystemExit("Khong tim thay model/ZIP. Dat CV_MODEL_PATH tro den best.pt.")
    with zipfile.ZipFile(archive) as bundle:
        data = bundle.read("weights/best.pt")
    # Expected checksum from the audited export.
    if hashlib.sha256(data).hexdigest() != "b17adc0d31269dab0f10a192947ffc683f143df7bd15cc9f166ec3ab54d43cd3":
        raise SystemExit("best.pt trong ZIP khong khop checksum da audit.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
print(f"Model ready: {target}")

