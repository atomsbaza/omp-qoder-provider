# omp qoder-provider

Use [Qoder](https://qoder.com) as a model provider inside [omp](https://github.com/can1357/oh-my-pi) — officially supported surface only: the extension spawns the local `qodercli` binary in headless print mode per request and translates its stream-json output into canonical omp assistant-message events. No protocol impersonation, no API keys, no WAF tricks; the child authenticates with your own Qoder sign-in and bills your existing Qoder plan credits.

> Independent community tool. Not affiliated with or endorsed by Qoder or the omp project.

## Requirements

- omp (`~/.local/bin/omp`) — extension API with `pi.registerProvider`
- [Qoder CLI](https://www.npmjs.com/package/@qoder-ai/qodercli) installed and signed in (`qodercli login`); developed against v1.1.83
- A Qoder plan with credits (each request bills credits via the child, reported per response)

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

## Knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `QODER_BRIDGE_BIN` | `qodercli` | qodercli binary path |
| `QODER_BRIDGE_PERMISSION_MODE` | `dont_ask` | child permission mode; `accept_edits` lets the child edit files, `bypass_permissions` removes its guardrails (not recommended) |
| `QODER_BRIDGE_LOG` | unset | append spawn/result diagnostics to a file |

## Limitations

- Delegate mode: the child never sees omp's tool schemas, and omp's tools are not bridged in; history is flattened to text (images are dropped).
- Text input only; `contextWindow` metadata is a conservative 128k placeholder, not measured.
- One child run per request: repeated follow-ups re-send the whole transcript as text.
- Stop reasons other than success map to stream errors (no length/toolUse distinction).

## Security notes

- Prompts, file excerpts, and tool results travel to the Qoder model service — treat the child like any cloud-model provider. Don't point it at workspaces with secrets or employer code you may not send there.
- The child executes with Qoder's permission system, not omp's; `dont_ask` denies anything that would normally prompt. Review the mode before switching.
- The repo contains no credentials; the child reads your local `qodercli` sign-in state.

## License

[MIT](LICENSE)
