# Security

This is a local stdio process for one owner. Do not expose it on the network.

## Boundaries

- No root is allowed until it is listed in the config. Paths are realpath'd. `/` and the home directory are rejected. State and the config file must sit outside the allowlist.
- Default sandbox is `read-only`. `workspace-write` is accepted only when the repository is inside `writeRoots`. The bridge never passes a Codex flag that bypasses the sandbox or approval system.
- `--ask-for-approval never` means a non-interactive turn cannot widen permissions. If Codex needs a grant outside the selected sandbox, the turn fails. The bridge has no tool that approves a permission prompt.
- Each task runs in its own git worktree and `bridge/<id>` branch, created under the private state directory. Tasks do not share a working tree.
- `bridge_cleanup` is the only destructive git operation. It requires the `approvalToken` from the private config, compared without printing it. It deletes only that task's worktree and `bridge/<id>` branch. It does not reset the main checkout, force-push, or publish.
- There is no deploy or publish tool. `package.json` is private. The GitHub publish workflow always fails.
- Prompts go to Codex on stdin. Logs returned to the client are redacted for common token shapes and for the approval token. Do not treat the state directory as encrypted storage. Prompts and model output are plaintext, mode 0600.
- `completed` means the turn and any configured test command finished. It is not an independent review.
- A bridge restart does not invent a result. A live Codex process is marked detached and is not given another prompt. A dead process without a terminal event in the log is `interrupted`. A usage limit found in the log is `rate_limited`. None of those states start a new attempt by themselves.

## Authentication

Codex keeps the ChatGPT subscription login created by `codex login`. The bridge runs `codex login status` for the doctor report and keeps only a short redacted line plus a mode of `chatgpt`, `api`, `unknown`, or `logged_out`. It does not read credential files and it does not accept a token argument.

## Trust

The allowlist constrains which repositories the bridge will start. Codex's own sandbox constrains the commands Codex runs. A compromised Codex binary, a hostile process running as the same user, or a secret written into a project file is outside what this bridge can prevent. Project notes are inserted into the prompt as untrusted reference text.

Test commands come from the owner config and run with `sh -c` in the task worktree. Do not point `testCommand` at a script you do not trust.

## Reporting

Report problems on the fork with versions, the error code, and redacted logs. Do not include prompts, receipts, or credentials.
