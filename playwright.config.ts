import { defineConfig, devices } from '@playwright/test'

const channel = process.env.ORDERING_TEST_BROWSER ?? (process.platform === 'win32' ? 'msedge' : undefined)

export default defineConfig({
  testDir: './tests/browser',
  reporter: 'list',
  use: { channel, screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Edge'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', testIgnore: /(?:kitchen|tables|demo)\.spec\.ts$/, use: { ...devices['Pixel 7'] } },
    { name: 'tablet', testMatch: /(?:kitchen|tables|demo)\.spec\.ts$/, use: { viewport: { width: 1024, height: 768 }, hasTouch: true } },
  ],
})
