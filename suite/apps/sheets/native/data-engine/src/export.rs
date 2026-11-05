//! Writing the whole base back out, streamed from DuckDB row by row so a
//! million-row save never holds the file in memory.
//!
//! - Delimited text follows the app's CSV writer (`csv-export.ts`): UTF-8 with
//!   a BOM, CRLF rows, a field is quoted when it holds a quote, a line break or
//!   the delimiter, and the optional Excel `sep=` first line. Cells keep the
//!   exact text they were read with (or the text an edit gave them), so an
//!   unedited value round-trips byte for byte.
//! - XLSX writes one sheet with number columns as numbers (read with the
//!   column's decimal mark, as the grid shows them) and everything else as
//!   text, in rust_xlsxwriter's constant-memory mode.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use duckdb::Connection;
use serde_json::{Value, json};

use crate::numbers::parse_number_with_mark;
use crate::{EngineError, NumberColumn, column_name};

/// Excel's sheet bounds.
const XLSX_MAX_ROWS: u64 = 1_048_576;
const XLSX_MAX_CELL_CHARS: usize = 32_767;

fn io_error(error: std::io::Error) -> EngineError {
    EngineError::new("IO", error.to_string())
}

/// `csvField` in csv-export.ts.
pub fn csv_field(text: &str, delimiter: char, out: &mut String) {
    let normalized = if text.contains('\r') {
        std::borrow::Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        std::borrow::Cow::Borrowed(text)
    };
    let special =
        normalized.contains('"') || normalized.contains('\n') || normalized.contains(delimiter);
    if special {
        out.push('"');
        out.push_str(&normalized.replace('"', "\"\""));
        out.push('"');
    } else {
        out.push_str(&normalized);
    }
}

fn select_all(columns: u64) -> String {
    let names: Vec<String> = (0..columns.max(1)).map(column_name).collect();
    format!("SELECT {} FROM t ORDER BY rowid", names.join(", "))
}

pub fn delimited(
    db: &Connection,
    columns: u64,
    path: &Path,
    delimiter: char,
    sep_line: bool,
) -> Result<Value, EngineError> {
    let file = File::create(path).map_err(io_error)?;
    let mut out = BufWriter::with_capacity(1 << 20, file);
    out.write_all(&[0xef, 0xbb, 0xbf]).map_err(io_error)?;
    if sep_line {
        out.write_all(format!("sep={delimiter}\r\n").as_bytes())
            .map_err(io_error)?;
    }
    let width = columns.max(1) as usize;
    let mut statement = db.prepare(&select_all(columns))?;
    let mut cursor = statement.query([])?;
    let mut line = String::with_capacity(4096);
    let mut rows = 0u64;
    while let Some(row) = cursor.next()? {
        line.clear();
        for column in 0..width {
            if column > 0 {
                line.push(delimiter);
            }
            let value: Option<String> = row.get(column)?;
            if let Some(text) = value {
                csv_field(&text, delimiter, &mut line);
            }
        }
        line.push_str("\r\n");
        out.write_all(line.as_bytes()).map_err(io_error)?;
        rows += 1;
    }
    out.flush().map_err(io_error)?;
    Ok(json!({ "rows": rows }))
}

pub fn xlsx(
    db: &Connection,
    rows: u64,
    columns: u64,
    path: &Path,
    sheet_name: &str,
    number_columns: &[NumberColumn],
) -> Result<Value, EngineError> {
    if rows > XLSX_MAX_ROWS {
        return Err(EngineError::new(
            "TOO_MANY_ROWS",
            format!("{rows} rows do not fit an .xlsx sheet (limit {XLSX_MAX_ROWS})"),
        ));
    }
    let xlsx_error =
        |error: rust_xlsxwriter::XlsxError| EngineError::new("XLSX", error.to_string());
    let marks: HashMap<u64, char> = number_columns
        .iter()
        .map(|c| (c.column, if c.decimal == "," { ',' } else { '.' }))
        .collect();
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let sheet = workbook
        .add_worksheet_with_constant_memory()
        .map_err(xlsx_error)?;
    sheet.set_name(sheet_name).map_err(xlsx_error)?;
    let width = columns.max(1) as usize;
    let mut statement = db.prepare(&select_all(columns))?;
    let mut cursor = statement.query([])?;
    let mut row_index = 0u32;
    while let Some(row) = cursor.next()? {
        for column in 0..width {
            let value: Option<String> = row.get(column)?;
            let Some(text) = value.filter(|t| !t.is_empty()) else {
                continue;
            };
            let number = marks
                .get(&(column as u64))
                .and_then(|mark| parse_number_with_mark(&text, *mark));
            match number {
                Some(number) => {
                    sheet
                        .write_number(row_index, column as u16, number)
                        .map_err(xlsx_error)?;
                }
                None => {
                    if text.chars().count() > XLSX_MAX_CELL_CHARS {
                        return Err(EngineError::new(
                            "CELL_TOO_LONG",
                            format!(
                                "row {}, column {}: more than {XLSX_MAX_CELL_CHARS} characters",
                                row_index + 1,
                                column + 1
                            ),
                        ));
                    }
                    sheet
                        .write_string(row_index, column as u16, &text)
                        .map_err(xlsx_error)?;
                }
            }
        }
        row_index += 1;
    }
    workbook.save(path).map_err(xlsx_error)?;
    Ok(json!({ "rows": row_index }))
}
