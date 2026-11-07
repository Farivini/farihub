//! Fariv data engine: holds large delimited tables in DuckDB so the Sheets
//! grid can page through them without the renderer or the XLSX sidecar ever
//! holding the whole base.
//!
//! Protocol (same envelope as the XLSX sidecar): one JSON request per line on
//! stdin, `{version, requestId, command, ...}`; one JSON response per line on
//! stdout, `{version, requestId, ok, result | error}`. Requests run on their
//! own threads, each with its own DuckDB connection, so a long find never
//! blocks the grid's reads.

mod aggregate;
mod calc;
mod delimited;
mod export;
mod formula;
mod numbers;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io::{self, BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use duckdb::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use delimited::{MAX_CSV_COLS, ReadError, TextSource, read_rows};
use numbers::{ColumnCounts, js_number_text, parse_number_with_mark};

pub const PROTOCOL_VERSION: u8 = 1;
/// Largest window one read may ask for (rows x columns), like the sidecar.
const MAX_READ_CELLS: u64 = 1_000_000;
/// One find page gives up well before the host's request timeout.
const FIND_TIME_BUDGET: Duration = Duration::from_secs(8);
const FIND_PAGE_ROWS: u64 = 50_000;

#[derive(Debug)]
pub struct EngineError {
    code: &'static str,
    message: String,
}

impl EngineError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<duckdb::Error> for EngineError {
    fn from(error: duckdb::Error) -> Self {
        Self::new("ENGINE", error.to_string())
    }
}

impl From<ReadError> for EngineError {
    fn from(error: ReadError) -> Self {
        match error {
            ReadError::NotUtf8 => Self::new("NOT_UTF8", error.to_string()),
            ReadError::TooManyColumns => Self::new("TOO_MANY_COLUMNS", error.to_string()),
            other => Self::new("READ", other.to_string()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Command {
    #[serde(rename_all = "camelCase")]
    ImportDelimited {
        path: PathBuf,
        work_dir: PathBuf,
        delimiter: String,
        encoding: String,
        #[serde(default)]
        skip_bytes: u64,
        #[serde(default)]
        strict: bool,
        #[serde(default)]
        memory_limit_mb: Option<u64>,
        #[serde(default)]
        threads: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    ReadRange {
        session_id: String,
        start_row: u64,
        end_row: u64,
        start_column: u64,
        end_column: u64,
    },
    #[serde(rename_all = "camelCase")]
    FindCells {
        session_id: String,
        query: String,
        #[serde(default)]
        match_case: bool,
        #[serde(default)]
        match_entire_cell: bool,
        #[serde(default)]
        wildcards: bool,
        /// Number columns and their decimal mark: a number cell matches on its
        /// JavaScript text, as the grid shows the value to Find.
        #[serde(default)]
        number_columns: Vec<NumberColumn>,
        #[serde(default)]
        resume_row: u64,
        #[serde(default)]
        resume_column: u64,
        limit: usize,
    },
    /// Excel's Ctrl+Up/Down in one column: where the run of filled (or
    /// empty) cells starting next to `row` ends.
    #[serde(rename_all = "camelCase")]
    ColumnEdge {
        session_id: String,
        column: u64,
        row: u64,
        down: bool,
    },
    /// Writes edits from the grid into the base: constant fills first, then
    /// single cells (the save planner's order). `text` is the cell's text in
    /// the file's own convention; null or "" empties the cell.
    #[serde(rename_all = "camelCase")]
    ApplyEdits {
        session_id: String,
        #[serde(default)]
        fills: Vec<FillEdit>,
        #[serde(default)]
        cells: Vec<CellEdit>,
    },
    /// The whole base as delimited text (UTF-8 with BOM, CRLF, Excel quoting),
    /// written to `path`.
    #[serde(rename_all = "camelCase")]
    ExportDelimited {
        session_id: String,
        path: PathBuf,
        delimiter: String,
        #[serde(default)]
        sep_line: bool,
    },
    /// The whole base as one .xlsx sheet; number columns are written as numbers.
    #[serde(rename_all = "camelCase")]
    ExportXlsx {
        session_id: String,
        path: PathBuf,
        sheet_name: String,
        #[serde(default)]
        number_columns: Vec<NumberColumn>,
    },
    /// A formula over rows `firstRow..=lastRow` of `column`, typed in
    /// `anchorRow`; written into the base (see calc.rs).
    #[serde(rename_all = "camelCase")]
    CalcCreate {
        session_id: String,
        formula: String,
        anchor_row: u64,
        column: u64,
        first_row: u64,
        last_row: u64,
        sheet_name: String,
        /// the mark numbers are written with (the file's)
        decimal: String,
        #[serde(default)]
        number_columns: Vec<NumberColumn>,
        #[serde(default)]
        edits: calc::GridEdits,
        /// a calculated column already on this column is replaced (Excel:
        /// typing a new formula into a table's calculated column)
        #[serde(default)]
        replace_existing: bool,
    },
    /// Undo (off) and Redo (on) of a calculated column.
    #[serde(rename_all = "camelCase")]
    CalcSetActive {
        session_id: String,
        calc_id: String,
        active: bool,
        #[serde(default)]
        number_columns: Vec<NumberColumn>,
        #[serde(default)]
        edits: calc::GridEdits,
    },
    /// Recomputes the formulas that read the `changed` cells.
    #[serde(rename_all = "camelCase")]
    CalcRefresh {
        session_id: String,
        changed: Vec<calc::Span>,
        #[serde(default)]
        number_columns: Vec<NumberColumn>,
        #[serde(default)]
        edits: calc::GridEdits,
        /// row-local formulas only; `pending` in the answer asks for a full pass
        #[serde(default)]
        quick: bool,
    },
    #[serde(rename_all = "camelCase")]
    CalcList { session_id: String },
    /// A range as clipboard text (Copy of a selection past the grid's window).
    #[serde(rename_all = "camelCase")]
    RangeText {
        session_id: String,
        start_row: u64,
        end_row: u64,
        start_column: u64,
        end_column: u64,
        #[serde(default)]
        number_columns: Vec<NumberColumn>,
        #[serde(default)]
        edits: calc::GridEdits,
    },
    /// Statistics of a range (status bar, the AI's aggregate_range).
    #[serde(rename_all = "camelCase")]
    AggregateRange {
        session_id: String,
        start_row: u64,
        end_row: u64,
        start_column: u64,
        end_column: u64,
        #[serde(default)]
        number_columns: Vec<NumberColumn>,
        #[serde(default)]
        edits: calc::GridEdits,
        #[serde(default)]
        top_values: usize,
    },
    #[serde(rename_all = "camelCase")]
    Close { session_id: String },
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FillEdit {
    start_row: u64,
    end_row: u64,
    start_column: u64,
    end_column: u64,
    text: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    row: u64,
    column: u64,
    text: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NumberColumn {
    pub(crate) column: u64,
    pub(crate) decimal: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub version: u8,
    pub request_id: String,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    version: u8,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

struct Session {
    db: Connection,
    /// columns written by the file and by saved edits
    columns: u64,
    rows: u64,
    calcs: Vec<calc::Calc>,
    /// one writer at a time (edits, calculated columns); reads never take it
    writer: Arc<Mutex<()>>,
}

impl Session {
    /// The columns reads and exports cover: the saved ones and every
    /// calculated column that is on.
    fn width(&self) -> u64 {
        self.calcs
            .iter()
            .filter(|c| c.active)
            .map(|c| c.column() + 1)
            .fold(self.columns, u64::max)
    }
}

#[derive(Default)]
pub struct Engine {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

pub(crate) fn column_name(index: u64) -> String {
    format!("c{index}")
}

fn sql_literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

impl Engine {
    fn session(&self, id: &str) -> Result<(Connection, u64, u64), EngineError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| EngineError::new("UNKNOWN_SESSION", "Unknown data session."))?;
        let session = session.lock().unwrap();
        Ok((session.db.try_clone()?, session.rows, session.width()))
    }

    /// The calculated columns that are on, with their decimal marks.
    pub(crate) fn calc_columns(&self, id: &str) -> Result<Vec<(u64, char)>, EngineError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| EngineError::new("UNKNOWN_SESSION", "Unknown data session."))?;
        let session = session.lock().unwrap();
        Ok(session
            .calcs
            .iter()
            .filter(|c| c.active)
            .map(|c| (c.column(), c.mark))
            .collect())
    }

    /// Every calculated column of the base, on or off.
    fn calc_list(&self, id: &str) -> Result<Value, EngineError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| EngineError::new("UNKNOWN_SESSION", "Unknown data session."))?;
        let session = session.lock().unwrap();
        let calcs: Vec<Value> = session
            .calcs
            .iter()
            .map(|c| {
                let (first_row, last_row) = c.rows();
                json!({
                    "calcId": c.id,
                    "column": c.column(),
                    "active": c.active,
                    "firstRow": first_row,
                    "lastRow": last_row,
                    "overrides": c.has_overrides(),
                })
            })
            .collect();
        Ok(json!({ "calcs": calcs }))
    }

    pub fn handle(&self, command: Command) -> Result<Value, EngineError> {
        match command {
            Command::ImportDelimited {
                path,
                work_dir,
                delimiter,
                encoding,
                skip_bytes,
                strict,
                memory_limit_mb,
                threads,
            } => {
                let mut chars = delimiter.chars();
                let delimiter = match (chars.next(), chars.next()) {
                    (Some(c), None) => c,
                    _ => {
                        return Err(EngineError::new(
                            "BAD_REQUEST",
                            "delimiter must be one character",
                        ));
                    }
                };
                let source = TextSource {
                    encoding,
                    skip_bytes,
                    strict,
                };
                self.import_delimited(
                    &path,
                    &work_dir,
                    &source,
                    delimiter,
                    memory_limit_mb,
                    threads,
                )
            }
            Command::ReadRange {
                session_id,
                start_row,
                end_row,
                start_column,
                end_column,
            } => self.read_range(&session_id, start_row, end_row, start_column, end_column),
            Command::FindCells {
                session_id,
                query,
                match_case,
                match_entire_cell,
                wildcards,
                number_columns,
                resume_row,
                resume_column,
                limit,
            } => self.find_cells(
                &session_id,
                &find::Matcher::new(&query, match_case, match_entire_cell, wildcards),
                &number_columns,
                resume_row,
                resume_column,
                limit,
            ),
            Command::ColumnEdge {
                session_id,
                column,
                row,
                down,
            } => self.column_edge(&session_id, column, row, down),
            Command::ApplyEdits {
                session_id,
                fills,
                cells,
            } => self.apply_edits(&session_id, &fills, &cells),
            Command::ExportDelimited {
                session_id,
                path,
                delimiter,
                sep_line,
            } => {
                let (db, _, columns) = self.session(&session_id)?;
                let mut chars = delimiter.chars();
                let delimiter = match (chars.next(), chars.next()) {
                    (Some(c), None) => c,
                    _ => {
                        return Err(EngineError::new(
                            "BAD_REQUEST",
                            "delimiter must be one character",
                        ));
                    }
                };
                export::delimited(&db, columns, &path, delimiter, sep_line)
            }
            Command::ExportXlsx {
                session_id,
                path,
                sheet_name,
                number_columns,
            } => {
                let (db, rows, columns) = self.session(&session_id)?;
                export::xlsx(&db, rows, columns, &path, &sheet_name, &number_columns)
            }
            Command::CalcCreate {
                session_id,
                formula,
                anchor_row,
                column,
                first_row,
                last_row,
                sheet_name,
                decimal,
                number_columns,
                edits,
                replace_existing,
            } => self.calc_create(
                &session_id,
                &formula,
                anchor_row,
                column,
                first_row,
                last_row,
                &sheet_name,
                &decimal,
                &number_columns,
                &edits,
                replace_existing,
            ),
            Command::CalcSetActive {
                session_id,
                calc_id,
                active,
                number_columns,
                edits,
            } => self.calc_set_active(&session_id, &calc_id, active, &number_columns, &edits),
            Command::CalcRefresh {
                session_id,
                changed,
                number_columns,
                edits,
                quick,
            } => self.calc_refresh(&session_id, &changed, &number_columns, &edits, quick),
            Command::CalcList { session_id } => self.calc_list(&session_id),
            Command::RangeText {
                session_id,
                start_row,
                end_row,
                start_column,
                end_column,
                number_columns,
                edits,
            } => self.range_text(
                &session_id,
                start_row,
                end_row,
                start_column,
                end_column,
                &number_columns,
                &edits,
            ),
            Command::AggregateRange {
                session_id,
                start_row,
                end_row,
                start_column,
                end_column,
                number_columns,
                edits,
                top_values,
            } => self.aggregate_range(
                &session_id,
                start_row,
                end_row,
                start_column,
                end_column,
                &number_columns,
                &edits,
                top_values,
            ),
            Command::Close { session_id } => {
                self.sessions.lock().unwrap().remove(&session_id);
                Ok(json!({}))
            }
        }
    }

    /// One pass with the app's reader: it counts each column's value shapes
    /// and writes a normalized copy (every value quoted, one record per row,
    /// `\x1f` between fields) that DuckDB then loads with its own parallel CSV
    /// reader into an in-memory table. Memory is bounded by `memory_limit`:
    /// past it DuckDB spills to `work_dir/spill`.
    fn import_delimited(
        &self,
        path: &std::path::Path,
        work_dir: &std::path::Path,
        source: &TextSource,
        delimiter: char,
        memory_limit_mb: Option<u64>,
        threads: Option<u32>,
    ) -> Result<Value, EngineError> {
        use std::io::Write as _;
        let started = Instant::now();
        std::fs::create_dir_all(work_dir)
            .map_err(|e| EngineError::new("IO", format!("work directory: {e}")))?;
        let normalized_path = work_dir.join("rows.csv");
        let normalized = std::fs::File::create(&normalized_path)
            .map_err(|e| EngineError::new("IO", format!("normalized copy: {e}")))?;
        let mut out = std::io::BufWriter::with_capacity(1 << 20, normalized);
        let mut min_width = usize::MAX;
        let mut max_width = 0usize;
        let mut newline_in_value = false;
        let mut rows = 0u64;
        let mut cells = 0u64;
        let mut counts: Vec<ColumnCounts> = Vec::new();
        let mut header: Vec<String> = Vec::new();
        let mut line = String::with_capacity(4096);
        read_rows(path, source, delimiter, |row| {
            if rows == 0 {
                header = row.to_vec();
            }
            rows += 1;
            min_width = min_width.min(row.len());
            max_width = max_width.max(row.len());
            if counts.len() < row.len() {
                counts.resize_with(row.len(), ColumnCounts::default);
            }
            line.clear();
            let mut any = false;
            for (index, value) in row.iter().enumerate() {
                if index > 0 {
                    line.push('\u{1f}');
                }
                if value.is_empty() {
                    continue;
                }
                any = true;
                cells += 1;
                counts[index].add(value);
                newline_in_value |= value.contains('\n');
                line.push('"');
                if value.contains('"') {
                    line.push_str(&value.replace('"', "\"\""));
                } else {
                    line.push_str(value);
                }
                line.push('"');
            }
            if !any {
                // an all-empty row must not become a blank line (CSV readers
                // skip those): one quoted empty value keeps it, and reads as ''
                line.insert_str(0, "\"\"");
            }
            line.push('\n');
            out.write_all(line.as_bytes())
                .map_err(|e| ReadError::Stopped(format!("normalized copy: {e}")))
        })?;
        out.flush()
            .map_err(|e| EngineError::new("IO", format!("normalized copy: {e}")))?;
        drop(out);
        let measured = started.elapsed();
        let width = max_width;
        if width > MAX_CSV_COLS {
            return Err(EngineError::new("TOO_MANY_COLUMNS", "too many columns"));
        }

        let db = Connection::open_in_memory()?;
        let memory = memory_limit_mb.unwrap_or(1024).clamp(256, 4096);
        db.execute_batch(&format!(
            "SET memory_limit='{memory}MB'; SET threads={}; SET temp_directory={}; \
             SET preserve_insertion_order=true; SET autoinstall_known_extensions=false; \
             SET autoload_known_extensions=false;",
            threads.unwrap_or(2).clamp(1, 16),
            sql_literal(&work_dir.join("spill").to_string_lossy()),
        ))?;
        let table_width = width.max(1);
        let ragged = rows > 0 && min_width != max_width;
        let columns: Vec<String> = (0..table_width as u64)
            .map(|i| format!("'{}': 'VARCHAR'", column_name(i)))
            .collect();
        // DuckDB's parallel scanner cannot pad short rows when a quoted value
        // spans lines; that rare file is read on one thread instead.
        let options = format!(
            "delim='\u{1f}', quote='\"', escape='\"', header=false, auto_detect=false, \
             strict_mode=true, new_line='\\n', max_line_size=2147483647, columns={{{}}}, \
             null_padding={}, parallel={}",
            columns.join(", "),
            ragged,
            !(ragged && newline_in_value),
        );
        db.execute_batch(&format!(
            "CREATE TABLE t AS SELECT * FROM read_csv({}, {options});",
            sql_literal(&normalized_path.to_string_lossy()),
        ))?;
        let _ = std::fs::remove_file(&normalized_path);
        let stored: u64 = db.query_row("SELECT count(*) FROM t", [], |r| r.get(0))?;
        if stored != rows {
            return Err(EngineError::new(
                "IMPORT_MISMATCH",
                format!("read {rows} rows but stored {stored}"),
            ));
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            Arc::new(Mutex::new(Session {
                db,
                columns: width as u64,
                rows,
                calcs: Vec::new(),
                writer: Arc::new(Mutex::new(())),
            })),
        );
        Ok(json!({
            "sessionId": session_id,
            "rows": rows,
            "columns": width,
            "cells": cells,
            "header": header,
            "counts": counts,
            "measureMs": measured.as_millis() as u64,
            "totalMs": started.elapsed().as_millis() as u64,
        }))
    }

    fn read_range(
        &self,
        session_id: &str,
        start_row: u64,
        end_row: u64,
        start_column: u64,
        end_column: u64,
    ) -> Result<Value, EngineError> {
        if start_row > end_row || start_column > end_column {
            return Err(EngineError::new(
                "BAD_REQUEST",
                "Range boundaries are reversed.",
            ));
        }
        if (end_row - start_row + 1).saturating_mul(end_column - start_column + 1) > MAX_READ_CELLS
        {
            return Err(EngineError::new("BAD_REQUEST", "Range too large."));
        }
        let (db, rows, columns) = self.session(session_id)?;
        if columns == 0 || start_row >= rows || start_column >= columns {
            return Ok(json!({ "rows": [] }));
        }
        let last_column = end_column.min(columns - 1);
        let last_row = end_row.min(rows - 1);
        let selected: Vec<String> = (start_column..=last_column).map(column_name).collect();
        let sql = format!(
            "SELECT rowid, {} FROM t WHERE rowid BETWEEN ? AND ? ORDER BY rowid",
            selected.join(", ")
        );
        let mut statement = db.prepare(&sql)?;
        let mut cursor = statement.query(params![start_row as i64, last_row as i64])?;
        let width = selected.len();
        let mut out = Vec::new();
        while let Some(row) = cursor.next()? {
            let index: i64 = row.get(0)?;
            let mut values = Vec::with_capacity(width);
            let mut any = false;
            for column in 0..width {
                let value: Option<String> = row.get(column + 1)?;
                any |= value.is_some();
                values.push(value);
            }
            if any {
                out.push(json!([index, values]));
            }
        }
        Ok(json!({ "rows": out }))
    }

    fn apply_edits(
        &self,
        session_id: &str,
        fills: &[FillEdit],
        cells: &[CellEdit],
    ) -> Result<Value, EngineError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| EngineError::new("UNKNOWN_SESSION", "Unknown data session."))?;
        // one writer at a time per base; reads keep their own connections
        // and never wait for it
        let (writer, rows, db) = {
            let locked = session.lock().unwrap();
            (locked.writer.clone(), locked.rows, locked.db.try_clone()?)
        };
        let _writing = writer.lock().unwrap();
        let filled = |text: &Option<String>| text.as_deref().is_some_and(|t| !t.is_empty());
        // only values widen the base: clearing a column nobody saved yet
        // (typed right of the base, then deleted) writes nothing
        let needed = fills
            .iter()
            .filter(|f| filled(&f.text))
            .map(|f| f.end_column + 1)
            .chain(
                cells
                    .iter()
                    .filter(|c| filled(&c.text))
                    .map(|c| c.column + 1),
            )
            .max()
            .unwrap_or(0);
        if fills
            .iter()
            .any(|f| f.end_row >= rows || f.start_row > f.end_row)
            || cells.iter().any(|c| c.row >= rows)
        {
            return Err(EngineError::new("BAD_REQUEST", "Edit outside the base."));
        }
        if needed > MAX_CSV_COLS as u64 {
            return Err(EngineError::new("TOO_MANY_COLUMNS", "too many columns"));
        }
        let empty =
            |text: &Option<String>| text.as_deref().filter(|t| !t.is_empty()).map(str::to_owned);
        db.execute_batch("BEGIN TRANSACTION")?;
        let result = (|| -> Result<(), EngineError> {
            let existing: u64 = db.query_row(
                "SELECT count(*) FROM information_schema.columns WHERE table_name = 't'",
                [],
                |r| r.get::<_, i64>(0),
            )? as u64;
            for index in existing..needed {
                db.execute_batch(&format!(
                    "ALTER TABLE t ADD COLUMN {} VARCHAR",
                    column_name(index)
                ))?;
            }
            // empty edits past the table have nothing to clear
            let have = existing.max(needed);
            for fill in fills {
                let value = empty(&fill.text);
                for column in fill.start_column..=fill.end_column.min(have.saturating_sub(1)) {
                    db.execute(
                        &format!(
                            "UPDATE t SET {} = ? WHERE rowid BETWEEN ? AND ?",
                            column_name(column)
                        ),
                        params![value, fill.start_row as i64, fill.end_row as i64],
                    )?;
                }
            }
            // single cells per column through a temp table: one UPDATE ... FROM
            // writes 100k cells in ~0.2 s, where one statement per cell is ~100x slower
            let mut by_column: std::collections::BTreeMap<u64, HashMap<u64, Option<String>>> =
                std::collections::BTreeMap::new();
            for cell in cells.iter().filter(|c| c.column < have) {
                by_column
                    .entry(cell.column)
                    .or_default()
                    .insert(cell.row, empty(&cell.text));
            }
            for (column, values) in by_column {
                db.execute_batch("CREATE OR REPLACE TEMP TABLE fariv_edits (r BIGINT, v VARCHAR)")?;
                {
                    let mut appender = db.appender("fariv_edits")?;
                    for (row, value) in &values {
                        appender.append_row(params![*row as i64, value])?;
                    }
                    appender.flush()?;
                }
                db.execute_batch(&format!(
                    "UPDATE t SET {} = fariv_edits.v FROM fariv_edits WHERE t.rowid = fariv_edits.r",
                    column_name(column)
                ))?;
            }
            db.execute_batch("DROP TABLE IF EXISTS fariv_edits")?;
            Ok(())
        })();
        match result {
            Ok(()) => db.execute_batch("COMMIT")?,
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
        let mut session = session.lock().unwrap();
        session.columns = session.columns.max(needed);
        // cells typed over a calculated column stay the person's after Save
        let cell_spots: Vec<(u64, u64)> = cells.iter().map(|c| (c.row, c.column)).collect();
        let fill_spans: Vec<(u64, u64, u64, u64)> = fills
            .iter()
            .map(|f| (f.start_row, f.end_row, f.start_column, f.end_column))
            .collect();
        for calc in session.calcs.iter_mut().filter(|c| c.active) {
            calc.record_overrides(&cell_spots, &fill_spans);
        }
        Ok(json!({ "columns": session.width() }))
    }

    fn column_edge(
        &self,
        session_id: &str,
        column: u64,
        row: u64,
        down: bool,
    ) -> Result<Value, EngineError> {
        let (db, rows, columns) = self.session(session_id)?;
        let last = rows.saturating_sub(1);
        if rows == 0 {
            return Ok(json!({ "row": 0 }));
        }
        let row = row.min(last);
        if column >= columns {
            // no data in this column: the walk ends at the sheet edge
            return Ok(json!({ "row": if down { last } else { 0 } }));
        }
        if (down && row == last) || (!down && row == 0) {
            return Ok(json!({ "row": row }));
        }
        let name = column_name(column);
        let filled = format!("({name} IS NOT NULL AND {name} <> '')");
        let empty = format!("({name} IS NULL OR {name} = '')");
        let neighbour = if down { row + 1 } else { row - 1 };
        let is_filled = |at: u64| -> Result<bool, EngineError> {
            Ok(db.query_row(
                &format!("SELECT count(*) FROM t WHERE rowid = ? AND {filled}"),
                params![at as i64],
                |r| r.get::<_, i64>(0),
            )? > 0)
        };
        let target = if is_filled(row)? && is_filled(neighbour)? {
            // inside a block: stop on its last filled cell
            let gap: Option<i64> = if down {
                db.query_row(
                    &format!("SELECT min(rowid) FROM t WHERE rowid > ? AND {empty}"),
                    params![row as i64],
                    |r| r.get(0),
                )?
            } else {
                db.query_row(
                    &format!("SELECT max(rowid) FROM t WHERE rowid < ? AND {empty}"),
                    params![row as i64],
                    |r| r.get(0),
                )?
            };
            match (gap, down) {
                (Some(gap), true) => gap as u64 - 1,
                (Some(gap), false) => gap as u64 + 1,
                (None, true) => last,
                (None, false) => 0,
            }
        } else {
            // on an edge or a gap: the next filled cell, or the sheet edge
            let next: Option<i64> = if down {
                db.query_row(
                    &format!("SELECT min(rowid) FROM t WHERE rowid > ? AND {filled}"),
                    params![row as i64],
                    |r| r.get(0),
                )?
            } else {
                db.query_row(
                    &format!("SELECT max(rowid) FROM t WHERE rowid < ? AND {filled}"),
                    params![row as i64],
                    |r| r.get(0),
                )?
            };
            next.map(|n| n as u64)
                .unwrap_or(if down { last } else { 0 })
        };
        Ok(json!({ "row": target }))
    }

    fn find_cells(
        &self,
        session_id: &str,
        matcher: &Option<find::Matcher>,
        number_columns: &[NumberColumn],
        resume_row: u64,
        resume_column: u64,
        limit: usize,
    ) -> Result<Value, EngineError> {
        let Some(matcher) = matcher else {
            return Ok(json!({ "matches": [], "complete": true }));
        };
        let (db, rows, columns) = self.session(session_id)?;
        let marks: HashMap<u64, char> = number_columns
            .iter()
            .map(|c| (c.column, if c.decimal == "," { ',' } else { '.' }))
            .collect();
        let started = Instant::now();
        let mut matches = Vec::new();
        let selected: Vec<String> = (0..columns).map(column_name).collect();
        if columns == 0 {
            return Ok(json!({ "matches": [], "complete": true }));
        }
        let sql = format!(
            "SELECT rowid, {} FROM t WHERE rowid BETWEEN ? AND ? ORDER BY rowid",
            selected.join(", ")
        );
        let mut statement = db.prepare(&sql)?;
        let mut page_start = resume_row;
        while page_start < rows {
            let page_end = (page_start + FIND_PAGE_ROWS - 1).min(rows - 1);
            let mut cursor = statement.query(params![page_start as i64, page_end as i64])?;
            while let Some(row) = cursor.next()? {
                let index = row.get::<_, i64>(0)? as u64;
                let first_column = if index == resume_row {
                    resume_column
                } else {
                    0
                };
                for column in first_column..columns {
                    let Some(raw): Option<String> = row.get((column + 1) as usize)? else {
                        continue;
                    };
                    let number = marks
                        .get(&column)
                        .and_then(|mark| parse_number_with_mark(&raw, *mark));
                    let text = number.map(js_number_text).unwrap_or_else(|| raw.clone());
                    if !matcher.matches_text(&text) {
                        continue;
                    }
                    if matches.len() >= limit {
                        return Ok(json!({
                            "matches": matches,
                            "complete": false,
                            "nextRow": index,
                            "nextColumn": column,
                        }));
                    }
                    matches.push(json!([index, column, text]));
                }
            }
            page_start = page_end + 1;
            if page_start < rows && started.elapsed() > FIND_TIME_BUDGET {
                return Ok(json!({
                    "matches": matches,
                    "complete": false,
                    "nextRow": page_start,
                    "nextColumn": 0,
                }));
            }
        }
        Ok(json!({ "matches": matches, "complete": true }))
    }
}

mod find {
    //! Excel find semantics, the same rules as the XLSX sidecar's find.rs.

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Token {
        Any,
        One,
        Literal(char),
    }

    pub struct Matcher {
        tokens: Vec<Token>,
        needle: String,
        match_case: bool,
        entire_cell: bool,
        wildcards: bool,
    }

    impl Matcher {
        pub fn new(
            query: &str,
            match_case: bool,
            entire_cell: bool,
            wildcards: bool,
        ) -> Option<Self> {
            let folded = if match_case {
                query.to_owned()
            } else {
                query.to_lowercase()
            };
            let needle = folded.trim().to_owned();
            if needle.is_empty() {
                return None;
            }
            let tokens = if wildcards {
                parse_wildcards(&needle)
            } else {
                Vec::new()
            };
            Some(Self {
                tokens,
                needle,
                match_case,
                entire_cell,
                wildcards,
            })
        }

        pub fn matches_text(&self, text: &str) -> bool {
            let folded;
            let haystack: &str = if self.match_case {
                text
            } else {
                folded = text.to_lowercase();
                &folded
            };
            let haystack = if self.entire_cell {
                haystack.trim_matches(' ')
            } else {
                haystack
            };
            if !self.wildcards {
                return if self.entire_cell {
                    haystack == self.needle
                } else {
                    haystack.contains(&self.needle)
                };
            }
            let chars: Vec<char> = haystack.chars().collect();
            if self.entire_cell {
                return glob_match(&self.tokens, &chars);
            }
            (0..=chars.len()).any(|start| glob_prefix_match(&self.tokens, &chars[start..]))
        }
    }

    fn parse_wildcards(needle: &str) -> Vec<Token> {
        let mut tokens = Vec::new();
        let mut chars = needle.chars();
        while let Some(c) = chars.next() {
            match c {
                '*' => {
                    if tokens.last() != Some(&Token::Any) {
                        tokens.push(Token::Any);
                    }
                }
                '?' => tokens.push(Token::One),
                '~' => match chars.next() {
                    Some(next) => tokens.push(Token::Literal(next)),
                    None => tokens.push(Token::Literal('~')),
                },
                other => tokens.push(Token::Literal(other)),
            }
        }
        tokens
    }

    fn glob_match(tokens: &[Token], text: &[char]) -> bool {
        let (mut t, mut s) = (0usize, 0usize);
        let mut star: Option<(usize, usize)> = None;
        while s < text.len() {
            match tokens.get(t) {
                Some(Token::Any) => {
                    star = Some((t, s));
                    t += 1;
                }
                Some(Token::One) => {
                    t += 1;
                    s += 1;
                }
                Some(Token::Literal(c)) if *c == text[s] => {
                    t += 1;
                    s += 1;
                }
                _ => match star {
                    Some((star_t, star_s)) => {
                        t = star_t + 1;
                        s = star_s + 1;
                        star = Some((star_t, star_s + 1));
                    }
                    None => return false,
                },
            }
        }
        tokens[t..].iter().all(|token| *token == Token::Any)
    }

    fn glob_prefix_match(tokens: &[Token], text: &[char]) -> bool {
        match tokens.split_first() {
            None => true,
            Some((Token::Any, rest)) => {
                (0..=text.len()).any(|skip| glob_prefix_match(rest, &text[skip..]))
            }
            Some((Token::One, rest)) => !text.is_empty() && glob_prefix_match(rest, &text[1..]),
            Some((Token::Literal(c), rest)) => {
                text.first() == Some(c) && glob_prefix_match(rest, &text[1..])
            }
        }
    }
}

type SharedOutput = Arc<Mutex<BufWriter<io::Stdout>>>;

fn write_response(output: &SharedOutput, response: &Response) {
    let mut out = output.lock().unwrap();
    if serde_json::to_writer(&mut *out, response).is_ok() {
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

fn main() {
    let engine = Arc::new(Engine::default());
    let output: SharedOutput = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let request_id = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|v| v["requestId"].as_str().map(str::to_owned))
                    .unwrap_or_default();
                write_response(
                    &output,
                    &Response {
                        version: PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(json!({ "code": "BAD_REQUEST", "message": error.to_string() })),
                    },
                );
                continue;
            }
        };
        let engine = Arc::clone(&engine);
        let output = Arc::clone(&output);
        thread::spawn(move || {
            let response = if request.version != PROTOCOL_VERSION {
                Response {
                    version: PROTOCOL_VERSION,
                    request_id: request.request_id,
                    ok: false,
                    result: None,
                    error: Some(
                        json!({ "code": "VERSION", "message": "Unsupported protocol version." }),
                    ),
                }
            } else {
                match engine.handle(request.command) {
                    Ok(result) => Response {
                        version: PROTOCOL_VERSION,
                        request_id: request.request_id,
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => Response {
                        version: PROTOCOL_VERSION,
                        request_id: request.request_id,
                        ok: false,
                        result: None,
                        error: Some(json!({ "code": error.code, "message": error.message })),
                    },
                }
            };
            write_response(&output, &response);
        });
    }
}
