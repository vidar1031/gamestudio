#!/usr/bin/env bash
# Fix documentation paths and rebuild

# Update STATUS.md path
sed -i '' -e 's|PROJECT_PATH.*|PROJECT_PATH=/Volumes/ovokit2t/aiwork/talkscene|' memory/STATUS.md

# Note: CONTROL_SYSTEM.md has been merged into docs/系统生产级推进方案.md
# If you need to update status markers, edit docs/系统生产级推进方案.md instead

# Rebuild docs
make docs || ./scripts/compile_docs.sh

# Restart services
./scripts/restart_control.sh
./scripts/restart_server.sh

# Log completion
echo "$(date +%F) Docs fix script completed" >> memory/LOG.md
