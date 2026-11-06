// Auto thinking level per prompt, judged by a classifier model (Jev by default).
//
// Why: Pi records a fixed thinking level with the model selection. This
// extension re-decides it for each new prompt before the run starts, so hard
// prompts get more reasoning and mechanical prompts stay cheap, without
// switching the model (the prompt cache identity stays fixed).
//
// Costs one classifier request per prompt. Fails open: no classifier, an
// error, or a timeout keeps a local heuristic instead of blocking the turn.
//
// Enabled by default. Disable for one process with PI_AUTO_THINKING=0, or
// toggle during a session with /autothink on|off. --auto-thinking forces it on.
// Model:  PI_AUTO_THINKING_MODEL=provider/modelId (default: TypeSafe Jev; any
//         classifier model Pi lists works, e.g. openrouter/cloudflare/clef or
//         openai/gpt-6-luna). Without an override the built-in Jev candidates
//         below are tried in order and the first one with credentials wins.
// Debug:  PI_AUTO_THINKING_DEBUG=1 prints each decision to stderr
//
// Every decision is also appended to the session as an `auto-thinking` custom
// entry (once per new prompt; a retried prompt reuses the stored level): the
// chosen level, where it came from, the classifier and active model ids, and
// whether the model clamped it. Custom entries are persisted in the session file
// and excluded from LLM context, so a main session and a detached subagent
// session can both be audited afterwards. The prompt, credentials, and user
// content are never recorded.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

type Level = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Ascending effort order, used for clamping to what a model supports. */
/** Ascending effort order, used for clamping and for config validation. */
const ORDER: Level[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Score scale handed to the classifier: index -> meaning. */
const CRITERIA = [
  'Mechanical: rename, format, print a file, run a known command, trivial edit',
  'Simple: a small well-scoped edit, lookup, or one-line answer',
  'Standard: an ordinary feature, fix, or explanation that needs some reading',
  'Hard: multi-file change, non-obvious debugging, or a design decision',
  'Very hard: architecture, root-cause analysis, security or migration work',
  'Maximum: subtle high-risk change, deep reasoning over a large system',
]

/** Scale index -> level. Index 0 counts as mechanical, not "no thinking". */
const SCALE: Level[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Default classifier models to try, in order; first one with credentials wins.
 * Jev is Pi's built-in classifier and the intended default; the list only
 * exists so one install works across providers. Override with
 * PI_AUTO_THINKING_MODEL to point at any other classifier.
 */
const CANDIDATES: Array<[provider: string, id: string]> = [
  ['typesafe', 'jev-latest'],
  ['openrouter', '~typesafe/jev-latest'],
  ['openrouter', 'typesafe/jev-1.14'],
  ['openrouter', 'typesafe/jev-1.13'],
  ['cloudflare-workers-ai', 'typesafe/jev'],
  ['vercel-ai-gateway', 'typesafe-ai/jev'],
  ['opencode', 'jev-1.13'],
]

const CLASSIFY_TIMEOUT_MS = 4000
const MAX_PROMPT_CHARS = 6000

/** Config lives in a folder of its own so it never collides with Pi's files. */
const CONFIG_DIR = 'pi-autothink'
const CONFIG_FILE = 'config.json'

/**
 * Optional settings, read from JSON so nobody has to remember env vars.
 * Order of precedence: env var > project config > user config > built-in default.
 * Every field is optional; a bad value is ignored with a warning, never fatal.
 */
interface Config {
  enabled?: boolean
  /** Classifier to use, `provider/modelId`. Same as PI_AUTO_THINKING_MODEL. */
  model?: string
  /** Never decide below this level, e.g. "low" so simple work stays smart enough. */
  minLevel?: Level
  /** Never decide above this level, e.g. "high" to cap cost on a big repo. */
  maxLevel?: Level
  timeoutMs?: number
  maxPromptChars?: number
  debug?: boolean
}

interface LoadedConfig {
  values: Config
  /** Files that were actually read, in precedence order (last wins). */
  sources: string[]
  warnings: string[]
}

function readJsonObject(file: string, warnings: string[]): Config | undefined {
  if (!fs.existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`${file}: not a JSON object, ignored`)
      return undefined
    }
    return parsed as Config
  } catch (error) {
    warnings.push(`${file}: ${error instanceof Error ? error.message : 'unreadable'}`)
    return undefined
  }
}

/** Keep the fields that make sense; drop bad values loudly but harmlessly. */
function sanitize(raw: Config | undefined, file: string, warnings: string[]): Config {
  if (!raw) return {}
  const out: Config = {}
  const take = <K extends keyof Config>(key: K, ok: (v: unknown) => boolean, expect: string) => {
    const value = raw[key]
    if (value === undefined) return
    if (ok(value)) out[key] = value as Config[K]
    else warnings.push(`${file}: ${String(key)} should be ${expect}, ignored`)
  }
  take('enabled', (v) => typeof v === 'boolean', 'true or false')
  take('model', (v) => typeof v === 'string' && v.includes('/'), '"provider/modelId"')
  take('minLevel', (v) => typeof v === 'string' && ORDER.includes(v as Level), ORDER.join(' / '))
  take('maxLevel', (v) => typeof v === 'string' && ORDER.includes(v as Level), ORDER.join(' / '))
  take('timeoutMs', (v) => typeof v === 'number' && v > 0 && v <= 60000, 'a number of milliseconds')
  take('maxPromptChars', (v) => typeof v === 'number' && v >= 200, 'a number of characters')
  take('debug', (v) => typeof v === 'boolean', 'true or false')
  return out
}

function loadConfig(cwd: string): LoadedConfig {
  const warnings: string[] = []
  const userFile = path.join(os.homedir(), '.pi', 'agent', CONFIG_DIR, CONFIG_FILE)
  const projectFile = path.join(cwd, '.pi', CONFIG_DIR, CONFIG_FILE)
  const sources: string[] = []
  const values: Config = {}
  for (const file of [userFile, projectFile]) {
    const raw = readJsonObject(file, warnings)
    if (!raw) continue
    sources.push(file)
    Object.assign(values, sanitize(raw, file, warnings))
  }
  if (values.minLevel !== undefined && values.maxLevel !== undefined) {
    if (ORDER.indexOf(values.minLevel) > ORDER.indexOf(values.maxLevel)) {
      warnings.push(`${CONFIG_FILE}: minLevel is above maxLevel, both ignored`)
      delete values.minLevel
      delete values.maxLevel
    }
  }
  return { values, sources, warnings }
}

/** Session entry type for the audit trail; custom entries never reach the model. */
const ENTRY_TYPE = 'auto-thinking'

interface Decision {
  level: Level
  source: 'jev' | 'heuristic'
  confidence?: number
  detail: string
  model?: string
}

/** What gets persisted per decision: no prompt, no credentials, no user content. */
interface DecisionEntry {
  requested: Level
  applied: Level
  clamped: boolean
  source: Decision['source']
  /** Classifier model id that scored the prompt, when one answered. */
  classifier: string | null
  /** Active model the level was clamped to, or null before a model is selected. */
  model: string | null
  /** Classifier score or heuristic reason, e.g. "jev 2.31/5". */
  detail: string
}

function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…`
}

/** Apply the user's own floor/ceiling before the model gets a say. */
function applyBounds(desired: Level, config: Config): Level {
  let level = desired
  if (config.minLevel && ORDER.indexOf(level) < ORDER.indexOf(config.minLevel)) level = config.minLevel
  if (config.maxLevel && ORDER.indexOf(level) > ORDER.indexOf(config.maxLevel)) level = config.maxLevel
  return level
}

/** The level a model can actually apply, nearest to `desired`. */
function clampToModel(model: Model<Api> | undefined, desired: Level): Level {
  if (!model) return desired
  const supported = (getSupportedThinkingLevels(model) as Level[]).filter((level) => ORDER.includes(level))
  if (supported.length === 0) return desired
  const target = ORDER.indexOf(desired)
  for (let index = target; index >= 0; index--) {
    if (supported.includes(ORDER[index])) return ORDER[index]
  }
  for (let index = target + 1; index < ORDER.length; index++) {
    if (supported.includes(ORDER[index])) return ORDER[index]
  }
  return supported[0]
}

/** Local fallback when no classifier answers: rough, cheap, and predictable. */
function heuristic(prompt: string): Decision {
  const text = prompt.trim()
  if (!text) return { level: 'minimal', source: 'heuristic', detail: 'empty prompt' }

  const deep = /\b(root cause|security|architect|migrat|trade-?off|optimi[sz]e?|prove|benchmark|audit)\b/i
  const escalate = /\b(plan|planning|architect|debug|diagnos|design|review|refactor|compare|why|analy[sz]e|investigat|complex|optimi[sz]e?)\b/i
  const mechanical = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|list|rename|format|show|print|cat|ls|pwd|status|what is|who is|define)\b/i

  if (deep.test(text)) return { level: 'xhigh', source: 'heuristic', detail: 'deep task keywords' }
  if (escalate.test(text)) return { level: 'high', source: 'heuristic', detail: 'planning or review keywords' }
  if (mechanical.test(text) && text.length < 240) {
    return { level: 'minimal', source: 'heuristic', detail: 'short mechanical prompt' }
  }
  return { level: 'medium', source: 'heuristic', detail: 'general task' }
}

/** First classifier model in CANDIDATES whose provider has credentials. */
async function findClassifier(ctx: ExtensionContext, configModel?: string) {
  const override = (process.env.PI_AUTO_THINKING_MODEL?.trim() || configModel?.trim()) ?? ''
  if (override) {
    const [provider, ...rest] = override.split('/')
    const id = rest.join('/')
    if (provider && id) {
      const model = ctx.modelRegistry.findOfType('classifier', provider, id)
      if (model) return model
    }
  }
  for (const [provider, id] of CANDIDATES) {
    const model = ctx.modelRegistry.findOfType('classifier', provider, id)
    if (!model) continue
    try {
      if (ctx.modelRegistry.hasConfiguredAuth(model)) return model
    } catch {
      // Auth probing must never break the turn.
    }
  }
  return undefined
}

async function decide(prompt: string, ctx: ExtensionContext, config: Config = {}): Promise<Decision> {
  const model = await findClassifier(ctx, config.model)
  const timeoutMs = config.timeoutMs ?? CLASSIFY_TIMEOUT_MS
  if (!model) return heuristic(prompt)

  try {
    const result = await ctx.modelRegistry.classify(
      model,
      {
        state: {
          prompt: clip(prompt, config.maxPromptChars ?? MAX_PROMPT_CHARS),
          workingDirectory: ctx.cwd,
          activeModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        },
        questions: {
          effort: {
            type: 'score',
            instructions:
              'How much internal reasoning does completing the request in `prompt` need? Judge the work itself, not its tone or length.',
            criteria: CRITERIA,
          },
        },
      },
      { signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) },
    )

    if (result.stopReason !== 'stop') return heuristic(prompt)
    const answer = result.answers.effort
    if (answer?.type !== 'score') return heuristic(prompt)

    const index = Math.max(0, Math.min(SCALE.length - 1, Math.round(answer.score)))
    return {
      level: SCALE[index],
      source: 'jev',
      confidence: answer.confidence,
      detail: `jev ${answer.score.toFixed(2)}/5`,
      model: `${model.provider}/${model.id}`,
    }
  } catch {
    return heuristic(prompt)
  }
}

export default function (pi: ExtensionAPI) {
  const envEnable = process.env.PI_AUTO_THINKING === undefined || envFlag('PI_AUTO_THINKING')
  let enabled = envEnable
  let config: Config = {}
  let configSources: string[] = []
  let lastApplied: { prompt: string; level: Level; detail: string } | undefined
  let announce = true
  let warned = false

  pi.registerFlag('auto-thinking', {
    description: 'Let a classifier model choose the thinking level for each prompt',
    type: 'boolean',
    default: enabled,
  })

  /** Where each setting came from, so `status` can explain itself. */
  function precedence(model: string | undefined): string {
    const envModel = process.env.PI_AUTO_THINKING_MODEL?.trim()
    if (envModel) return 'PI_AUTO_THINKING_MODEL'
    if (config.model) return `config (${model ?? 'unresolved'})`
    return 'built-in candidate list'
  }

  function boundsLabel(): string {
    if (!config.minLevel && !config.maxLevel) return 'none'
    return `${config.minLevel ?? 'off'} … ${config.maxLevel ?? 'max'}`
  }

  /** One-shot, non-blocking nudge when the extension is running degraded. */
  async function warnOnce(ctx: ExtensionContext) {
    if (warned || !enabled) return
    warned = true
    const model = await findClassifier(ctx, config.model)
    for (const warning of loadConfig(ctx.cwd).warnings) ctx.ui.notify(`autothink: ${warning}`, 'warning')
    if (!model) {
      ctx.ui.notify(
        'autothink: no classifier credentials, using the keyword fallback.\nRun /autothink setup to connect one (Jev from TypeSafe, or any Pi classifier).',
        'warning',
      )
    }
  }

  async function setup(ctx: ExtensionContext) {
    const model = await findClassifier(ctx, config.model)
    if (model) {
      ctx.ui.notify(
        `autothink is ready: ${model.provider}/${model.id} (${precedence(`${model.provider}/${model.id}`)}).`,
        'info',
      )
      return
    }

    const choice = await ctx.ui.select(
      'No classifier credentials found. Which one do you want to connect?\n(After connecting, run /autothink setup again.)',
      [
        'TypeSafe Jev  — the default. Get a key at https://typesafe.ai, then run: /login typesafe',
        'OpenRouter   — Jev and Clef. Sign in or paste a key with: /login openrouter',
        'Cloudflare Workers AI — CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID',
        'Keep using the keyword fallback for now',
      ],
    )

    if (!choice) return
    if (choice.startsWith('TypeSafe')) {
      ctx.ui.notify('Run /login typesafe in Pi and paste your TypeSafe API key.\nThen run /autothink setup again.', 'info')
    } else if (choice.startsWith('OpenRouter')) {
      ctx.ui.notify('Run /login openrouter in Pi (browser sign-in or API key).\nThen run /autothink setup again.', 'info')
    } else if (choice.startsWith('Cloudflare')) {
      ctx.ui.notify(
        'Export CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID, then restart Pi.\nOr add the provider to ~/.pi/agent/auth.json.',
        'info',
      )
    } else {
      ctx.ui.notify(
        'Fine. The keyword fallback is coarse but never blocks: /autothink status shows which path each decision took.',
        'info',
      )
    }
  }

  pi.registerCommand('autothink', {
    description: 'Auto thinking level: /autothink [on|off|status|setup]',
    handler: async (args, ctx) => {
      const action = (args ?? '').trim().toLowerCase()
      if (action === 'on' || action === 'off') {
        enabled = action === 'on'
        const model = await findClassifier(ctx, config.model)
        ctx.ui.notify(
          enabled
            ? `Auto thinking on${model ? ` (${model.provider}/${model.id})` : ' — no classifier credentials, using the keyword fallback'}`
            : 'Auto thinking off',
          'info',
        )
        return
      }
      if (action === 'setup') {
        await setup(ctx)
        return
      }
      const model = await findClassifier(ctx, config.model)
      const lines = [
        `auto thinking: ${enabled ? 'on' : 'off'}`,
        `classifier: ${model ? `${model.provider}/${model.id}` : 'none — keyword fallback (run /autothink setup)'}`,
        `classifier source: ${precedence(model ? `${model.provider}/${model.id}` : undefined)}`,
        `level bounds: ${boundsLabel()}`,
        `current level: ${ctx.thinkingLevel}`,
        `config: ${configSources.length ? configSources.join(', ') : 'none (defaults)'}`,
        lastApplied ? `last decision: ${lastApplied.level} (${lastApplied.detail})` : 'last decision: none yet',
      ]
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd)
    config = loaded.values
    configSources = loaded.sources
    if (config.enabled !== undefined) enabled = config.enabled
    enabled = Boolean(pi.getFlag('auto-thinking')) || enabled
    announce = true
    if (config.debug || envFlag('PI_AUTO_THINKING_DEBUG')) {
      for (const warning of loaded.warnings) console.error(`[autothink] ${warning}`)
    }
    ctx.ui.setStatus('autothink', enabled ? 'autothink: on' : undefined)
    void warnOnce(ctx)
  })

  pi.on('before_agent_start', async (event, ctx) => {
    if (!enabled) return
    if (event.messageType !== 'user') return
    const prompt = event.prompt?.trim()
    if (!prompt) return

    // A retry or recovery re-enters with the same prompt: reuse the decision
    // instead of paying for another classifier call.
    if (lastApplied && lastApplied.prompt === prompt) {
      pi.setThinkingLevel(lastApplied.level)
      return
    }

    const decision = await decide(prompt, ctx, config)
    const level = clampToModel(ctx.model, applyBounds(decision.level, config))
    const changed = level !== ctx.thinkingLevel
    if (config.debug || envFlag('PI_AUTO_THINKING_DEBUG')) {
      console.error(`[autothink] ${decision.level} -> ${level} (${decision.source}${decision.model ? ` via ${decision.model}` : ''}: ${decision.detail})`)
    }
    try {
      pi.appendEntry<DecisionEntry>(ENTRY_TYPE, {
        requested: decision.level,
        applied: level,
        clamped: level !== decision.level,
        source: decision.source,
        classifier: decision.model ?? null,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
        detail: decision.detail,
      })
    } catch {
      // The audit trail must never block the level change it describes.
    }
    lastApplied = { prompt, level, detail: decision.detail }
    if (changed) pi.setThinkingLevel(level)

    if (announce || changed) {
      const confidence = decision.confidence === undefined ? '' : ` ${decision.confidence.toFixed(2)}`
      ctx.ui.setStatus('autothink', `autothink: ${level} (${decision.source}${confidence})`)
      announce = false
    }
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    ctx.ui.setStatus('autothink', undefined)
  })
}
