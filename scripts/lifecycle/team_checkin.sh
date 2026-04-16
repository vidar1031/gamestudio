#!/bin/bash
set -euo pipefail

ROOT="/Volumes/ovokit2t/aiwork/gamestudio"
cd "$ROOT"

node scripts/lifecycle/team_checkin.js
