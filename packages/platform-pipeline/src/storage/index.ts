/**
 * 存储子路径出口（`platform-pipeline/storage`，docs/10 §8）。
 *
 * 只导出**端口**与**后端装配**，不导出任何具体 store 类：
 * 编排层与工具应当依赖端口，宿主装配才需要具体后端。
 *
 * @module platform-pipeline/storage
 */

export {
  STORAGE_SCHEMA_VERSION,
  StorageCorruptError,
  StorageSchemaVersionError,
  StorageUnavailableError,
  assertBackendPorts,
  assertSchemaVersion,
  checkAndStripSchemaVersion,
  isStorageDataError,
  isStorageInfrastructureError,
  readSchemaVersion,
  withSchemaVersion,
  type ArtifactStore,
  type AuditEvent,
  type AuditEventKind,
  type AuditEventQuery,
  type AuditEventRead,
  type AuditEventStore,
  type CaseMeta,
  type CaseStorePort,
  type CheckpointPort,
  type KnowledgeConfidence,
  type KnowledgeConflict,
  type KnowledgeEntry,
  type KnowledgeHit,
  type KnowledgeKind,
  type KnowledgeQuery,
  type KnowledgeStatus,
  type KnowledgeStorePort,
  type PipelineLockFactory,
  type StorageBackend,
  type StorageBackendDescription,
  type StorageDiagnostic,
  type StorageDiagnosticCode,
  type StorageHealth,
  type StorageMigrationReport,
  type StoragePorts,
  type StorageRecordKind,
  type VersionedCase,
} from './ports.ts'

export {
  AUDIT_LOG_FILE,
  auditDir,
  auditLogPath,
  fileAuditStore,
} from './file/audit.ts'

export {
  FILE_STORAGE_VALIDATORS,
  createFileStorageBackend,
  type FileStorageOptions,
} from './file/index.ts'

export {
  createMemoryStorageBackend,
  type MemoryRawStore,
  type MemoryStorageBackend,
} from './memory/index.ts'

export {
  composeStorageBackends,
  type ComposeStorageOptions,
  type ComposedMigrationReport,
  type ComposedStorageBackend,
  type ComposedStoragePart,
  type StorageBackendRole,
} from './compose.ts'

export {
  POSTGRES_DEFAULT_SCHEMA,
  POSTGRES_PORT_TABLES,
  POSTGRES_TABLES,
  POSTGRES_TRANSACTION_BOUNDARIES,
  classifyPostgresError,
  describePostgresBackend,
  postgresSchemaDdl,
  requirePostgresClient,
  type PostgresClient,
  type PostgresQueryResult,
  type PostgresStorageOptions,
  type PostgresTransactionBoundary,
} from './postgres/index.ts'

export {
  OBJECT_KEY_MAX_LENGTH,
  OBJECT_KEY_ROOTS,
  artifactObjectKey,
  assertKeyInProject,
  assertSafeObjectKey,
  caseObjectKey,
  classifyObjectStoreError,
  describeObjectStoreBackend,
  evidenceObjectKey,
  knowledgeObjectKey,
  requireObjectStoreClient,
  type ObjectKeyRoot,
  type ObjectStat,
  type ObjectStorageOptions,
  type ObjectStoreClient,
} from './object-store/index.ts'
