export type Point = {
  x: number
  y: number
}

export type CalibrationPoint = {
  angle: number
  frame: number
}

export type FrameGrid = {
  column: number
  row: number
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function frameToGrid(index: number, columns: number, rows: number): FrameGrid {
  const columnCount = Math.max(1, Math.round(columns))
  const rowCount = Math.max(1, Math.round(rows))
  const maxFrame = columnCount * rowCount - 1
  const bounded = clamp(Math.max(0, Math.round(index)), 0, maxFrame)

  return {
    column: bounded % columnCount,
    row: clamp(Math.floor(bounded / columnCount), 0, rowCount - 1),
  }
}

export function frameToBackgroundPosition(index: number, columns: number, rows: number) {
  const { column, row } = frameToGrid(index, columns, rows)

  return {
    x: columns <= 1 ? 0 : (column / (columns - 1)) * 100,
    y: rows <= 1 ? 0 : (row / (rows - 1)) * 100,
  }
}

export function normalizeAngle(angle: number) {
  return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
}

export function positionToAngle(cx: number, cy: number, px: number, py: number) {
  const dx = px - cx
  const dy = py - cy
  return normalizeAngle(Math.atan2(-dy, dx))
}

export function degreesToRadians(deg: number) {
  return (deg * Math.PI) / 180
}

export function radiansToDegrees(angle: number) {
  return Math.round((normalizeAngle(angle) * 180) / Math.PI)
}

export function normalizeFrame(frame: number, frameCount: number) {
  const frames = Math.max(1, Math.round(frameCount))
  return ((Math.round(frame) % frames) + frames) % frames
}

export function normalizePoints2D(points: CalibrationPoint[], frameCount: number) {
  if (!Array.isArray(points)) return []

  const seen = new Set<string>()
  const result: CalibrationPoint[] = []

  for (const point of points) {
    const frame = clamp(Math.round(Number(point.frame)), 0, frameCount - 1)
    const angle = Number(point.angle)
    if (!Number.isFinite(angle) || !Number.isFinite(frame)) continue

    const normAngle = normalizeAngle(angle)
    const key = normAngle.toFixed(3)
    if (seen.has(key)) continue

    seen.add(key)
    result.push({ angle: normAngle, frame })
  }

  return result.sort((a, b) => a.angle - b.angle)
}

function normalizePointsClockwise(points: CalibrationPoint[], frameCount: number) {
  return normalizePoints2D(points, frameCount).sort((a, b) => b.angle - a.angle)
}

function clockwiseSpan(fromAngle: number, toAngle: number) {
  let span = fromAngle - toAngle
  if (span < 0) span += 2 * Math.PI
  return span
}

function radiansToDegreeFloat(angle: number) {
  return (angle * 180) / Math.PI
}

function clockwiseSegmentForAngle(queryAngle: number, points: CalibrationPoint[]) {
  const angle = normalizeAngle(queryAngle)

  for (let index = 0; index < points.length; index += 1) {
    const left = points[index]
    const right = points[(index + 1) % points.length]
    const span = Math.max(0.0001, clockwiseSpan(left.angle, right.angle))
    const distance = clockwiseSpan(left.angle, angle)

    if (distance <= span + 0.000001) {
      return { left, right, local: clamp(distance / span, 0, 1) }
    }
  }

  return { left: points[0], right: points[0], local: 0 }
}

export function interpolateCircularPoints(
  queryAngle: number,
  points: CalibrationPoint[],
  frameCount: number,
) {
  const frames = Math.max(1, Math.round(frameCount))
  const normalized = normalizePointsClockwise(points, frames)
  if (normalized.length === 0) return 0
  if (normalized.length === 1) return normalized[0].frame

  const angle = normalizeAngle(queryAngle)
  const exact = normalized.find((point) => Math.abs(point.angle - angle) < 0.000001)
  if (exact) return exact.frame

  const { left, right, local } = clockwiseSegmentForAngle(queryAngle, normalized)
  const rawDelta = right.frame - left.frame
  const maxDelta = radiansToDegreeFloat(clockwiseSpan(left.angle, right.angle))
  const frameDelta = clamp(rawDelta, -maxDelta, maxDelta)

  return normalizeFrame(left.frame + local * frameDelta, frames)
}

export function progress2DToFrame(
  pos: Point,
  options: {
    centerPoint: Point | null
    points: CalibrationPoint[]
    frameCount: number
    reverse?: boolean
  },
) {
  if (!options.centerPoint) return 0

  const angle = positionToAngle(options.centerPoint.x, options.centerPoint.y, pos.x, pos.y)
  const mappedAngle = options.reverse ? normalizeAngle(-angle) : angle

  return interpolateCircularPoints(mappedAngle, options.points, options.frameCount)
}

export function angleToDiskPosition(angle: number) {
  const radius = 42

  return {
    left: 50 + Math.cos(angle) * radius,
    top: 50 - Math.sin(angle) * radius,
  }
}
