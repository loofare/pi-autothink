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

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

type Level = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Ascending effort order, used for clamping to what a model supports. */
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
async function findClassifier(ctx: ExtensionContext) {
  const override = process.env.PI_AUTO_THINKING_MODEL?.trim()
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

async function decide(prompt: string, ctx: ExtensionContext): Promise<Decision> {
  const model = await findClassifier(ctx)
  if (!model) return heuristic(prompt)

  try {
    const result = await ctx.modelRegistry.classify(
      model,
      {
        state: {
          prompt: clip(prompt, MAX_PROMPT_CHARS),
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
      { signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)]) : AbortSignal.timeout(CLASSIFY_TIMEOUT_MS) },
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
  let enabled = process.env.PI_AUTO_THINKING === undefined || envFlag('PI_AUTO_THINKING')
  let lastApplied: { prompt: string; level: Level; detail: string } | undefined
  let announce = true

  pi.registerFlag('auto-thinking', {
    description: 'Let a classifier model choose the thinking level for each prompt',
    type: 'boolean',
    default: enabled,
  })

  pi.registerCommand('autothink', {
    description: 'Auto thinking level: /autothink [on|off|status]',
    handler: async (args, ctx) => {
      const action = (args ?? '').trim().toLowerCase()
      if (action === 'on' || action === 'off') {
        enabled = action === 'on'
        const model = await findClassifier(ctx)
        ctx.ui.notify(
          enabled
            ? `Auto thinking on${model ? ` (${model.provider}/${model.id})` : ' — no classifier credentials, using heuristic'}`
            : 'Auto thinking off',
          'info',
        )
        return
      }
      const model = await findClassifier(ctx)
      const lines = [
        `auto thinking: ${enabled ? 'on' : 'off'}`,
        `classifier: ${model ? `${model.provider}/${model.id}` : 'none (heuristic fallback)'}`,
        `current level: ${ctx.thinkingLevel}`,
        lastApplied ? `last decision: ${lastApplied.level} (${lastApplied.detail})` : 'last decision: none yet',
      ]
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    enabled = Boolean(pi.getFlag('auto-thinking')) || enabled
    announce = true
    ctx.ui.setStatus('autothink', enabled ? 'autothink: on' : undefined)
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

    const decision = await decide(prompt, ctx)
    const level = clampToModel(ctx.model, decision.level)
    const changed = level !== ctx.thinkingLevel
    if (envFlag('PI_AUTO_THINKING_DEBUG')) {
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
