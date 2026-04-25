export interface Org {
  alias: string
  username: string
  orgType: string
  instanceUrl: string
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
  tables: TableStat[]
}

export interface AppConfig {
  activeOrgAlias: string | null
  autoSyncEnabled: boolean
}

export interface SyncOrderItem {
  objectApiName: string
  syncOrder: number
}
