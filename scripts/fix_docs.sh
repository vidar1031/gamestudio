#!/usr/bin/env bash
# Fix documentation paths and rebuild

# Update STATUS.md path
sed -i '' -e 's|PROJECT_PATH.*|PROJECT_PATH=/Volumes/ovokit2t/aiwork/gamestudio|' memory/STATUS.md

# Update CONTROL_SYSTEM.md
sed -i '' -e 's|暂未实现|已实现|' docs/CONTROL_SYSTEM.md

# Rebuild docs
make docs || ./scripts/compile_docs.sh

# Restart services
./scripts/restart_control.sh
./scripts/restart_server.sh

# Log completion
echo "$(date +%F) Docs fix script completed" >> memory/LOG.md
