import { Connection } from 'jsforce'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BulkClientOptions {
  accessToken: string
  instanceUrl: string
  apiVersion?: string // default: '59.0'
}

export interface QueryResult {
  records: AsyncIterable<Record<string, string | null>>
  totalSize: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal CSV parser — handles quoted fields (with embedded commas and newlines
 * escaped as \n in Salesforce bulk output), empty values, and null literals.
 *
 * Salesforce Bulk API 2.0 CSV quirks:
 * - Fields may be double-quoted.
 * - A quoted field containing a comma or a double-quote is escaped per RFC 4180
 *   (two consecutive double-quotes represent a literal double-quote).
 * - Empty unquoted field  → empty string.
 * - The literal string `""` (two consecutive quotes with nothing inside) in a
 *   quoted field → empty string.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  const len = line.length

  while (i <= len) {
    if (i === len) {
      // Trailing comma produces one empty field
      if (fields.length > 0 || line.endsWith(',')) {
        fields.push('')
      }
      break
    }

    if (line[i] === '"') {
      // Quoted field
      i++ // skip opening quote
      let value = ''
      while (i < len) {
        if (line[i] === '"') {
          if (i + 1 < len && line[i + 1] === '"') {
            // Escaped double-quote
            value += '"'
            i += 2
          } else {
            // Closing quote
            i++
            break
          }
        } else {
          value += line[i]
          i++
        }
      }
      fields.push(value)
      // Skip delimiter
      if (i < len && line[i] === ',') {
        i++
      }
    } else {
      // Unquoted field
      const start = i
      while (i < len && line[i] !== ',') {
        i++
      }
      fields.push(line.slice(start, i))
      if (i < len) {
        i++ // skip comma
      }
    }
  }

  return fields
}

/**
 * Split a CSV body into lines while respecting quoted fields that may contain
 * embedded newlines. Salesforce Bulk API 2.0 typically does not embed newlines
 * in field values, but we handle it for correctness.
 */
function* splitCsvLines(text: string): Iterable<string> {
  let inQuotes = false
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      const line = text.slice(start, i)
      // Handle \r\n by advancing past the \n if we just saw \r
      if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
        i++
      }
      start = i + 1
      if (line.length > 0) {
        yield line
      }
    }
  }
  // Yield any remaining content
  const remaining = text.slice(start)
  if (remaining.length > 0) {
    yield remaining
  }
}

/**
 * Stream CSV lines from a fetch response body without loading the entire
 * response into a single string. This avoids hitting Node.js's ~512 MB
 * string length limit for very large Bulk API result pages.
 *
 * Respects CSV quoting so embedded newlines inside quoted fields do not
 * cause premature line splits.
 */
async function* streamCsvLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let inQuotes = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      const chunk = done ? '' : decoder.decode(value, { stream: true })

      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i]
        if (ch === '"') {
          inQuotes = !inQuotes
          buffer += ch
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
          if (ch === '\r' && i + 1 < chunk.length && chunk[i + 1] === '\n') {
            i++
          }
          if (buffer.length > 0) {
            yield buffer
            buffer = ''
          }
        } else {
          buffer += ch
        }
      }

      if (done) {
        if (buffer.length > 0) yield buffer
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Converts an array of field value strings (from a CSV data row) into a plain
 * record object. The empty string produced by the CSV parser is mapped to null
 * to represent Salesforce null values.
 */
function rowToRecord(
  headers: string[],
  values: string[]
): Record<string, string | null> {
  const record: Record<string, string | null> = {}
  for (let i = 0; i < headers.length; i++) {
    const raw = i < values.length ? values[i] : ''
    record[headers[i]] = raw === '' ? null : raw
  }
  return record
}

/**
 * Throw a descriptive error for non-2xx HTTP responses.
 */
async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    let body = ''
    try {
      body = await response.text()
    } catch {
      // ignore read errors
    }
    throw new Error(
      `Bulk API HTTP ${response.status} (${context}): ${body}`
    )
  }
}

// ---------------------------------------------------------------------------
// Bulk API 2.0 implementation
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000
const JOB_TIMEOUT_MS = 30 * 60 * 1_000 // 30 minutes

interface BulkJobStatus {
  id: string
  state: 'UploadComplete' | 'InProgress' | 'JobComplete' | 'Failed' | 'Aborted'
  errorMessage?: string
  numberRecordsProcessed?: number
}

async function createBulkQueryJob(
  instanceUrl: string,
  accessToken: string,
  version: string,
  soql: string
): Promise<string> {
  const url = `${instanceUrl}/services/data/v${version}/jobs/query`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operation: 'query', query: soql }),
  })
  await assertOk(response, 'create job')
  const body = (await response.json()) as { id: string }
  return body.id
}

async function pollBulkJobUntilComplete(
  instanceUrl: string,
  accessToken: string,
  version: string,
  jobId: string
): Promise<void> {
  const url = `${instanceUrl}/services/data/v${version}/jobs/query/${jobId}`
  const deadline = Date.now() + JOB_TIMEOUT_MS
  const startTime = Date.now()
  let pollCount = 0

  while (true) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })
    await assertOk(response, `poll job ${jobId}`)

    const status = (await response.json()) as BulkJobStatus
    pollCount++

    // Log progress every ~30 seconds
    if (pollCount % 15 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1_000)
      console.log(
        `[bulk-api] job ${jobId}: ${status.state} — ${status.numberRecordsProcessed ?? 0} records, ${elapsed}s elapsed`
      )
    }

    if (status.state === 'JobComplete') {
      const elapsed = Math.round((Date.now() - startTime) / 1_000)
      console.log(
        `[bulk-api] job ${jobId}: complete — ${status.numberRecordsProcessed ?? 0} records in ${elapsed}s`
      )
      return
    }

    if (status.state === 'Failed' || status.state === 'Aborted') {
      throw new Error(
        `Bulk API job ${jobId} ${status.state}: ${status.errorMessage ?? 'no error message'}`
      )
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Bulk API job ${jobId} timed out after 30 minutes (last state: ${status.state})`
      )
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

async function deleteBulkJob(
  instanceUrl: string,
  accessToken: string,
  version: string,
  jobId: string
): Promise<void> {
  const url = `${instanceUrl}/services/data/v${version}/jobs/query/${jobId}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })
  // Best-effort cleanup: ignore 404 (job already deleted), surface other errors
  if (!response.ok && response.status !== 404) {
    let body = ''
    try {
      body = await response.text()
    } catch {
      // ignore
    }
    console.warn(`Bulk API: failed to delete job ${jobId} (HTTP ${response.status}): ${body}`)
  }
}

/**
 * Fetch all pages of results for a completed Bulk API 2.0 query job.
 *
 * Returns an async generator that yields one plain record object per data row.
 * Also returns the total record count from the first page's Sforce-Numberofrecords header.
 */
async function* streamBulkResults(
  instanceUrl: string,
  accessToken: string,
  version: string,
  jobId: string
): AsyncGenerator<Record<string, string | null>, number, undefined> {
  const baseUrl = `${instanceUrl}/services/data/v${version}/jobs/query/${jobId}/results`
  let locator: string | null = null
  let totalSize = 0
  let headers: string[] | null = null

  do {
    const url = locator !== null ? `${baseUrl}?locator=${locator}` : baseUrl

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })
    await assertOk(response, `fetch results for job ${jobId}`)

    // Capture total size from first page
    if (locator === null) {
      const countHeader = response.headers.get('Sforce-Numberofrecords')
      if (countHeader !== null) {
        totalSize = parseInt(countHeader, 10) || 0
      }
    }

    // Advance locator (null string from header means no more pages)
    const nextLocator = response.headers.get('Sforce-Locator')
    locator = nextLocator !== null && nextLocator !== 'null' ? nextLocator : null

    const csvText = await response.text()

    let isFirstLine = headers === null
    for (const line of splitCsvLines(csvText)) {
      if (isFirstLine && headers === null) {
        headers = parseCsvLine(line)
        isFirstLine = false
        continue
      }
      if (headers !== null) {
        const values = parseCsvLine(line)
        yield rowToRecord(headers, values)
      }
    }
  } while (locator !== null)

  return totalSize
}

/**
 * Run a Bulk API 2.0 query job end-to-end and return a QueryResult.
 *
 * The async iterable streams CSV rows lazily — the job is cleaned up after all
 * pages are consumed or if the caller stops iteration early.
 */
async function runBulkQuery(
  instanceUrl: string,
  accessToken: string,
  version: string,
  soql: string
): Promise<QueryResult> {
  const jobId = await createBulkQueryJob(instanceUrl, accessToken, version, soql)

  try {
    await pollBulkJobUntilComplete(instanceUrl, accessToken, version, jobId)
  } catch (err) {
    // Attempt cleanup before re-throwing
    await deleteBulkJob(instanceUrl, accessToken, version, jobId)
    throw err
  }

  // Fetch the first page eagerly to read total-size and locator headers.
  // The body is NOT read here — it is streamed line-by-line inside generateRecords
  // to avoid loading potentially hundreds of MB into a single V8 string.
  const baseUrl = `${instanceUrl}/services/data/v${version}/jobs/query/${jobId}/results`
  const firstResponse = await fetch(baseUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })
  await assertOk(firstResponse, `fetch results (first page) for job ${jobId}`)

  const countHeader = firstResponse.headers.get('Sforce-Numberofrecords')
  const totalSize = countHeader !== null ? parseInt(countHeader, 10) || 0 : 0
  const firstLocatorHeader = firstResponse.headers.get('Sforce-Locator')
  const firstLocator =
    firstLocatorHeader !== null && firstLocatorHeader !== 'null'
      ? firstLocatorHeader
      : null

  async function* generateRecords(): AsyncIterable<Record<string, string | null>> {
    let csvHeaders: string[] | null = null

    // Stream first page line-by-line (body not consumed above)
    for await (const line of streamCsvLines(firstResponse.body!)) {
      if (csvHeaders === null) {
        csvHeaders = parseCsvLine(line)
        continue
      }
      yield rowToRecord(csvHeaders, parseCsvLine(line))
    }

    // Stream remaining pages
    let locator = firstLocator
    while (locator !== null) {
      const url = `${baseUrl}?locator=${locator}`
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      })
      await assertOk(response, `fetch results (locator ${locator}) for job ${jobId}`)

      const nextLocatorHeader = response.headers.get('Sforce-Locator')
      locator =
        nextLocatorHeader !== null && nextLocatorHeader !== 'null'
          ? nextLocatorHeader
          : null

      let isFirstLine = true
      for await (const line of streamCsvLines(response.body!)) {
        if (isFirstLine) {
          isFirstLine = false
          continue // skip header row on page 2+
        }
        if (csvHeaders !== null) {
          yield rowToRecord(csvHeaders, parseCsvLine(line))
        }
      }
    }

    // Clean up the job after all records have been streamed
    await deleteBulkJob(instanceUrl, accessToken, version, jobId)
  }

  return {
    records: generateRecords(),
    totalSize,
  }
}

// ---------------------------------------------------------------------------
// REST fallback (jsforce) — for objects with < 2 000 records
// ---------------------------------------------------------------------------

async function runRestQuery(
  accessToken: string,
  instanceUrl: string,
  version: string,
  soql: string
): Promise<QueryResult> {
  const conn = new Connection({ accessToken, instanceUrl, version })

  // Paginate via queryMore so we collect all records, not just the first page.
  const allRaw: Record<string, unknown>[] = []
  let result = await conn.query<Record<string, unknown>>(soql)
  allRaw.push(...result.records)

  while (!result.done && result.nextRecordsUrl) {
    result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl)
    allRaw.push(...result.records)
  }

  const totalSize = result.totalSize

  // Strip jsforce metadata fields (attributes) and normalise values to string | null.
  function normaliseRecord(raw: Record<string, unknown>): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    for (const [key, val] of Object.entries(raw)) {
      if (key === 'attributes') continue
      if (val === null || val === undefined) {
        out[key] = null
      } else {
        out[key] = String(val)
      }
    }
    return out
  }

  async function* generateRecords(): AsyncIterable<Record<string, string | null>> {
    for (const raw of allRaw) {
      yield normaliseRecord(raw)
    }
  }

  return {
    records: generateRecords(),
    totalSize,
  }
}

// ---------------------------------------------------------------------------
// Row-count helper (reads from sfdb.sync_config / sfdb.sync_log)
// ---------------------------------------------------------------------------

// The bulk client intentionally does not take a DB pool dependency to keep it
// focused. The `query` method accepts an optional `estimatedRowCount` parameter
// that the caller (sync runner) should pass when known. When absent, the client
// assumes the object may have > 2 000 rows and uses the Bulk API.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BulkClient {
  /**
   * Run a SOQL query using either Bulk API 2.0 or the REST fallback.
   *
   * @param soql            The SOQL query to execute.
   * @param estimatedRows   Known/estimated row count for the object. When this
   *                        is > 2 000 or undefined the Bulk API is used;
   *                        when ≤ 2 000 the REST query fallback is used.
   */
  query(soql: string, estimatedRows?: number): Promise<QueryResult>
}

/**
 * Create a Bulk API 2.0 client bound to a specific Salesforce org.
 *
 * HTTP calls use Node's built-in `fetch` (Node 20+). jsforce is used only for
 * the REST query fallback (<2 000 records).
 */
export function createBulkClient(options: BulkClientOptions): BulkClient {
  const { accessToken, instanceUrl } = options
  const version = options.apiVersion ?? '59.0'

  return {
    async query(soql: string, estimatedRows?: number): Promise<QueryResult> {
      const useBulk = estimatedRows === undefined || estimatedRows > 2_000

      if (useBulk) {
        return runBulkQuery(instanceUrl, accessToken, version, soql)
      } else {
        return runRestQuery(accessToken, instanceUrl, version, soql)
      }
    },
  }
}
