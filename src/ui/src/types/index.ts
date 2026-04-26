export interface AvailableOrg {
  alias: string | null
  username: string
  orgId: string
  instanceUrl: string
  loginUrl: string
  registered: boolean
}

export interface AvailableOrgsResponse {
  mounted: boolean
  orgs: AvailableOrg[]
}

export interface RegisteredOrg {
  orgId: string
  alias: string | null
  username: string
  instanceUrl: string
  schemaName: string
  addedAt: string
  active: boolean
}

export interface RegisteredOrgsResponse {
  orgs: RegisteredOrg[]
  activeOrgId: string | null
}

export interface SObject {
  apiName: string
  label: string
  enabled: boolean
  lastDeltaSync: string | null
  lastFullSync: string | null
  rowCount: number | null
}

export interface Field {
  apiName: string
  label: string
  sfType: string
  pgType: string
  enabled: boolean
  nullable: boolean
}

export interface SyncProgress {
  recordsUpserted: number
  totalRecords: number | null
  phase: string
}

export interface SyncStatus {
  locked: boolean
  lockedAt: string | null
  jobType: string | null
  currentObject: string | null
  currentProgress: SyncProgress | null
  objects: ObjectSyncStatus[]
}

export interface ObjectSyncStatus {
  objectApiName: string
  lastDeltaSync: string | null
  lastFullSync: string | null
  deltaIntervalMinutes: number
  fullIntervalHours: number
}

export interface ScheduleConfig {
  autoSyncEnabled: boolean
  deltaIntervalMinutes: number
  fullIntervalHours: number
}

export interface LogEntry {
  id: number
  objectApiName: string
  syncType: 'delta' | 'full'
  startedAt: string
  completedAt: string | null
  recordsUpserted: number
  recordsDeleted: number
  error: string | null
}

export interface ConnectionDetails {
  host: string
  port: number
  database: string
  user: string
  password: string
  connectionString: string
}

export interface TableStat {
  schemaName: string
  tableName: string
  rowCount: number
  tableSizeBytes: number
  totalSizeBytes: number
}

export interface DbStats {
  dbSizeBytes: number
  salesforceSizeBytes: number
  tableCount: number
  totalRows: number
  orgs: Array<{ orgId: string; alias: string | null; schemaName: string }>
  tables: TableStat[]
}

export interface AppConfig {
  activeOrgId: string | null
  autoSyncEnabled: boolean
}

export interface SyncOrderItem {
  objectApiName: string
  syncOrder: number
}
