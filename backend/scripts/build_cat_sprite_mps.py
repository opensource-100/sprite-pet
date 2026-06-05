#!/usr/bin/env python3
import argparse
import json
import shutil
import tempfile
import time
from pathlib import Path

import torch
from PIL import Image, ImageFilter
from torchvision import transforms
from tqdm import tqdm
from transformers import AutoModelForImageSegmentation

from build_cat_sprite import (
    DEFAULT_CALIBRATION,
    PROJECT_ROOT,
    ROOT,
    alpha_bbox,
    clear_transparent_rgb,
    extract_frames,
    normalize_frames,
    remove_green_spill,
)


def make_cutout(source, mask, alpha_threshold, despill_strength):
    alpha = mask.resize(source.size, Image.Resampling.BILINEAR)
    alpha = alpha.filter(ImageFilter.MedianFilter(size=3))
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.45))
    if alpha_threshold > 0:
        alpha = alpha.point(lambda value: 0 if value < alpha_threshold else value)

    cutout = source.convert("RGBA")
    cutout.putalpha(alpha)
    cutout = remove_green_spill(cutout, despill_strength)
    return clear_transparent_rgb(cutout)


def load_model(model_name, device):
    print(f"Loading {model_name} on {device}...")
    started = time.perf_counter()
    model = AutoModelForImageSegmentation.from_pretrained(model_name, trust_remote_code=True)
    model.to(device)
    model.eval()
    print(f"Model loaded in {time.perf_counter() - started:.2f}s")
    return model


def infer_cutouts(model, frame_paths, out_frames_dir, image_size, alpha_threshold, despill_strength, device):
    out_frames_dir.mkdir(parents=True, exist_ok=True)
    transform_image = transforms.Compose(
        [
            transforms.Resize((image_size, image_size)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )

    cutouts = []
    infer_times = []
    for index, frame_path in enumerate(tqdm(frame_paths, desc="BiRefNet MPS", unit="frame")):
        source = Image.open(frame_path).convert("RGB")
        tensor = transform_image(source).unsqueeze(0).to(device)

        if device.type == "mps":
            torch.mps.synchronize()
        started = time.perf_counter()
        with torch.inference_mode():
            pred = model(tensor)[-1].sigmoid()
        if device.type == "mps":
            torch.mps.synchronize()
        infer_times.append(time.perf_counter() - started)

        mask = transforms.ToPILImage()(pred[0].squeeze().cpu())
        cutout = make_cutout(source, mask, alpha_threshold, despill_strength)
        cutout.save(out_frames_dir / f"cat-{index:03d}.png")
        cutouts.append(cutout)

    avg = sum(infer_times) / max(1, len(infer_times))
    print(f"Average model inference: {avg:.3f}s/frame")
    return cutouts, avg


def pack_sprite(cutouts, sprite_path, metadata_path, padding, max_frame_height, columns, metadata):
    normalized, frame_width, frame_height, crop_box = normalize_frames(cutouts, padding, max_frame_height)
    columns = max(1, min(columns, len(normalized)))
    rows = (len(normalized) + columns - 1) // columns
    sprite = Image.new("RGBA", (frame_width * columns, frame_height * rows), (0, 0, 0, 0))

    print(f"Packing {len(normalized)} frames into sprite sheet...")
    for index, frame in enumerate(tqdm(normalized, desc="Pack sprite", unit="frame")):
        column = index % columns
        row = index // columns
        sprite.alpha_composite(frame, (column * frame_width, row * frame_height))

    sprite = remove_green_spill(sprite, metadata["despill"]["strength"])
    sprite = clear_transparent_rgb(sprite)
    sprite_path.parent.mkdir(parents=True, exist_ok=True)
    sprite.save(sprite_path)

    metadata.update(
        {
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
            "calibration": DEFAULT_CALIBRATION,
        }
    )
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description="Build a transparent cat sprite sheet with BiRefNet on PyTorch MPS.")
    parser.add_argument("--video", default=str(ROOT / "cat_range_head.mp4"))
    parser.add_argument("--frames", type=int, default=200)
    parser.add_argument("--model", default="ZhengPeng7/BiRefNet_lite")
    parser.add_argument("--image-size", type=int, default=1024)
    parser.add_argument("--padding", type=int, default=18)
    parser.add_argument("--columns", type=int, default=20)
    parser.add_argument("--max-frame-height", type=int, default=512)
    parser.add_argument("--despill-strength", type=float, default=1.0)
    parser.add_argument("--alpha-threshold", type=int, default=35)
    parser.add_argument("--out-frames", default=str(ROOT / "frames"))
    parser.add_argument("--sprite", default=str(PROJECT_ROOT / "public" / "sprites" / "cat-sprite.webp"))
    parser.add_argument("--metadata", default=str(PROJECT_ROOT / "public" / "sprites" / "cat-sprite.json"))
    args = parser.parse_args()

    if not torch.backends.mps.is_available():
        raise SystemExit("MPS is not available. Use scripts/build_cat_sprite.py for CPU.")

    video_path = Path(args.video)
    if not video_path.exists():
        raise SystemExit(f"Video not found: {video_path}")
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise SystemExit("ffmpeg and ffprobe are required.")

    started = time.perf_counter()
    device = torch.device("mps")
    model = load_model(args.model, device)

    with tempfile.TemporaryDirectory(prefix="cat-sprite-mps-") as temp_name:
        source_frames = extract_frames(video_path, Path(temp_name), args.frames)
        cutouts, avg_infer = infer_cutouts(
            model,
            source_frames,
            Path(args.out_frames),
            args.image_size,
            args.alpha_threshold,
            args.despill_strength,
            device,
        )

    metadata = {
        "source": video_path.name,
        "model": args.model,
        "provider": "mps",
        "imageSize": args.image_size,
        "averageInferenceSeconds": avg_infer,
        "despill": {
            "color": "green",
            "strength": args.despill_strength,
        },
        "alphaCleanup": {
            "threshold": args.alpha_threshold,
            "erode": 0,
            "alphaMatting": False,
        },
    }
    metadata = pack_sprite(
        cutouts,
        Path(args.sprite),
        Path(args.metadata),
        args.padding,
        args.max_frame_height,
        args.columns,
        metadata,
    )

    print(
        "Done. Built {frameCount} frames: {spriteWidth}x{spriteHeight} sprite, "
        "{frameWidth}x{frameHeight} per frame".format(**metadata)
    )
    print(f"Total time: {time.perf_counter() - started:.2f}s")
    print(f"Sprite: {args.sprite}")
    print(f"Metadata: {args.metadata}")


if __name__ == "__main__":
    main()
