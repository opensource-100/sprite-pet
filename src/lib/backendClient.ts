import type { SpriteAsset } from './spriteTypes'

export type BackendStatus =
  | { online: true; url: string }
  | { online: false; url: string; message: string }

export type UploadParams = {
  frames: number
  framesAuto: boolean
  columns: number
  maxFrameHeight: number
  padding: number
  despillStrength: number
  alphaThreshold: number
}

export type ConvertTask = {
  id: string
  status: 'processing' | 'done' | 'error'
  progress: number
  error: string | null
  spriteName?: string
  metadataPath?: string
}

export function backendUrl() {
  return (import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:8003').replace(/\/$/, '')
}

export async function checkBackend(): Promise<BackendStatus> {
  const url = backendUrl()
  try {
    const response = await fetch(`${url}/api/health`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { online: true, url }
  } catch (error) {
    return {
      online: false,
      url,
      message: error instanceof Error ? error.message : 'Backend unavailable',
    }
  }
}

export async function fetchBackendSprites(url = backendUrl()): Promise<SpriteAsset[]> {
  const response = await fetch(`${url}/api/sprites`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load backend sprites: ${response.status}`)
  const data = (await response.json()) as {
    sprites?: Array<{ id: string; name: string; label?: string }>
  }

  return (data.sprites ?? []).map((sprite) => ({
    id: sprite.id,
    label: sprite.label || sprite.id,
    metadataUrl: `${url}/api/sprites/${encodeURIComponent(sprite.name)}/metadata`,
    imageBaseUrl: `${url}/sprites/`,
    source: 'backend',
  }))
}

export async function uploadVideo(file: File, params: UploadParams, url = backendUrl()) {
  const formData = new FormData()
  formData.append('video', file)
  formData.append('params', JSON.stringify(params))

  const response = await fetch(`${url}/api/upload`, {
    method: 'POST',
    body: formData,
  })
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`)

  return (await response.json()) as { taskId: string; status: string }
}

export async function fetchLatestTask(url = backendUrl()): Promise<ConvertTask | null> {
  const response = await fetch(`${url}/api/task/latest`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load latest task: ${response.status}`)
  const data = (await response.json()) as { task: ConvertTask | null }
  return data.task
}

export async function fetchTask(taskId: string, url = backendUrl()): Promise<ConvertTask> {
  const response = await fetch(`${url}/api/task/${encodeURIComponent(taskId)}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load task: ${response.status}`)
  return (await response.json()) as ConvertTask
}
