import { Pool } from 'pg'

const password = process.env.POSTGRES_PASSWORD
if (!password) throw new Error('POSTGRES_PASSWORD environment variable is required')

export const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT_INTERNAL ?? process.env.POSTGRES_PORT ?? '7745', 10),
  database: process.env.POSTGRES_DB ?? 'sfdb',
  user: process.env.POSTGRES_USER ?? 'sfdb',
  password,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})
