#!/usr/bin/env python3
import argparse
import json
import math
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Encode a PNG into raw ASTC blocks for Unity Texture2D data.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--format", required=True)
    parser.add_argument("--mip-count", type=int, default=1)
    parser.add_argument("--quality", type=float, default=10.0)
    parser.add_argument("--profile", choices=["ldr-srgb", "ldr"], default="ldr-srgb")
    args = parser.parse_args()

    try:
        from PIL import Image
        from astc_encoder import ASTCConfig, ASTCContext, ASTCImage, ASTCProfile, ASTCSwizzle, ASTCType
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"ASTC encoder import failed: {error}"}))
        return 1

    try:
        block_x, block_y = parse_block_size(args.format)
        requested_mips = max(args.mip_count, 1)
        with Image.open(args.input) as opened:
            image = opened.convert("RGBA")

        width, height = image.size
        mip_count = min(requested_mips, max_mip_count(width, height))
        swizzle = ASTCSwizzle.from_str("rgba" if wants_alpha(args.format) else "rgb1")
        profile = ASTCProfile.LDR_SRGB if args.profile == "ldr-srgb" else ASTCProfile.LDR
        config = ASTCConfig(profile, block_x, block_y, 1, quality=args.quality)
        context = ASTCContext(config)

        encoded_mips = []
        current = image
        for mip_index in range(mip_count):
            mip = current.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            mip_bytes = mip.tobytes()
            astc_image = ASTCImage(ASTCType.U8, mip.width, mip.height, data=mip_bytes)
            encoded_mips.append(context.compress(astc_image, swizzle))

            if mip_index + 1 < mip_count:
                next_width = max(current.width // 2, 1)
                next_height = max(current.height // 2, 1)
                current = current.resize((next_width, next_height), Image.Resampling.LANCZOS)

        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"".join(encoded_mips))
        print(json.dumps({
            "ok": True,
            "width": width,
            "height": height,
            "mipCount": mip_count,
            "format": args.format,
            "blockWidth": block_x,
            "blockHeight": block_y,
            "bytes": output.stat().st_size
        }))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


def parse_block_size(format_name):
    normalized = format_name.upper()
    for size in ("4X4", "5X5", "6X6", "8X8", "10X10", "12X12"):
        if normalized.endswith(size):
            block = int(size.split("X")[0])
            return block, block
    raise ValueError(f"Unsupported ASTC format: {format_name}")


def wants_alpha(format_name):
    normalized = format_name.upper()
    return "_RGBA_" in normalized or "_HDR_" in normalized


def max_mip_count(width, height):
    return int(math.floor(math.log2(max(width, height)))) + 1


if __name__ == "__main__":
    sys.exit(main())
