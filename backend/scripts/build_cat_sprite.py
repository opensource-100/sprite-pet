#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from tqdm import tqdm


ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = ROOT.parent

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


def require_rembg():
    try:
        from rembg import remove, new_session
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: rembg. Install it with:\n"
            "  python3 -m pip install rembg onnxruntime numpy\n"
        ) from exc
    return remove, new_session


def run(command):
    subprocess.run(command, check=True)


def ffprobe_duration(video_path):
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def ffprobe_video_frames(video_path):
    """Get the total number of frames in a video."""
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_frames",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    nb = result.stdout.strip()
    if nb and nb != "N/A":
        return int(nb)
    # Fallback: use duration * r_frame_rate
    dur = ffprobe_duration(video_path)
    fps_result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=r_frame_rate",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    fps_str = fps_result.stdout.strip()
    num, den = fps_str.split("/")
    return int(dur * int(num) / int(den))


def extract_frames(video_path, temp_dir, frame_count):
    duration = ffprobe_duration(video_path)
    fps = frame_count / duration
    print(f"Extracting about {frame_count} frames from {video_path.name}...")
    run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-vf",
            f"fps={fps:.8f}",
            "-frames:v",
            str(frame_count),
            str(temp_dir / "source-%03d.png"),
        ]
    )
    frames = sorted(temp_dir.glob("source-*.png"))
    if not frames:
        raise RuntimeError("ffmpeg did not create any frames")
    if len(frames) < frame_count * 0.9:
        raise RuntimeError(f"ffmpeg created {len(frames)} frames, expected {frame_count}")
    print(f"Extracted {len(frames)} frames.")
    return frames[: min(frame_count, len(frames))]


def alpha_bbox(image):
    alpha = image.getchannel("A")
    return alpha.getbbox()


def soften_alpha(image):
    channels = image.split()
    alpha = channels[3].filter(ImageFilter.MedianFilter(size=3))
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.45))
    return Image.merge("RGBA", (*channels[:3], alpha))


def remove_green_spill(image, strength):
    if strength <= 0:
        return image

    data = np.array(image.convert("RGBA"), dtype=np.float32)
    red = data[:, :, 0]
    green = data[:, :, 1]
    blue = data[:, :, 2]
    alpha = data[:, :, 3]

    edge = (alpha > 0) & (alpha < 255)
    green_dominant = (green > red + 3) & (green > blue - 8) & (green > ((red + blue) / 2 + 4))
    mask = edge & green_dominant

    neutral_green = (red + blue) / 2
    data[:, :, 1] = np.where(mask, green + (neutral_green - green) * strength, green)

    return Image.fromarray(np.clip(data, 0, 255).astype(np.uint8), "RGBA")


def clean_alpha_edge(image, threshold, erode):
    if threshold <= 0 and erode <= 0:
        return image

    channels = image.split()
    alpha = channels[3]
    if threshold > 0:
        alpha = alpha.point(lambda value: 0 if value < threshold else value)
    for _ in range(max(0, erode)):
        alpha = alpha.filter(ImageFilter.MinFilter(size=3))
    if erode > 0:
        alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.35))
    return Image.merge("RGBA", (*channels[:3], alpha))


def apply_source_rgb_with_alpha(source, alpha_source):
    output = source.copy()
    output.putalpha(alpha_source.getchannel("A"))
    return output


def clear_transparent_rgb(image):
    data = np.array(image.convert("RGBA"), dtype=np.uint8)
    transparent = data[:, :, 3] == 0
    data[:, :, :3] = np.where(transparent[:, :, None], 0, data[:, :, :3])
    return Image.fromarray(data, "RGBA")


def resize_to_max_height(image, max_height):
    if max_height <= 0 or image.height <= max_height:
        return image
    scale = max_height / image.height
    width = max(1, round(image.width * scale))
    return image.resize((width, max_height), Image.Resampling.LANCZOS)


def union_alpha_bbox(images, padding):
    boxes = [alpha_bbox(image) for image in images]
    boxes = [box for box in boxes if box is not None]
    if not boxes:
        return (0, 0, 1, 1)

    width, height = images[0].size
    left = max(0, min(box[0] for box in boxes) - padding)
    top = max(0, min(box[1] for box in boxes) - padding)
    right = min(width, max(box[2] for box in boxes) + padding)
    bottom = min(height, max(box[3] for box in boxes) + padding)
    return (left, top, right, bottom)


def normalize_frames(images, padding, max_frame_height):
    print("Calculating shared crop box and normalizing frame sizes...")
    crop_box = union_alpha_bbox(images, padding)
    cropped = [
        resize_to_max_height(image.crop(crop_box), max_frame_height)
        for image in tqdm(images, desc="Normalize frames", unit="frame")
    ]
    frame_width = max(crop.width for crop in cropped)
    frame_height = max(crop.height for crop in cropped)

    normalized = []
    for crop in tqdm(cropped, desc="Pad frames", unit="frame"):
        canvas = Image.new("RGBA", (frame_width, frame_height), (0, 0, 0, 0))
        x = (frame_width - crop.width) // 2
        y = (frame_height - crop.height) // 2
        canvas.alpha_composite(crop, (x, y))
        normalized.append(canvas)

    return normalized, frame_width, frame_height, crop_box


def build_sprite(
    frames,
    out_frames_dir,
    sprite_path,
    metadata_path,
    padding,
    model_name,
    columns,
    max_frame_height,
    despill_strength,
    alpha_threshold,
    alpha_erode,
    alpha_matting,
    provider,
):
    remove, new_session = require_rembg()
    providers = None
    if provider == "coreml":
        providers = [
            (
                "CoreMLExecutionProvider",
                {
                    "MLComputeUnits": "ALL",
                    "ModelFormat": "MLProgram",
                },
            ),
            "CPUExecutionProvider",
        ]
    elif provider == "cpu":
        providers = ["CPUExecutionProvider"]

    session_kwargs = {"providers": providers} if providers else {}
    print(f"Loading model: {model_name} ({provider})")
    session = new_session(model_name, **session_kwargs)
    out_frames_dir.mkdir(parents=True, exist_ok=True)
    sprite_path.parent.mkdir(parents=True, exist_ok=True)

    cutouts = []
    for index, frame_path in enumerate(tqdm(frames, desc="Remove background", unit="frame")):
        source = Image.open(frame_path).convert("RGBA")
        matte = remove(
            source,
            session=session,
            alpha_matting=alpha_matting,
            alpha_matting_foreground_threshold=240,
            alpha_matting_background_threshold=10,
            alpha_matting_erode_size=10,
        ).convert("RGBA")
        cutout = apply_source_rgb_with_alpha(source, matte)
        cutout = soften_alpha(cutout)
        cutout = clean_alpha_edge(cutout, alpha_threshold, alpha_erode)
        cutout = remove_green_spill(cutout, despill_strength)
        cutout = clear_transparent_rgb(cutout)
        frame_out = out_frames_dir / f"cat-{index:03d}.png"
        cutout.save(frame_out)
        cutouts.append(cutout)

    normalized, frame_width, frame_height, crop_box = normalize_frames(cutouts, padding, max_frame_height)
    columns = max(1, min(columns, len(normalized)))
    rows = (len(normalized) + columns - 1) // columns
    sprite = Image.new("RGBA", (frame_width * columns, frame_height * rows), (0, 0, 0, 0))
    print(f"Packing {len(normalized)} frames into sprite sheet...")
    for index, frame in enumerate(tqdm(normalized, desc="Pack sprite", unit="frame")):
        column = index % columns
        row = index // columns
        sprite.alpha_composite(frame, (column * frame_width, row * frame_height))

    sprite = remove_green_spill(sprite, despill_strength)
    sprite = clear_transparent_rgb(sprite)
    print("Final green despill and transparent RGB cleanup...")
    sprite.save(sprite_path)
    metadata = {
        "image": sprite_path.name,
        "frameCount": len(normalized),
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "spriteWidth": sprite.width,
        "spriteHeight": sprite.height,
        "columns": columns,
        "rows": rows,
        "layout": "grid",
        "cropBox": crop_box,
        "source": "cat_range_head.mp4",
        "model": model_name,
        "provider": provider,
        "providers": providers,
        "despill": {
            "color": "green",
            "strength": despill_strength,
        },
        "alphaCleanup": {
            "threshold": alpha_threshold,
            "erode": alpha_erode,
            "alphaMatting": alpha_matting,
        },
        "calibration": DEFAULT_CALIBRATION,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description="Build a transparent cat sprite sheet from a video.")
    parser.add_argument("--video", default=str(ROOT / "cat_range_head.mp4"))
    parser.add_argument("--frames", type=int, default=200)
    parser.add_argument("--padding", type=int, default=18)
    parser.add_argument("--model", default="birefnet-general-lite")
    parser.add_argument("--provider", choices=["auto", "cpu", "coreml"], default="cpu")
    parser.add_argument("--columns", type=int, default=20)
    parser.add_argument("--max-frame-height", type=int, default=512)
    parser.add_argument("--despill-strength", type=float, default=1.0)
    parser.add_argument("--alpha-threshold", type=int, default=35)
    parser.add_argument("--alpha-erode", type=int, default=0)
    parser.add_argument("--alpha-matting", action="store_true")
    parser.add_argument("--out-frames", default=str(ROOT / "frames"))
    parser.add_argument("--sprite", default=str(PROJECT_ROOT / "public" / "sprites" / "cat-sprite.webp"))
    parser.add_argument("--metadata", default=str(PROJECT_ROOT / "public" / "sprites" / "cat-sprite.json"))
    args = parser.parse_args()

    video_path = Path(args.video)
    if not video_path.exists():
        raise SystemExit(f"Video not found: {video_path}")

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise SystemExit("ffmpeg and ffprobe are required.")

    with tempfile.TemporaryDirectory(prefix="cat-sprite-") as temp_name:
        temp_dir = Path(temp_name)
        print("Starting sprite build")
        print(f"Video: {video_path}")
        print(f"Model: {args.model}")
        print(f"Provider: {args.provider}")
        source_frames = extract_frames(video_path, temp_dir, args.frames)
        metadata = build_sprite(
            source_frames,
            Path(args.out_frames),
            Path(args.sprite),
            Path(args.metadata),
            args.padding,
            args.model,
            args.columns,
            args.max_frame_height,
            args.despill_strength,
            args.alpha_threshold,
            args.alpha_erode,
            args.alpha_matting,
            args.provider,
        )

    print(
        "Done. Built {frameCount} frames: {spriteWidth}x{spriteHeight} sprite, "
        "{frameWidth}x{frameHeight} per frame".format(**metadata)
    )
    print(f"Sprite: {args.sprite}")
    print(f"Metadata: {args.metadata}")


if __name__ == "__main__":
    main()
