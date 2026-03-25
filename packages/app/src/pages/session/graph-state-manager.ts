import type { ResearchAtomsListResponse } from "@opencode-ai/sdk/v2"

type Atom = ResearchAtomsListResponse["atoms"][number]
type Relation = ResearchAtomsListResponse["relations"][number]

export interface GraphState {
  positions: Record<string, { x: number; y: number }>
  viewport: {
    zoom: number
    centerX: number
    centerY: number
  }
  metadata: {
    timestamp: number
    version: string
    projectId: string
  }
}

export interface Position {
  x: number
  y: number
}

export class GraphStateManager {
  private readonly projectId: string
  private readonly storageKey: string
  private saveTimeout: ReturnType<typeof setTimeout> | undefined
  private readonly SAVE_DELAY = 500 // 防抖延迟500ms
  private readonly VERSION = "1.0.0"

  constructor(projectId: string) {
    this.projectId = projectId
    this.storageKey = `graph-state-${projectId}`
  }

  // 从localStorage加载保存的状态
  loadState(): GraphState | null {
    if (typeof window === "undefined") return null

    try {
      const saved = localStorage.getItem(this.storageKey)
      if (!saved) return null

      const state = JSON.parse(saved) as GraphState

      // 验证数据完整性
      if (!this.validateState(state)) {
        console.warn("Invalid graph state, clearing...")
        this.clearState()
        return null
      }

      return state
    } catch (error) {
      console.warn("Failed to load graph state:", error)
      this.clearState()
      return null
    }
  }

  // 保存状态到localStorage（防抖）
  saveState(positions: Record<string, Position>, viewport: { zoom: number; centerX: number; centerY: number }) {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }

    this.saveTimeout = setTimeout(() => {
      this.doSaveState(positions, viewport)
    }, this.SAVE_DELAY)
  }

  private doSaveState(
    positions: Record<string, Position>,
    viewport: { zoom: number; centerX: number; centerY: number },
  ) {
    if (typeof window === "undefined") return

    try {
      const state: GraphState = {
        positions: this.compressPositions(positions),
        viewport,
        metadata: {
          timestamp: Date.now(),
          version: this.VERSION,
          projectId: this.projectId,
        },
      }

      const dataString = JSON.stringify(state)

      if (!this.checkStorageCapacity(dataString.length)) {
        console.warn("Storage capacity exceeded, attempting cleanup...")
        this.cleanupOldData()
      }

      localStorage.setItem(this.storageKey, dataString)
    } catch (error) {
      console.warn("Failed to save graph state:", error)
    }
  }

  // 清除保存的状态
  clearState() {
    if (typeof window === "undefined") return

    try {
      localStorage.removeItem(this.storageKey)
    } catch (error) {
      console.warn("Failed to clear graph state:", error)
    }
  }

  // 验证状态数据完整性
  private validateState(state: any): state is GraphState {
    return (
      state &&
      typeof state === "object" &&
      state.positions &&
      typeof state.positions === "object" &&
      state.viewport &&
      typeof state.viewport === "object" &&
      typeof state.viewport.zoom === "number" &&
      typeof state.viewport.centerX === "number" &&
      typeof state.viewport.centerY === "number" &&
      state.metadata &&
      typeof state.metadata === "object" &&
      typeof state.metadata.timestamp === "number" &&
      typeof state.metadata.version === "string" &&
      typeof state.metadata.projectId === "string"
    )
  }

  // 压缩位置数据（减少存储空间）
  private compressPositions(positions: Record<string, Position>): Record<string, Position> {
    return Object.entries(positions).reduce(
      (acc, [id, pos]) => {
        acc[id] = {
          x: Math.round(pos.x * 10) / 10, // 保留一位小数
          y: Math.round(pos.y * 10) / 10,
        }
        return acc
      },
      {} as Record<string, Position>,
    )
  }

  // 检查存储容量
  private checkStorageCapacity(dataSize: number): boolean {
    try {
      const currentUsage = this.getStorageUsage()
      const limit = 5 * 1024 * 1024 // 5MB
      return currentUsage + dataSize < limit * 0.9 // 保留10%缓冲
    } catch {
      return false
    }
  }

  // 获取当前存储使用量
  private getStorageUsage(): number {
    let total = 0
    for (let key in localStorage) {
      if (localStorage.hasOwnProperty(key)) {
        total += localStorage[key].length + key.length
      }
    }
    return total
  }

  // 清理旧数据
  private cleanupOldData() {
    try {
      // 清理其他项目的旧数据（保留最近的项目）
      const keysToRemove: string[] = []

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith("graph-state-") && key !== this.storageKey) {
          try {
            const data = JSON.parse(localStorage.getItem(key) || "{}")
            const age = Date.now() - (data.metadata?.timestamp || 0)

            // 删除超过30天的旧数据
            if (age > 30 * 24 * 60 * 60 * 1000) {
              keysToRemove.push(key)
            }
          } catch {
            keysToRemove.push(key) // 损坏的数据也删除
          }
        }
      }

      keysToRemove.forEach((key) => localStorage.removeItem(key))
    } catch (error) {
      console.warn("Failed to cleanup old data:", error)
    }
  }
  // 基于关系计算位置
  // 获取项目ID
  getProjectId(): string {
    return this.projectId
  }
}
