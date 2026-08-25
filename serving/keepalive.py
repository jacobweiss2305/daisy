"""Keeps the managed Qwen3.8 Endpoint warm so Daisy never waits on a cold start.

Managed Endpoints always scale to zero and expose no warm-container setting, so
the only way to hold one up is to keep asking it for something.

    modal deploy serving/keepalive.py
    modal app stop -y daisy-keepalive     # to stop paying for an idle GPU
"""

import os
import urllib.request

import modal

ENDPOINT = "https://silvia--ep-qwen3-8-27b-server.us-west.modal.direct/v1/models"
EVERY_SECONDS = 60

app = modal.App("daisy-keepalive")

image = modal.Image.debian_slim(python_version="3.12")


@app.function(
    image=image,
    schedule=modal.Period(seconds=EVERY_SECONDS),
    secrets=[modal.Secret.from_name("daisy-proxy")],
    timeout=120,
)
def ping() -> None:
    request = urllib.request.Request(
        ENDPOINT,
        headers={"Authorization": f"Bearer {os.environ['MODAL_PROXY_TOKEN']}"},
    )

    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            print(f"warm: {response.status}")
    except Exception as error:
        # A 503 is the endpoint still starting. The request itself is what
        # brings it up, so a failure here is progress, not a problem.
        print(f"starting: {error}")
