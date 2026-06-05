import {
  Download,
  MousePointer2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Video,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { CURSOR_STYLES, SPRITES } from './data/sprites'
import { readCursorStyle, saveCursorStyle, useCursorEffect } from './hooks/useCursorEffect'
import {
  checkBackend,
  backendUrl,
  fetchBackendSprites,
  fetchLatestTask,
  uploadVideo,
  type BackendStatus,
  type ConvertTask,
  type UploadParams,
} from './lib/backendClient'
import {
  angleToDiskPosition,
  clamp,
  degreesToRadians,
  frameToBackgroundPosition,
  normalizePoints2D,
  positionToAngle,
  progress2DToFrame,
  radiansToDegrees,
} from './lib/spriteMath'
import type { CalibrationPoint, Point } from './lib/spriteMath'
import type { CursorStyle, LoadedSprite, SpriteAsset, SpriteMetadata } from './lib/spriteTypes'

type Route = 'preview' | 'convert'

type LoadState =
  | { status: 'loading' }
  | { status: 'loading_image'; sprite: LoadedSprite; progress: number }
  | { status: 'ready'; sprite: LoadedSprite }
  | { status: 'error'; message: string }

function App() {
  const [route, setRoute] = useState<Route>(() => readRoute())
  const [backendStatus, setBackendStatus] = useState<BackendStatus>({
    online: false,
    url: 'http://127.0.0.1:8003',
    message: 'Not checked',
  })
  const [sprites, setSprites] = useState<SpriteAsset[]>(SPRITES)

  const refreshBackend = useCallback(() => {
    checkBackend()
      .then((status) => {
        setBackendStatus(status)
        if (!status.online) {
          setSprites(SPRITES)
          return []
        }
        return fetchBackendSprites(status.url)
      })
      .then((backendSprites) => {
        if (!backendSprites || backendSprites.length === 0) return
        setSprites(mergeSprites(SPRITES, backendSprites))
      })
      .catch((error: Error) => {
        setBackendStatus({ online: false, url: backendUrl(), message: error.message })
      })
  }, [])

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (route === 'convert') refreshBackend()
  }, [refreshBackend, route])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">SpritePet</p>
          <h1>{route === 'convert' ? 'Video to sprite converter' : 'Video sprite pet preview and calibration'}</h1>
        </div>
        <nav className="topnav" aria-label="Primary">
          <a className={route === 'preview' ? 'is-active' : ''} href="#/">
            Preview
          </a>
          <a className={route === 'convert' ? 'is-active' : ''} href="#/convert">
            Convert
          </a>
        </nav>
      </header>

      {route === 'convert' ? (
        <ConvertPage backendStatus={backendStatus} onRefreshBackend={refreshBackend} />
      ) : (
        <PreviewPage sprites={sprites} />
      )}
    </main>
  )
}

function PreviewPage({ sprites }: { sprites: SpriteAsset[] }) {
  const [selectedSpriteId, setSelectedSpriteId] = useState(sprites[0]?.id ?? 'cat-sprite')
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [cursorStyle, setCursorStyle] = useState<CursorStyle>(() => readCursorStyle())
  const [centerPoint, setCenterPoint] = useState<Point | null>(null)
  const [calibrationPoints, setCalibrationPoints] = useState<CalibrationPoint[]>([])
  const [selectedPointIndex, setSelectedPointIndex] = useState(0)
  const [selectedFrame, setSelectedFrame] = useState(0)
  const [calibrating, setCalibrating] = useState(false)
  const [settingCenter, setSettingCenter] = useState(false)
  const [showCenterMarker, setShowCenterMarker] = useState(false)
  const [pointerPos, setPointerPos] = useState<Point>({ x: 0.5, y: 0.5 })
  const spriteRef = useRef<HTMLDivElement>(null)
  const imageUrlRef = useRef<string | null>(null)

  useCursorEffect(cursorStyle)

  const effectiveSpriteId = sprites.some((sprite) => sprite.id === selectedSpriteId)
    ? selectedSpriteId
    : sprites[0]?.id ?? 'cat-sprite'

  useEffect(() => {
    let alive = true
    const asset = sprites.find((sprite) => sprite.id === effectiveSpriteId) ?? sprites[0]
    if (!asset) return undefined

    // Revoke previous blob URL
    if (imageUrlRef.current && imageUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(imageUrlRef.current)
    }
    imageUrlRef.current = null

    loadSpriteMetadata(asset)
      .then(async (metadata) => {
        if (!alive) return
        const normalized = normalizeMetadata(metadata)
        const points = normalizePoints2D(normalized.calibration?.calibrationPoints ?? [], normalized.frameCount)
        const sprite: LoadedSprite = { ...asset, metadata: normalized }

        setLoadState({ status: 'loading_image', sprite, progress: 0 })
        setCenterPoint(normalized.calibration?.centerPoint ?? null)
        setCalibrationPoints(points)
        setSelectedPointIndex(points.length > 0 ? 0 : -1)
        setSelectedFrame(points[0]?.frame ?? 0)
        setCalibrating(Boolean(normalized.calibration?.calibrating))
        setPointerPos(normalized.calibration?.centerPoint ?? { x: 0.5, y: 0.5 })

        // Preload the WebP image with download progress
        const imageUrl = spriteImageUrl(asset, normalized)
        try {
          const loadedUrl = await fetchImageWithProgress(imageUrl, (progress) => {
            if (alive) setLoadState({ status: 'loading_image', sprite, progress })
          })
          if (!alive) return
          imageUrlRef.current = loadedUrl
        } catch {
          // Fall back to original URL if progress tracking fails
          imageUrlRef.current = imageUrl
        }

        if (alive) setLoadState({ status: 'ready', sprite })
      })
      .catch((error: Error) => {
        if (alive) setLoadState({ status: 'error', message: error.message })
      })

    return () => {
      alive = false
    }
  }, [effectiveSpriteId, sprites])

  const metadata = loadState.status === 'ready' ? loadState.sprite.metadata : null
  const activeAsset = loadState.status === 'ready' ? loadState.sprite : null
  const frameCount = metadata?.frameCount ?? 1
  const points = useMemo(
    () => normalizePoints2D(calibrationPoints, frameCount),
    [calibrationPoints, frameCount],
  )

  const activeFrame = useMemo(() => {
    if (!metadata) return 0
    if (calibrating || !centerPoint || points.length < 2) return clamp(selectedFrame, 0, frameCount - 1)

    return progress2DToFrame(pointerPos, {
      centerPoint,
      points,
      frameCount,
      reverse: Boolean(metadata.calibration?.reverse),
    })
  }, [calibrating, centerPoint, frameCount, metadata, pointerPos, points, selectedFrame])

  const currentAngle = centerPoint
    ? positionToAngle(centerPoint.x, centerPoint.y, pointerPos.x, pointerPos.y)
    : 0
  const selectedPoint = points[selectedPointIndex] ?? null
  const backgroundPosition = metadata
    ? frameToBackgroundPosition(activeFrame, metadata.columns, metadata.rows)
    : { x: 0, y: 0 }
  const calibrationJson = useMemo(
    () =>
      JSON.stringify(
        {
          centerPoint,
          calibrationPoints: points,
          calibrating,
        },
        null,
        2,
      ),
    [calibrating, centerPoint, points],
  )

  const handleCursorChange = (style: CursorStyle) => {
    setCursorStyle(style)
    saveCursorStyle(style)
  }

  const updatePointerFromEvent = (event: PointerEvent | React.PointerEvent) => {
    const rect = spriteRef.current?.getBoundingClientRect()
    if (!rect) return

    setPointerPos({
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
    })
  }

  useEffect(() => {
    const move = (event: PointerEvent) => updatePointerFromEvent(event)
    window.addEventListener('pointermove', move, { passive: true })
    return () => window.removeEventListener('pointermove', move)
  }, [])

  const handleSpriteClick = (event: React.PointerEvent) => {
    updatePointerFromEvent(event)
    const rect = spriteRef.current?.getBoundingClientRect()
    if (!rect) return

    const pos = {
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
    }

    if (settingCenter) {
      setCenterPoint(pos)
      setSettingCenter(false)
    }
  }

  const addCurrentPoint = () => {
    if (!centerPoint) return
    const point = {
      angle: positionToAngle(centerPoint.x, centerPoint.y, pointerPos.x, pointerPos.y),
      frame: clamp(selectedFrame, 0, frameCount - 1),
    }
    const next = normalizePoints2D([...points, point], frameCount)
    setCalibrationPoints(next)
    setSelectedPointIndex(next.findIndex((item) => item.angle === point.angle && item.frame === point.frame))
  }

  const updateSelectedPoint = (patch: Partial<CalibrationPoint>) => {
    if (!selectedPoint) return
    const next = [...points]
    next[selectedPointIndex] = {
      angle: patch.angle ?? selectedPoint.angle,
      frame: clamp(Math.round(patch.frame ?? selectedPoint.frame), 0, frameCount - 1),
    }
    const normalized = normalizePoints2D(next, frameCount)
    setCalibrationPoints(normalized)
    setSelectedPointIndex(Math.max(0, normalized.findIndex((point) => point.angle === next[selectedPointIndex].angle)))
  }

  const removeSelectedPoint = () => {
    if (!selectedPoint) return
    const next = points.filter((_, index) => index !== selectedPointIndex)
    setCalibrationPoints(next)
    setSelectedPointIndex(Math.min(selectedPointIndex, next.length - 1))
  }

  const resetFromMetadata = () => {
    if (!metadata) return
    const nextPoints = normalizePoints2D(metadata.calibration?.calibrationPoints ?? [], metadata.frameCount)
    setCenterPoint(metadata.calibration?.centerPoint ?? null)
    setCalibrationPoints(nextPoints)
    setSelectedPointIndex(nextPoints.length > 0 ? 0 : -1)
    setSelectedFrame(nextPoints[0]?.frame ?? 0)
    setCalibrating(Boolean(metadata.calibration?.calibrating))
  }

  return (
    <section className="workspace">
      <aside className="control-panel" aria-label="Sprite controls">
        <PanelTitle icon={<SlidersHorizontal size={18} />} title="Sprite" />
        <label>
          Asset
          <select value={effectiveSpriteId} onChange={(event) => setSelectedSpriteId(event.target.value)}>
            {sprites.map((sprite) => (
              <option value={sprite.id} key={`${sprite.source}-${sprite.id}`}>
                {sprite.label} {sprite.source === 'backend' ? '(local)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          Cursor
          <select
            value={cursorStyle}
            onChange={(event) => handleCursorChange(event.target.value as CursorStyle)}
          >
            {CURSOR_STYLES.map((style) => (
              <option value={style.id} key={style.id}>
                {style.label}
              </option>
            ))}
          </select>
        </label>

        <div className="segmented" aria-label="Preview mode">
          <button className={!calibrating ? 'is-active' : ''} type="button" onClick={() => setCalibrating(false)}>
            <MousePointer2 size={16} />
            Play
          </button>
          <button className={calibrating ? 'is-active' : ''} type="button" onClick={() => setCalibrating(true)}>
            <Sparkles size={16} />
            Calibrate
          </button>
        </div>

        <label>
          Frame
          <input
            min={0}
            max={Math.max(0, frameCount - 1)}
            type="range"
            value={selectedFrame}
            onChange={(event) => setSelectedFrame(Number(event.target.value))}
          />
        </label>
        <output>{selectedFrame} / {Math.max(0, frameCount - 1)}</output>

        <div className="button-row">
          <button type="button" onClick={() => setSettingCenter(true)}>Set center</button>
          <button type="button" onClick={addCurrentPoint} disabled={!centerPoint}>Add point</button>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showCenterMarker}
            onChange={(e) => setShowCenterMarker(e.target.checked)}
          />
          Show center marker
        </label>
        <button className="ghost-button" type="button" onClick={resetFromMetadata}>
          <RotateCcw size={16} />
          Reset metadata
        </button>
      </aside>

      <section className="stage" aria-label="Sprite preview">
        {loadState.status === 'loading' || loadState.status === 'loading_image' ? (
          <div className="image-loading">
            <div className="image-loading-message">
              {loadState.status === 'loading_image' ? `Loading… ${loadState.progress}%` : 'Loading…'}
            </div>
            <div className="progress-track">
              <span style={{ width: `${loadState.status === 'loading_image' ? loadState.progress : 0}%` }} />
            </div>
          </div>
        ) : null}
        {loadState.status === 'error' ? <div className="loading">{loadState.message}</div> : null}
        {metadata ? (
          <>
            <div className="stage-meta">
              <span>{activeAsset?.label}</span>
              <span>Frame {activeFrame}</span>
              <span>{radiansToDegrees(currentAngle)} deg</span>
            </div>
            <div
              className={`sprite-view ${settingCenter ? 'is-setting-center' : ''}`}
              ref={spriteRef}
              role="img"
              aria-label="Animated pet sprite"
              onPointerDown={handleSpriteClick}
              style={{
                aspectRatio: `${metadata.frameWidth} / ${metadata.frameHeight}`,
                backgroundImage: `url("${imageUrlRef.current ?? spriteImageUrl(activeAsset, metadata)}")`,
                backgroundSize: `${metadata.columns * 100}% ${metadata.rows * 100}%`,
                backgroundPosition: `${backgroundPosition.x}% ${backgroundPosition.y}%`,
              }}
            >
              {centerPoint && showCenterMarker ? (
                <span
                  className="center-marker"
                  style={{ left: `${centerPoint.x * 100}%`, top: `${centerPoint.y * 100}%` }}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </section>

      <aside className="calibration-panel" aria-label="Calibration controls">
        <PanelTitle icon={<Sparkles size={18} />} title="Calibration" />
        <div className="disk" aria-label="Calibration disk">
          <span className="needle" style={{ transform: `rotate(${-radiansToDegrees(currentAngle)}deg)` }} />
          {points.map((point, index) => {
            const pos = angleToDiskPosition(point.angle)
            return (
              <button
                type="button"
                className={`calibration-handle${index === selectedPointIndex ? ' is-selected' : ''}`}
                style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
                key={`${point.angle}-${point.frame}`}
                onClick={() => {
                  setSelectedPointIndex(index)
                  setSelectedFrame(point.frame)
                }}
              >
                {point.frame}
              </button>
            )
          })}
        </div>

        <div className="point-editor">
          <label>
            Angle
            <input
              disabled={!selectedPoint}
              type="number"
              value={selectedPoint ? radiansToDegrees(selectedPoint.angle) : 0}
              onChange={(event) => updateSelectedPoint({ angle: degreesToRadians(Number(event.target.value)) })}
            />
          </label>
          <label>
            Frame
            <input
              disabled={!selectedPoint}
              min={0}
              max={Math.max(0, frameCount - 1)}
              type="number"
              value={selectedPoint?.frame ?? selectedFrame}
              onChange={(event) => updateSelectedPoint({ frame: Number(event.target.value) })}
            />
          </label>
        </div>
        <button className="ghost-button" type="button" onClick={removeSelectedPoint} disabled={!selectedPoint}>
          Remove point
        </button>

        <label>
          Calibration JSON
          <textarea readOnly value={calibrationJson} />
        </label>
        <a
          className="download-link"
          href={`data:application/json;charset=utf-8,${encodeURIComponent(calibrationJson)}`}
          download={`${selectedSpriteId}-calibration.json`}
        >
          <Download size={16} />
          Download JSON
        </a>
      </aside>
    </section>
  )
}

function ConvertPage({
  backendStatus,
  onRefreshBackend,
}: {
  backendStatus: BackendStatus
  onRefreshBackend: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [params, setParams] = useState<UploadParams>({
    frames: 360,
    framesAuto: true,
    columns: 20,
    maxFrameHeight: 512,
    padding: 18,
    despillStrength: 1,
    alphaThreshold: 35,
  })
  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<ConvertTask | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const logsRef = useRef<HTMLDivElement>(null)

  // On mount, check for an active task and reconnect
  useEffect(() => {
    if (!backendStatus.online) return
    fetchLatestTask(backendStatus.url)
      .then((latest) => {
        if (latest && latest.status === 'processing') {
          setTaskId(latest.id)
        }
      })
      .catch(() => {})
  }, [backendStatus.online, backendStatus.url])

  // Auto-scroll logs
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    if (!taskId || !backendStatus.online) return undefined

    setLogs([])
    setTask({ id: taskId, status: 'processing', progress: 0, error: null })
    setError(null)

    const es = new EventSource(`${backendStatus.url}/api/task/${encodeURIComponent(taskId)}/stream`)

    es.addEventListener('progress', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      setTask((prev) => prev ? { ...prev, progress: data.progress } : null)
    })

    es.addEventListener('log', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      setLogs((prev) => [...prev, data.message])
    })

    es.addEventListener('done', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      setTask((prev) => prev ? { ...prev, status: 'done', progress: 100, spriteName: data.spriteName, metadataPath: data.metadataPath } : null)
      onRefreshBackend()
      es.close()
    })

    es.addEventListener('error', (e: MessageEvent) => {
      if (e.data) {
        const data = JSON.parse(e.data)
        setError(data.error)
        setTask((prev) => prev ? { ...prev, status: 'error', error: data.error } : null)
      } else {
        setError('Connection lost')
      }
      es.close()
    })

    return () => {
      es.close()
    }
  }, [backendStatus, onRefreshBackend, taskId])

  const startUpload = async () => {
    if (!file || !backendStatus.online) return
    setError(null)
    setTask(null)
    try {
      const result = await uploadVideo(file, params, backendStatus.url)
      setTaskId(result.taskId)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed')
    }
  }

  return (
    <section className="convert-layout">
      <section className="convert-panel">
        <PanelTitle icon={<Video size={18} />} title="Video converter" />
        <BackendBadge status={backendStatus} />

        <label className="file-drop">
          <Upload size={26} />
          <span>{file ? file.name : 'Choose a video file'}</span>
          <input
            type="file"
            accept="video/*"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>

        <div className="param-grid">
          <div className="frames-field">
            <NumberField label="Frames" value={params.frames} min={1} max={360} onChange={(frames) => setParams({ ...params, frames })} disabled={params.framesAuto} />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={params.framesAuto}
                onChange={(e) => setParams({ ...params, framesAuto: e.target.checked })}
              />
              Auto
            </label>
          </div>
          <NumberField label="Columns" value={params.columns} min={1} max={50} onChange={(columns) => setParams({ ...params, columns })} />
          <NumberField label="Max height" value={params.maxFrameHeight} min={64} max={2048} onChange={(maxFrameHeight) => setParams({ ...params, maxFrameHeight })} />
          <NumberField label="Padding" value={params.padding} min={0} max={100} onChange={(padding) => setParams({ ...params, padding })} />
          <NumberField label="Alpha threshold" value={params.alphaThreshold} min={0} max={255} onChange={(alphaThreshold) => setParams({ ...params, alphaThreshold })} />
          <NumberField label="Despill" value={params.despillStrength} min={0} max={2} step={0.1} onChange={(despillStrength) => setParams({ ...params, despillStrength })} />
        </div>

        <button type="button" className="primary-button" disabled={!backendStatus.online || !file} onClick={startUpload}>
          <Upload size={16} />
          Convert video
        </button>

        {!backendStatus.online ? (
          <p className="notice">Backend is not connected. Start `backend/start.sh` to enable conversion.</p>
        ) : null}
      </section>

      <section className="convert-panel">
        <PanelTitle icon={<Sparkles size={18} />} title="Task status" />
        {task ? (
          <>
            <div className="progress-track">
              <span style={{ width: `${clamp(task.progress, 0, 100)}%` }} />
            </div>
            <div className="task-grid">
              <span>Status</span>
              <strong>{task.status}</strong>
              <span>Progress</span>
              <strong>{task.progress}%</strong>
              <span>Sprite</span>
              <strong>{task.spriteName ?? '-'}</strong>
            </div>
            {logs.length > 0 ? (
              <div className="task-logs" ref={logsRef}>
                {logs.map((line, i) => (
                  <span key={i}>{line}</span>
                ))}
              </div>
            ) : null}
            {task.status === 'done' ? (
              <a className="download-link" href="#/">
                Open preview
              </a>
            ) : null}
            {task.status === 'error' ? (
              <div className="task-error">
                <strong>Conversion failed</strong>
                <p>{task.error}</p>
              </div>
            ) : null}
          </>
        ) : error ? (
          <div className="task-error">
            <strong>Request failed</strong>
            <p>{error}</p>
          </div>
        ) : (
          <p className="notice">No conversion task is running.</p>
        )}
      </section>
    </section>
  )
}

function BackendBadge({ status }: { status: BackendStatus }) {
  return (
    <div className={`backend-badge ${status.online ? 'is-online' : 'is-offline'}`}>
      <span>{status.online ? 'Backend online' : 'Backend offline'}</span>
      <code>{status.url}</code>
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  )
}

function readRoute(): Route {
  return window.location.hash.replace(/^#\/?/, '') === 'convert' ? 'convert' : 'preview'
}

function mergeSprites(staticSprites: SpriteAsset[], backendSprites: SpriteAsset[]) {
  const byId = new Map<string, SpriteAsset>()
  for (const sprite of [...staticSprites, ...backendSprites]) {
    byId.set(sprite.id, sprite)
  }
  return [...byId.values()]
}

async function loadSpriteMetadata(asset: SpriteAsset) {
  const url = asset.metadataUrl ?? `${import.meta.env.BASE_URL}${asset.metadataPath}`
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load ${url}`)
  return (await response.json()) as SpriteMetadata
}

function spriteImageUrl(asset: SpriteAsset | null, metadata: SpriteMetadata) {
  return `${asset?.imageBaseUrl ?? `${import.meta.env.BASE_URL}sprites/`}${metadata.image}`
}

/** Preload an image via fetch with download progress callbacks. Returns a blob URL. */
async function fetchImageWithProgress(
  url: string,
  onProgress: (progress: number) => void,
): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load image: ${response.statusText}`)

  const contentLength = response.headers.get('Content-Length')
  const body = response.body
  if (!contentLength || !body) return url

  const total = parseInt(contentLength, 10)
  let received = 0
  const chunks: Uint8Array[] = []
  const reader = body.getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress(Math.min(Math.round((received / total) * 100), 99))
  }

  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.length
  }
  const blob = new Blob([all], { type: 'image/webp' })
  return URL.createObjectURL(blob)
}

function normalizeMetadata(metadata: SpriteMetadata): SpriteMetadata {
  const frameCount = Math.max(1, Math.round(Number(metadata.frameCount)))
  const columns = Math.max(1, Math.round(Number(metadata.columns)))
  const rows = Math.max(1, Math.round(Number(metadata.rows)))
  const frameWidth = Math.max(1, Math.round(Number(metadata.frameWidth)))
  const frameHeight = Math.max(1, Math.round(Number(metadata.frameHeight)))

  return {
    ...metadata,
    frameCount,
    columns,
    rows,
    frameWidth,
    frameHeight,
    spriteWidth: Number(metadata.spriteWidth) || frameWidth * columns,
    spriteHeight: Number(metadata.spriteHeight) || frameHeight * rows,
  }
}

export default App
