import type { CalibrationPoint, Point } from './spriteMath'

export type SpriteMetadata = {
  image: string
  frameCount: number
  frameWidth: number
  frameHeight: number
  spriteWidth: number
  spriteHeight: number
  columns: number
  rows: number
  layout?: string
  source?: string
  model?: string
  provider?: string
  averageInferenceSeconds?: number
  calibration?: {
    centerPoint?: Point | null
    calibrationPoints?: CalibrationPoint[]
    reverse?: boolean
    calibrating?: boolean
  }
}

export type SpriteAsset = {
  id: string
  label: string
  metadataPath?: string
  metadataUrl?: string
  imageBaseUrl?: string
  source?: 'static' | 'backend'
}

export type LoadedSprite = SpriteAsset & {
  metadata: SpriteMetadata
}

export type CursorStyle = 'default' | 'cat-paw' | 'star-trail' | 'hello-kitty' | 'fish' | 'alarm'
