#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path


def main():
    total_started = time.perf_counter()
    timings = []
    parser = argparse.ArgumentParser(description="Patch Unity AssetBundle assets for BD-SpineX mods.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mod-name")
    parser.add_argument("--atlas", action="append", default=[])
    parser.add_argument("--skel", action="append", default=[])
    parser.add_argument("--png", action="append", default=[])
    parser.add_argument("--insert-png", action="append", default=[])
    parser.add_argument("--unity-version", default="2021.3.33f1")
    parser.add_argument("--decrypt-key")
    parser.add_argument("--asset-backup-dir")
    parser.add_argument("--job-manifest")
    args = parser.parse_args()

    try:
        import UnityPy
        import UnityPy.config
    except Exception as error:
        add_timing(timings, "total", total_started)
        print(json.dumps({"ok": False, "error": f"UnityPy import failed: {error}", "timings": timings, "elapsedMs": elapsed_ms(total_started)}))
        return 1

    try:
        setup_started = time.perf_counter()
        UnityPy.config.FALLBACK_UNITY_VERSION = args.unity_version
        if args.decrypt_key:
            UnityPy.set_assetbundle_decrypt_key(args.decrypt_key)

        replacements = build_replacements(args)
        validate_replacements(replacements)
        add_timing(timings, "prepare_replacements", setup_started)

        load_started = time.perf_counter()
        env = UnityPy.load(args.input)
        add_timing(timings, "load_bundle", load_started)

        patch_started = time.perf_counter()
        changed = []

        for obj in env.objects:
            type_name = getattr(obj.type, "name", str(obj.type))
            if type_name not in ("TextAsset", "Texture2D"):
                continue

            data = obj.read()
            name = (getattr(data, "name", None) or getattr(data, "m_Name", None) or "").lower()

            if type_name == "TextAsset" and name in replacements["text"]:
                replacement = replacements["text"][name]
                backup_path = backup_textasset(replacement.get("assetBackupDir"), data, name, replacement)
                data.m_Script = read_textasset_payload(replacement["path"])
                data.save()
                changed.append({
                    "type": type_name,
                    "name": getattr(data, "m_Name", name),
                    "action": replacement["action"],
                    "modName": replacement.get("modName"),
                    "source": replacement["path"],
                    "assetBackup": backup_path
                })

            if type_name == "Texture2D" and name in replacements["texture"]:
                replacement = replacements["texture"][name]
                backup_path = backup_texture(replacement.get("assetBackupDir"), data, name, replacement)
                data.set_image(replacement["path"])
                data.save()
                changed.append({
                    "type": type_name,
                    "name": getattr(data, "m_Name", name),
                    "action": "replace_texture",
                    "modName": replacement.get("modName"),
                    "source": replacement["path"],
                    "assetBackup": backup_path
                })

        missing = find_missing(replacements, changed)
        add_timing(timings, "patch_assets", patch_started)
        if missing:
            add_timing(timings, "total", total_started)
            print(json.dumps({"ok": False, "changed": changed, "missing": missing, "error": "Target asset(s) not found.", "timings": timings, "elapsedMs": elapsed_ms(total_started)}, ensure_ascii=False))
            return 1

        write_started = time.perf_counter()
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
        add_timing(timings, "write_bundle", write_started)
        add_timing(timings, "total", total_started)

        print(json.dumps({"ok": True, "changed": changed, "output": str(output), "timings": timings, "elapsedMs": elapsed_ms(total_started)}, ensure_ascii=False))
        return 0
    except Exception as error:
        add_timing(timings, "total", total_started)
        print(json.dumps({"ok": False, "error": str(error), "timings": timings, "elapsedMs": elapsed_ms(total_started)}, ensure_ascii=False))
        return 1


def elapsed_ms(started):
    return int((time.perf_counter() - started) * 1000)


def add_timing(timings, name, started):
    timings.append({"name": name, "ms": elapsed_ms(started)})


def build_replacements(args):
    text = {}
    texture = {}

    if args.job_manifest:
        manifest = json.loads(Path(args.job_manifest).read_text(encoding="utf-8"))
        for job in manifest.get("jobs", []):
            add_job_replacements(
                text,
                texture,
                job.get("modName"),
                job.get("assetBackupDir"),
                job.get("atlases", []),
                job.get("skels", []),
                job.get("pngs", []),
                job.get("insertPngs", [])
            )
        return {"text": text, "texture": texture}

    if not args.mod_name:
        raise ValueError("--mod-name is required when --job-manifest is not used.")

    add_job_replacements(text, texture, args.mod_name, args.asset_backup_dir, args.atlas, args.skel, args.png, args.insert_png)

    return {"text": text, "texture": texture}


def add_job_replacements(text, texture, mod_name, asset_backup_dir, atlases, skels, pngs, insert_pngs=None):
    for atlas in atlases:
        add_replacement(text, Path(atlas).name.lower(), atlas, "replace_atlas", mod_name, asset_backup_dir)

    for skel in skels:
        add_replacement(text, Path(skel).name.lower(), skel, "replace_skel", mod_name, asset_backup_dir)

    for png in pngs:
        add_replacement(texture, Path(png).stem.lower(), png, "replace_texture", mod_name, asset_backup_dir)

    if insert_pngs:
        raise ValueError("Texture2D insertion requires the UABEA patch backend.")


def add_replacement(group, key, file_path, action, mod_name, asset_backup_dir):
    if key in group:
        raise ValueError(f"Duplicate replacement target in one batch: {key}")

    group[key] = {
        "path": file_path,
        "action": action,
        "modName": mod_name,
        "assetBackupDir": asset_backup_dir
    }


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
