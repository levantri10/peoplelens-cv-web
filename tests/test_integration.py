"""Integration tests: trained detector + ByteTrack + actual video/WS/export routes.

No physical webcam is opened: the WS path receives JPEG frames from the sample.
"""

import csv
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

TEST_DATA = tempfile.TemporaryDirectory(prefix="peoplelens-test-")
os.environ["CV_DATA_DIR"] = TEST_DATA.name
os.environ["CV_DEVICE"] = "cpu"

import cv2
import numpy as np
from fastapi.testclient import TestClient

from people_counter import config
from people_counter.app import app


class PipelineIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not config.WEIGHTS.is_file() or not config.SAMPLE.is_file():
            raise unittest.SkipTest("Need best.pt and samples/people-walking.mp4; run setup/sample downloader first.")
        cls.client_context = TestClient(app)
        cls.client = cls.client_context.__enter__()
        cls.video = Path(TEST_DATA.name) / "test-input.mp4"
        capture = cv2.VideoCapture(str(config.SAMPLE))
        ok, cls.first_frame = capture.read()
        if not ok:
            raise RuntimeError("Sample could not be decoded.")
        # Real motion frames followed by an empty scene test zero-count emission and lost tracks.
        width, height = cls.first_frame.shape[1], cls.first_frame.shape[0]
        writer = cv2.VideoWriter(str(cls.video), cv2.VideoWriter_fourcc(*"mp4v"), 10, (width, height))
        cls.frame_count = 20
        writer.write(cls.first_frame)
        for _ in range(15):
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError("Sample ended early.")
            writer.write(frame)
        for _ in range(4):
            writer.write(np.zeros_like(cls.first_frame))
        writer.release()
        capture.release()
        encoded, jpeg = cv2.imencode(".jpg", cls.first_frame)
        if not encoded:
            raise RuntimeError("JPEG encoding failed.")
        cls.jpeg = jpeg.tobytes()

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        TEST_DATA.cleanup()

    def wait_for_job(self, run_id):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            response = self.client.get(f"/api/jobs/{run_id}")
            self.assertEqual(response.status_code, 200)
            state = response.json()
            if state["status"] not in {"uploading", "queued", "loading", "processing", "encoding", "live"}:
                # The worker releases the slot immediately after final state persistence.
                for _ in range(100):
                    if app.state.manager.slot.acquire(blocking=False):
                        app.state.manager.slot.release()
                        return state
                    time.sleep(.01)
            time.sleep(.05)
        self.fail("Job did not finish within 120 seconds.")

    def test_01_health_page_and_invalid_input(self):
        health = self.client.get("/api/health")
        self.assertTrue(health.json()["model_exists"])
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/static/app.js").status_code, 200)
        self.assertEqual(self.client.post("/api/jobs", files={"file": ("wrong.txt", b"abc")}).status_code, 415)
        self.assertEqual(self.client.post("/api/jobs", files={"file": ("empty.mp4", b"")}).status_code, 400)
        self.assertEqual(self.client.post("/api/demo?confidence=2").status_code, 422)
        self.assertEqual(self.client.get("/api/jobs/not-a-run").status_code, 404)

    def test_02_real_video_tracking_zero_count_and_exports(self):
        with self.video.open("rb") as stream:
            response = self.client.post("/api/jobs", files={"file": ("input.mp4", stream, "video/mp4")}, data={"confidence": ".32"})
        self.assertEqual(response.status_code, 202, response.text)
        run_id = response.json()["id"]
        state = self.wait_for_job(run_id)
        self.assertEqual(state["status"], "completed", state.get("error"))
        self.assertEqual(state["processed_frames"], self.frame_count)
        base = f"/api/jobs/{run_id}/files/"
        records = [json.loads(line) for line in self.client.get(base + "jsonl").text.splitlines()]
        self.assertEqual(len(records), self.frame_count)
        for index, record in enumerate(records):
            self.assertEqual(record["frame_index"], index)
            self.assertEqual(record["timestamp_ms"], index * 100)
            self.assertEqual(record["people_count"], len(record["detections"]))
            self.assertEqual(record["tracked_count"], sum(d["track_id"] is not None for d in record["detections"]))
        self.assertGreater(max(r["people_count"] for r in records[:16]), 0)
        self.assertTrue(all(r["people_count"] == 0 and r["tracked_count"] == 0 for r in records[-4:]))
        seen = [{d["track_id"] for d in r["detections"] if d["track_id"] is not None} for r in records[:16]]
        self.assertTrue(any(a & b for a, b in zip(seen, seen[1:])), "No ID persisted between adjacent frames")
        csv_response = self.client.get(base + "csv")
        rows = list(csv.DictReader(io.StringIO(csv_response.content.decode("utf-8-sig"))))
        self.assertEqual(len(rows), self.frame_count)
        self.assertEqual(rows[-1]["people_count"], "0")
        self.assertEqual(self.client.get(base + "summary").json()["status"], "completed")
        self.assertEqual(self.client.get(f"/api/jobs/{run_id}/preview").status_code, 200)
        video_response = self.client.get(base + "video", headers={"Range": "bytes=0-31"})
        self.assertEqual(video_response.status_code, 206)
        self.assertEqual(len(video_response.content), 32)
        capture = cv2.VideoCapture(str(config.RUNS / run_id / "annotated.mp4"))
        self.assertTrue(capture.isOpened())
        self.assertEqual(int(capture.get(cv2.CAP_PROP_FRAME_COUNT)), self.frame_count)
        codec = int(capture.get(cv2.CAP_PROP_FOURCC))
        self.assertIn("".join(chr((codec >> (8 * i)) & 255) for i in range(4)), {"avc1", "h264"})
        capture.release()

    def test_03_webcam_protocol_tracks_stop_and_exclusive_source(self):
        with self.client.websocket_connect("/ws/webcam?confidence=.32") as websocket:
            ready = websocket.receive_json()
            self.assertEqual(ready["type"], "ready")
            run_id = ready["session_id"]
            self.assertEqual(self.client.post("/api/demo").status_code, 409)
            records = []
            for _ in range(3):
                websocket.send_bytes(self.jpeg)
                record = websocket.receive_json()
                self.assertEqual(record["type"], "result")
                self.assertGreater(record["people_count"], 0)
                records.append(record)
            ids = [{d["track_id"] for d in r["detections"] if d["track_id"] is not None} for r in records]
            self.assertTrue(ids[0] & ids[1] & ids[2])
            self.assertLessEqual(records[0]["timestamp_ms"], records[-1]["timestamp_ms"])
            websocket.send_text('{"type":"stop"}')
            self.assertEqual(websocket.receive_json()["type"], "stopped")
        state = self.wait_for_job(run_id)
        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["processed_frames"], 3)
        self.assertIsNone(state["video_url"])
        self.assertEqual(self.client.get(f"/api/jobs/{run_id}/files/csv").status_code, 200)

    def test_04_video_cancellation_and_corrupt_video(self):
        response = self.client.post("/api/demo")
        self.assertEqual(response.status_code, 202, response.text)
        run_id = response.json()["id"]
        self.assertTrue(self.client.post(f"/api/jobs/{run_id}/cancel").json()["cancelling"])
        self.assertEqual(self.wait_for_job(run_id)["status"], "cancelled")
        response = self.client.post("/api/jobs", files={"file": ("broken.mp4", b"not a video", "video/mp4")})
        self.assertEqual(response.status_code, 202)
        state = self.wait_for_job(response.json()["id"])
        self.assertEqual(state["status"], "failed")
        self.assertIn("video", state["error"])

    def test_05_webcam_invalid_frame_and_disconnect_release_source(self):
        with self.client.websocket_connect("/ws/webcam") as websocket:
            run_id = websocket.receive_json()["session_id"]
            websocket.send_bytes(b"not a jpeg")
            self.assertEqual(websocket.receive_json()["type"], "error")
        self.assertEqual(self.wait_for_job(run_id)["status"], "failed")
        with self.client.websocket_connect("/ws/webcam") as websocket:
            run_id = websocket.receive_json()["session_id"]
            websocket.send_bytes(self.jpeg)
            self.assertEqual(websocket.receive_json()["type"], "result")
        self.assertEqual(self.wait_for_job(run_id)["status"], "completed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
