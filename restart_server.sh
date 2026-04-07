#!/bin/bash
set -euo pipefail

ROOT="."

cd "${ROOT}"

./stop_server.sh || true
sleep 1
./start_server.sh
