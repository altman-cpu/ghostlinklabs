"""MeshForge dev server — stdlib only.

    python -m meshforge.server --port 7600

Serves the forge UI plus on-demand STL/OBJ/manifest generation from the
same Python generator the CLI uses. The browser preview is three.js; the
files you download here are byte-for-byte what ``meshforge export`` writes.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import posixpath
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
WEB = Path(__file__).resolve().parent / "web"
MAX_BODY = 1 << 20


class Handler(BaseHTTPRequestHandler):
    server_version = "MeshForge/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ helpers
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, ctype: str | None = None) -> None:
        try:
            data = path.read_bytes()
        except OSError:
            self._json({"error": "not found", "path": str(path)}, 404)
            return
        ctype = ctype or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if path.suffix in {".js", ".html", ".css"}:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:  # quieter default logging
        sys.stderr.write("[meshforge] %s\n" % (fmt % args))

    # ------------------------------------------------------------- routes
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        route = parsed.path
        qs = parse_qs(parsed.query or "")

        if route in ("/", "/index.html"):
            return self._file(WEB / "index.html")
        if route == "/healthz":
            return self._json({"ok": True, "service": "meshforge", "time": time.time()})
        if route == "/api/families":
            from .fields import list_families
            return self._json({"families": list_families()})
        if route == "/api/forge":
            return self._forge(qs)
        if route in ("/api/export/stl", "/api/export/obj", "/api/export/manifest"):
            return self._export(route.rsplit("/", 1)[-1], qs)

        # static: web/ then the bundled three.js
        rel = posixpath.normpath(route).lstrip("/")
        if ".." in rel.split("/"):
            return self._json({"error": "bad path"}, 400)
        for base in (WEB, ROOT / "meshforge"):
            candidate = (base / rel).resolve()
            try:
                candidate.relative_to(base.resolve())
            except ValueError:
                continue
            if candidate.is_file():
                if candidate.suffix == ".js":
                    return self._file(candidate, "text/javascript; charset=utf-8")
                return self._file(candidate)
        return self._json({"error": "not found", "path": route}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/forge":
            return self._json({"error": "not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json({"error": "bad length"}, 400)
        if length > MAX_BODY:
            return self._json({"error": "body too large"}, 413)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "invalid json"}, 400)
        return self._forge({k: [str(v)] for k, v in payload.items()})

    # ------------------------------------------------------------- forge
    def _params(self, qs: dict):
        from .fields import Params, clamp_params
        p = Params()
        if "prompt" in qs:
            from .prompts import parse_prompt
            p = parse_prompt(qs["prompt"][0])
        casts = {
            "family": (str, "family"), "layers": (int, "layers"), "samples": (int, "samples"),
            "lobes": (int, "lobes"), "twist": (float, "twist"),
            "amplitude": (float, "amplitude"), "differentiation": (float, "differentiation"),
            "bore": (float, "bore"), "diameter": (float, "diameter"),
            "radius": (float, "radius_mm"), "layer_height": (float, "layer_height_mm"),
            "seed": (int, "seed"),
        }
        for key, (cast, attr) in casts.items():
            if key not in qs:
                continue
            try:
                val = cast(qs[key][0])
            except (TypeError, ValueError):
                return None
            if key == "diameter":
                val = val / 2.0
            setattr(p, attr, val)
        return clamp_params(p)

    def _forge(self, qs: dict) -> None:
        started = time.time()
        p = self._params(qs)
        if p is None:
            return self._json({"error": "bad parameter"}, 400)
        light = qs.get("light", ["0"])[0] in ("1", "true", "yes")
        try:
            from .layerstack import forge
            result = forge(p)
        except Exception as exc:  # pragma: no cover - surfaced to the UI
            traceback.print_exc()
            return self._json({"error": str(exc)}, 500)
        body = {
            "params": result.params.to_dict(),
            "stats": result.stats,
            "audit": result.audit,
            "id": result.gid,
            "digest": result.digest,
            "ms": round((time.time() - started) * 1000, 1),
        }
        if light:
            body["layers"] = [
                {"i": r["i"], "z": r["z"], "tag": r["tag"], "digest": r["digest"],
                 "r_mean": r["r_mean"], "r_min": r["r_min"], "r_max": r["r_max"]}
                for r in result.layers
            ]
        else:
            body["layers"] = result.layers
        return self._json(body)

    def _export(self, kind: str, qs: dict) -> None:
        p = self._params(qs)
        if p is None:
            return self._json({"error": "bad parameter"}, 400)
        try:
            from .layerstack import forge
            from .exporters import (
                write_obj, write_manifest, write_stl_binary, stamp_filename,
            )
            result = forge(p)
        except Exception as exc:  # pragma: no cover
            traceback.print_exc()
            return self._json({"error": str(exc)}, 500)

        out = Path(qs.get("out", ["/tmp/meshforge"])[0])
        if kind == "stl":
            path = out / stamp_filename(result, "stl")
            write_stl_binary(result.mesh, path, header=f"MeshForge {result.gid[:8]}")
            ctype = "model/stl"
        elif kind == "obj":
            path = out / stamp_filename(result, "obj")
            write_obj(result.mesh, path)
            ctype = "text/plain"
        else:
            path = out / stamp_filename(result, "json")
            write_manifest(result, path)
            ctype = "application/json"
        return self._file(path, ctype)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="meshforge.server", description="MeshForge forge UI")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7600)
    args = ap.parse_args(argv)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"MeshForge forge up on http://{args.host}:{args.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down", flush=True)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
