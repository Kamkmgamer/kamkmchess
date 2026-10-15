"""Temporary MCP transport for this wayfinder effort; credentials stay in mcp-remote's store."""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading

sys.stdout.reconfigure(encoding="utf-8")

def unpack(result):
    content = result.get("content", [])
    texts = [item["text"] for item in content if item.get("type") == "text"]
    if len(texts) == 1:
        try:
            return json.loads(texts[0])
        except (ValueError, TypeError):
            return texts[0]
    return result.get("structuredContent", result)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("calls")
    parser.add_argument("output")
    args = parser.parse_args()
    calls = json.loads(Path(args.calls).read_text(encoding="utf-8-sig"))
    output = Path(args.output)
    node = shutil.which("node")
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if not node or not npx:
        raise RuntimeError("Node and npx are required")
    npx_cli = Path(npx).parent / "node_modules" / "npm" / "bin" / "npx-cli.js"
    if not npx_cli.is_file():
        raise RuntimeError("Cannot locate the installed npx CLI")
    incoming = queue.Queue()
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as errors:
        proc = subprocess.Popen(
            [node, str(npx_cli), "--yes", "mcp-remote", "https://mcp.linear.app/mcp"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
            text=True, encoding="utf-8", bufsize=1,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        def reader():
            for line in proc.stdout:
                try:
                    incoming.put(json.loads(line))
                except ValueError:
                    pass
            incoming.put(None)
        threading.Thread(target=reader, daemon=True).start()
        serial = 0
        def send(payload):
            proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            proc.stdin.flush()
        def request(method, params):
            nonlocal serial
            serial += 1
            request_id = serial
            send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            while True:
                message = incoming.get(timeout=90)
                if message is None:
                    raise RuntimeError("MCP transport closed before responding")
                if message.get("method") and "id" in message:
                    if message["method"] == "roots/list":
                        send({"jsonrpc": "2.0", "id": message["id"], "result": {"roots": []}})
                    elif message["method"] == "ping":
                        send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
                    else:
                        send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "Unsupported client method"}})
                    continue
                if message.get("id") != request_id:
                    continue
                if "error" in message:
                    raise RuntimeError(json.dumps(message["error"]))
                return message["result"]
        results = []
        try:
            request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                  "clientInfo": {"name": "kamkmchess-wayfinder", "version": "1.0"}})
            send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            for call in calls:
                result = request("tools/call", {"name": call["name"], "arguments": call.get("arguments", {})})
                entry = {"key": call.get("key"), "name": call["name"], "isError": result.get("isError", False),
                         "data": unpack(result), "raw": result}
                results.append(entry)
                output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
                data = entry["data"]
                summary = {"key": entry["key"], "tool": call["name"], "isError": entry["isError"]}
                if isinstance(data, dict):
                    summary.update({key: data[key] for key in ("id", "title", "url", "name", "status") if key in data})
                    summary["resultKeys"] = list(data)
                print(json.dumps(summary, ensure_ascii=False), flush=True)
                if entry["isError"]:
                    raise RuntimeError("MCP tool returned an error; inspect the saved result before retrying")
        finally:
            try:
                proc.stdin.close()
                proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    proc.terminate()
                proc.wait(timeout=5)

if __name__ == "__main__":
    main()

