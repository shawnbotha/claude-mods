import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Goal, GoalTask } from '../types'

const mine = atom({ plugin: 'goal-meter', key: 'mine' } as const, null)
const others = atom({ plugin: 'goal-meter', key: 'others' } as const, [])
const now = atom({ plugin: 'goal-meter', key: 'now' } as const, 0)
const isOpen = atom({ plugin: 'goal-meter', key: 'isOpen' } as const, false)
const isHidden = atom({ plugin: 'goal-meter', key: 'isHidden' } as const, false)

const CYAN = '#1fb6c8'
const TRACK = '#3a3a3a'
const CELLS = 45
// Same gradient as the usage bar: 100 = green, 5 or less = red.
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
const STALE_MS = 24 * 3600 * 1000

const span = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// Friendly names for MCP connectors, keyed by the server segment of mcp__<server>__<tool>.
const SERVER_NAMES: Record<string, string> = {
  // '<server-id-from-mcp__<server-id>__tool>': 'Friendly name',
}

const sentence = (s: string) => {
  const w = s.replace(/[_-]+/g, ' ').trim()
  return w.charAt(0).toUpperCase() + w.slice(1)
}

const stepText = (a: Record<string, any>): string => {
  const tool = String(a.tool)
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (m) {
    const raw = m[1]
    const name = SERVER_NAMES[raw] ?? (/^[0-9a-f-]{20,}$/i.test(raw) ? 'connector' : sentence(raw.replace(/^claude_ai_/i, '')))
    return `Using ${name}: ${sentence(m[2])}`
  }
  const arg = String(a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.description ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const verbs: Record<string, string> = {
    Bash: 'Running', PowerShell: 'Running', Read: 'Reading', Edit: 'Editing', Write: 'Writing',
    Grep: 'Searching', Glob: 'Finding files', WebFetch: 'Fetching', WebSearch: 'Searching the web',
    Agent: 'Delegating', Skill: 'Using skill',
  }
  const verb = verbs[tool] ?? `Using ${tool}`
  return arg ? `${verb}: ${cut(arg, 70)}` : verb
}

const dur = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? [])

// Moves a plan forward: the step whose words best match the call just finished becomes
// the running one, and every step before it is marked done.
function advance(tasks: GoalTask[], blob: string): GoalTask[] {
  const hay = words(blob)
  const cur = tasks.findIndex((t) => t.status !== 'completed')
  if (cur < 0) return tasks
  let best = -1
  let bestScore = 0
  for (let i = cur; i < tasks.length; i++) {
    let score = 0
    for (const w of words(tasks[i].text)) if (hay.has(w)) score++
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  }
  if (bestScore < 2 || best < 0) return tasks
  return tasks.map((t, i) =>
    i < best ? { ...t, status: 'completed' as const } : i === best ? { ...t, status: 'in_progress' as const } : t,
  )
}

const stats = (g: Goal) => {
  const total = g.tasks.length
  const done = g.tasks.filter((t) => t.status === 'completed').length
  const pct = total ? Math.round((done / total) * 100) : 0
  return { total, done, pct }
}

let sid = ''
let firstPrompt = ''
let startedAt = 0

async function ensure($: any): Promise<Goal> {
  const g = (await read($, mine)) as Goal | null
  if (g) return g
  const t = await $.clock.now()
  return {
    sid,
    title: firstPrompt,
    startedAt: startedAt || t,
    updatedAt: t,
    tasks: [],
  }
}

async function save($: any, g: Goal) {
  const t = await $.clock.now()
  const tasks = g.tasks
  const isDone = tasks.length > 0 && tasks.every((x) => x.status === 'completed')
  const next: Goal = {
    ...g,
    sid,
    updatedAt: t,
    doneAt: isDone ? g.doneAt ?? t : undefined,
  }
  await update($, mine, () => next)
  if (sid) await $.store.set(`goal:${sid}`, JSON.parse(JSON.stringify(next)))
}

async function refresh($: any) {
  const t = await $.clock.now()
  await update($, now, () => t)
  const out: Goal[] = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith('goal:') || k === `goal:${sid}`) continue
    const g = (await $.store.get(k)) as Goal | undefined
    if (!g || t - g.updatedAt > STALE_MS) {
      if (g) await $.store.delete(k)
      continue
    }
    out.push(g)
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  await update($, others, () => out)
}


export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    sid = await $.session.id()
    await $.command.register({
      name: 'hide-commands',
      description: 'Toggle blocking out the commands Claude runs on screen',
    })
    await $.command.register({
      name: 'goal-reset',
      description: 'Clear the goal meter and start fresh',
    })
    await refresh($)
    $.clock.every(5000, () => refresh($))
    return next(e)
  })

  on('command.run', { command: 'goal-reset' }, async ($) => {
    firstPrompt = ''
    startedAt = 0
    await update($, mine, () => null)
    if (sid) await $.store.delete(`goal:${sid}`)
    return { text: 'Goal meter cleared.' }
  })

  on('command.run', { command: 'hide-commands' }, async ($) => {
    const was = await read($, isHidden)
    await update($, isHidden, () => !was)
    return { text: was ? 'Commands are visible again.' : 'Commands are now blocked out.' }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, isHidden))) return next(e)
    const { Text } = $.ui.resolve(e)
    const tool = String((e.props as any).tool ?? 'tool')
    return <Text dimColor>■ {tool} ██████████████████</Text>
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, isHidden))) return next(e)
    const { Text } = $.ui.resolve(e)
    const n = (e.props as any).calls?.length ?? 0
    return <Text dimColor>■ {n} command{n === 1 ? '' : 's'} ██████████████████</Text>
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const text = e.text.trim()
      if (text && !text.startsWith('/')) {
        const cur = (await read($, mine)) as Goal | null
        const nowMs = await $.clock.now()
        const isStale = !!cur && (!!cur.doneAt || nowMs - cur.updatedAt > 30 * 60 * 1000)
        if (!firstPrompt || !cur || !cur.explicit || isStale) {
          firstPrompt = text.replace(/\s+/g, ' ')
          startedAt = nowMs
          await update($, mine, () => null)
        }
      }
      if (text.startsWith('/goal ')) {
        const g = await ensure($)
        await save($, { ...g, title: text.slice(6).trim() })
      }
    } catch {}
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const g = (await read($, mine)) as Goal | null
      if (g && !g.explicit && g.tasks.length) {
        await save($, { ...g, tasks: g.tasks.map((t) => ({ ...t, status: 'completed' as const, endedAt: t.endedAt ?? Date.now() })) })
      } else if (g && g.explicit && g.activity?.length && g.tasks.some((t) => t.id.startsWith('plan'))) {
        // A turn that ran tools moves a plan along even when no step's words matched.
        const i = g.tasks.findIndex((t) => t.status === 'in_progress')
        const tasks = g.tasks.map((t, k) =>
          k === i ? { ...t, status: 'completed' as const } : k === i + 1 && t.status === 'pending' ? { ...t, status: 'in_progress' as const } : t,
        )
        await save($, { ...g, tasks, activity: [] })
      }
    } catch {}
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const a = e as unknown as Record<string, any>
    const isPlanner = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'ProposeGoal'].includes(String(a.tool))
    let stepId = ''
    let activityId = ''
    if (!isPlanner) {
      try {
        const g = await ensure($)
        const id = String(a.tool_use_id ?? Date.now())
        const began = await $.clock.now()
        const text = stepText(a)
        if (!g.explicit) {
          stepId = id
          await save($, { ...g, tasks: [...g.tasks, { id, text, status: 'in_progress', startedAt: began }] })
        } else {
          activityId = id
          const activity = [...(g.activity ?? []), { id, text, status: 'in_progress' as const, startedAt: began }].slice(-6)
          await save($, { ...g, activity })
        }
      } catch {}
    }
    const r = await next(e)
    if (stepId || activityId) {
      try {
        const end = await $.clock.now()
        const g = await ensure($)
        if (stepId) {
          await save($, {
            ...g,
            tasks: g.tasks.map((t) => (t.id === stepId ? { ...t, status: 'completed' as const, endedAt: end } : t)),
          })
        } else {
          const activity = (g.activity ?? []).map((t) =>
            t.id === activityId ? { ...t, status: 'completed' as const, endedAt: end } : t,
          )
          await save($, { ...g, activity, tasks: advance(g.tasks, JSON.stringify(a)) })
        }
      } catch {}
    }
    try {
      if (a.tool === 'TodoWrite' && Array.isArray(a.todos)) {
        const g = { ...(await ensure($)), explicit: true }
        const tasks: GoalTask[] = a.todos.map((t: any, i: number) => ({
          id: String(i + 1),
          text: String(t.status === 'in_progress' && t.activeForm ? t.content : t.content),
          status: t.status,
        }))
        await save($, { ...g, tasks })
      } else if (a.tool === 'TaskCreate' && a.subject) {
        const g0 = await ensure($)
        const g: Goal = g0.explicit ? g0 : { ...g0, explicit: true, tasks: [] }
        const id = String(g.tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1)
        await save($, { ...g, tasks: [...g.tasks, { id, text: String(a.subject), status: 'pending' }] })
      } else if (a.tool === 'TaskUpdate' && a.taskId) {
        const g = { ...(await ensure($)), explicit: true }
        const tasks = g.tasks
          .filter((t) => !(t.id === String(a.taskId) && a.status === 'deleted'))
          .map((t) =>
            t.id === String(a.taskId)
              ? { ...t, text: a.subject ? String(a.subject) : t.text, status: a.status ?? t.status }
              : t,
          )
        await save($, { ...g, tasks })
      } else if (a.tool === 'ExitPlanMode') {
        const rr = r as any
        const plan = String(rr?.result?.plan ?? rr?.plan ?? '')
        const lines = plan.split(/\r?\n/)
        const at = lines.findIndex((l) => /^##\s+plan\b/i.test(l))
        let scope = lines
        if (at >= 0) {
          const rest = lines.slice(at + 1)
          const stop = rest.findIndex((l) => /^##\s/.test(l))
          scope = stop >= 0 ? rest.slice(0, stop) : rest
        }
        const pick = (re: RegExp) =>
          scope.map((l) => re.exec(l)?.[1]).filter((x): x is string => !!x)
        let steps = pick(/^\s*\d+[.)]\s+(.*\S)\s*$/)
        if (!steps.length) steps = pick(/^\s*[-*•]\s+(.*\S)\s*$/)
        steps = steps.map((x) => x.replace(/\*\*|`/g, ''))
        if (steps.length) {
          const g0 = await ensure($)
          const head = plan.split(/\r?\n/).find((l) => /^#\s+/.test(l))?.replace(/^#+\s*/, '')
          const tasks: GoalTask[] = steps.map((x, i) => ({
            id: `plan${i + 1}`,
            text: x,
            status: i === 0 ? 'in_progress' : 'pending',
          }))
          await save($, { ...g0, explicit: true, title: head ? `Plan: ${head}` : g0.title, tasks })
        }
      } else if (a.tool === 'ProposeGoal' && a.condition) {
        const g = await ensure($)
        await save($, { ...g, title: String(a.condition) })
      }
    } catch {}
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const g = (await read($, mine)) as Goal | null
    const list = (await read($, others)) as Goal[]
    const open = await read($, isOpen)
    const hidden = await read($, isHidden)
    const hasMine = !!g && g.tasks.length > 0
    if (e.props.hasSurvey) return next(e)

    const t = ((await read($, now)) as number) || Date.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const rows: any[] = []
    const ticks = (lit: number) => (
      <Box key="bar">
        <Text dimColor>| </Text>
        {Array.from({ length: CELLS }, (_, i) => (
          <Text key={i} color={i < lit ? colorFor(5 + (95 * i) / (CELLS - 1)) : '#555555'} bold={i < lit}>
            |
          </Text>
        ))}
        <Text dimColor> |</Text>
      </Box>
    )

    if (g && hasMine) {
      const { total, done, pct } = stats(g)
      const filled = Math.round((pct / 100) * CELLS)
      const elapsed = (g.doneAt ?? t) - g.startedAt
      const left = total - done
      const eta = g.doneAt
        ? `done in ${span(elapsed)}`
        : done > 0
          ? `ETA ~${span((elapsed / done) * left)}`
          : `ETA after ${left} task${left === 1 ? '' : 's'} finish`

      rows.push(
        <Box key="head">
          <Box flexGrow={1}>
            <Text bold>◎ Goal: {cut(g.title || 'untitled', 80)}</Text>
          </Box>
          <Text color={CYAN} bold>
            {done} of {total} tasks · {pct}%{'  '}
          </Text>
          <Button key="cmds" label={hidden ? 'show cmds' : 'hide cmds'} onPress={() => update($, isHidden, () => !hidden)} />
          <Button key="all" label={open ? 'hide other goals' : 'all goals'} onPress={() => update($, isOpen, () => !open)} />
        </Box>,
        ticks(filled),
        <Text key="time" dimColor>
          {span(elapsed)} elapsed · {eta}
        </Text>,
      )

      // Fit the list into the rows the band is allowed, keeping the running task in view.
      const maxRows = Number((e.props as any).maxRows) || 20
      const reserve =
        3 + 2 + 3 + (g.explicit && g.activity?.length ? 1 + Math.min(3, g.activity.length) : 0) + (open ? list.length + 1 : 0)
      const budget = Math.max(3, maxRows - reserve)
      const count = g.tasks.length
      let start = 0
      if (count > budget) {
        const run = g.tasks.findIndex((x) => x.status === 'in_progress')
        const focus = g.explicit ? (run >= 0 ? run : Math.max(0, g.tasks.findIndex((x) => x.status === 'pending'))) : count - 1
        start = Math.min(Math.max(0, focus - Math.floor(budget / 3)), count - budget)
        if (!g.explicit) start = count - budget
      }
      const shown = g.tasks.slice(start, start + budget)
      if (start > 0) rows.push(<Text key="before" dimColor>{start} earlier steps</Text>)
      for (const task of shown) {
        const mark = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '▶' : '○'
        const color = task.status === 'completed' ? '#3fb950' : task.status === 'in_progress' ? CYAN : undefined
        rows.push(
          <Box key={`t${task.id}`}>
            <Box width={3}>
              <Text color={color}>{mark}</Text>
            </Box>
            <Text bold={task.status === 'in_progress'} dimColor={task.status === 'completed'}>
              {cut(task.text, 90)}
            </Text>
            {task.startedAt ? <Text dimColor>{'  '}{dur((task.endedAt ?? t) - task.startedAt)} ›</Text> : null}
          </Box>,
        )
      }
      if (start + shown.length < count) rows.push(<Text key="more" dimColor>{count - start - shown.length} more steps</Text>)
      if (g.explicit && g.activity?.length) {
        rows.push(<Text key="now" dimColor>Now</Text>)
        for (const s of g.activity.slice(-3)) {
          rows.push(
            <Box key={`a${s.id}`}>
              <Box width={3}>
                <Text color={s.status === 'completed' ? '#3fb950' : CYAN}>{s.status === 'completed' ? '✓' : '▶'}</Text>
              </Box>
              <Text dimColor={s.status === 'completed'}>{cut(s.text, 80)}</Text>
              {s.startedAt ? <Text dimColor>{'  '}{dur((s.endedAt ?? t) - s.startedAt)} ›</Text> : null}
            </Box>,
          )
        }
      }
    } else {
      rows.push(
        <Box key="head">
          <Box flexGrow={1}>
            <Text bold>◎ Goal: </Text>
            <Text dimColor>none yet · progress shows once there is a task list</Text>
          </Box>
          <Button key="cmds" label={hidden ? 'show cmds' : 'hide cmds'} onPress={() => update($, isHidden, () => !hidden)} />
          <Button key="all" label={open ? 'hide other goals' : 'all goals'} onPress={() => update($, isOpen, () => !open)} />
        </Box>,
        ticks(0),
        <Text key="time" dimColor>
          0 of 0 tasks · 0%
        </Text>,
      )
    }

    if (open) {
      for (const o of list) {
        const s = stats(o)
        const el = (o.doneAt ?? t) - o.startedAt
        rows.push(
          <Box key={`o${o.sid}`}>
            <Box width={3}>
              <Text color={o.doneAt ? '#3fb950' : CYAN}>{o.doneAt ? '✓' : '◎'}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor>{cut(o.title || 'untitled', 60)}</Text>
            </Box>
            <Text color={CYAN}>
              {s.done}/{s.total} · {s.pct}% · {span(el)}
            </Text>
          </Box>,
        )
      }
      if (list.length === 0) rows.push(<Text key="none" dimColor>No other goals tracked.</Text>)
    }

    const inner = await next(e)
    return <Box flexDirection="column">{rows}{inner}</Box>
  })
}
