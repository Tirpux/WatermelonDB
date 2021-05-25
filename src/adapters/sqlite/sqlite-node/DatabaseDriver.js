// @flow

import Database from './Database'

function fixArgs(args: any): any {
  return Object.keys(args).reduce((acc, argName) => {
    if (typeof acc[argName] === 'boolean') {
      acc[argName] = acc[argName] ? 1 : 0
    }
    return acc
  }, args)
}

function fixArgsArray(args: any[]): any[] {
  return args.map((value) => {
    if (typeof value === 'boolean') {
      return value ? 1 : 0
    }
    return value
  })
}

type Migrations = { from: number, to: number, sql: string }

class MigrationNeededError extends Error {
  databaseVersion: number

  type: string

  constructor(databaseVersion): void {
    super('MigrationNeededError')
    this.databaseVersion = databaseVersion
    this.type = 'MigrationNeededError'
    this.message = 'MigrationNeededError'
  }
}

class SchemaNeededError extends Error {
  type: string

  constructor(): void {
    super('SchemaNeededError')
    this.type = 'SchemaNeededError'
    this.message = 'SchemaNeededError'
  }
}

export function getPath(dbName: string): string {
  if (dbName === ':memory:' || dbName === 'file::memory:') {
    return dbName
  }

  let path =
    dbName.startsWith('/') || dbName.startsWith('file:') ? dbName : `${process.cwd()}/${dbName}`
  if (path.indexOf('.db') === -1) {
    if (path.indexOf('?') >= 0) {
      const index = path.indexOf('?')
      path = `${path.substring(0, index)}.db${path.substring(index)}`
    } else {
      path = `${path}.db`
    }
  }

  return path
}

class DatabaseDriver {
  static sharedMemoryConnections: { ... } = {}

  database: Database

  cachedRecords: any = {}

  initialize(dbName: string, schemaVersion: number): void {
    this.init(dbName)
    this.isCompatible(schemaVersion)
  }

  setUpWithSchema(dbName: string, schema: string, schemaVersion: number): void {
    this.init(dbName)
    this.unsafeResetDatabase({ version: schemaVersion, sql: schema })
    this.isCompatible(schemaVersion)
  }

  setUpWithMigrations(dbName: string, migrations: Migrations): void {
    this.init(dbName)
    this.migrate(migrations)
    this.isCompatible(migrations.to)
  }

  init(dbName: string): void {
    this.database = new Database(getPath(dbName))

    const isSharedMemory = dbName.indexOf('mode=memory') > 0 && dbName.indexOf('cache=shared') > 0
    if (isSharedMemory) {
      if (!DatabaseDriver.sharedMemoryConnections[dbName]) {
        DatabaseDriver.sharedMemoryConnections[dbName] = this.database
      }
      this.database = DatabaseDriver.sharedMemoryConnections[dbName]
    }
  }

  find(table: string, id: string): any | null | string {
    if (this.isCached(table, id)) {
      return id
    }

    const query = `SELECT * FROM '${table}' WHERE id == ? LIMIT 1`
    const results = this.database.queryRaw(query, [id])

    if (results.length === 0) {
      return null
    }

    this.markAsCached(table, id)
    return results[0]
  }

  cachedQuery(table: string, query: string, args: any[]): any[] {
    const results = this.database.queryRaw(query, fixArgsArray(args))
    return results.map((row: any) => {
      const id = `${row.id}`
      if (this.isCached(table, id)) {
        return id
      }
      this.markAsCached(table, id)
      return row
    })
  }

  queryIds(query: string, args: any[]): string[] {
    return this.database.queryRaw(query, fixArgsArray(args)).map((row) => `${row.id}`)
  }

  count(query: string, args: any[]): number {
    return this.database.count(query, fixArgsArray(args))
  }

  batch(operations: any[]): void {
    const newIds = []
    const removedIds = []

    this.database.inTransaction(() => {
      operations.forEach((operation: any[]) => {
        const [type, ...rest] = operation
        switch (type) {
          case 'execute': {
            const [query, args] = rest
            this.database.execute(query, fixArgs(args))
            break
          }

          case 'create': {
            const [table, id, query, args] = rest
            this.database.execute(query, fixArgs(args))
            newIds.push([table, id])
            break
          }

          case 'markAsDeleted': {
            const [table, id] = rest
            this.database.execute(`UPDATE '${table}' SET _status='deleted' WHERE id == ?`, [id])
            removedIds.push([table, id])
            break
          }

          case 'destroyPermanently': {
            const [table, id] = rest
            // TODO: What's the behavior if nothing got deleted?
            this.database.execute(`DELETE FROM '${table}' WHERE id == ?`, [id])
            removedIds.push([table, id])
            break
          }

          default: {
            throw new Error('unknown batch operation')
          }
        }
      })
    })

    newIds.forEach(([table, id]) => {
      this.markAsCached(table, id)
    })

    removedIds.forEach(([table, id]) => {
      this.removeFromCache(table, id)
    })
  }

  destroyDeletedRecords(table: string, records: string[]): void {
    const recordPlaceholders = records.map(() => '?').join(',')
    this.database.execute(`DELETE FROM '${table}' WHERE id IN (${recordPlaceholders})`, records)
  }

  // MARK: - LocalStorage

  getLocal(key: string): any | null {
    const results = this.database.queryRaw('SELECT `value` FROM `local_storage` WHERE `key` = ?', [
      key,
    ])

    if (results.length > 0) {
      return results[0].value
    }

    return null
  }

  // MARK: - Record caching

  hasCachedTable(table: string): any {
    return Object.prototype.hasOwnProperty.call(this.cachedRecords, table)
  }

  isCached(table: string, id: string): boolean {
    if (this.hasCachedTable(table)) {
      return this.cachedRecords[table].has(id)
    }
    return false
  }

  markAsCached(table: string, id: string): void {
    if (!this.hasCachedTable(table)) {
      this.cachedRecords[table] = new Set()
    }
    this.cachedRecords[table].add(id)
  }

  removeFromCache(table: string, id: string): void {
    if (this.hasCachedTable(table) && this.cachedRecords[table].has(id)) {
      this.cachedRecords[table].delete(id)
    }
  }

  // MARK: - Other private details

  isCompatible(schemaVersion: number): void {
    const databaseVersion = this.database.userVersion
    if (schemaVersion !== databaseVersion) {
      if (databaseVersion > 0 && databaseVersion < schemaVersion) {
        throw new MigrationNeededError(databaseVersion)
      } else {
        throw new SchemaNeededError()
      }
    }
  }

  unsafeResetDatabase(schema: { sql: string, version: number }): void {
    this.database.unsafeDestroyEverything()
    this.cachedRecords = {}

    this.setUpSchema(schema)
  }

  setUpSchema(schema: { sql: string, version: number }): void {
    this.database.inTransaction(() => {
      this.database.executeStatements(schema.sql + this.localStorageSchema)
      this.database.userVersion = schema.version
    })
  }

  migrate(migrations: Migrations): void {
    const databaseVersion = this.database.userVersion

    if (`${databaseVersion}` !== `${migrations.from}`) {
      throw new Error(
        `Incompatbile migration set applied. DB: ${databaseVersion}, migration: ${migrations.from}`,
      )
    }

    this.database.inTransaction(() => {
      this.database.executeStatements(migrations.sql)
      this.database.userVersion = migrations.to
    })
  }

  localStorageSchema: string = `
      create table local_storage (
      key varchar(16) primary key not null,
      value text not null
      );

      create index local_storage_key_index on local_storage (key);
      `
}

export default DatabaseDriver