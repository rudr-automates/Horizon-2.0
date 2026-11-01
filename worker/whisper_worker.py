#!/usr/bin/env python3
"""Outbound-only Horizon worker for the locally installed whisper.cpp executable."""
from __future__ import annotations

import json
import hashlib
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

MAX_VIDEO_BYTES = 200 * 1024 * 1024
MAX_JSON_BYTES = 9 * 1024 * 1024
STOP = threading.Event()


def env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).expanduser().resolve()


def parse_timestamp(value: str) -> float:
    match = re.fullmatch(r"(\d+):(\d{2}):(\d{2})[,.](\d{3})", value.strip())
    if not match:
        raise ValueError(f"Unsupported Whisper timestamp: {value!r}")
    hours, minutes, seconds, millis = map(int, match.groups())
    if minutes >= 60 or seconds >= 60:
        raise ValueError("Whisper timestamp component outside range")
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def normalize_whisper_json(payload: dict[str, Any], duration: float) -> list[dict[str, Any]]:
    """Normalize whisper.cpp transcription[] output; timestamps stay segment-level."""
    source = payload.get("transcription")
    if not isinstance(source, list) or not source:
        raise ValueError("Whisper JSON has no transcription segments")
    result: list[dict[str, Any]] = []
    previous_end = 0.0
    for item in source:
        if not isinstance(item, dict) or not isinstance(item.get("timestamps"), dict):
            raise ValueError("Whisper segment is missing timestamps")
        times = item["timestamps"]
        start, end = parse_timestamp(str(times.get("from", ""))), parse_timestamp(str(times.get("to", "")))
        text = str(item.get("text", "")).strip()
        if not text or start < previous_end or end <= start or end > duration + 0.25:
            raise ValueError("Whisper segments failed timestamp or text validation")
        result.append({"start": start, "end": end, "text": text})
        previous_end = end
    return result


class SameHostRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_host: str):
        super().__init__()
        self.allowed_host = allowed_host.lower()

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlparse(newurl)
        if target.scheme != "https" or (target.hostname or "").lower() != self.allowed_host:
            raise urllib.error.HTTPError(newurl, code, "Redirect outside Supabase media host rejected", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def request_json(url: str, token: str, data: dict[str, Any], timeout: int = 45) -> dict[str, Any]:
    encoded = json.dumps(data).encode("utf-8")
    if len(encoded) > 3_800_000:
        raise ValueError("Request exceeded the application payload limit")
    req = urllib.request.Request(url, data=encoded, method="POST", headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError("Server response exceeded size limit")
        return json.loads(raw.decode("utf-8"))


def download_video(url: str, destination: Path, supabase_host: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() != supabase_host.lower():
        raise ValueError("Signed media URL is not on the configured Supabase HTTPS host")
    opener = urllib.request.build_opener(SameHostRedirect(supabase_host))
    req = urllib.request.Request(url, headers={"Accept": "video/mp4, video/webm, application/octet-stream"})
    total = 0
    with opener.open(req, timeout=60) as response, destination.open("wb") as out:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_VIDEO_BYTES:
                raise ValueError("Video exceeded the 200 MB download limit")
            out.write(chunk)
    if total == 0:
        raise ValueError("Downloaded video was empty")


def run_command(args: list[str], env: dict[str, str], heartbeat, *, timeout: int) -> tuple[str, str]:
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    start = time.monotonic()
    while True:
        if STOP.is_set():
            process.terminate()
            raise RuntimeError("Worker stopped")
        heartbeat()
        if time.monotonic() - start > timeout:
            process.kill()
            raise TimeoutError(f"Process timed out: {Path(args[0]).name}")
        try:
            stdout, stderr = process.communicate(timeout=5)
            break
        except subprocess.TimeoutExpired:
            continue
    if process.returncode:
        raise RuntimeError(f"{Path(args[0]).name} exited with code {process.returncode}: {stderr[-1200:]}")
    return stdout, stderr


def duration_from_ffmpeg(media: Path, ffmpeg: Path, env: dict[str, str], heartbeat) -> float:
    heartbeat()
    process = subprocess.Popen([str(ffmpeg), "-hide_banner", "-i", str(media)], stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, text=True, env=env)
    try:
        _, stderr = process.communicate(timeout=60)
    except subprocess.TimeoutExpired:
        process.kill()
        raise TimeoutError("FFmpeg media inspection timed out")
    match = re.search(r"Duration:\s*(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)", stderr)
    if not match:
        raise ValueError("FFmpeg could not read a media duration")
    hours, minutes, seconds = match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    if duration <= 0:
        raise ValueError("Video duration is invalid")
    return duration


def worker_main() -> int:
    api = os.environ.get("HORIZON_API_URL", "").rstrip("/")
    token = os.environ.get("WHISPER_WORKER_TOKEN", "")
    supabase_url = os.environ.get("HORIZON_SUPABASE_URL", "")
    worker_id = os.environ.get("WHISPER_WORKER_ID", "windows-rx580")
    cli = env_path("WHISPER_CLI_PATH", r"D:\Asmi\Hackathon\AHGV NSUT Hackathon\warm-page-learning-studio-main\whisper.cpp\build-ucrt64\bin\whisper-cli.exe")
    model = env_path("WHISPER_MODEL_PATH", r"D:\Asmi\Hackathon\AHGV NSUT Hackathon\warm-page-learning-studio-main\whisper.cpp\models\ggml-large-v3-turbo.bin")
    ffmpeg = env_path("FFMPEG_PATH", r"C:\msys64\ucrt64\bin\ffmpeg.exe")
    output = env_path("WHISPER_OUTPUT_DIR", str(Path(__file__).resolve().parents[1] / "whisper.cpp" / "output"))
    runtime = os.environ.get("WHISPER_RUNTIME_PATH", r"C:\msys64\ucrt64\bin")
    interval = max(2, int(os.environ.get("WHISPER_POLL_SECONDS", "10")))
    allow_cpu = os.environ.get("WHISPER_ALLOW_CPU_FALLBACK", "false").strip().lower() == "true"
    if not api.startswith("https://") or not token or not supabase_url.startswith("https://"):
        print("Set HORIZON_API_URL, HORIZON_SUPABASE_URL and WHISPER_WORKER_TOKEN in worker/.env", file=sys.stderr)
        return 2
    for path, label in ((cli, "Whisper executable"), (model, "Whisper model"), (ffmpeg, "FFmpeg")):
        if not path.is_file():
            print(f"{label} not found: {path}", file=sys.stderr)
            return 2
    if model.stat().st_size < 100_000_000:
        print("The configured model file is unexpectedly small", file=sys.stderr)
        return 2
    expected_sha1 = os.environ.get("WHISPER_MODEL_SHA1", "4AF2B29D7EC73D781377BFD1758CA957A807E941").strip().upper()
    digest = hashlib.sha1(usedforsecurity=False)
    with model.open("rb") as model_file:
        for block in iter(lambda: model_file.read(8 * 1024 * 1024), b""):
            digest.update(block)
    if expected_sha1 and digest.hexdigest().upper() != expected_sha1:
        print("Configured Whisper model SHA-1 does not match WHISPER_MODEL_SHA1", file=sys.stderr)
        return 2
    output.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PATH"] = os.pathsep.join((str(cli.parent), runtime, env.get("PATH", "")))
    try:
        run_command([str(cli), "--help"], env, lambda: None, timeout=20)
    except (OSError, RuntimeError, TimeoutError) as exc:
        print(f"Whisper executable could not initialize with configured Windows runtime: {exc}", file=sys.stderr)
        return 2
    supabase_host = urllib.parse.urlparse(supabase_url).hostname or ""
    print(f"Horizon worker {worker_id}; one job at a time; Whisper CLI={cli}; model={model}; FFmpeg={ffmpeg}")
    print("GPU policy: Vulkan required" + ("; explicit CPU fallback enabled" if allow_cpu else "; CPU fallback disabled"))

    def handle_stop(_signum, _frame):
        STOP.set()
    signal.signal(signal.SIGINT, handle_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_stop)

    while not STOP.is_set():
        try:
            request_json(f"{api}/api/whisper/worker/heartbeat", token,
                         {"workerId": worker_id, "state": "idle"}, timeout=20)
            claim = request_json(f"{api}/api/whisper/worker/claim", token, {"workerId": worker_id})
            job = claim.get("job")
            if not job:
                STOP.wait(interval)
                continue
            process_job(api, token, worker_id, job, cli, model, ffmpeg, output, env, supabase_host, allow_cpu)
        except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError, OSError) as exc:
            print(f"Worker poll/job error: {str(exc)[:400]}", file=sys.stderr)
            STOP.wait(interval)
    print("Worker stopped")
    return 0


def process_job(api: str, token: str, worker_id: str, job: dict[str, Any], cli: Path, model: Path,
                ffmpeg: Path, output: Path, base_env: dict[str, str], supabase_host: str, allow_cpu: bool) -> None:
    job_id, lease = str(job["id"]), str(job["leaseToken"])
    api_base = f"{api}/api/whisper/worker/jobs/{urllib.parse.quote(job_id)}"
    stage = ["downloading"]
    heartbeat_stop = threading.Event()

    def beat() -> None:
        try:
            request_json(f"{api}/api/whisper/worker/heartbeat", token,
                         {"workerId": worker_id, "state": stage[0]}, timeout=20)
            request_json(api_base, token, {"action": "heartbeat", "leaseToken": lease, "stage": stage[0]}, timeout=20)
        except Exception as exc:
            print(f"Heartbeat issue for job {job_id}: {type(exc).__name__}", file=sys.stderr)

    def heartbeat_loop() -> None:
        while not heartbeat_stop.wait(35):
            beat()
    hb = threading.Thread(target=heartbeat_loop, daemon=True)
    hb.start()
    prefix = output / f"job-{job_id}"
    try:
        with tempfile.TemporaryDirectory(prefix="horizon-whisper-") as temp_name:
            temp = Path(temp_name)
            media = temp / ("source.webm" if str(job["downloadUrl"]).lower().split("?", 1)[0].endswith(".webm") else "source.mp4")
            wav = temp / "audio.wav"
            download_video(str(job["downloadUrl"]), media, supabase_host)
            stage[0] = "extracting_audio"
            duration = duration_from_ffmpeg(media, ffmpeg, base_env, beat)
            run_command([str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error", "-i", str(media),
                         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)], base_env, beat, timeout=1800)
            stage[0] = "transcribing"
            base_name = str(prefix)
            out_json = Path(base_name + ".json")
            stdout, stderr = run_command([str(cli), "-m", str(model), "-f", str(wav), "-oj", "-of", base_name,
                                          "--language", "auto"], base_env, beat, timeout=duration * 8 + 900)
            logs = (stdout + "\n" + stderr)
            vulkan = bool(re.search(r"using\s+Vulkan\d+\s+backend", logs, re.I))
            cpu = bool(re.search(r"using\s+CPU\s+backend", logs, re.I))
            if not vulkan and not (allow_cpu and cpu):
                raise RuntimeError("GPU backend could not be confirmed in Whisper logs; CPU fallback is disabled")
            if not out_json.is_file():
                raise RuntimeError("Whisper did not write its JSON transcript output")
            result = json.loads(out_json.read_text(encoding="utf-8-sig"))
            stage[0] = "normalizing"
            segments = normalize_whisper_json(result, duration)
            metadata = result.get("result") if isinstance(result.get("result"), dict) else {}
            stage[0] = "indexing"
            request_json(api_base, token, {
                "action": "result", "leaseToken": lease, "durationSeconds": duration,
                "segments": segments, "model": "ggml-large-v3-turbo", "language": metadata.get("language"),
                "backend": "vulkan" if vulkan else ("cpu" if cpu else "unknown"), "workerId": worker_id,
            }, timeout=120)
            print(f"Job {job_id}: {len(segments)} timestamped segments; backend={'Vulkan' if vulkan else 'CPU'}; output={out_json}")
    except Exception as exc:
        message = re.sub(r"https?://\S+", "[redacted-url]", str(exc).replace(token, "[redacted]"))[:300]
        print(f"Job {job_id} failed at {stage[0]}: {message}", file=sys.stderr)
        try:
            request_json(api_base, token, {"action": "failed", "leaseToken": lease,
                         "code": re.sub(r"[^a-zA-Z0-9_]+", "_", type(exc).__name__).lower(), "message": message}, timeout=30)
        except Exception:
            print(f"Could not report failure for {job_id}; lease will expire and be retried", file=sys.stderr)
    finally:
        heartbeat_stop.set()
        hb.join(timeout=2)


if __name__ == "__main__":
    raise SystemExit(worker_main())
