# omp qoder-provider

Use [Qoder](https://qoder.com) as a model provider inside [omp](https://github.com/can1357/oh-my-pi) — officially supported surface only: the extension spawns the local `qodercli` binary in headless print mode per request and translates its stream-json output into canonical omp assistant-message events. No protocol impersonation, no API keys, no WAF tricks; the child authenticates with your own Qoder sign-in and bills your existing Qoder plan credits.

> Independent community tool. Not affiliated with or endorsed by Qoder or the omp project.

## Requirements

- omp (`~/.local/bin/omp`) — extension API with `pi.registerProvider`
- [Qoder CLI](https://www.npmjs.com/package/@qoder-ai/qodercli) installed and signed in (`qodercli login`); developed against v1.1.83
- A Qoder plan with credits (each request bills credits via the child, reported per response)
- Node 18+ (optional) — only for the remaining-quota display

## Install

```sh
./install.sh
```

Then restart any running omp session and pick a model (`/model qoder/auto`), or go straight to headless:

```sh
omp -p --model qoder/auto "Reply with exactly: PONG"
```

Uninstall with `./install.sh --uninstall`. To install into a named omp profile, point `OMP_EXTENSIONS_DIR` at its extensions directory (e.g. `~/.omp/profiles/<name>/agent/extensions`).

## Models

Model selectors use Qoder's display names under the hood (`qodercli --list-models`):

| Selector | Qoder model |
| --- | --- |
| `qoder/auto` | Auto router |
| `qoder/efficient` | Efficient |
| `qoder/qwen3.8-max` / `qoder/qwen3.8-flash` | Qwen3.8-Max / Flash |
| `qoder/kimi-k3.1-pro` / `qoder/kimi-k2.8-preview` | Kimi K3.1 Pro / K2.8 Preview |
| `qoder/glm-5.3` / `qoder/glm-5.3-flash` | GLM-5.3 / Flash |
| `qoder/deepseek-v4-pro` / `qoder/deepseek-flash` | DeepSeek V4 Pro / Flash |
| `qoder/minimax-m3.1-flash` | MiniMax M3.1 Flash |

## How it works

One omp request = one `qodercli -p --output-format stream-json` child process:

- conversation history is serialized to a text transcript on stdin
- the child runs its own agent loop with its own tools (Read/Edit/Bash/…) in the working directory, governed by Qoder's own permission system
- assistant text and thinking blocks stream back as omp events; the final narration becomes the model response
- `--strict-mcp-config` keeps your personal Qoder MCP servers out of child runs

```
omp session ── provider "qoder" ── spawn qodercli (headless, stream-json)
     ▲                                   │ own tool loop, own sign-in
     └── canonical assistant events ─────┘
```

## Images

Models declare `["text", "image"]` input. Images in the omp conversation are written to temp files and passed to the child via `qodercli --attachment` (verified with PNG; JPEG/WebP/GIF mapped by extension, up to 10 per request). Attachments land on the child's initial prompt — history images are re-attached as `[image #N attached]` markers in the transcript, not positioned per turn.

## Credits and usage

Every response carries the credits it cost (`message.details.credits`, from the child's own accounting) and is added to a local ledger:

- `/qoder-credits` (in an omp session) — remaining quota (when available), plus credits spent in this omp process and all-time (stored in `~/.omp/agent/qoder-credits.json`).
- Set `QODER_BRIDGE_COST_AS_CREDITS=1` to mirror per-run credits into `usage.cost.total`, so omp's statusline/usage cost shows credit spend (unit is credits, not USD).

**Remaining quota** comes from the official `@qoder-ai/qoder-agent-sdk` (`getUsageInfo()` over the CLI's own control channel — no agent turn is billed). `install.sh` sets it up under `~/.omp/agent/vendor/qoder-sdk` (needs Node 18+ and network access to `download.qoder.com`/npm). Status on the dev machine (macOS, qodercli 1.1.83 + SDK 1.0.58): the SDK daemon fails to start under both Bun and Node, so remaining quota reports `unavailable` there; spent tracking is unaffected. The extension negative-caches failures for 10 minutes, so a broken helper never stalls sessions.

## Knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `QODER_BRIDGE_BIN` | `qodercli` | qodercli binary path |
| `QODER_BRIDGE_PERMISSION_MODE` | `dont_ask` | child permission mode; `accept_edits` lets the child edit files, `bypass_permissions` removes its guardrails (not recommended) |
| `QODER_BRIDGE_LOG` | unset | append spawn/result diagnostics to a file |
| `QODER_BRIDGE_COST_AS_CREDITS` | off | mirror per-run credits into `usage.cost.total` |
| `QODER_BRIDGE_CREDITS_FILE` | `~/.omp/agent/qoder-credits.json` | all-time credits ledger |
| `QODER_BRIDGE_VENDOR_DIR` | `~/.omp/agent/vendor/qoder-sdk` | SDK install location for the remaining-quota helper |
| `QODER_BRIDGE_USAGE_HELPER` | `<vendor dir>/qoder-usage-helper.cjs` | helper script run under Node |

## Limitations

- Delegate mode: the child never sees omp's tool schemas, and omp's tools are not bridged in; history is flattened to text (images travel as attachments, not per-turn placement).
- One child run per request: repeated follow-ups re-send the whole transcript as text.
- Stop reasons other than success map to stream errors (no length/toolUse distinction).
- `contextWindow` metadata is a conservative 128k placeholder, not measured.
- Images in tool results are not forwarded (only user-turn images).

## Security notes

- Prompts, file excerpts, and tool results travel to the Qoder model service — treat the child like any cloud-model provider. Don't point it at workspaces with secrets or employer code you may not send there.
- The child executes with Qoder's permission system, not omp's; `dont_ask` denies anything that would normally prompt. Review the mode before switching.
- The repo contains no credentials; the child reads your local `qodercli` sign-in state.

## License

[MIT](LICENSE)
