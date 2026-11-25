import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { createServer } from 'vite'

test('all launcher and placeholder routes resolve through React Router', async () => {
  const vite = await createServer({
    configFile: 'frontend/vite.config.ts',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, ws: false, watch: null },
  })
  try {
    const { App } = await vite.ssrLoadModule('/src/App.tsx')
    const routes = [
      ['/', 'Demo launcher'],
      ['/menu/' + '1'.repeat(32), 'Customer ordering'],
      ['/cashier', 'Cashier dashboard'],
      ['/kitchen', 'Kitchen display'],
      ['/tables', 'Table management'],
    ]
    for (const [path, heading] of routes) {
      const markup = renderToStaticMarkup(
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)),
      )
      assert.ok(markup.includes(heading), `Expected ${path} to render ${heading}`)
      assert.ok(!markup.includes('Page not found'), `Unexpected fallback for ${path}`)
    }
  } finally {
    await vite.close()
  }
})
