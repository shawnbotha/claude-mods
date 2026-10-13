export type PluginRow = { id: string; scope: string; isOn: boolean }

declare module 'claude-code' {
  interface PluginState {
    'plugin-switcher': {
      isOpen: boolean
      view: 'list' | 'settings'
      rows: PluginRow[]
      hidden: string[]
      page: number
      note: string
    }
  }
}
