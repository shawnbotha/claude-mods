import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { PluginRow } from '../types'

const PER_PAGE = 8
const SELF = 'plugin-switcher'
// Hide list, so a plugin installed later shows up by default.
const STORE_KEY = 'hidden'

const isOpen = atom({ plugin: 'plugin-switcher', key: 'isOpen' } as const, false)
const view = atom({ plugin: 'plugin-switcher', key: 'view' } as const, 'list')
const rows = atom({ plugin: 'plugin-switcher', key: 'rows' } as const, [])
// Ids left out of the main list.
const hidden = atom({ plugin: 'plugin-switcher', key: 'hidden' } as const, [])
const page = atom({ plugin: 'plugin-switcher', key: 'page' } as const, 0)
const note = atom({ plugin: 'plugin-switcher', key: 'note' } as const, '')

// "name@marketplace" -> "name"
const shortName = (id: string) => id.split('@')[0]

// Reads the installed plugins, whether each is enabled, and the saved selection.
async function refresh($: Engine) {
  const ran = await $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 60000 })
  if (ran.exitCode !== 0) {
    await update($, note, () => 'Could not list plugins')
    return
  }
  const parsed = JSON.parse(ran.stdout) as { id: string; scope: string; enabled: boolean }[]
  const list: PluginRow[] = parsed
    .filter(p => shortName(p.id) !== SELF)
    .map(p => ({ id: p.id, scope: p.scope, isOn: p.enabled }))
    .sort((a, b) => a.id.localeCompare(b.id))
  await update($, rows, () => list)
  const saved = await $.store.get(STORE_KEY)
  await update($, hidden, () => (Array.isArray(saved) ? (saved as string[]) : []))
}

async function toggle($: Engine, row: PluginRow) {
  const verb = row.isOn ? 'disable' : 'enable'
  const ran = await $.process.run(
    ['claude', 'plugin', verb, row.id, '--scope', row.scope],
    { timeoutMs: 60000 },
  )
  if (ran.exitCode !== 0) {
    await update($, note, () => `Could not ${verb} ${shortName(row.id)}`)
    return
  }
  await update($, rows, list => list.map(r => (r.id === row.id ? { ...r, isOn: !r.isOn } : r)))
  await update($, note, () => `${shortName(row.id)} ${verb}d. Run /reload-plugins to apply.`)
}

// Saves the hide list for this session and for later ones.
async function hide($: Engine, ids: string[]) {
  await update($, hidden, () => ids)
  await $.store.set(STORE_KEY, ids)
}

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const open = await read($, isOpen)
    // Keep what other mods draw in this band (usage bar, goal meter) and add ours after it.
    const inner = await next(e)

    // Closed: one small button pinned to the right edge.
    if (!open) {
      return (
        <Box flexDirection="column">
          {inner}
          <Box justifyContent="flex-end">
            <Button
              key="open"
              label="⚙ Mods"
              onPress={async () => {
                await update($, isOpen, () => true)
                await update($, view, () => 'list')
                await refresh($)
              }}
            />
          </Box>
        </Box>
      )
    }

    const all = await read($, rows)
    const hiddenIds = await read($, hidden)
    const mode = await read($, view)
    const current = await read($, page)
    const message = await read($, note)

    const isSettings = mode === 'settings'
    // The main list shows the chosen plugins; settings lists every one.
    const list = isSettings ? all : all.filter(r => !hiddenIds.includes(r.id))
    const pages = Math.max(1, Math.ceil(list.length / PER_PAGE))
    const at = Math.min(current, pages - 1)
    const visible = list.slice(at * PER_PAGE, (at + 1) * PER_PAGE)
    const isPicked = (id: string) => !hiddenIds.includes(id)

    return (
      <Box flexDirection="column">
      {inner}
      <Box flexDirection="column" alignSelf="flex-end" borderStyle="round" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>{isSettings ? 'Choose plugins to show' : 'Mods & plugins'}</Text>
          <Box>
            <Button
              key="gear"
              label={isSettings ? '← Back' : '⚙'}
              onPress={async () => {
                await update($, view, () => (isSettings ? 'list' : 'settings'))
                await update($, page, () => 0)
              }}
            />
            <Text> </Text>
            <Button key="close" label="✕" onPress={() => update($, isOpen, () => false)} />
          </Box>
        </Box>

        {isSettings && (
          <Box>
            <Button key="all" label="All" onPress={() => hide($, [])} />
            <Text> </Text>
            <Button key="none" label="None" onPress={() => hide($, all.map(r => r.id))} />
          </Box>
        )}

        {list.length === 0 && (
          <Text dimColor>
            {isSettings ? 'No plugins found.' : 'Nothing selected. Press ⚙ to choose plugins.'}
          </Text>
        )}

        {visible.map(row =>
          isSettings ? (
            <Button
              key={`s:${row.id}`}
              plain
              label={`${isPicked(row.id) ? '☑' : '☐'} ${shortName(row.id)}`}
              onPress={() =>
                hide(
                  $,
                  isPicked(row.id)
                    ? [...hiddenIds, row.id]
                    : hiddenIds.filter(id => id !== row.id),
                )
              }
            />
          ) : (
            <Box key={row.id} justifyContent="space-between">
              <Button
                key={`n:${row.id}`}
                plain
                dimColor={!row.isOn}
                label={`${shortName(row.id)} `}
                onPress={() => toggle($, row)}
              />
              {/* Pill switch: blue with the knob right when on, grey with it left when off. */}
              <Box
                width={6}
                backgroundColor={row.isOn ? 'blue' : 'gray'}
                justifyContent={row.isOn ? 'flex-end' : 'flex-start'}
              >
                <Button key={`t:${row.id}`} plain label=" ● " onPress={() => toggle($, row)} />
              </Box>
            </Box>
          ),
        )}

        {pages > 1 && (
          <Box>
            <Button key="prev" label="◀" onPress={() => update($, page, () => Math.max(0, at - 1))} />
            <Text dimColor> {at + 1}/{pages} </Text>
            <Button key="next" label="▶" onPress={() => update($, page, () => Math.min(pages - 1, at + 1))} />
          </Box>
        )}
        {message !== '' && <Text dimColor>{message}</Text>}
      </Box>
      </Box>
    )
  })
}
