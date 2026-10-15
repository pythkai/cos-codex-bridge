# Codex driver

The bridge drives the official Codex CLI through **`codex exec`**, not the app server.

## Why `codex exec`

OpenAI documents `codex exec` as the non-interactive interface for scripts. With `--json` it prints newline-delimited events (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`). The first `thread.started` event carries `thread_id`. A later turn uses:

```text
codex -a never exec --json --color never --sandbox <mode> -C <worktree> -o <file> resume <thread_id> -
```

The prompt is written to stdin. It is not placed in argv, so it does not appear in the process list.

`codex app-server` can also start and resume threads, but the current CLI reference describes it as a development interface that may change without notice. `codex exec` is the stable scripted surface, and a thread id from it is enough to resume the same session. That is the whole session model this bridge needs.

## What the bridge refuses to pass

The argument builder rejects all of these:

- `--dangerously-bypass-approvals-and-sandbox` and `--yolo`
- `--full-auto` (it can override an explicit read-only sandbox)
- `danger-full-access`
- `--ignore-rules`
- `--ephemeral` (a resumed thread has to persist)

`--ask-for-approval never` is placed before `exec` because older CLIs treat it as a global flag. It does **not** turn the sandbox off. In a stdio bridge there is nobody to answer an interactive approval, so a command that would need a wider grant fails the turn instead of escalating. The sandbox is always explicit: `read-only` unless the caller asks for `workspace-write` and the project directory is inside a configured write root.

Codex keeps its own login. The primary path is `codex login` → Sign in with ChatGPT. `OPENAI_API_KEY` remains an optional Codex feature and is never read, stored, or printed by the bridge.

## Output capture

Codex stdout and stderr are files under the private state directory, not pipes. A pipe would often kill Codex with `SIGPIPE` when this process restarts. File capture lets a live process stay in its own session, and `bridge_log` still has the bytes. Returned logs are redacted. Raw capture files are rewritten redacted after the process exits.
