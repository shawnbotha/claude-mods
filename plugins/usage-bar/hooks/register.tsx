import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'usage-bar', key: 'limits' } as const, [])
const now = atom({ plugin: 'usage-bar', key: 'now' } as const, 0)

// 100% left = green, 5% or less = red, hue sweeps 120 -> 0 in between.
const colorFor = (left: number): string => {
  const t = Math.min(1, Math.max(0, (left - 5) / 95))
  const hue = 120 * t
  const s = 0.85
  const l = 0.5
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

const span = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d ${h}h`
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

const WINDOWS: Record<string, { label: string; long: boolean }> = {
  five_hour: { label: '5h  ', long: false },
  seven_day: { label: 'Week', long: true },
}

const relevant = (list: readonly Limit[]): Limit[] =>
  list.filter((l) => l.kind in WINDOWS)

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      const u = await $.session.usage()
      await update($, limits, () => relevant(u.rateLimits))
    } catch {}
    { const n = await $.clock.now(); await update($, now, () => n) }
    $.clock.every(30000, async () => {
      { const n = await $.clock.now(); await update($, now, () => n) }
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const l = relevant(e.rateLimits)
    if (l.length) await update($, limits, () => l)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, limits)
    if (!list.length || e.props.hasSurvey) return next(e)
    const nowRaw = await read($, now)
    const t = typeof nowRaw === 'number' && nowRaw > 0 ? nowRaw : Date.now()
    const { Box, Text } = $.ui.resolve(e)

    const rows = list.map((l) => {
      const w = WINDOWS[l.kind]
      const left = Math.max(0, Math.round((100 - l.percentUsed) * 10) / 10)
      const color = colorFor(left)
      const $pct = (left.toFixed(0) + '%').padStart(4)
      const cells = 45
      const filled = Math.round((left / 100) * cells)

      let reset = 'reset time unknown'
      if (l.resetsAt) {
        const raw = Number(l.resetsAt)
        const at = new Date(Number.isFinite(raw) ? (raw < 1e12 ? raw * 1000 : raw) : l.resetsAt)
        const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const day = w.long
          ? at.toLocaleDateString([], { weekday: 'short' }) + ' '
          : ''
        reset = Number.isNaN(at.getTime())
          ? 'reset time unknown'
          : `resets ${(day + clock).padEnd(12)} in ${span(at.getTime() - t)}`
      }

      return (
        <Box key={l.kind}>
          <Box width={7}><Text dimColor>{w.label.trim()}</Text></Box>
          <Box>
            <Text dimColor>| </Text>
            {Array.from({ length: cells }, (_, i) => (
              <Text key={i} color={i < filled ? colorFor(5 + (95 * i) / (cells - 1)) : '#555555'} bold={i < filled}>
                |
              </Text>
            ))}
            <Text dimColor> |  </Text>
          </Box>
          <Box width={10}><Text color={color} bold>{$pct} left</Text></Box>
          <Text dimColor>{reset}</Text>
        </Box>
      )
    })

    const inner = await next(e)
    return <Box flexDirection="column">{inner}{rows}</Box>
  })
}