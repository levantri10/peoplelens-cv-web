import csv
import json
import logging
import math
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import imageio_ffmpeg

from . import config
from .engine import TrackingSession, annotate, utc_now

logger = logging.getLogger(__name__)
CSV_FIELDS = ["session_id", "source_type", "frame_index", "timestamp_ms", "recorded_at",
              "people_count", "tracked_count", "peak_count", "unique_track_count", "processing_ms"]
ACTIVE = {"uploading", "queued", "loading", "processing", "encoding", "live"}


class Run:
    def __init__(self, source_type, name, confidence):
        self.id = uuid.uuid4().hex
        self.path = config.RUNS / self.id
        self.path.mkdir()
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.state = {
            "id": self.id, "source_type": source_type, "name": name,
            "confidence": confidence, "status": "uploading", "created_at": utc_now(),
            "processed_frames": 0, "total_frames": 0, "progress": 0,
            "processing_fps": 0, "latest": None, "timeline": [],
            "peak_count": 0, "video_url": None, "error": None,
        }
        self.json_file = None
        self.csv_file = None
        self.last_publish = 0
        self.started = time.perf_counter()
        self.opened = None
        self.publish()

    def publish(self, **changes):
        with self.lock:
            self.state.update(changes)
            temporary = self.path / "state.tmp"
            temporary.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")
            temporary.replace(self.path / "state.json")

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.state))

    def open_records(self):
        self.opened = time.perf_counter()
        self.json_file = (self.path / "results.jsonl").open("w", encoding="utf-8")
        self.csv_file = (self.path / "counts.csv").open("w", encoding="utf-8-sig", newline="")
        self.csv_writer = csv.DictWriter(self.csv_file, fieldnames=CSV_FIELDS)
        self.csv_writer.writeheader()

    def record(self, record, sample_interval_ms=1000):
        self.json_file.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.csv_writer.writerow({key: record[key] for key in CSV_FIELDS})
        now = time.perf_counter()
        with self.lock:
            self.state["latest"] = record
            self.state["processed_frames"] += 1
            count = self.state["processed_frames"]
            self.state["peak_count"] = record["peak_count"]
            self.state["processing_fps"] = round(count / max(.001, now - self.opened), 2)
            total = self.state["total_frames"]
            self.state["progress"] = round(min(.98, count / total) * 100, 1) if total else 0
            timeline = self.state["timeline"]
            if not timeline or record["timestamp_ms"] - timeline[-1]["timestamp_ms"] >= sample_interval_ms:
                timeline.append({"timestamp_ms": record["timestamp_ms"], "people_count": record["people_count"]})
                if len(timeline) > 300:
                    self.state["timeline"] = timeline[::2]
            if now - self.last_publish > .5:
                self.json_file.flush()
                self.csv_file.flush()
                self.publish()
                self.last_publish = now

    def close_records(self):
        for stream in (self.json_file, self.csv_file):
            if stream is not None and not stream.closed:
                stream.close()

    def finish(self, status="completed", error=None, **changes):
        self.close_records()
        with self.lock:
            latest = self.state["latest"]
            timeline = self.state["timeline"]
            if latest and (not timeline or timeline[-1]["timestamp_ms"] != latest["timestamp_ms"]):
                timeline.append({"timestamp_ms": latest["timestamp_ms"], "people_count": latest["people_count"]})
        self.publish(status=status, error=error, finished_at=utc_now(),
                     elapsed_seconds=round(time.perf_counter() - self.started, 2),
                     progress=100 if status == "completed" else self.state["progress"], **changes)
        summary = self.snapshot()
        (self.path / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


class Manager:
    def __init__(self, detector):
        self.detector = detector
        self.slot = threading.BoundedSemaphore(1)
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cv-video")
        self.runs = {}
        # A stopped server cannot continue a previous video or webcam session.
        for path in config.RUNS.glob("*/state.json"):
            state = json.loads(path.read_text(encoding="utf-8"))
            if state["status"] in ACTIVE:
                state.update(status="interrupted", error="Ứng dụng đã khởi động lại. Hãy chạy lại nguồn video.")
                path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")

    def create(self, source_type, name, confidence):
        if not self.slot.acquire(blocking=False):
            raise RuntimeError("Đang có một nguồn chạy. Hãy dừng hoặc chờ phiên hiện tại hoàn tất.")
        try:
            run = Run(source_type, name, confidence)
            self.runs[run.id] = run
            return run
        except Exception:
            self.slot.release()
            raise

    def get(self, run_id):
        if run_id in self.runs:
            return self.runs[run_id].snapshot()
        if len(run_id) != 32 or any(c not in "0123456789abcdef" for c in run_id):
            raise KeyError(run_id)
        path = config.RUNS / run_id / "state.json"
        if not path.is_file():
            raise KeyError(run_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def history(self):
        snapshots = [self.get(p.parent.name) for p in config.RUNS.glob("*/state.json")]
        snapshots.sort(key=lambda item: item["created_at"], reverse=True)
        return [{key: state.get(key) for key in ("id", "name", "source_type", "status", "created_at", "peak_count", "processed_frames")}
                for state in snapshots[:30]]

    def submit(self, run, source):
        run.publish(status="queued")
        self.executor.submit(self.process_video, run, source)

    def process_video(self, run, source):
        capture, writer = None, None
        try:
            run.publish(status="loading")
            capture = cv2.VideoCapture(str(source))
            if not capture.isOpened():
                raise ValueError("Không đọc được video. Hãy thử tệp MP4/H.264 khác.")
            fps = capture.get(cv2.CAP_PROP_FPS)
            if not math.isfinite(fps) or not 0 < fps <= 240:
                raise ValueError("Video không có FPS hợp lệ (cần trong khoảng 0–240).")
            total = max(0, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
            session = TrackingSession(self.detector, run.id, "video", run.state["confidence"], fps)
            run.publish(status="processing", total_frames=total, source_fps=round(fps, 4))
            run.open_records()
            raw_path = run.path / "annotated.raw.mp4"
            index = 0
            last_preview = 0
            while not run.cancel.is_set():
                ok, frame = capture.read()
                if not ok:
                    break
                # Cap display/processing size while preserving the original aspect ratio.
                scale = min(1, 1280 / max(frame.shape[:2]))
                width = max(2, int(frame.shape[1] * scale) // 2 * 2)
                height = max(2, int(frame.shape[0] * scale) // 2 * 2)
                frame = cv2.resize(frame, (width, height))
                if writer is None:
                    writer = cv2.VideoWriter(str(raw_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
                    if not writer.isOpened():
                        raise RuntimeError("Không tạo được tệp video kết quả.")
                    run.publish(frame_width=width, frame_height=height)
                # Zero-based decoded-frame timeline; see README for variable-FPS limitations.
                record = session.process(frame, index, index * 1000 / fps)
                run.record(record)
                image = annotate(frame, record)
                writer.write(image)
                now = time.perf_counter()
                if now - last_preview > .4:
                    preview = run.path / "preview.tmp.jpg"
                    cv2.imwrite(str(preview), image)
                    try:
                        preview.replace(run.path / "preview.jpg")
                    except PermissionError:
                        pass  # A Windows browser download may briefly hold the previous preview open.
                    last_preview = now
                index += 1
            writer.release() if writer is not None else None
            writer = None
            capture.release()
            capture = None
            if run.cancel.is_set():
                run.finish("cancelled")
                return
            if index == 0:
                raise ValueError("Video không có frame đọc được.")
            run.close_records()
            run.publish(status="encoding", progress=99)
            target = run.path / "annotated.mp4"
            command = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-i", str(raw_path), "-an",
                       "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                       "-movflags", "+faststart", str(target)]
            kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}
            with (run.path / "encoding.log").open("wb") as encoding_log:
                process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=encoding_log, **kwargs)
                deadline = time.monotonic() + 600
                while process.poll() is None:
                    if run.cancel.wait(.2) or time.monotonic() > deadline:
                        process.kill()
                        process.wait()
                        if run.cancel.is_set():
                            run.finish("cancelled")
                            return
                        raise RuntimeError("Quá thời gian mã hóa video.")
            if process.returncode != 0:
                raise RuntimeError("Mã hóa H.264 thất bại: " + (run.path / "encoding.log").read_text(errors="replace")[-500:])
            raw_path.unlink(missing_ok=True)
            run.finish(video_url=f"/api/jobs/{run.id}/files/video")
        except Exception as exc:
            logger.exception("Video run %s failed", run.id)
            run.finish("failed", error=str(exc))
        finally:
            if writer is not None:
                writer.release()
            if capture is not None:
                capture.release()
            run.close_records()
            self.slot.release()

    def shutdown(self):
        for run in self.runs.values():
            run.cancel.set()
        self.executor.shutdown(wait=True, cancel_futures=False)
