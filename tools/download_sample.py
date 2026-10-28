"""Create a five-second demo from OpenCV's unannotated surveillance fixture."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import urlopen

URL = "https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/vtest.avi"
target = Path(__file__).resolve().parent.parent / "samples/people-walking.mp4"
target.parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="peoplelens-sample-") as directory:
    source = Path(directory) / "vtest.avi"
    with urlopen(URL, timeout=90) as response, source.open("wb") as stream:
        shutil.copyfileobj(response, stream)
    executable = shutil.which("ffmpeg")
    if executable is None:
        import imageio_ffmpeg
        executable = imageio_ffmpeg.get_ffmpeg_exe()
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}
    subprocess.run([executable, "-v", "error", "-y", "-i", str(source), "-t", "5", "-vf", "fps=10",
                    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(target)], check=True, timeout=120, **kwargs)
data = target.read_bytes()
print(f"Saved {target} ({len(data)} bytes), SHA256={hashlib.sha256(data).hexdigest()}")

