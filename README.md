# GrokBot Codex Control Bridge

Local stdio MCP server that lets Grok Bot launch Codex CLI tasks, resume the same Codex thread, read bounded logs, run project tests, and stop when a ChatGPT usage limit is hit.

The Codex CLI is the only coding agent. Sign in with ChatGPT (`codex login`). An API key is optional and stays inside Codex. This process never deploys or publishes.

This tree is a clean rewrite of the MCP server from [cos-codex-bridge](https://github.com/AV-Labs-Co/cos-codex-bridge) by Aninvieve Labs (AV-Labs-Co). The original MIT license is unchanged. See [NOTICE](NOTICE) for what was reused.

**The real end-to-end session on the Mac Mini has not been run.** CI uses a fake Codex binary. [How to run the Mac test, and the output that counts as success](docs/USAGE.md#real-mac-end-to-end-test).

## Résumé

Pont MCP local entre Grok Bot et le CLI Codex. Un outil lance une tâche dans un worktree Git, un autre reprend le même fil Codex, les journaux restent paginés, et les tests du projet peuvent relancer Codex dans une limite de 3 essais et d'un temps maximum. La connexion prévue est l'abonnement ChatGPT (`codex login`), pas une clé d'API. Si Codex signale un plafond d'usage, le statut devient `rate_limited` et la boucle s'arrête. L'accès en écriture est refusé tant que le dépôt n'est pas dans une liste explicite. Rien n'est publié ni déployé. Les tests automatiques utilisent un faux binaire Codex. L'essai réel sur le Mac reste à faire.

## Tools

| Tool | Purpose |
|---|---|
| `bridge_doctor` | Codex binary, version, auth mode without secrets, Node, roots, limits |
| `bridge_projects` | List or inspect allowlisted repositories |
| `bridge_launch` | Start a task in a new worktree and branch |
| `bridge_resume` | Follow up on the same Codex thread |
| `bridge_redirect` | Interrupt the running turn, then send a new instruction |
| `bridge_status` | One task, or a page of recent tasks |
| `bridge_log` | Redacted events and stderr, by cursor |
| `bridge_cancel` | Stop the Codex process. Does not delete the worktree |
| `bridge_autofix` | Re-run tests and ask Codex to fix failures, within the caps |
| `bridge_test` | Run the configured test command once |
| `bridge_memory` | Read or update local project notes |
| `bridge_report` | Diff stat, commits, tests, attempts, errors |
| `bridge_cleanup` | Remove the task worktree and branch. Requires the approval token |

`bridge_launch` returns as soon as the task is queued. Poll `bridge_status`. A `completed` status means the Codex turn finished and, when tests were enabled, the test command exited 0. It does not mean the change was reviewed.

## Codex interface

The bridge uses `codex exec --json` and `codex exec resume <thread_id>`. That is the documented non-interactive CLI. Details and the flags that are rejected are in [docs/CODEX-DRIVER.md](docs/CODEX-DRIVER.md).

Default sandbox is `read-only`. `workspace-write` works only for a repository inside `writeRoots`. The bridge does not pass `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--full-auto`, or `danger-full-access`.

## Plan limits

Defaults, also enforced as caps the caller cannot raise:

- `maxConcurrentTasks`: 2
- auto-fix `maxAttempts`: 3 per user-initiated run, including the first turn
- auto-fix `maxWallTimeSeconds`: 1200
- per-attempt timeout: 600 seconds

Usage-limit and rate-limit errors become status `rate_limited`. The auto-fix loop does not try again. Wait for the plan window, then call `bridge_resume` if you still want another turn.

## Install

Node.js 22+, a Codex CLI signed in with ChatGPT, and a stdio MCP client. macOS steps, including the Grok Bot config, are in [INSTALLER.md](INSTALLER.md).

```sh
npm ci
npm test
node scripts/install.mjs --root /absolute/parent/of/your/repos
```

Generated MCP entry:

```json
{
  "mcpServers": {
    "grokbot-codex-bridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dist/cli.js", "--config", "/absolute/path/to/config.json", "mcp"],
      "env": {}
    }
  }
}
```

A model-free demo, using the fake Codex binary:

```sh
npm test
npm run demo
```

The demo prints a completed receipt, a thread id, and `codex: "fake"`.

## Walkthrough

Launch, monitor, auto-fix, resume, and the final report are written out with the JSON arguments in [docs/USAGE.md](docs/USAGE.md).

## Security

Allowlists use realpath and reject `/` and the home directory. State lives in `~/.local/share/grokbot-codex-bridge` with mode 0700. Receipts are 0600. Each task gets its own git worktree and `bridge/<id>` branch. Cleanup, and only cleanup, requires `approvalToken` from the private config. There is no push, deploy, or registry publish. The package is marked private and the publish workflow exits 1. See [SECURITY.md](SECURITY.md).

## Tests

`npm test` builds and runs unit plus integration tests on Node 22. They cover launch, log retrieval, session resume, auto-fix of a failing test, attempt caps, rate-limit stop, needs-input stop, cancel, worktree isolation, approval-token cleanup, secret redaction, bridge restart with a live process and with a dead process, and an MCP handshake over stdio. CI runs those tests on Linux and macOS. None of them contact Codex or OpenAI.

## License

MIT. Copyright (c) 2026 Aninvieve Labs, plus fork modifications under the same license. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
