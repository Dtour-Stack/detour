#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "google-genai>=1.0.0",
#     "pillow>=10.0.0",
# ]
# ///
"""
Generate images using Google's Nano Banana Pro (Gemini 3 Pro Image) API.

Usage:
    uv run generate_image.py --prompt "your image description" --filename "output.png" [--resolution 1K|2K|4K] [--api-key KEY]

Multi-image editing (up to 14 images):
    uv run generate_image.py --prompt "combine these images" --filename "output.png" -i img1.png -i img2.png -i img3.png
"""

import argparse
import os
import sys
from pathlib import Path


def get_api_key(provided_key: str | None) -> str | None:
    """Get API key from argument first, then environment."""
    if provided_key:
        return provided_key
    return os.environ.get("GEMINI_API_KEY")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate images using Nano Banana Pro (Gemini 3 Pro Image)"
    )
    parser.add_argument(
        "--prompt", "-p",
        required=True,
        help="Image description/prompt"
    )
    parser.add_argument(
        "--filename", "-f",
        required=True,
        help="Output filename (e.g., sunset-mountains.png)"
    )
    parser.add_argument(
        "--input-image", "-i",
        action="append",
        dest="input_images",
        metavar="IMAGE",
        help="Input image path(s) for editing/composition. Can be specified multiple times (up to 14 images)."
    )
    parser.add_argument(
        "--resolution", "-r",
        choices=["1K", "2K", "4K"],
        default="1K",
        help="Output resolution: 1K (default), 2K, or 4K"
    )
    parser.add_argument(
        "--api-key", "-k",
        help="Gemini API key (overrides GEMINI_API_KEY env var)"
    )

    return parser.parse_args()


def require_api_key(provided_key: str | None) -> str:
    api_key = get_api_key(provided_key)
    if not api_key:
        print("Error: No API key provided.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print("  1. Provide --api-key argument", file=sys.stderr)
        print("  2. Set GEMINI_API_KEY environment variable", file=sys.stderr)
        sys.exit(1)
    return api_key


def load_input_images(paths, image_cls):
    if not paths:
        return [], 0
    if len(paths) > 14:
        print(f"Error: Too many input images ({len(paths)}). Maximum is 14.", file=sys.stderr)
        sys.exit(1)
    input_images = []
    max_input_dim = 0
    for img_path in paths:
        try:
            img = image_cls.open(img_path)
            input_images.append(img)
            print(f"Loaded input image: {img_path}")
            width, height = img.size
            max_input_dim = max(max_input_dim, width, height)
        except Exception as e:
            print(f"Error loading input image '{img_path}': {e}", file=sys.stderr)
            sys.exit(1)
    return input_images, max_input_dim


def output_resolution(requested: str, max_input_dim: int) -> str:
    if requested != "1K" or max_input_dim <= 0:
        return requested
    if max_input_dim >= 3000:
        return "4K"
    if max_input_dim >= 1500:
        return "2K"
    return "1K"


def build_contents(input_images, prompt: str, resolution: str):
    if input_images:
        contents = [*input_images, prompt]
        img_count = len(input_images)
        print(f"Processing {img_count} image{'s' if img_count > 1 else ''} with resolution {resolution}...")
        return contents
    print(f"Generating image with resolution {resolution}...")
    return prompt


def save_image_part(part, output_path: Path, image_cls) -> bool:
    if part.text is not None:
        print(f"Model response: {part.text}")
        return False
    if part.inline_data is None:
        return False
    from io import BytesIO

    image_data = part.inline_data.data
    if isinstance(image_data, str):
        import base64
        image_data = base64.b64decode(image_data)
    image = image_cls.open(BytesIO(image_data))
    if image.mode == 'RGBA':
        rgb_image = image_cls.new('RGB', image.size, (255, 255, 255))
        rgb_image.paste(image, mask=image.split()[3])
        rgb_image.save(str(output_path), 'PNG')
    elif image.mode == 'RGB':
        image.save(str(output_path), 'PNG')
    else:
        image.convert('RGB').save(str(output_path), 'PNG')
    return True


def save_response_image(response, output_path: Path, image_cls) -> None:
    image_saved = False
    for part in response.parts:
        image_saved = save_image_part(part, output_path, image_cls) or image_saved
    if image_saved:
        full_path = output_path.resolve()
        print(f"\nImage saved: {full_path}")
        print(f"MEDIA: {full_path}")
        return
    print("Error: No image was generated in the response.", file=sys.stderr)
    sys.exit(1)


def main():
    args = parse_args()
    api_key = require_api_key(args.api_key)
    from google import genai
    from google.genai import types
    from PIL import Image as PILImage

    client = genai.Client(api_key=api_key)
    output_path = Path(args.filename)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    input_images, max_input_dim = load_input_images(args.input_images, PILImage)
    resolution = output_resolution(args.resolution, max_input_dim)
    if resolution != args.resolution:
        print(f"Auto-detected resolution: {resolution} (from max input dimension {max_input_dim})")
    contents = build_contents(input_images, args.prompt, resolution)
    try:
        response = client.models.generate_content(
            model="gemini-3-pro-image-preview",
            contents=contents,
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                image_config=types.ImageConfig(
                    image_size=resolution
                )
            )
        )
        save_response_image(response, output_path, PILImage)
    except Exception as e:
        print(f"Error generating image: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
