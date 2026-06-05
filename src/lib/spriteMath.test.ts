import { describe, expect, it } from 'vitest'
import {
  frameToBackgroundPosition,
  frameToGrid,
  interpolateCircularPoints,
  normalizePoints2D,
  progress2DToFrame,
} from './spriteMath'

describe('sprite frame math', () => {
  it('maps a frame index to a bounded sprite grid cell', () => {
    expect(frameToGrid(23, 10, 3)).toEqual({ column: 3, row: 2 })
    expect(frameToGrid(-4, 10, 3)).toEqual({ column: 0, row: 0 })
    expect(frameToGrid(99, 10, 3)).toEqual({ column: 9, row: 2 })
  })

  it('converts a frame index to CSS background percentages', () => {
    expect(frameToBackgroundPosition(11, 10, 3)).toEqual({ x: 100 / 9, y: 50 })
    expect(frameToBackgroundPosition(0, 1, 1)).toEqual({ x: 0, y: 0 })
  })
})

describe('angle calibration', () => {
  it('normalizes calibration points by angle and clamps frames', () => {
    const points = normalizePoints2D(
      [
        { angle: Math.PI * 2 + Math.PI / 2, frame: 20 },
        { angle: -Math.PI / 2, frame: -5 },
        { angle: Number.NaN, frame: 3 },
      ],
      10,
    )

    expect(points).toEqual([
      { angle: Math.PI / 2, frame: 9 },
      { angle: (Math.PI * 3) / 2, frame: 0 },
    ])
  })

  it('interpolates clockwise between angle calibration points', () => {
    const points = [
      { angle: Math.PI, frame: 20 },
      { angle: 0, frame: 10 },
    ]

    expect(interpolateCircularPoints(Math.PI, points, 40)).toBe(20)
    expect(interpolateCircularPoints(Math.PI / 2, points, 40)).toBe(15)
    expect(interpolateCircularPoints(0, points, 40)).toBe(10)
  })

  it('maps pointer positions around a center point to calibrated frames', () => {
    const points = [
      { angle: 0, frame: 5 },
      { angle: Math.PI / 2, frame: 15 },
      { angle: Math.PI, frame: 25 },
      { angle: (Math.PI * 3) / 2, frame: 35 },
    ]

    expect(
      progress2DToFrame(
        { x: 1, y: 0.5 },
        { centerPoint: { x: 0.5, y: 0.5 }, points, frameCount: 40 },
      ),
    ).toBe(5)
    expect(
      progress2DToFrame(
        { x: 0.5, y: 0 },
        { centerPoint: { x: 0.5, y: 0.5 }, points, frameCount: 40 },
      ),
    ).toBe(15)
  })
})
