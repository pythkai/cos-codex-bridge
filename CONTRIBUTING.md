# Contributing

Run `npm test` on Node.js 22 before sending a change. The suite uses the fake Codex binary in `test/fixtures/fake-codex.mjs`. Do not add a test that needs ChatGPT credentials. The Mac session script is opt-in and stays out of CI.

Do not add another coding-agent runtime, a publish step, or a flag that bypasses the Codex sandbox. Destructive git cleanup stays behind `approvalToken`.

Keep prompts and tokens out of argv, log lines, and doctor output.
