#!/usr/bin/env python3
"""Optional SpritePet backend.

The frontend is fully static and works without this process. Start this server
only when you need local video-to-sprite conversion.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import tempfile
import threading
import time
import uuid
from http.server import HTTPServer, SimpleHTTPRequestHandler
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote, urlparse

BACKEND_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_ROOT.parent
SPRITES_DIR = PROJECT_ROOT / "public" / "sprites"
UPLOADS_DIR = BACKEND_ROOT / "uploads"
TASKS: dict[str, dict] = {}
TASK_EVENTS: dict[str, queue.Queue] = {}
SUPPORTED_SPRITE_SUFFIXES = {".webp", ".png"}

sys.path.insert(0, str(BACKEND_ROOT / "scripts"))

DEFAULT_CALIBRATION = {
    "centerPoint": {
        "x": 0.5238826815642458,
        "y": 0.2892578125,
    },
    "calibrationPoints": [
        {"angle": 0.048164566172261836, "frame": 105},
        {"angle": 0.5131520374652752, "frame": 82},
        {"angle": 0.9704009022526998, "frame": 74},
        {"angle": 1.6180038743981209, "frame": 66},
        {"angle": 3.1302315233980043, "frame": 24},
        {"angle": 3.1590459461097353, "frame": 152},
        {"angle": 3.857177646907468, "frame": 142},
        {"angle": 4.699694349857307, "frame": 131},
        {"angle": 5.59414814579233, "frame": 118},
    ],
    "reverse": False,
    "calibrating": False,
}


def sprite_stem(name: str) -> str:
    safe_name = Path(unquote(name).replace("\\", "/")).name
    return Path(safe_name).stem


def sprite_metadata_path(name: str) -> Path:
    return SPRITES_DIR / f"{sprite_stem(name)}.json"


def collect_sprites() -> list[dict]:
    sprites = []
    if not SPRITES_DIR.exists():
        return sprites

    for image_path in sorted(SPRITES_DIR.iterdir()):
        if not image_path.is_file() or image_path.suffix.lower() not in SUPPORTED_SPRITE_SUFFIXES:
            continue
        metadata = {}
        meta_path = image_path.with_suffix(".json")
        if meta_path.exists():
            try:
                metadata = json.loads(meta_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                metadata = {}
        sprites.append(
            {
                "id": image_path.stem,
                "name": image_path.name,
                "label": image_path.stem.replace("-", " ").title(),
                "metadataPath": f"sprites/{image_path.stem}.json",
                "frameCount": metadata.get("frameCount", 0),
                "frameWidth": metadata.get("frameWidth", 0),
                "frameHeight": metadata.get("frameHeight", 0),
                "columns": metadata.get("columns", 0),
                "rows": metadata.get("rows", 0),
                "image": metadata.get("image", image_path.name),
            }
        )
    return sprites


def save_calibration_metadata(name: str, calibration: dict) -> dict:
    meta_path = sprite_metadata_path(name)
    if not meta_path.exists():
        raise FileNotFoundError(f"Metadata not found for {name}")
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    metadata["calibration"] = calibration
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return metadata


def _emit_event(task_id: str, event_type: str, data: dict) -> None:
    """Push an SSE event into the task's queue."""
    q = TASK_EVENTS.get(task_id)
    if q is not None:
        q.put({"event": event_type, "data": data})


def _emit_log(task_id: str, message: str) -> None:
    print(f"[sprite-pet] {message}", flush=True)
    _emit_event(task_id, "log", {"message": message})


def _build_sprite_from_video(
    video_path: Path,
    frames: int,
    columns: int,
    max_frame_height: int,
    padding: int,
    despill_strength: float,
    alpha_threshold: int,
    sprite_path: Path,
    metadata_path: Path,
    progress_callback=None,
    log_callback=None,
) -> dict:
    def _log(msg: str) -> None:
        print(f"[sprite-pet] {msg}", flush=True)
        if log_callback:
            log_callback(msg)

    import torch
    from PIL import Image, ImageFilter
    from torchvision import transforms
    from tqdm import tqdm
    from transformers import AutoModelForImageSegmentation

    from build_cat_sprite import clear_transparent_rgb, extract_frames, ffprobe_video_frames, normalize_frames, remove_green_spill

    if not torch.backends.mps.is_available():
        raise RuntimeError("MPS is not available. Use the CLI CPU pipeline in backend/scripts/build_cat_sprite.py.")

    device = torch.device("mps")
    model_name = "ZhengPeng7/BiRefNet_lite"
    image_size = 1024

    video_frames = ffprobe_video_frames(video_path)
    if frames > video_frames:
        _log(f"Capping frames from {frames} to video frame count {video_frames}")
        frames = video_frames

    _log(f"Step 1/6: Loading segmentation model {model_name} on {device}...")
    t0 = time.perf_counter()
    model = AutoModelForImageSegmentation.from_pretrained(model_name, trust_remote_code=True)
    model.to(device)
    model.eval()
    _log(f"Model loaded in {time.perf_counter() - t0:.1f}s")

    out_frames_dir = BACKEND_ROOT / "frames" / sprite_path.stem
    out_frames_dir.mkdir(parents=True, exist_ok=True)
    transform_image = transforms.Compose(
        [
            transforms.Resize((image_size, image_size)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )

    _log(f"Step 2/6: Extracting frames (target={frames}) from {video_path.name}...")
    if progress_callback:
        progress_callback(2)
    with tempfile.TemporaryDirectory(prefix="sprite-pet-web-") as temp_name:
        source_frames = extract_frames(video_path, Path(temp_name), frames)
        _log(f"Extracted {len(source_frames)} frames from video")

        cutouts = []
        infer_times = []
        total_frames = len(source_frames)
        _log(f"Step 3/6: Running BiRefNet segmentation on {total_frames} frames (this may take a while)...")
        if progress_callback:
            progress_callback(5)
        for index, frame_path in enumerate(tqdm(source_frames, desc="BiRefNet MPS", unit="frame")):
            source = Image.open(frame_path).convert("RGB")
            tensor = transform_image(source).unsqueeze(0).to(device)
            torch.mps.synchronize()
            started = time.perf_counter()
            with torch.inference_mode():
                pred = model(tensor)[-1].sigmoid()
            torch.mps.synchronize()
            infer_times.append(time.perf_counter() - started)

            mask = transforms.ToPILImage()(pred[0].squeeze().cpu())
            alpha = mask.resize(source.size, Image.Resampling.BILINEAR)
            alpha = alpha.filter(ImageFilter.MedianFilter(size=3))
            alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.45))
            if alpha_threshold > 0:
                alpha = alpha.point(lambda v: 0 if v < alpha_threshold else v)

            cutout = source.convert("RGBA")
            cutout.putalpha(alpha)
            cutout = remove_green_spill(cutout, despill_strength)
            cutout = clear_transparent_rgb(cutout)
            cutout.save(out_frames_dir / f"frame-{index:03d}.png")
            cutouts.append(cutout)
            if progress_callback:
                progress_callback(5 + int(65 * (index + 1) / total_frames))
            if (index + 1) % 10 == 0 or index == total_frames - 1:
                _log(f"Segmentation progress: {index + 1}/{total_frames} frames ({infer_times[-1]:.2f}s last)")

        avg_infer = sum(infer_times) / max(1, len(infer_times))
        _log(f"Segmentation done: avg {avg_infer:.2f}s/frame, saved to {out_frames_dir}")

    _log(f"Step 4/6: Normalizing frames (padding={padding}px, maxHeight={max_frame_height}px)...")
    if progress_callback:
        progress_callback(72)
    normalized, frame_width, frame_height, crop_box = normalize_frames(cutouts, padding, max_frame_height)
    columns = max(1, min(columns, len(normalized)))
    rows = (len(normalized) + columns - 1) // columns
    _log(f"Step 5/6: Packing {len(normalized)} frames into {columns}x{rows} sprite sheet ({frame_width}x{frame_height} per frame)...")
    sprite = Image.new("RGBA", (frame_width * columns, frame_height * rows), (0, 0, 0, 0))

    total_normalized = len(normalized)
    for index, frame in enumerate(tqdm(normalized, desc="Pack sprite", unit="frame")):
        column = index % columns
        row = index // columns
        sprite.alpha_composite(frame, (column * frame_width, row * frame_height))
        if progress_callback:
            progress_callback(75 + int(18 * (index + 1) / total_normalized))

    sprite = remove_green_spill(sprite, despill_strength)
    sprite = clear_transparent_rgb(sprite)
    SPRITES_DIR.mkdir(parents=True, exist_ok=True)
    sprite.save(sprite_path)
    _log(f"Step 6/6: Sprite saved — {sprite.width}x{sprite.height}px, {columns}x{rows} grid, {frame_width}x{frame_height} per frame")

    if progress_callback:
        progress_callback(95)

    metadata = {
        "source": video_path.name,
        "model": model_name,
        "provider": "mps",
        "imageSize": image_size,
        "averageInferenceSeconds": avg_infer,
        "despill": {"color": "green", "strength": despill_strength},
        "alphaCleanup": {"threshold": alpha_threshold, "erode": 0, "alphaMatting": False},
        "image": sprite_path.name,
        "frameCount": len(normalized),
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "spriteWidth": sprite.width,
        "spriteHeight": sprite.height,
        "columns": columns,
        "rows": rows,
        "layout": "grid",
        "cropBox": list(crop_box),
        "calibration": DEFAULT_CALIBRATION,
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _log(f"Metadata written to {metadata_path.name}")
    return metadata


class SpritePetHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/health":
            self._json_response({"ok": True, "spritesDir": str(SPRITES_DIR)})
        elif path == "/api/task/latest":
            self._handle_get_latest_task()
        elif path == "/api/sprites":
            self._json_response({"sprites": collect_sprites()})
        elif path.startswith("/api/sprites/") and path.endswith("/metadata"):
            name = path[len("/api/sprites/") : -len("/metadata")]
            self._handle_get_metadata(name)
        elif path.startswith("/api/task/") and path.endswith("/stream"):
            task_id = path[len("/api/task/") : -len("/stream")]
            self._handle_task_stream(task_id)
        elif path.startswith("/api/task/"):
            self._handle_get_task(path[len("/api/task/") :])
        elif path.startswith("/sprites/"):
            self._handle_sprite_file(path[len("/sprites/") :])
        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/upload":
            self._handle_upload()
        elif path.startswith("/api/calibration/"):
            self._handle_save_calibration(path[len("/api/calibration/") :])
        else:
            self.send_error(404)

    def _json_response(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _handle_get_metadata(self, name):
        meta_path = sprite_metadata_path(name)
        if not meta_path.exists():
            self.send_error(404, "Metadata not found")
            return
        try:
            self._json_response(json.loads(meta_path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError) as error:
            self._json_response({"error": str(error)}, 500)

    def _handle_sprite_file(self, name):
        file_path = SPRITES_DIR / Path(unquote(name)).name
        if not file_path.exists() or file_path.suffix.lower() not in SUPPORTED_SPRITE_SUFFIXES:
            self.send_error(404, "Sprite not found")
            return
        content_type = "image/webp" if file_path.suffix.lower() == ".webp" else "image/png"
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_upload(self):
        try:
            from multipart.multipart import parse_form
        except ImportError:
            self._json_response({"error": "Missing dependency: python-multipart"}, 500)
            return

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._json_response({"error": "Expected multipart/form-data"}, 400)
            return

        body = self._read_body()
        if not body:
            self._json_response({"error": "Empty request body"}, 400)
            return

        video_data = None
        video_filename = "video.mp4"
        params = {}

        def on_field(field):
            nonlocal params
            if field.field_name == b"params":
                try:
                    params = json.loads(field.value)
                except (json.JSONDecodeError, TypeError, AttributeError):
                    params = {}

        def on_file(file):
            nonlocal video_data, video_filename
            if file.field_name == b"video":
                file.file_object.seek(0)
                video_data = file.file_object.read()
                if file.file_name:
                    video_filename = file.file_name.decode("utf-8", errors="replace")

        parse_form({"Content-Type": content_type}, BytesIO(body), on_field, on_file)
        if not video_data:
            self._json_response({"error": "Missing 'video' field"}, 400)
            return

        frames = int(params.get("frames", 20))
        columns = int(params.get("columns", 20))
        max_frame_height = int(params.get("maxFrameHeight", 512))
        padding = int(params.get("padding", 18))
        despill_strength = float(params.get("despillStrength", 1.0))
        alpha_threshold = int(params.get("alphaThreshold", 35))

        task_id = str(uuid.uuid4())[:8]
        video_ext = Path(video_filename).suffix or ".mp4"
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        video_path = UPLOADS_DIR / f"upload-{task_id}{video_ext}"
        video_path.write_bytes(video_data)

        sprite_name = f"sprite-{task_id}.webp"
        sprite_path = SPRITES_DIR / sprite_name
        metadata_path = sprite_path.with_suffix(".json")

        TASKS[task_id] = {
            "id": task_id,
            "status": "processing",
            "progress": 0,
            "error": None,
            "spriteName": sprite_name,
            "metadataPath": f"sprites/{metadata_path.name}",
        }
        TASK_EVENTS[task_id] = queue.Queue()

        def update_progress(progress):
            TASKS[task_id]["progress"] = progress
            _emit_event(task_id, "progress", {"progress": progress})

        def on_log(message: str):
            _emit_log(task_id, message)

        def process():
            try:
                _emit_log(task_id, f"Starting conversion: {video_filename} ({frames} frames, {columns} columns)")
                _build_sprite_from_video(
                    video_path,
                    frames,
                    columns,
                    max_frame_height,
                    padding,
                    despill_strength,
                    alpha_threshold,
                    sprite_path,
                    metadata_path,
                    progress_callback=update_progress,
                    log_callback=on_log,
                )
                TASKS[task_id]["status"] = "done"
                TASKS[task_id]["progress"] = 100
                _emit_event(task_id, "done", {
                    "spriteName": sprite_name,
                    "metadataPath": f"sprites/{metadata_path.name}",
                })
                _emit_log(task_id, f"Conversion complete! Sprite ready: {sprite_name}")
            except Exception as error:
                TASKS[task_id]["status"] = "error"
                TASKS[task_id]["error"] = str(error)
                _emit_event(task_id, "error", {"error": str(error)})
                _emit_log(task_id, f"Error: {error}")

        threading.Thread(target=process, daemon=True).start()
        self._json_response({"taskId": task_id, "status": "processing"})

    def _handle_get_latest_task(self):
        if not TASKS:
            self._json_response({"task": None})
            return
        latest_id = list(TASKS.keys())[-1]
        self._json_response({"task": TASKS[latest_id]})

    def _handle_get_task(self, task_id):
        task = TASKS.get(task_id)
        if not task:
            self.send_error(404, "Task not found")
            return
        self._json_response(task)

    def _handle_task_stream(self, task_id):
        q = TASK_EVENTS.get(task_id)
        if q is None:
            self.send_error(404, "Task not found")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        try:
            while True:
                try:
                    event = q.get(timeout=15)
                except queue.Empty:
                    # Send keepalive comment
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue

                event_type = event["event"]
                data = json.dumps(event["data"], ensure_ascii=False)
                self.wfile.write(f"event: {event_type}\ndata: {data}\n\n".encode("utf-8"))
                self.wfile.flush()

                if event_type in ("done", "error"):
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle_save_calibration(self, name):
        try:
            data = json.loads(self._read_body())
        except json.JSONDecodeError:
            self._json_response({"error": "Invalid JSON"}, 400)
            return
        try:
            metadata = save_calibration_metadata(name, data)
        except FileNotFoundError:
            self.send_error(404, "Metadata not found")
            return
        except (json.JSONDecodeError, OSError) as error:
            self._json_response({"error": str(error)}, 500)
            return
        self._json_response({"saved": True, "metadata": metadata})

    def log_message(self, format, *args):
        print(f"[sprite-pet] {args[0] if args else format}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Optional SpritePet backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8003)
    args = parser.parse_args()

    class ReusableHTTPServer(HTTPServer):
        allow_reuse_address = True

    server = ReusableHTTPServer((args.host, args.port), SpritePetHandler)
    print(f"SpritePet backend running at http://{args.host}:{args.port}")
    print(f"Writing sprites to {SPRITES_DIR}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
