# Install on macOS

Target machine: your Mac Mini, Node.js 22 or newer, Codex CLI signed in with ChatGPT. The same package tests run on Linux; a real Codex session does not.

## 1. Node.js 22

Install Node 22 from [nodejs.org](https://nodejs.org/) or Homebrew (`brew install node@22`). Check:

```sh
node -v
```

The reported version must be 22 or newer.

## 2. Codex CLI and ChatGPT sign-in

Install the official Codex CLI, then sign in with your ChatGPT subscription. This is the primary path. An API key is optional and is configured by Codex itself, not by this bridge.

```sh
npm install -g @openai/codex
codex login
codex login status
```

`codex login` opens the browser. Choose **Sign in with ChatGPT**. `codex login status` should exit 0 and mention ChatGPT. Do not paste the output into a chat if it contains anything that looks like a token. The bridge never reads `~/.codex` itself and never prints credentials. `bridge_doctor` reports only `chatgpt`, `api`, `unknown`, or `logged_out`.

If `codex` is not on the PATH that Grok Bot will use, pass its absolute path to the installer with `--codex`.

## 3. Build this checkout

```sh
git clone <this-fork-url>
cd cos-codex-bridge
npm ci
npm test
```

`npm test` uses a fake Codex binary. It does not call OpenAI and it does not prove the Mac session works.

## 4. Allowlist project roots

Pick the parent directory that contains the repositories Codex may see. Do not pass `/` or your home directory. Write access is a second, narrower list. Omit `--write-root` to stay read-only.

```sh
node scripts/install.mjs \
  --root /Users/you/src \
  --write-root /Users/you/src/app \
  --project app=/Users/you/src/app \
  --test app='npm test' \
  --codex "$(which codex)"
```

Optional: `--approval-token` sets the local phrase required by `bridge_cleanup`. Use a phrase that is not a password you use elsewhere. The installer stores it only in the private config and doctor output never includes it.

This writes, under `~/.local/share/grokbot-codex-bridge`:

- `config.json` (mode 0600)
- `grokbot-codex-bridge` launcher
- `mcp-client.json`

The installer does not edit Grok Bot's settings and does not publish anything. Running it again against the same prefix fails instead of overwriting.

Check:

```sh
~/.local/share/grokbot-codex-bridge/grokbot-codex-bridge doctor
```

Confirm `codex.available`, `codex.auth.mode` (`chatgpt`), `bypassSandbox: false`, `limits.maxConcurrentTasks` (2), `limits.autoFixMaxAttempts` (3), and the roots.

## 5. Connect Grok Bot

Grok Bot accepts a stdio MCP server as command, args, and env. Paste the generated `mcp-client.json`, or the equivalent entry:

```json
{
  "mcpServers": {
    "grokbot-codex-bridge": {
      "command": "/usr/local/bin/node",
      "args": [
        "/absolute/path/to/cos-codex-bridge/dist/cli.js",
        "--config",
        "/Users/you/.local/share/grokbot-codex-bridge/config.json",
        "mcp"
      ],
      "env": {}
    }
  }
}
```

Use the absolute `node` that can see your Codex install. Leave `env` empty. Do not put `OPENAI_API_KEY` or an access token there. Codex uses the ChatGPT login already stored by `codex login`.

Restart Grok Bot and ask it to call `bridge_doctor` before the first task.

## Defaults that protect the ChatGPT plan

| Limit | Default |
|---|---|
| Concurrent Codex tasks | 2 |
| Auto-fix attempts per run, including the first turn | 3 |
| Wall time per user-initiated run | 1200 seconds |
| Per-attempt Codex timeout | 600 seconds |
| Sandbox | read-only |

A caller can ask for a lower cap. A caller cannot raise the cap past the config. A usage-limit error becomes `rate_limited` and the auto-fix loop stops.

## Updating

Pull this checkout, run `npm ci && npm test`, and keep the existing config. The launcher points at `dist/cli.js` in the checkout, so the checkout has to stay where it was installed.
