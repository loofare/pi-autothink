# pi-autothink

A single-file [Pi](https://pi.dev) extension: **before every prompt, a classifier model decides how much thinking the task needs, and Pi switches the current model's thinking level to match.**

Same model, same context, same prompt cache — only the thinking level changes. A rename task stops paying for architecture-grade reasoning, and you stop deciding per message how deep the model should think.

```
you type a message
   ├─▶ classifier (TypeSafe Jev by default): "how much reasoning does this need?" → score 0–5
   ├─▶ score → thinking level (minimal / low / medium / high / xhigh / max)
   ├─▶ clamp to the levels your current model actually supports
   └─▶ Pi runs the turn at that level; the decision is written to the session for audit
```

## Why

Pi stores the thinking level with the model selection, so it stays wherever you left it. Most people leave it at max (safe, expensive, slow) or keep switching it by hand (cheap, but it costs attention and you get it wrong).

Thinking tokens are billed as output. Reasoning through "fix this typo" at max effort is money and latency spent on nothing; reasoning through a migration script at the lowest level costs you a wrong edit and a rerun. This extension puts one cheap classifier call in front of the turn so the level follows the work.

## Requirements

1. **Pi with classifier-model support** (the `ctx.modelRegistry.classify()` API — Pi 1.4.0 or newer).
2. **Credentials for at least one classifier model.** Pi ships Jev and Clef as built-in classifiers; any of these works:
   - `TYPESAFE_API_KEY` (Jev, first choice)
   - `OPENROUTER_API_KEY` or `/login` (Jev, Clef)
   - `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` (Jev, Clef)
   - `AI_GATEWAY_API_KEY` (Jev), `OPENCODE_API_KEY` (Jev)
   - `OPENAI_API_KEY` (GPT-6 Luna via the Decisions API)
3. **A model that supports thinking levels.** Without one, Pi clamps everything to `off`; the extension is harmless but pointless.

No classifier credentials? It still works: the extension falls back to a local keyword heuristic instead of blocking the turn.

## Install

```bash
# from git
pi install git:github.com/loofare/pi-autothink

# from a local checkout (development)
pi install ./pi-autothink

# try once without adding it to settings
pi -e /path/to/pi-autothink
```

Restart Pi or `/reload` after installing. Check it loaded:

```
/autothink status
```

## Controls

| Control | Effect |
|---|---|
| `/autothink on` · `/autothink off` | Toggle during a session |
| `/autothink status` | On/off, which classifier was found, current level, last decision |
| `PI_AUTO_THINKING=0` | Disable for one process |
| `pi --auto-thinking` | Force on for one process |
| `PI_AUTO_THINKING_MODEL=provider/modelId` | Use a different classifier, e.g. `openai/gpt-6-luna` |
| `PI_AUTO_THINKING_DEBUG=1` | Print each decision to stderr |

Enabled by default.

## How it decides

The classifier is asked one scored question — *how much internal reasoning does completing this request need? Judge the work itself, not its tone or length* — on a six-point scale:

| Score | Meaning | Level |
|---:|---|---|
| 0 | Mechanic: rename, format, run a known command | `minimal` |
| 1 | Simple: one small edit, a lookup | `low` |
| 2 | Standard: an ordinary feature, fix, or explanation | `medium` |
| 3 | Hard: multi-file change, non-obvious debugging, a design decision | `high` |
| 4 | Very hard: architecture, root cause, security, migration | `xhigh` |
| 5 | Maximum: subtle high-risk change in a large system | `max` |

Score 0 maps to `minimal`, not `off`: deciding *not to think at all* stays your call, not the classifier's.

Request text is clipped to 6000 characters. The result is clamped to the levels the active model supports, nearest-first, so an unsupported level never reaches the provider.

**Fallback.** No classifier, an error, or a 4000 ms timeout → a local heuristic keeps the turn moving: root-cause/security/architecture/migration wording → `xhigh`; planning/debugging/review wording → `high`; short mechanical prompts → `minimal`; otherwise `medium`. It never blocks.

## Audit trail

Every decision is appended to the session as an `auto-thinking` custom entry:

```json
{"requested":"medium","applied":"low","clamped":true,"source":"jev",
 "classifier":"typesafe/jev-latest","model":"some/model","detail":"jev 2.31/5"}
```

Custom entries stay out of the LLM context. The prompt text, credentials, and any user content are never recorded — only the decision.

Retries and recoveries reuse the previous decision instead of paying for another classifier call.

## Boundaries

- **One decision per user prompt.** Tool loops inside that turn keep the same level. If a task turns out to be harder mid-run, raise the level yourself.
- **The classifier can be wrong.** It scores the sentence you wrote, not what the turn will actually require. Keep `/autothink off` and manual `/thinking` as the override.
- **The plugin advises; your model decides.** If the model doesn't support a level, the applied level differs from the requested one — the `clamped` field in the session entry says when.
- **Foreground subagents don't load it.** A detached (async) subagent session loads ambient extensions and decides for itself; a foreground `async: false` subagent runs in-process without it, and its level comes from the agent configuration.
- **No benchmark claims.** It reports the level distribution, not a measured saving. Whether it saves tokens depends on how many light tasks sit in your day.

## 中文速览

Pi 的单文件扩展：**每条消息进来，先让一个分类器模型（默认 TypeSafe 的 Jev）判一句「这件事要想多深」，再把当前模型的思考档位调到对应那一档。**

只换档位、不换模型，上下文缓存不受影响。判不出来、报错、或 4 秒超时，就退回本地关键词判断，不会卡住你。

- 开关：`/autothink on|off|status`、`PI_AUTO_THINKING=0`、`pi --auto-thinking`
- 换分类器：`PI_AUTO_THINKING_MODEL=provider/modelId`
- 前提：Pi 1.4.0+、任一分类器凭据、当前模型支持思考档
- 边界：一条消息只判一次；它会判错；模型不支持的档会被钳制；后台子代理各判各的

## License

MIT
