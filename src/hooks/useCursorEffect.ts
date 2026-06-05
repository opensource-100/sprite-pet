import { useEffect } from 'react'
import { CURSOR_IMAGES } from '../data/sprites'
import type { CursorStyle } from '../lib/spriteTypes'

const STORAGE_KEY = 'spritePetCursorStyle'

export function saveCursorStyle(style: CursorStyle) {
  window.localStorage.setItem(STORAGE_KEY, style)
}

export function readCursorStyle(): CursorStyle {
  const saved = window.localStorage.getItem(STORAGE_KEY)
  if (
    saved === 'cat-paw' ||
    saved === 'star-trail' ||
    saved === 'hello-kitty' ||
    saved === 'fish' ||
    saved === 'alarm'
  ) {
    return saved
  }

  return 'default'
}

export function useCursorEffect(style: CursorStyle) {
  useEffect(() => {
    if (style === 'default') {
      document.body.style.cursor = ''
      return undefined
    }

    document.body.style.cursor = 'none'

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    canvas.className = 'cursor-canvas'
    document.body.appendChild(canvas)

    let x = window.innerWidth / 2
    let y = window.innerHeight / 2
    let raf = 0
    const stars: Array<{ x: number; y: number; life: number }> = []
    const image = createCursorImage(style)

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }

    const move = (event: PointerEvent) => {
      x = event.clientX
      y = event.clientY
      if (style === 'star-trail') {
        stars.push({ x, y, life: 1 })
        if (stars.length > 60) stars.shift()
      }
    }

    const render = () => {
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (style === 'cat-paw') {
        drawCatPaw(ctx, x, y)
      } else if (style === 'star-trail') {
        drawStarTrail(ctx, stars, x, y)
      } else if (image) {
        drawCursorImage(ctx, image, x, y)
      }

      raf = window.requestAnimationFrame(render)
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', move, { passive: true })
    render()

    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', move)
      canvas.remove()
      document.body.style.cursor = ''
    }
  }, [style])
}

function createCursorImage(style: CursorStyle) {
  const path = CURSOR_IMAGES[style]
  if (!path) return null

  const image = new Image()
  image.src = `${import.meta.env.BASE_URL}${path}`
  return image
}

function drawCursorImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number) {
  const size = 48
  if (!image.complete || !image.naturalWidth) {
    ctx.fillStyle = 'rgba(45, 111, 114, 0.72)'
    ctx.beginPath()
    ctx.arc(x, y, 8, 0, Math.PI * 2)
    ctx.fill()
    return
  }

  ctx.drawImage(image, x - size / 2, y - size / 2, size, size)
}

function drawCatPaw(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = '#f3b35f'
  ctx.strokeStyle = '#8f4a21'
  ctx.lineWidth = 1.5

  ctx.beginPath()
  ctx.ellipse(x, y + 2, 11, 9, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  for (const toe of [
    { dx: -8, dy: -10, r: 4 },
    { dx: 0, dy: -14, r: 4 },
    { dx: 8, dy: -10, r: 4 },
  ]) {
    ctx.beginPath()
    ctx.arc(x + toe.dx, y + toe.dy, toe.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}

function drawStarTrail(
  ctx: CanvasRenderingContext2D,
  stars: Array<{ x: number; y: number; life: number }>,
  x: number,
  y: number,
) {
  for (let i = stars.length - 1; i >= 0; i -= 1) {
    const star = stars[i]
    star.life -= 0.025
    if (star.life <= 0) {
      stars.splice(i, 1)
      continue
    }

    ctx.globalAlpha = star.life * 0.8
    ctx.fillStyle = '#f2c14e'
    drawStar(ctx, star.x, star.y, 3 + star.life * 6)
  }

  ctx.globalAlpha = 1
  ctx.fillStyle = '#ffe181'
  ctx.strokeStyle = '#9b6a1d'
  ctx.lineWidth = 1.5
  drawStar(ctx, x, y, 10)
  ctx.stroke()
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, outerR: number) {
  const innerR = outerR * 0.4
  const step = Math.PI / 5

  ctx.beginPath()
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? outerR : innerR
    const angle = -Math.PI / 2 + i * step
    const x = cx + Math.cos(angle) * radius
    const y = cy + Math.sin(angle) * radius
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
}
