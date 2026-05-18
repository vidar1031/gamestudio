# Project Analysis Rules

Never analyze the entire project at once.

Only inspect files directly related to the task.

Prefer incremental analysis.

Maximum:
- 10 files per step
- 2 directory levels deep

Avoid recursive exploration.

Always:
1. Identify entry point
2. Identify dependencies
3. Trace minimal call chain

Do not refactor unrelated code.

Keep responses concise.