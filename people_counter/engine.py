"""One detector, one active source, and a separate ByteTrack lifecycle per run."""

import time
from datetime import datetime, timezone
from types import SimpleNamespace

from . import config

import cv2
import numpy as np
import torch
from ultralytics import YOLO
from ultralytics.trackers.byte_tracker import BYTETracker


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Detector:
    def __init__(self):
        self.model = None
        self.device = ("0" if torch.cuda.is_available() else "cpu") if config.DEVICE == "auto" else config.DEVICE
        torch.set_num_threads(max(1, min(4, torch.get_num_threads())))

    def load(self):
        if self.model is None:
            if not config.WEIGHTS.is_file():
                raise FileNotFoundError(f"Không tìm thấy model: {config.WEIGHTS}")
            model = YOLO(str(config.WEIGHTS))
            if model.names != {0: "person"}:
                raise ValueError("Model phải có đúng một lớp 0: person.")
            self.model = model


class TrackingSession:
    def __init__(self, detector, run_id, source_type, confidence=0.32, fps=30):
        detector.load()
        self.detector = detector
        self.run_id = run_id
        self.source_type = source_type
        self.confidence = confidence
        # Keep low-score boxes for ByteTrack recovery; only count boxes above the UI threshold.
        args = SimpleNamespace(track_high_thresh=0.25, track_low_thresh=0.1,
                               new_track_thresh=0.25, track_buffer=max(1, round(fps)),
                               match_thresh=0.8, fuse_score=True)
        self.tracker = BYTETracker(args)
        self.seen_ids = set()
        self.peak = 0

    def process(self, frame, frame_index, timestamp_ms):
        started = time.perf_counter()
        result = self.detector.model.predict(
            frame, classes=[0], conf=min(0.1, self.confidence), iou=0.7,
            imgsz=640, device=self.detector.device, verbose=False, max_det=300,
        )[0]
        boxes = result.boxes.cpu().numpy()
        # Update even for an empty frame so lost tracks age correctly.
        tracks = self.tracker.update(boxes, frame)
        track_by_detection = {int(track[-1]): int(track[4]) for track in tracks}
        detections = []
        for index, (xyxy, score) in enumerate(zip(boxes.xyxy, boxes.conf)):
            if float(score) < self.confidence:
                continue
            track_id = track_by_detection.get(index)
            if track_id is not None:
                self.seen_ids.add(track_id)
            detections.append({"track_id": track_id, "class_id": 0, "label": "person",
                               "confidence": round(float(score), 4),
                               "bbox_xyxy": [round(float(value), 2) for value in xyxy]})
        self.peak = max(self.peak, len(detections))
        elapsed = (time.perf_counter() - started) * 1000
        return {
            "schema_version": "1.0", "session_id": self.run_id,
            "source_type": self.source_type, "frame_index": frame_index,
            "timestamp_ms": round(timestamp_ms, 3), "recorded_at": utc_now(),
            "frame_width": frame.shape[1], "frame_height": frame.shape[0],
            "people_count": len(detections),
            "tracked_count": sum(d["track_id"] is not None for d in detections),
            "peak_count": self.peak, "unique_track_count": len(self.seen_ids),
            "processing_ms": round(elapsed, 2), "detections": detections,
        }


def annotate(frame, record):
    image = frame.copy()
    for detection in record["detections"]:
        x1, y1, x2, y2 = [int(v) for v in detection["bbox_xyxy"]]
        color = (70, 200, 115) if detection["track_id"] is not None else (30, 170, 245)
        cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
        identity = f"#{detection['track_id']}" if detection["track_id"] is not None else "new"
        label = f"person {identity} {detection['confidence']:.0%}"
        y = max(22, y1)
        cv2.rectangle(image, (max(0, x1), y - 22), (min(image.shape[1], x1 + 185), y), color, -1)
        cv2.putText(image, label, (max(0, x1) + 4, y - 6), cv2.FONT_HERSHEY_SIMPLEX, .48, (15, 25, 25), 1, cv2.LINE_AA)
    cv2.rectangle(image, (10, 10), (min(image.shape[1] - 1, 310), 66), (24, 32, 45), -1)
    cv2.putText(image, f"People: {record['people_count']} | Tracks: {record['tracked_count']}",
                (20, 35), cv2.FONT_HERSHEY_SIMPLEX, .6, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(image, f"Time: {record['timestamp_ms'] / 1000:.2f}s", (20, 56),
                cv2.FONT_HERSHEY_SIMPLEX, .48, (170, 190, 200), 1, cv2.LINE_AA)
    return image

