import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:5174/'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

page.on('console', (message) => {
  if (message.text().includes('ERR_CONNECTION_REFUSED')) return
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))

await page.goto(url, { waitUntil: 'networkidle' })
await page.getByRole('heading', { name: 'Video sprite pet preview and calibration' }).waitFor()

const spriteBackground = await page.locator('.sprite-view').evaluate((node) => {
  return window.getComputedStyle(node).backgroundImage
})

if (!spriteBackground.includes('cat-sprite.webp')) {
  throw new Error(`Expected cat sprite background, got ${spriteBackground}`)
}

await mkdir('artifacts', { recursive: true })
await page.screenshot({ path: 'artifacts/sprite-pet-preview.png', fullPage: false })

await page.getByLabel('Asset').selectOption('dog-sprite')
await page.waitForFunction(() => {
  const sprite = document.querySelector('.sprite-view')
  return sprite && window.getComputedStyle(sprite).backgroundImage.includes('dog-sprite.webp')
})

await page.goto(`${url.replace(/#.*$/, '')}#/convert`, { waitUntil: 'networkidle' })
await page.getByRole('heading', { name: 'Video to sprite converter' }).waitFor()
await page.getByText(/Backend (online|offline)/).waitFor()

await browser.close()

if (errors.length > 0) {
  throw new Error(`Browser console errors:\n${errors.join('\n')}`)
}

console.log('Verified SpritePet page:', url)
