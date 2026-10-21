#!/usr/bin/env bash
# 安装：sudo ./install.sh；安全卸载：sudo ./install.sh --restore
set -euo pipefail
SRC="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -I "$SRC/install.py" "$@"
