//! Statistics of a range of the base: what the status bar shows for a
//! selection and what the AI's aggregate_range answers ("how many", "how
//! much", "how many distinct"). One pass over the columns in the engine,
//! with the grid's unsaved edits on top, so a selection of the whole base
//! never goes through the grid or through chunked reads.
//!
//! Same rules as the app's RangeAggregator (renderer/ai/aggregate.ts):
//! numbers are what the grid reads (the column's decimal mark), distinct
//! values are keyed by type and JavaScript text, tracking stops past 200,000
//! distinct values, and the sum runs in row-major order.

use std::collections::HashMap;

use duckdb::params;
use serde_json::{Value as Json, json};

use crate::calc::{GridEdits, each_text_pub, number_marks_pub};
use crate::formula::Value;
use crate::numbers::{js_number_text, parse_number_fast};
use crate::{Engine, EngineError, NumberColumn, column_name};

const MAX_DISTINCT_TRACKED: usize = 200_000;

#[derive(Default)]
struct Totals {
    cells: u64,
    non_empty: u64,
    numeric_count: u64,
    sum: f64,
    min: Option<f64>,
    max: Option<f64>,
    overflowed: bool,
    /// key -> (count, first seen)
    counts: HashMap<String, (u64, u64)>,
    seen: u64,
}

impl Totals {
    fn add(&mut self, value: &Value) {
        self.cells += 1;
        let key = match value {
            Value::Empty => return,
            Value::Text(t) if t.is_empty() => return,
            Value::Num(n) => {
                self.numeric_count += 1;
                self.sum += n;
                self.min = Some(self.min.map_or(*n, |m| m.min(*n)));
                self.max = Some(self.max.map_or(*n, |m| m.max(*n)));
                format!("number:{}", js_number_text(*n))
            }
            Value::Text(t) => format!("string:{t}"),
            Value::Bool(b) => format!("boolean:{b}"),
            Value::Err(e) => format!("string:{}", e.text()),
        };
        self.non_empty += 1;
        if self.overflowed {
            return;
        }
        if let Some(entry) = self.counts.get_mut(&key) {
            entry.0 += 1;
        } else if self.counts.len() >= MAX_DISTINCT_TRACKED {
            self.overflowed = true;
            self.counts.clear();
        } else {
            self.counts.insert(key, (1, self.seen));
            self.seen += 1;
        }
    }
}

impl Engine {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn aggregate_range(
        &self,
        session_id: &str,
        start_row: u64,
        end_row: u64,
        start_column: u64,
        end_column: u64,
        number_columns: &[NumberColumn],
        edits: &GridEdits,
        top_values: usize,
    ) -> Result<Json, EngineError> {
        let Some(columns) = self.load_range(
            session_id,
            start_row,
            end_row,
            start_column,
            end_column,
            number_columns,
            edits,
        )?
        else {
            return Ok(empty_result());
        };
        let height = columns.first().map_or(0, Vec::len);
        let mut totals = Totals::default();
        for row in 0..height {
            for values in &columns {
                totals.add(&values[row]);
            }
        }
        let mut ranked: Vec<(&String, &(u64, u64))> = totals.counts.iter().collect();
        ranked.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(a.1.1.cmp(&b.1.1)));
        let top: Vec<Json> = if totals.overflowed {
            Vec::new()
        } else {
            ranked
                .iter()
                .take(top_values)
                .map(|(key, (count, _))| {
                    let value = key.split_once(':').map_or(key.as_str(), |(_, v)| v);
                    json!({ "value": value, "count": count })
                })
                .collect()
        };
        Ok(json!({
            "cells": totals.cells,
            "nonEmpty": totals.non_empty,
            "distinct": if totals.overflowed { Json::Null } else { json!(totals.counts.len()) },
            "numericCount": totals.numeric_count,
            "sum": totals.sum,
            "min": totals.min,
            "max": totals.max,
            "average": if totals.numeric_count > 0 { json!(totals.sum / totals.numeric_count as f64) } else { Json::Null },
            "topValues": top,
            "withheld": 0,
        }))
    }
}

impl Engine {
    /// The grid's values of a range (clamped to the base and to the columns
    /// edits added), one vector per column, unsaved edits on top. None when
    /// the range holds no cell of the base.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn load_range(
        &self,
        session_id: &str,
        start_row: u64,
        end_row: u64,
        start_column: u64,
        end_column: u64,
        number_columns: &[NumberColumn],
        edits: &GridEdits,
    ) -> Result<Option<Vec<Vec<Value>>>, EngineError> {
        let (db, rows, width) = self.session(session_id)?;
        let calcs = self.calc_columns(session_id)?;
        let marks = number_marks_pub(number_columns, &calcs);
        // the extent covers columns and rows the grid's edits added
        let edit_extent = edits.extent();
        let last_column = end_column.min(width.max(edit_extent.1).saturating_sub(1));
        let last_row = end_row.min(rows.saturating_sub(1));
        if rows == 0 || start_row > last_row || start_column > last_column {
            return Ok(None);
        }
        let height = (last_row - start_row + 1) as usize;
        let mut columns: Vec<Vec<Value>> = Vec::new();
        for column in start_column..=last_column {
            let mut values = Vec::with_capacity(height);
            if column < width {
                let sql = format!(
                    "SELECT {} FROM t WHERE rowid BETWEEN ? AND ? ORDER BY rowid",
                    column_name(column)
                );
                let mut statement = db.prepare(&sql)?;
                let mark = marks.get(&column).copied();
                let logical = calcs.iter().any(|(c, _)| *c == column);
                for batch in statement.query_arrow(params![start_row as i64, last_row as i64])? {
                    each_text_pub(batch.column(0), |raw| {
                        values.push(match raw {
                            None | Some("") => Value::Empty,
                            Some("TRUE") if logical => Value::Bool(true),
                            Some("FALSE") if logical => Value::Bool(false),
                            Some(text) => match mark.and_then(|m| parse_number_fast(text, m)) {
                                Some(n) => Value::Num(n),
                                None => Value::Text(text.to_owned()),
                            },
                        });
                    })?;
                }
            }
            values.resize(height, Value::Empty);
            columns.push(values);
        }
        edits.overlay(start_row, last_row, start_column, &mut columns);
        Ok(Some(columns))
    }

    /// The range as clipboard text (tab-separated, Excel quoting), the
    /// numbers as the grid shows them unformatted.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn range_text(
        &self,
        session_id: &str,
        start_row: u64,
        end_row: u64,
        start_column: u64,
        end_column: u64,
        number_columns: &[NumberColumn],
        edits: &GridEdits,
    ) -> Result<Json, EngineError> {
        let Some(columns) = self.load_range(
            session_id,
            start_row,
            end_row,
            start_column,
            end_column,
            number_columns,
            edits,
        )?
        else {
            return Ok(json!({ "text": "", "rows": 0, "columns": 0 }));
        };
        let height = columns.first().map_or(0, Vec::len);
        let mut text = String::with_capacity(height * columns.len() * 8);
        for row in 0..height {
            if row > 0 {
                text.push('\n');
            }
            for (i, values) in columns.iter().enumerate() {
                if i > 0 {
                    text.push('\t');
                }
                let field = match &values[row] {
                    Value::Empty => continue,
                    Value::Num(n) => js_number_text(*n),
                    Value::Text(t) => t.replace("\r\n", "\n").replace('\r', "\n"),
                    Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_owned(),
                    Value::Err(e) => e.text().to_owned(),
                };
                if field.contains(['\t', '\n', '"']) {
                    text.push('"');
                    text.push_str(&field.replace('"', "\"\""));
                    text.push('"');
                } else {
                    text.push_str(&field);
                }
            }
        }
        Ok(json!({ "text": text, "rows": height, "columns": columns.len() }))
    }
}

fn empty_result() -> Json {
    json!({
        "cells": 0, "nonEmpty": 0, "distinct": 0, "numericCount": 0, "sum": 0.0,
        "min": null, "max": null, "average": null, "topValues": [], "withheld": 0,
    })
}
