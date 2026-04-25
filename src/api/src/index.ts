import 'dotenv/config'
import { createApp, initApp } from './app'

const PORT = parseInt(process.env.APP_PORT ?? '7743', 10)

const app = createApp()

app.listen(PORT, () => {
  console.log(`sfetch API running on http://localhost:${PORT}`)
  initApp().catch((err) => {
    console.error('[startup] initApp failed:', err)
  })
})
