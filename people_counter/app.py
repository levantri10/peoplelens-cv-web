import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .engine import Detector, TrackingSession
from .jobs import ACTIVE, Manager

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(application):
    application.state.manager = Manager(Detector())
    yield
    await asyncio.to_thread(application.state.manager.shutdown)


app = FastAPI(title="PeopleLens · YOLOv8n + ByteTrack", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=config.STATIC), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(config.STATIC / "index.html")


@app.get("/api/health")
def health():
    manager = app.state.manager
    cuda = torch.cuda.is_available()
    return {"ok": config.WEIGHTS.is_file(), "model": "YOLOv8n CCTV v5", "tracker": "ByteTrack",
            "model_exists": config.WEIGHTS.is_file(), "device": manager.detector.device,
            "device_name": torch.cuda.get_device_name(0) if cuda and manager.detector.device != "cpu" else "CPU",
            "max_upload_mb": config.MAX_UPLOAD_BYTES // (1024 * 1024),
            "demo_available": config.SAMPLE.is_file(), "busy": any(r.state["status"] in ACTIVE for r in manager.runs.values())}


def create_run(kind, name, confidence):
    if not config.WEIGHTS.is_file():
        raise HTTPException(503, "Không tìm thấy best.pt. Xem README để giải nén hoặc đặt CV_MODEL_PATH.")
    try:
        return app.state.manager.create(kind, name, confidence)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.get("/api/jobs")
def list_jobs():
    return app.state.manager.history()


@app.post("/api/jobs", status_code=202)
async def upload_video(file: UploadFile = File(...), confidence: float = Form(.32, ge=.1, le=.9)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}:
        await file.close()
        raise HTTPException(415, "Chọn video MP4, MOV, AVI, MKV hoặc WEBM.")
    # Only a generated filename is written to disk, never the client-supplied path.
    run = create_run("video", (file.filename or "video").replace("\\", "/").split("/")[-1][:120], confidence)
    source = run.path / ("input" + suffix)
    submitted = False
    try:
        size = 0
        with source.open("wb") as stream:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > config.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"Video vượt giới hạn {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
                stream.write(chunk)
        if not size:
            raise HTTPException(400, "Video rỗng.")
        app.state.manager.submit(run, source)
        submitted = True
        return run.snapshot()
    except BaseException as exc:
        if not submitted:
            source.unlink(missing_ok=True)
            run.finish("failed", error=str(getattr(exc, "detail", exc)))
            app.state.manager.slot.release()
        raise
    finally:
        await file.close()


@app.post("/api/demo", status_code=202)
def start_demo(confidence: float = Query(.32, ge=.1, le=.9)):
    if not config.SAMPLE.is_file():
        raise HTTPException(404, "Chưa có video mẫu. Chạy python tools/download_sample.py.")
    run = create_run("video", "people-walking.mp4 · video mẫu", confidence)
    app.state.manager.submit(run, config.SAMPLE)
    return run.snapshot()


@app.get("/api/jobs/{run_id}")
def get_job(run_id: str):
    try:
        return app.state.manager.get(run_id)
    except KeyError as exc:
        raise HTTPException(404, "Không tìm thấy phiên xử lý.") from exc


@app.post("/api/jobs/{run_id}/cancel")
def cancel_job(run_id: str):
    state = get_job(run_id)
    run = app.state.manager.runs.get(run_id)
    if run is not None and state["status"] in ACTIVE:
        run.cancel.set()
        return {"id": run_id, "cancelling": True}
    return {"id": run_id, "cancelling": False, "status": state["status"]}


@app.get("/api/jobs/{run_id}/preview")
def preview(run_id: str):
    get_job(run_id)
    path = config.RUNS / run_id / "preview.jpg"
    if not path.is_file():
        raise HTTPException(404, "Chưa có frame xem trước.")
    # Read once to avoid holding a Windows file handle while the worker replaces the preview.
    from fastapi.responses import Response
    return Response(path.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/jobs/{run_id}/files/{kind}")
def download(run_id: str, kind: str):
    state = get_job(run_id)
    mapping = {"video": ("annotated.mp4", "video/mp4"), "jsonl": ("results.jsonl", "application/x-ndjson"),
               "csv": ("counts.csv", "text/csv"), "summary": ("summary.json", "application/json")}
    if kind not in mapping:
        raise HTTPException(404, "Loại kết quả không hợp lệ.")
    if state["status"] in ACTIVE:
        raise HTTPException(409, "Kết quả vẫn đang được ghi. Hãy chờ phiên kết thúc.")
    filename, mime = mapping[kind]
    path = config.RUNS / run_id / filename
    if not path.is_file():
        raise HTTPException(404, "Phiên này không có loại kết quả được chọn.")
    # Inline video allows HTML playback and HTTP range seeking; data files are downloaded.
    return FileResponse(path, media_type=mime, filename=None if kind == "video" else f"{run_id[:8]}-{filename}")


@app.websocket("/ws/webcam")
async def webcam(websocket: WebSocket, confidence: float = Query(.32, ge=.1, le=.9)):
    # A page from another origin cannot silently open a local camera inference session.
    origin = websocket.headers.get("origin")
    if origin and origin.split("://", 1)[-1] != websocket.headers.get("host"):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    run = None
    try:
        try:
            run = create_run("webcam", "Webcam trình duyệt", confidence)
        except HTTPException as exc:
            await websocket.send_json({"type": "error", "message": exc.detail})
            await websocket.close(code=1013)
            return
        run.publish(status="loading")
        session = await asyncio.to_thread(TrackingSession, app.state.manager.detector, run.id, "webcam", confidence, 10)
        run.open_records()
        run.publish(status="live")
        await websocket.send_json({"type": "ready", "session_id": run.id})
        start = time.monotonic()
        index = 0
        disconnected = False
        while not run.cancel.is_set():
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=30)
            except asyncio.TimeoutError:
                break
            if message["type"] == "websocket.disconnect":
                disconnected = True
                break
            if message.get("text"):
                if json.loads(message["text"]).get("type") == "stop":
                    break
                continue
            content = message.get("bytes")
            if not content or len(content) > 2 * 1024 * 1024:
                raise ValueError("Frame webcam rỗng hoặc vượt 2 MB.")
            frame = await asyncio.to_thread(cv2.imdecode, np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError("Không đọc được frame JPEG.")
            if max(frame.shape[:2]) > 1920:
                raise ValueError("Frame webcam vượt 1920 pixel. Hãy giảm độ phân giải.")
            timestamp = (time.monotonic() - start) * 1000
            record = await asyncio.to_thread(session.process, frame, index, timestamp)
            run.record(record)
            await websocket.send_json({"type": "result", **record})
            index += 1
        run.finish()
        if not disconnected:
            await websocket.send_json({"type": "stopped", "session_id": run.id})
    except WebSocketDisconnect:
        if run is not None:
            run.finish()
    except Exception as exc:
        logger.exception("Webcam session failed")
        if run is not None:
            run.finish("failed", error=str(exc))
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        if run is not None:
            run.close_records()
            app.state.manager.slot.release()
        try:
            await websocket.close()
        except RuntimeError:
            pass

