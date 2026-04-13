#!/bin/bash
# 快捷访问 - 实际脚本在 scripts/lifecycle/
exec bash "$(dirname "$0")/scripts/lifecycle/stop_project.sh" "$@"
