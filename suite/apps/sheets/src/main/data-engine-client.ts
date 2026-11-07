import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

/// Client of the large-table engine (native/data-engine): DuckDB in its own
/// process, so a base of millions of rows never lives in the renderer or the
/// XLSX sidecar. Same JSON-lines envelope as XlsxSidecarClient.

const PROTOCOL_VERSION = 1
const READ_TIMEOUT_MS = 30_000
/// Importing reads the file twice; a slow disk with a multi-GB file needs room.
const IMPORT_TIMEOUT_MS = 30 * 60_000
const MAX_STDERR_LENGTH = 8_192

export interface DataEngineColumnCounts {
  readonly int: number
  readonly comma: number
  readonly point: number
  readonly ambiguous: number
  readonly code: number
  readonly text: number
  readonly firstAmbiguous?: string
  readonly firstConflict?: string
  readonly firstCode?: string
}

export interface DataEngineImport {
  readonly sessionId: string
  readonly rows: number
  readonly columns: number
  /** non-empty values (each becomes a grid cell) */
  readonly cells: number
  readonly header: readonly string[]
  readonly counts: readonly DataEngineColumnCounts[]
  readonly measureMs: number
  readonly totalMs: number
}

/** `[row, values]` with values from startColumn; null = empty cell */
export type DataEngineRow = readonly [number, readonly (string | null)[]]

export interface DataEngineFindPage {
  /** `[row, column, text]` in row-major order */
  readonly matches: readonly (readonly [number, number, string])[]
  readonly complete: boolean
  readonly nextRow?: number
  readonly nextColumn?: number
}

export interface DataEngineSpan {
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
}

/// The grid's unsaved value edits, with the values the grid holds.
export interface DataEngineGridEdits {
  readonly cells: readonly {
    readonly row: number
    readonly column: number
    readonly value: string | number | boolean | null
  }[]
  readonly fills: readonly (DataEngineSpan & {
    readonly value: string | number | boolean | null
  })[]
}

export interface DataEngineCalcRefreshed {
  readonly ms: number
  /** columns whose cells changed */
  readonly refreshed: readonly number[]
  /** a quick refresh left formulas that need a full pass */
  readonly pending?: boolean
}

export interface DataEngineCalcCreated extends DataEngineCalcRefreshed {
  readonly calcId: string
  /** the calculated column this one replaced */
  readonly replaced: string | null
  readonly rows: number
  readonly written: number
  /** rows whose result is an error value (#DIV/0!, #N/A, …) */
  readonly errors: number
  readonly firstErrorRow: number | null
}

export interface DataEngineCalcInfo {
  readonly calcId: string
  readonly column: number
  readonly active: boolean
  readonly firstRow: number
  readonly lastRow: number
  /// cells typed over it before a Save, kept in the base when it is off
  readonly overrides: boolean
}

/// The app's RangeAggregate (renderer/ai/aggregate.ts).
export interface DataEngineAggregate {
  readonly cells: number
  readonly nonEmpty: number
  readonly distinct: number | null
  readonly numericCount: number
  readonly sum: number
  readonly min: number | null
  readonly max: number | null
  readonly average: number | null
  readonly topValues: readonly { value: string; count: number }[]
  readonly withheld: number
}

export class DataEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timeout: NodeJS.Timeout
}

export class DataEngineClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private lines: Interface | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private stderr = ''

  constructor(private readonly binaryPath: string) {}

  getProcessId(): number | null {
    return this.process?.pid ?? null
  }

  importDelimited(input: {
    path: string
    workDir: string
    delimiter: string
    encoding: string
    skipBytes: number
    strict: boolean
    memoryLimitMb: number
    threads: number
  }): Promise<DataEngineImport> {
    return this.request(
      { command: 'import_delimited', ...input },
      IMPORT_TIMEOUT_MS,
    ) as Promise<DataEngineImport>
  }

  async readRange(input: {
    sessionId: string
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
  }): Promise<readonly DataEngineRow[]> {
    const result = (await this.request({ command: 'read_range', ...input })) as {
      rows: DataEngineRow[]
    }
    return result.rows
  }

  findCells(input: {
    sessionId: string
    query: string
    matchCase: boolean
    matchEntireCell: boolean
    wildcards: boolean
    numberColumns: readonly { column: number; decimal: ',' | '.' }[]
    resumeRow: number
    resumeColumn: number
    limit: number
  }): Promise<DataEngineFindPage> {
    return this.request({ command: 'find_cells', ...input }) as Promise<DataEngineFindPage>
  }

  async columnEdge(input: {
    sessionId: string
    column: number
    row: number
    down: boolean
  }): Promise<number> {
    const result = (await this.request({ command: 'column_edge', ...input })) as { row: number }
    return result.row
  }

  async applyEdits(input: {
    sessionId: string
    fills: readonly {
      startRow: number
      endRow: number
      startColumn: number
      endColumn: number
      text: string | null
    }[]
    cells: readonly { row: number; column: number; text: string | null }[]
  }): Promise<{ columns: number }> {
    return (await this.request({ command: 'apply_edits', ...input }, IMPORT_TIMEOUT_MS)) as {
      columns: number
    }
  }

  async exportDelimited(input: {
    sessionId: string
    path: string
    delimiter: string
    sepLine: boolean
  }): Promise<{ rows: number }> {
    return (await this.request({ command: 'export_delimited', ...input }, IMPORT_TIMEOUT_MS)) as {
      rows: number
    }
  }

  async exportXlsx(input: {
    sessionId: string
    path: string
    sheetName: string
    numberColumns: readonly { column: number; decimal: ',' | '.' }[]
  }): Promise<{ rows: number }> {
    return (await this.request({ command: 'export_xlsx', ...input }, IMPORT_TIMEOUT_MS)) as {
      rows: number
    }
  }

  /// A formula over every data row of a column (see calc.rs).
  async calcCreate(input: {
    sessionId: string
    formula: string
    anchorRow: number
    column: number
    firstRow: number
    lastRow: number
    sheetName: string
    decimal: ',' | '.'
    numberColumns: readonly { column: number; decimal: ',' | '.' }[]
    edits: DataEngineGridEdits
    replaceExisting: boolean
  }): Promise<DataEngineCalcCreated> {
    return (await this.request(
      { command: 'calc_create', ...input },
      IMPORT_TIMEOUT_MS,
    )) as DataEngineCalcCreated
  }

  /// Undo (off) and Redo (on) of a calculated column.
  async calcSetActive(input: {
    sessionId: string
    calcId: string
    active: boolean
    numberColumns: readonly { column: number; decimal: ',' | '.' }[]
    edits: DataEngineGridEdits
  }): Promise<DataEngineCalcRefreshed> {
    return (await this.request(
      { command: 'calc_set_active', ...input },
      IMPORT_TIMEOUT_MS,
    )) as DataEngineCalcRefreshed
  }

  /// Recomputes the formulas that read the changed cells.
  async calcRefresh(input: {
    sessionId: string
    changed: readonly DataEngineSpan[]
    numberColumns: readonly { column: number; decimal: ',' | '.' }[]
    edits: DataEngineGridEdits
    /** row-local formulas only; `pending` asks for a full pass */
    quick?: boolean
  }): Promise<DataEngineCalcRefreshed> {
    return (await this.request(
      { command: 'calc_refresh', ...input },
      IMPORT_TIMEOUT_MS,
    )) as DataEngineCalcRefreshed
  }

  /// Every calculated column of the base, on or off.
  async calcList(sessionId: string): Promise<DataEngineCalcInfo[]> {
    const result = (await this.request({ command: 'calc_list', sessionId })) as {
      calcs: DataEngineCalcInfo[]
    }
    return result.calcs
  }

  /// Statistics of a range with the grid's unsaved edits on top.
  async aggregateRange(input: {
    sessionId: string
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
    numberColumns: readonly { column: number; decimal: ',' | '.' }[]
    edits: DataEngineGridEdits
    topValues: number
  }): Promise<DataEngineAggregate> {
    return (await this.request(
      { command: 'aggregate_range', ...input },
      IMPORT_TIMEOUT_MS,
    )) as DataEngineAggregate
  }

  /// A range as clipboard text (tab-separated).
  async rangeText(input: {
    sessionId: string
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
    numberColumns: readonly { column: number; decimal: ',' | '.' }[]
    edits: DataEngineGridEdits
  }): Promise<{ text: string; rows: number; columns: number }> {
    return (await this.request({ command: 'range_text', ...input }, IMPORT_TIMEOUT_MS)) as {
      text: string
      rows: number
      columns: number
    }
  }

  async close(sessionId: string): Promise<void> {
    if (!this.process) return
    await this.request({ command: 'close', sessionId })
  }

  stop(): void {
    this.lines?.close()
    this.lines = null
    this.process?.kill()
    this.process = null
    this.rejectPending(new Error('Data engine stopped.'))
  }

  private request(
    command: Readonly<Record<string, unknown>>,
    timeoutMs: number = READ_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.ensureStarted()
    const requestId = crypto.randomUUID()
    const payload = JSON.stringify({ version: PROTOCOL_VERSION, requestId, ...command })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Data engine request timed out.'))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timeout })
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(requestId)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pending.delete(requestId)
        pending.reject(error)
      })
    })
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) return this.process
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      throw new Error(
        `Data engine failed to start (${this.binaryPath}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    this.process = child
    this.stderr = ''
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_LENGTH)
    })
    const teardown = (reason: Error): void => {
      if (this.process !== child) return
      this.process = null
      this.lines?.close()
      this.lines = null
      this.rejectPending(reason)
    }
    child.once('error', teardown)
    child.stdin.on('error', () => teardown(new Error('Data engine stdin failed.')))
    child.once('exit', (code, signal) => {
      const detail = this.stderr.trim()
      teardown(
        new Error(
          detail
            ? `Data engine exited: ${detail}`
            : `Data engine exited with code ${String(code)} and signal ${String(signal)}.`,
        ),
      )
    })
    return child
  }

  private handleLine(line: string): void {
    let response: {
      version?: number
      requestId?: string
      ok?: boolean
      result?: unknown
      error?: { code?: string; message?: string }
    }
    try {
      response = JSON.parse(line) as typeof response
    } catch {
      this.stderr = `${this.stderr}[stdout] ${line}\n`.slice(-MAX_STDERR_LENGTH)
      return
    }
    if (response.version !== PROTOCOL_VERSION || typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(response.requestId)
    if (response.ok === true) pending.resolve(response.result)
    else
      pending.reject(
        new DataEngineError(
          response.error?.code ?? 'ENGINE',
          response.error?.message ?? 'Data engine request failed.',
        ),
      )
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
