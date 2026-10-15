# Changelog

## 0.3.0

Clean rewrite of the MCP server as a Codex-only GrokBot control bridge.

- Drive Codex with `codex exec --json` and `codex exec resume`.
- One git worktree and `bridge/<id>` branch per task.
- Durable receipts, paginated logs, project notes, and a final report.
- Auto-fix stops at 3 attempts and a wall-time cap, and stops immediately on a usage limit.
- Restart recovery leaves a live process detached and marks a dead one `interrupted`.
- npm and registry publishing are disabled.

Earlier upstream history remains in git. See NOTICE.
