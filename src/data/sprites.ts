import type { CursorStyle, SpriteAsset } from '../lib/spriteTypes'

export const SPRITES: SpriteAsset[] = [
  {
    id: 'cat-sprite',
    label: 'Cat',
    metadataPath: 'sprites/cat-sprite.json',
    source: 'static',
  },
  {
    id: 'dog-sprite',
    label: 'Dog',
    metadataPath: 'sprites/dog-sprite.json',
    source: 'static',
  },
]

export const CURSOR_STYLES: Array<{ id: CursorStyle; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'cat-paw', label: 'Cat paw' },
  { id: 'star-trail', label: 'Star trail' },
  { id: 'hello-kitty', label: 'Hello Kitty' },
  { id: 'fish', label: 'Fish' },
  { id: 'alarm', label: 'Alarm' },
]

export const CURSOR_IMAGES: Partial<Record<CursorStyle, string>> = {
  'hello-kitty': 'mouse/Hellokitty.webp',
  fish: 'mouse/小鱼.webp',
  alarm: 'mouse/闹钟.webp',
}
