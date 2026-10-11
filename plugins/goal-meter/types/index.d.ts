export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type GoalTask = { id: string; text: string; status: TaskStatus; startedAt?: number; endedAt?: number }
export type Goal = {
  sid: string
  title: string
  startedAt: number
  updatedAt: number
  doneAt?: number
  explicit?: boolean
  activity?: GoalTask[]
  tasks: GoalTask[]
}

declare module 'claude-code' {
  interface PluginState {
    'goal-meter': { mine: Goal | null; others: Goal[]; now: number; isOpen: boolean; isHidden: boolean }
  }
}
