#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Patch Unity AssetBundle assets for BD2 Spine mods.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mod-name", required=True)
    parser.add_argument("--atlas", action="append", default=[])
    parser.add_argument("--skel", action="append", default=[])
    parser.add_argument("--png", action="append", default=[])
    parser.add_argument("--unity-version", default="2021.3.33f1")
    parser.add_argument("--decrypt-key")
    parser.add_argument("--asset-backup-dir")
    args = parser.parse_args()

    try:
        import UnityPy
        import UnityPy.config
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"UnityPy import failed: {error}"}))
        return 1

    try:
        UnityPy.config.FALLBACK_UNITY_VERSION = args.unity_version
        if args.decrypt_key:
            UnityPy.set_assetbundle_decrypt_key(args.decrypt_key)

        replacements = build_replacements(args)
        validate_replacements(replacements)

        env = UnityPy.load(args.input)
        changed = []

        for obj in env.objects:
            type_name = getattr(obj.type, "name", str(obj.type))
            if type_name not in ("TextAsset", "Texture2D"):
                continue

            data = obj.read()
            name = (getattr(data, "name", None) or getattr(data, "m_Name", None) or "").lower()

            if type_name == "TextAsset" and name in replacements["text"]:
                replacement = replacements["text"][name]
                backup_path = backup_textasset(args.asset_backup_dir, data, name, replacement)
                data.m_Script = read_textasset_payload(replacement["path"])
                data.save()
                changed.append({
                    "type": type_name,
                    "name": getattr(data, "m_Name", name),
                    "action": replacement["action"],
                    "source": replacement["path"],
                    "assetBackup": backup_path
                })

            if type_name == "Texture2D" and name in replacements["texture"]:
                replacement = replacements["texture"][name]
                backup_path = backup_texture(args.asset_backup_dir, data, name, replacement)
                data.set_image(replacement["path"])
                data.save()
                changed.append({
                    "type": type_name,
                    "name": getattr(data, "m_Name", name),
                    "action": "replace_texture",
                    "source": replacement["path"],
                    "assetBackup": backup_path
                })

        missing = find_missing(replacements, changed)
        if missing:
            print(json.dumps({"ok": False, "changed": changed, "missing": missing, "error": "Target asset(s) not found."}, ensure_ascii=False))
            return 1

        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmpdir:
            env.save(out_path=tmpdir)
            saved = Path(tmpdir) / Path(args.input).name
            if not saved.exists():
                saved_files = list(Path(tmpdir).iterdir())
                if len(saved_files) != 1:
                    print(json.dumps({"ok": False, "error": "UnityPy did not produce a single patched bundle."}, ensure_ascii=False))
                    return 1
                saved = saved_files[0]
            shutil.copyfile(saved, output)

        print(json.dumps({"ok": True, "changed": changed, "output": str(output)}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


def build_replacements(args):
    text = {}
    texture = {}

    for atlas in args.atlas:
        text[Path(atlas).name.lower()] = {
            "path": atlas,
            "action": "replace_atlas"
        }

    for skel in args.skel:
        text[Path(skel).name.lower()] = {
            "path": skel,
            "action": "replace_skel"
        }

    for png in args.png:
        texture[Path(png).stem.lower()] = {
            "path": png,
            "action": "replace_texture"
        }

    return {"text": text, "texture": texture}


def validate_replacements(replacements):
    for group in replacements.values():
        for replacement in group.values():
            if not os.path.isfile(replacement["path"]):
                raise FileNotFoundError(replacement["path"])


def read_textasset_payload(file_path):
    payload = Path(file_path).read_bytes()
    return payload.decode("utf-8", "surrogateescape")


def backup_textasset(backup_dir, data, name, replacement):
    if not backup_dir:
        return None

    backup_path = Path(backup_dir) / replacement_backup_name(name, replacement)
    if backup_path.exists():
        return str(backup_path)

    backup_path.parent.mkdir(parents=True, exist_ok=True)
    payload = getattr(data, "m_Script", "")
    if isinstance(payload, bytes):
        backup_path.write_bytes(payload)
    else:
        backup_path.write_bytes(str(payload).encode("utf-8", "surrogateescape"))
    return str(backup_path)


def backup_texture(backup_dir, data, name, replacement):
    if not backup_dir:
        return None

    backup_path = Path(backup_dir) / replacement_backup_name(name, replacement)
    if backup_path.exists():
        return str(backup_path)

    backup_path.parent.mkdir(parents=True, exist_ok=True)
    data.image.save(backup_path)
    return str(backup_path)


def replacement_backup_name(name, replacement):
    source_suffix = Path(replacement["path"]).suffix
    if source_suffix:
        if source_suffix.lower() == ".png":
            return f"{name}.png"
        return Path(replacement["path"]).name
    return name


def find_missing(replacements, changed):
    changed_keys = {
        (item["type"], item["name"].lower())
        for item in changed
    }
    missing = []

    for name, replacement in replacements["text"].items():
        if ("TextAsset", name) not in changed_keys:
            missing.append({"type": "TextAsset", "name": name, "source": replacement["path"]})

    for name, replacement in replacements["texture"].items():
        if ("Texture2D", name) not in changed_keys:
            missing.append({"type": "Texture2D", "name": name, "source": replacement["path"]})

    return missing


if __name__ == "__main__":
    sys.exit(main())
