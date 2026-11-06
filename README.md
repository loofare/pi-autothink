# pi-autothink

**English** · [中文说明](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/pi-autothink.svg)](https://www.npmjs.com/package/pi-autothink)
[![license](https://img.shields.io/npm/l/pi-autothink.svg)](./LICENSE)

> A [Pi](https://pi.dev) extension that decides **how hard the model should think** before every turn.
>
> Typing `fix this typo` and `redesign the auth layer` no longer cost the same reasoning budget: a small classifier model scores the request, and Pi runs that turn at the matching thinking level.
>
> Same model. Same context. Same prompt cache. **Only the thinking level moves.**

```
  you type a message
          │
          ▼
  ┌─────────────────────────┐      score 0–5
  │  classifier (Jev)       │ ─────────────────┐
  │  "how deep is this?"    │                  │
  └─────────────────────────┘                  ▼
                                     ┌──────────────────┐
                                     │  thinking level  │
                                     │ minimal … max    │
                                     └────────┬─────────┘
          ┌───────────────────────────────────┘
          ▼
  clamp to what your model supports  →  run the turn  →  log the decision to the session
```

## Quick start

```bash
pi install npm:pi-autothink          # or: pi install git:github.com/loofare/pi-autothink
```

Then restart Pi (or `/reload`) and check it is live:

```
/autothink status
```

It is **on by default**. Turn it off with `/autothink off` or `PI_AUTO_THINKING=0`.

## Where does the judging model come from?

This plugin **stores no keys of its own**. It asks Pi which classifier models already have credentials and uses the first one that answers — TypeSafe Jev unless you say otherwise. That means one setup covers every Pi extension: log in once, and this works.

```bash
/autothink status     # what did it find?
/autothink setup      # nothing yet: tells you the one command to run
```

| You want | Do this | Where the key lives |
|---|---|---|
| TypeSafe Jev (default) | `/login typesafe` | Pi's `auth.json`, or `TYPESAFE_API_KEY` |
| OpenRouter | `/login openrouter` | OAuth sign-in or `OPENROUTER_API_KEY`; serves Jev and Clef |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | environment, or `auth.json` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | environment |
| OpenCode | `OPENCODE_API_KEY` | environment |
| OpenAI (GPT-6 Luna) | `OPENAI_API_KEY` | environment |
| Nothing at all | do nothing | keyword fallback, never blocks the turn |

Run `/autothink setup` again afterwards; it re-checks and reports what it found.

## Optional config file

No config needed. When you want one:

- user: `~/.pi/agent/pi-autothink/config.json`
- project: `<project>/.pi/pi-autothink/config.json` (wins over the user file)

```json
{
  "minLevel": "low",
  "maxLevel": "high",
  "timeoutMs": 3000,
  "model": "typesafe/jev-latest",
  "enabled": true,
  "debug": false,
  "maxPromptChars": 6000
}
```

| Key | What it does |
|---|---|
| `minLevel` / `maxLevel` | Your own floor and ceiling. `"minLevel": "low"` keeps the classifier from ever dropping below low; `"maxLevel": "high"` caps cost on a big repo |
| `model` | Force a specific classifier, `provider/modelId` — same as `PI_AUTO_THINKING_MODEL` |
| `timeoutMs` | Classifier timeout, default `4000` |
| `maxPromptChars` | How much of the prompt is sent, default `6000` |
| `enabled` | Start enabled or not |
| `debug` | Print each decision to stderr |

**Precedence:** environment variable → project config → user config → built-in default. A bad value (typo, wrong type, `minLevel` above `maxLevel`) is ignored with a warning, never fatal.

## Why this exists

Pi stores the thinking level next to the model selection, so it stays wherever you left it. That leaves two habits, both bad:

| Habit | What it costs |
|---|---|
| Leave it at `max` forever | Typo fixes and one-line lookups pay architecture-grade reasoning: slower, more expensive, no better |
| Switch it by hand per message | The switching itself eats attention, and you get it wrong at the worst moment |

Thinking tokens are billed as output. This extension puts **one cheap classifier call** in front of each turn so the level follows the work instead of your mood.

## Requirements

| Requirement | Detail |
|---|---|
| Pi with classifier support | `ctx.modelRegistry.classify()` — Pi 1.4.0 or newer |
| A classifier credential | Any **one** of: `TYPESAFE_API_KEY` (Jev, tried first), `OPENROUTER_API_KEY` / `/login`, `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`, `AI_GATEWAY_API_KEY`, `OPENCODE_API_KEY`, `OPENAI_API_KEY` (GPT-6 Luna) |
| A model with thinking levels | Without one, Pi clamps everything to `off`: harmless, pointless |

**Missing the credential?** It still works. No classifier, an error, or a 4-second timeout falls back to a local keyword heuristic instead of blocking the turn.

## How it decides

The classifier gets one scored question — *how much internal reasoning does completing this request need? Judge the work itself, not its tone or length* — and answers on this scale:

| Score | The work looks like | Level |
|---:|---|---|
| 0 | rename a variable, format a file, run a known command | `minimal` |
| 1 | one small edit, a lookup | `low` |
| 2 | an ordinary feature, fix, or explanation | `medium` |
| 3 | multi-file change, non-obvious debugging, a design decision | `high` |
| 4 | architecture, root cause, security, migration | `xhigh` |
| 5 | subtle high-risk change across a large system | `max` |

Two details that matter:

- **Score 0 → `minimal`, never `off`.** Deciding *not to think at all* stays your call, not the classifier's.
- **The result is clamped to your model.** The requested level is pulled to the nearest level the active model actually supports, so an unsupported level never reaches the provider.

Request text is clipped to 6000 characters. Timeout is 4000 ms.

## Controls

| Control | Effect |
|---|---|
| `/autothink setup` | Guided connect: finds a classifier, or tells you the one command to run |
| `/autothink on` · `/autothink off` | Toggle during a session |
| `/autothink status` | On/off, which classifier, where the setting came from, bounds, last decision |
| `PI_AUTO_THINKING=0` | Disable for one process |
| `pi --auto-thinking` | Force on for one process |
| `PI_AUTO_THINKING_MODEL=provider/modelId` | Use another classifier, e.g. `openai/gpt-6-luna` |
| `PI_AUTO_THINKING_DEBUG=1` | Print each decision to stderr |

## What it does not do

Being explicit about the edges is cheaper than debugging them later:

| It does not… | Why |
|---|---|
| change your model | Only the thinking level moves, so the prompt cache identity survives |
| re-decide mid-turn | One decision per user prompt; tool loops inside that turn keep the level |
| guarantee a correct score | It reads the sentence you wrote, not what the turn will turn out to need |
| think for you when unsure | On failure it falls back to keywords, and always lets the turn run |
| claim a measured saving | It reports a level distribution, not a benchmark |
| load in foreground subagents | Detached (async) subagents do load it and decide for themselves; `async: false` ones run in-process without it and keep their configured level |

## Audit trail

Every decision lands in the session as an `auto-thinking` custom entry — outside the LLM context, with no prompt text, credentials, or user content:

```json
{"requested":"medium","applied":"low","clamped":true,"source":"jev",
 "classifier":"typesafe/jev-latest","model":"some/model","detail":"jev 2.31/5"}
```

`requested` is what the classifier said, `applied` is what actually ran, and `clamped` says whether the model could not honour it. Retries and recoveries reuse the previous decision instead of paying for another classifier call.

## Install variants

```bash
pi install npm:pi-autothink                          # npm
pi install git:github.com/loofare/pi-autothink        # git
pi install ./pi-autothink                            # local checkout
pi -e /path/to/pi-autothink                          # try once, don't add to settings
```

## License

MIT
