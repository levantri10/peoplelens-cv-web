"""Export the audited person-only checkpoint for browser-side inference."""
import hashlib
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / ".data/ultralytics"))
os.environ.setdefault("YOLO_AUTOINSTALL", "false")

import cv2
import numpy as np
import onnx
import onnxruntime as ort
import torch
from ultralytics import YOLO
from ultralytics.data.augment import LetterBox


def main():
    checkpoint = Path(os.environ.get("CV_MODEL_PATH", ROOT / "artifacts/cctv_yolov8n_v5/weights/best.pt"))
    target = ROOT / "web/public/models/person-yolov8n.onnx"
    target.parent.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(checkpoint))
    exported = model.export(format="onnx", imgsz=640, batch=1, dynamic=False,
                            simplify=False, opset=17, nms=False, half=False, device="cpu")
    shutil.copy2(exported, target)
    graph = onnx.load(str(target))
    graph.graph.name = "PeopleLensPersonDetector"
    graph.doc_string = ""
    graph.graph.doc_string = ""
    for prop in graph.metadata_props:
        if prop.key == "description":
            prop.value = "PeopleLens YOLOv8n CCTV v5 person detection"
    onnx.save(graph, str(target))
    onnx.checker.check_model(graph)
    session = ort.InferenceSession(str(target), providers=["CPUExecutionProvider"])
    capture = cv2.VideoCapture(str(ROOT / "samples/people-walking.mp4"))
    ok, frame = capture.read()
    capture.release()
    if not ok:
        raise RuntimeError("Sample video could not be decoded")
    prepared = LetterBox(new_shape=(640, 640), auto=False)(image=frame)
    tensor = np.ascontiguousarray(prepared[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255
    output = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    with torch.inference_mode():
        reference = model.model.cpu().float().eval()(torch.from_numpy(tensor))[0].numpy()
    np.testing.assert_allclose(output, reference, rtol=2e-3, atol=3e-3)
    fixture = ROOT / ".data/browser-fixture"
    fixture.mkdir(exist_ok=True)
    tensor.tofile(fixture / "input.bin")
    output.tofile(fixture / "output.bin")
    metadata = {
        "name": "YOLOv8n CCTV v5", "input_size": 640, "classes": {"0": "person"},
        "url": "/models/person-yolov8n.onnx", "opset": 17,
        "input_shape": [1, 3, 640, 640], "output_shape": list(output.shape),
        "bytes": target.stat().st_size, "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "source_checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "default_confidence": .32, "onnx_max_absolute_difference": float(np.abs(output - reference).max()),
    }
    (target.parent / "manifest.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
