#!/usr/bin/env python3
"""非互動 frida runner：連到 gadget、載入指定 JS、印出 console 訊息、N 秒後離開。

用法：
    .venv-tools/bin/python probes/run_probe.py probes/bd2_resolve_check.js [seconds]
"""
import sys, time, frida

script_path = sys.argv[1]
duration = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0

dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
session = dev.attach("Gadget")

with open(script_path, "r", encoding="utf-8") as f:
    src = f.read()

script = session.create_script(src)

def on_message(msg, data):
    if msg["type"] == "send":
        print(msg["payload"])
    elif msg["type"] == "error":
        print("[JS ERROR]", msg.get("stack") or msg.get("description"))

script.on("message", on_message)
script.load()
time.sleep(duration)
session.detach()
