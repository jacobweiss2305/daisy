"""Always-on Qwen3.8-27B on Modal, OpenAI-compatible, for Daisy.

    modal secret create daisy-llm DAISY_API_KEY=$(openssl rand -hex 24)
    modal deploy serving/qwen38_modal.py

Managed Endpoints (`modal endpoint create`) always scale to zero, so keeping a
container warm needs this app instead.
"""

import subprocess

import modal

MODEL = "Qwen/Qwen3.8-27B-FP8"
SERVED_AS = "qwen3.8-27b"
PORT = 8000
MAX_MODEL_LEN = 131072

# One container stays up permanently. This is the whole point of the file, and
# the whole cost of it: billing runs whether or not anyone is typing. Set to 0
# while validating a change, so a crash loop cannot bill overnight.
MIN_CONTAINERS = 0

app = modal.App("daisy-qwen38")

weights = modal.Volume.from_name("daisy-hf-cache", create_if_missing=True)
compile_cache = modal.Volume.from_name("daisy-vllm-cache", create_if_missing=True)

# The official image already carries CUDA and nvcc. vLLM compiles kernels at
# startup, so a slim base fails with "Could not find nvcc".
image = (
    modal.Image.from_registry("vllm/vllm-openai:v0.27.1")
    .entrypoint([])
    # The image ships python3 but no `python`, which Modal's tooling expects.
    .run_commands("ln -sf $(command -v python3) /usr/local/bin/python")
    .pip_install("hf_transfer")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "VLLM_USE_V1": "1"})
)


@app.function(
    image=image,
    gpu="H100",
    min_containers=MIN_CONTAINERS,
    max_containers=1,
    volumes={
        "/root/.cache/huggingface": weights,
        "/root/.cache/vllm": compile_cache,
    },
    secrets=[modal.Secret.from_name("daisy-llm")],
    timeout=24 * 60 * 60,
    scaledown_window=15 * 60,
)
@modal.concurrent(max_inputs=32)
@modal.web_server(port=PORT, startup_timeout=20 * 60)
def serve() -> None:
    import os

    command = [
        "vllm",
        "serve",
        MODEL,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--served-model-name", SERVED_AS,
        "--tensor-parallel-size", "1",
        "--max-model-len", str(MAX_MODEL_LEN),
        "--kv-cache-dtype", "fp8",
        # Emits reasoning as `reasoning_content`, the channel Daisy renders.
        "--reasoning-parser", "qwen3",
        "--enable-auto-tool-choice",
        "--tool-call-parser", "qwen3_coder",
        "--api-key", os.environ["DAISY_API_KEY"],
    ]

    subprocess.Popen(command)
