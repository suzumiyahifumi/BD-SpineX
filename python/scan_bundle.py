#!/usr/bin/env python3
import argparse
import json
import re
import sys


CANDIDATE_PATTERN = re.compile(r"(?:cutscene_char\d+|char\d+|illust_dating[\w\d_]*)", re.IGNORECASE)


def main():
    parser = argparse.ArgumentParser(description="Scan candidate Spine assets from a Unity AssetBundle.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--unity-version", default="2021.3.33f1")
    parser.add_argument("--decrypt-key")
    args = parser.parse_args()

    try:
        import UnityPy
        import UnityPy.config
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"UnityPy import failed: {error}"}))
        return 0

    try:
        UnityPy.config.FALLBACK_UNITY_VERSION = args.unity_version
        if args.decrypt_key:
            UnityPy.set_assetbundle_decrypt_key(args.decrypt_key)

        env = UnityPy.load(args.input)
        assets = []
        skipped = 0

        for obj in env.objects:
            type_name = getattr(obj.type, "name", str(obj.type))
            if type_name not in ("TextAsset", "Texture2D"):
                continue

            try:
                data = obj.read()
            except Exception:
                skipped += 1
                continue

            name = getattr(data, "name", None) or getattr(data, "m_Name", None) or ""
            if not CANDIDATE_PATTERN.search(name):
                continue

            asset = {
                "name": name,
                "type": type_name,
                "pathId": int(getattr(obj, "path_id", 0)),
            }

            if type_name == "Texture2D":
                width = getattr(data, "m_Width", None) or getattr(data, "width", None)
                height = getattr(data, "m_Height", None) or getattr(data, "height", None)
                if width:
                    asset["width"] = int(width)
                if height:
                    asset["height"] = int(height)

            assets.append(asset)

        assets.sort(key=lambda asset: (asset["name"].lower(), asset["type"]))
        print(json.dumps({"ok": True, "assets": assets, "skipped": skipped}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    sys.exit(main())
