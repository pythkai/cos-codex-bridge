# Usage

Build and install first. [INSTALLER.md](../INSTALLER.md) covers the Mac. The commands below assume the bridge is already connected to Grok Bot, or that you call tools with:

```sh
grokbot-codex-bridge --config ~/.local/share/grokbot-codex-bridge/config.json call <tool> --input args.json
```

## 1. Launch

`bridge_launch` creates `bridge/<task-id>` and a git worktree, then queues Codex.

```json
{
  "project": "app",
  "prompt": "Add a unit test for the parser and keep the public API unchanged.",
  "requestId": "parser-test-001",
  "sandbox": "workspace-write",
  "autoFix": true
}
```

The call returns immediately with `taskId` and `status`. Default `sandbox` is `read-only`. `workspace-write` is rejected unless that repository is inside `writeRoots`. `autoFix` defaults to false. When it is true, a failed turn or a failing project test asks Codex to fix the worktree, at most 3 attempts and 1200 seconds unless the config cap is lower.

## 2. Monitor

```json
{ "taskId": "TASK_ID" }
```

Call `bridge_status` until `status` is terminal. Values:

| Status | Meaning |
|---|---|
| `queued` | Waiting for a free slot. Default concurrency is 2. |
| `running` | Codex is executing, or the project tests are running inside the auto-fix loop. |
| `needs_input` | Codex asked for input or an approval. Nothing is answered automatically. |
| `completed` | The turn finished. If tests were enabled, they passed. This is not a review. |
| `failed` | The turn, the tests, or a limit stopped the task. |
| `cancelled` | `bridge_cancel` or `bridge_redirect` interrupted it. |
| `rate_limited` | Codex reported a usage or rate limit. The bridge will not retry. |
| `interrupted` | The bridge restarted and the Codex process was gone. Outcome unknown. No retry. |

`bridge_log` pages the redacted event stream:

```json
{ "taskId": "TASK_ID", "cursor": 0, "limitBytes": 16000 }
```

Pass `nextCursor` back as `cursor` until `done` is true.

## 3. Auto-fix

With `autoFix: true` on launch, the loop is already running. To start it later:

```json
{ "taskId": "TASK_ID", "maxAttempts": 3, "maxWallTimeSeconds": 1200 }
```

`bridge_autofix` runs the configured `testCommand` in the worktree. On failure it resumes the same Codex thread with the failure excerpt. It stops when tests pass, when an attempt cap or the wall clock is reached, or immediately on `rate_limited`, `needs_input`, or cancel. A later manual `bridge_resume` is allowed after a rate limit. `bridge_autofix` is not.

`bridge_test` runs the same command once and does not call Codex.

## 4. Resume

```json
{
  "taskId": "TASK_ID",
  "prompt": "The review found an off-by-one in the last test. Fix only that.",
  "requestId": "parser-test-002"
}
```

`bridge_resume` sends the follow-up to the same `threadId` and worktree. If the task is still running, it returns `BUSY`. Use `bridge_redirect` to interrupt the current turn and then send the new instruction.

## 5. Final report

```json
{ "taskId": "TASK_ID" }
```

`bridge_report` returns the diff stat, changed paths, commits since the task's base commit, every attempt, test excerpts, and the error if there is one. The bridge does not push, open a pull request, or publish.

## Project notes

```json
{ "project": "app", "action": "write", "text": "The parser lives in src/parser.ts. Keep snapshots stable." }
```

Notes are stored under the private state directory. The next launch includes a bounded excerpt in the prompt and labels it as untrusted reference text.

## Cleanup

Removing a worktree is destructive. Set `approvalToken` in the private config, then pass that same token:

```json
{ "taskId": "TASK_ID", "approvalToken": "YOUR_LOCAL_TOKEN", "discardChanges": false }
```

`discardChanges: true` is required when the worktree is dirty or the task branch is unmerged. Cleanup never resets the main checkout and never force-pushes. There is no deploy tool.

## Real Mac end-to-end test

This does not run in CI. It spends ChatGPT plan usage.

```sh
npm ci
npm run build
codex login
codex login status
GROKBOT_E2E=1 npm run e2e:mac -- --root /absolute/parent/of/disposable/repos
```

`--root` must be a directory you are willing to contain one temporary git repository. The script deletes that temporary repository when it finishes. It does not use an existing project.

Success is this exact shape, with your own ids:

```text
E2E_RESULT=pass
auth=chatgpt
task=<uuid>
thread=<codex-thread-id>
resume_thread=<same-codex-thread-id>
file=bridge-ok
status=completed
```

`auth=chatgpt` confirms subscription login. `file=bridge-ok` means `hello-bridge.txt` in the task worktree contained exactly that text. `resume_thread` equals `thread`, so the follow-up stayed on the same Codex thread.

Any other `E2E_RESULT` is not success. `rate_limited` means the plan window blocked the run and the bridge stopped. The real Mac run is still pending until you see `E2E_RESULT=pass` locally.
