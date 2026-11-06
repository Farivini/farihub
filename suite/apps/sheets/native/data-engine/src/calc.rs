//! Calculated columns: one formula over every data row of a column.
//!
//! A calculated column lives in the base itself: its results are written into
//! the column (in the file's convention, with Excel's 15 digits), so reads,
//! Find, Ctrl+Down and the save path see them like any other value. It is
//! created only over an empty range, so turning it off (Undo) empties that
//! range again, and turning it back on recomputes it.
//!
//! The grid keeps its own edits in a journal until Save. Every calc request
//! carries those edits, so a formula reads what the grid shows, not the base
//! as last saved. When an edit touches a column a formula reads, the host asks
//! for a refresh and only the cells whose result changed are written.
//!
//! After a Save writes the journal into the base, cells the person typed over
//! inside a calculated column are kept as overrides: a later refresh leaves
//! them alone, as Excel leaves a cell that breaks a table's column formula.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use duckdb::{Connection, params};
use serde::Deserialize;
use serde_json::{Value as Json, json};

use duckdb::arrow::array::{Array, ArrayRef, LargeStringArray, StringArray, StringViewArray};

use crate::formula::{Data, Evaluator, Formula, Value, stored_text};
use crate::numbers::parse_number_fast;
use crate::{Engine, EngineError, NumberColumn, Session, column_name};

/// A refresh recomputes only the rows an edit touched when the formula reads
/// nothing but its own row and at most this many rows changed.
const PARTIAL_ROWS: u64 = 200_000;

/// One edit of the grid's journal, with the value the grid holds.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GridCell {
    row: u64,
    column: u64,
    value: Json,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GridFill {
    start_row: u64,
    end_row: u64,
    start_column: u64,
    end_column: u64,
    value: Json,
}

/// The grid's unsaved value edits, in journal order (fills, then cells, which
/// always win).
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GridEdits {
    #[serde(default)]
    cells: Vec<GridCell>,
    #[serde(default)]
    fills: Vec<GridFill>,
}

impl GridEdits {
    /// One past the last (row, column) an edit writes.
    pub(crate) fn extent(&self) -> (u64, u64) {
        let mut rows = 0;
        let mut columns = 0;
        for c in &self.cells {
            rows = rows.max(c.row + 1);
            columns = columns.max(c.column + 1);
        }
        for f in &self.fills {
            rows = rows.max(f.end_row + 1);
            columns = columns.max(f.end_column + 1);
        }
        (rows, columns)
    }

    /// Writes the edits over columns `first_column..` holding rows
    /// `first_row..=last_row` (fills first, cells win).
    pub(crate) fn overlay(
        &self,
        first_row: u64,
        last_row: u64,
        first_column: u64,
        columns: &mut [Vec<Value>],
    ) {
        let width = columns.len() as u64;
        let inside = |col: u64| col >= first_column && col < first_column + width;
        for fill in &self.fills {
            let value = json_value(&fill.value);
            for col in (fill.start_column..=fill.end_column).filter(|c| inside(*c)) {
                let values = &mut columns[(col - first_column) as usize];
                for row in fill.start_row.max(first_row)..=fill.end_row.min(last_row) {
                    values[(row - first_row) as usize] = value.clone();
                }
            }
        }
        for cell in &self.cells {
            if inside(cell.column) && cell.row >= first_row && cell.row <= last_row {
                columns[(cell.column - first_column) as usize][(cell.row - first_row) as usize] =
                    json_value(&cell.value);
            }
        }
    }

    /// Whether an edit puts a value in rows `first..=last` of `column`.
    fn touches(&self, column: u64, first: u64, last: u64) -> bool {
        let filled = |v: &Json| !matches!(json_value(v), Value::Empty);
        self.cells
            .iter()
            .any(|c| c.column == column && c.row >= first && c.row <= last && filled(&c.value))
            || self.fills.iter().any(|f| {
                (f.start_column..=f.end_column).contains(&column)
                    && f.end_row >= first
                    && f.start_row <= last
                    && filled(&f.value)
            })
    }

    /// A hash of the edits in `columns`, in journal order.
    fn fingerprint(&self, columns: &BTreeSet<u64>) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for fill in &self.fills {
            if (fill.start_column..=fill.end_column).any(|c| columns.contains(&c)) {
                (
                    fill.start_row,
                    fill.end_row,
                    fill.start_column,
                    fill.end_column,
                )
                    .hash(&mut hasher);
                fill.value.to_string().hash(&mut hasher);
            }
        }
        for cell in self.cells.iter().filter(|c| columns.contains(&c.column)) {
            (cell.row, cell.column).hash(&mut hasher);
            cell.value.to_string().hash(&mut hasher);
        }
        hasher.finish()
    }
}

/// Cells that changed since the formulas last ran (an edit, a pasted block).
#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start_row: u64,
    pub end_row: u64,
    pub start_column: u64,
    pub end_column: u64,
}

#[derive(Clone)]
pub struct Calc {
    pub id: String,
    formula: Formula,
    /// decimal mark its numbers are stored with
    pub mark: char,
    pub active: bool,
    /// rows typed over after a Save (single cells and filled spans)
    override_rows: BTreeSet<u64>,
    override_spans: Vec<(u64, u64)>,
    /// fingerprint of the unsaved edits (of what it reads) its results reflect
    edits_seen: Option<u64>,
}

impl Calc {
    pub fn column(&self) -> u64 {
        self.formula.column
    }

    pub fn rows(&self) -> (u64, u64) {
        (self.formula.first_row, self.formula.last_row)
    }

    fn overridden(&self, row: u64) -> bool {
        self.override_rows.contains(&row)
            || self
                .override_spans
                .iter()
                .any(|(a, b)| row >= *a && row <= *b)
    }

    /// Records the cells a Save is writing over inside this column.
    pub fn record_overrides(&mut self, cells: &[(u64, u64)], fills: &[(u64, u64, u64, u64)]) {
        let (first, last, column) = (self.formula.first_row, self.formula.last_row, self.column());
        for (row, col) in cells {
            if *col == column && *row >= first && *row <= last {
                self.override_rows.insert(*row);
            }
        }
        for (r0, r1, c0, c1) in fills {
            if column >= *c0 && column <= *c1 && *r1 >= first && *r0 <= last {
                self.override_spans
                    .push(((*r0).max(first), (*r1).min(last)));
            }
        }
    }
}

fn json_value(value: &Json) -> Value {
    match value {
        Json::Null => Value::Empty,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => n.as_f64().map_or(Value::Empty, Value::Num),
        Json::String(s) if s.is_empty() => Value::Empty,
        Json::String(s) => Value::Text(s.clone()),
        _ => Value::Empty,
    }
}

fn mark_of(text: &str) -> char {
    if text == "," { ',' } else { '.' }
}

fn table_width(db: &Connection) -> Result<u64, EngineError> {
    Ok(db.query_row(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = 't'",
        [],
        |r| r.get::<_, i64>(0),
    )? as u64)
}

/// A session, its writer lock, a connection and the row count.
type Writer = (Arc<Mutex<Session>>, Arc<Mutex<()>>, Connection, u64);

impl Engine {
    /// The session's writer lock, connection and row count. Calc work runs
    /// under the writer lock only, so grid reads never wait for a recompute.
    fn writer(&self, session_id: &str) -> Result<Writer, EngineError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| EngineError::new("UNKNOWN_SESSION", "Unknown data session."))?;
        let (writer, db, rows) = {
            let locked = session.lock().unwrap();
            (locked.writer.clone(), locked.db.try_clone()?, locked.rows)
        };
        Ok((session, writer, db, rows))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn calc_create(
        &self,
        session_id: &str,
        text: &str,
        anchor_row: u64,
        column: u64,
        first_row: u64,
        last_row: u64,
        sheet_name: &str,
        decimal: &str,
        number_columns: &[NumberColumn],
        edits: &GridEdits,
        replace_existing: bool,
    ) -> Result<Json, EngineError> {
        let started = Instant::now();
        let (session, writer, db, rows) = self.writer(session_id)?;
        let _writing = writer.lock().unwrap();
        if first_row > last_row || last_row >= rows || first_row == 0 {
            return Err(EngineError::new("BAD_REQUEST", "Rows outside the base."));
        }
        let formula = Formula::parse(text, anchor_row, column, first_row, last_row, sheet_name)
            .map_err(|e| EngineError::new(e.code, e.detail))?;
        let mut calcs = session.lock().unwrap().calcs.clone();
        // a new formula over a calculated column replaces it (Excel: typing a
        // new formula into a table's calculated column)
        let replaced = calcs.iter().position(|c| c.active && c.column() == column);
        if replaced.is_some() && !replace_existing {
            return Err(EngineError::new(
                "COLUMN_NOT_EMPTY",
                "The column has a formula.",
            ));
        }
        // values typed in the column and not yet saved would hide the results
        if edits.touches(column, first_row, last_row) {
            return Err(EngineError::new(
                "COLUMN_NOT_EMPTY",
                "The column has values.",
            ));
        }
        if replaced.is_none() && column < table_width(&db)? {
            let name = column_name(column);
            let filled: i64 = db.query_row(
                &format!(
                    "SELECT count(*) FROM t WHERE rowid BETWEEN ? AND ? \
                     AND {name} IS NOT NULL AND {name} <> ''"
                ),
                params![first_row as i64, last_row as i64],
                |r| r.get(0),
            )?;
            if filled > 0 {
                return Err(EngineError::new(
                    "COLUMN_NOT_EMPTY",
                    "The column has values.",
                ));
            }
        }
        let mut calc = Calc {
            id: uuid::Uuid::new_v4().to_string(),
            formula,
            mark: mark_of(decimal),
            active: true,
            override_rows: BTreeSet::new(),
            override_spans: Vec::new(),
            edits_seen: None,
        };
        if let Some(at) = replaced {
            // the old formula's overrides stay the person's cells
            calc.override_rows = calcs[at].override_rows.clone();
            calc.override_spans = calcs[at].override_spans.clone();
        }
        let marks = number_marks(number_columns, &calcs);
        let summary = compute(
            &db,
            rows,
            &mut calc,
            &marks,
            edits,
            None,
            replaced.is_none(),
        )?;
        let replaced_id = replaced.map(|at| {
            calcs[at].active = false;
            calcs[at].id.clone()
        });
        let id = calc.id.clone();
        calcs.push(calc);
        // later formulas reading this column follow it
        let whole = vec![Span {
            start_row: first_row,
            end_row: last_row,
            start_column: column,
            end_column: column,
        }];
        let refreshed = refresh(
            &db,
            rows,
            &mut calcs,
            &whole,
            number_columns,
            edits,
            Some(&id),
            None,
        )?;
        session.lock().unwrap().calcs = calcs;
        Ok(json!({
            "calcId": id,
            "replaced": replaced_id,
            "rows": last_row - first_row + 1,
            "written": summary.written,
            "errors": summary.errors,
            "firstErrorRow": summary.first_error_row,
            "refreshed": refreshed,
            "ms": started.elapsed().as_millis() as u64,
        }))
    }

    pub(crate) fn calc_set_active(
        &self,
        session_id: &str,
        calc_id: &str,
        active: bool,
        number_columns: &[NumberColumn],
        edits: &GridEdits,
    ) -> Result<Json, EngineError> {
        let started = Instant::now();
        let (session, writer, db, rows) = self.writer(session_id)?;
        let _writing = writer.lock().unwrap();
        let mut calcs = session.lock().unwrap().calcs.clone();
        let at = calcs
            .iter()
            .position(|c| c.id == calc_id)
            .ok_or_else(|| EngineError::new("BAD_REQUEST", "Unknown calculated column."))?;
        if calcs[at].active == active {
            return Ok(json!({ "ms": 0, "refreshed": [] }));
        }
        let column = calcs[at].column();
        if active {
            if calcs.iter().any(|c| c.active && c.column() == column) {
                return Err(EngineError::new(
                    "COLUMN_NOT_EMPTY",
                    "The column has a formula.",
                ));
            }
            let marks = number_marks(number_columns, &calcs);
            compute(&db, rows, &mut calcs[at], &marks, edits, None, false)?;
            calcs[at].active = true;
        } else {
            clear_calc(&db, &calcs[at])?;
            calcs[at].active = false;
        }
        let whole = vec![Span {
            start_row: calcs[at].formula.first_row,
            end_row: calcs[at].formula.last_row,
            start_column: column,
            end_column: column,
        }];
        let refreshed = refresh(
            &db,
            rows,
            &mut calcs,
            &whole,
            number_columns,
            edits,
            Some(calc_id),
            None,
        )?;
        session.lock().unwrap().calcs = calcs;
        Ok(json!({ "ms": started.elapsed().as_millis() as u64, "refreshed": refreshed }))
    }

    pub(crate) fn calc_refresh(
        &self,
        session_id: &str,
        changed: &[Span],
        number_columns: &[NumberColumn],
        edits: &GridEdits,
        quick: bool,
    ) -> Result<Json, EngineError> {
        let started = Instant::now();
        let (session, writer, db, rows) = self.writer(session_id)?;
        let _writing = writer.lock().unwrap();
        let mut calcs = session.lock().unwrap().calcs.clone();
        let mut pending = false;
        let refreshed = refresh(
            &db,
            rows,
            &mut calcs,
            changed,
            number_columns,
            edits,
            None,
            quick.then_some(&mut pending),
        )?;
        session.lock().unwrap().calcs = calcs;
        Ok(json!({
            "ms": started.elapsed().as_millis() as u64,
            "refreshed": refreshed,
            "pending": pending,
        }))
    }
}

/// Recomputes, in creation order, every active formula that reads a changed
/// cell, and the formulas that read those in turn. A row-local formula
/// recomputes only the changed rows. Returns the columns whose cells changed.
#[allow(clippy::too_many_arguments)]
fn refresh(
    db: &Connection,
    rows: u64,
    calcs: &mut [Calc],
    changed: &[Span],
    number_columns: &[NumberColumn],
    edits: &GridEdits,
    skip: Option<&str>,
    // a quick pass runs the row-local formulas only (an edited row shows its
    // results at once) and flags the others for a full pass
    mut quick: Option<&mut bool>,
) -> Result<Vec<u64>, EngineError> {
    let mut changed: Vec<Span> = changed.to_vec();
    let given = changed.len();
    let mut refreshed = Vec::new();
    let marks = number_marks(number_columns, calcs);
    for calc in calcs.iter_mut() {
        if !calc.active || Some(calc.id.as_str()) == skip {
            continue;
        }
        let reads = &calc.formula.reads;
        let reads_span = |s: &Span| (s.start_column..=s.end_column).any(|c| reads.contains(&c));
        let hits: Vec<&Span> = changed.iter().filter(|s| reads_span(s)).collect();
        if hits.is_empty() {
            continue;
        }
        // already computed over these very edits (a Save right after the
        // refresh that followed the last edit), and nothing above it moved
        let upstream = changed[given..].iter().any(reads_span);
        if !upstream && calc.edits_seen == Some(edits.fingerprint(reads)) {
            continue;
        }
        if let Some(pending) = quick.as_deref_mut()
            && !calc.formula.row_local
        {
            *pending = true;
            continue;
        }
        let only_rows = if calc.formula.row_local {
            let mut rows_hit: BTreeSet<u64> = BTreeSet::new();
            let mut fits = true;
            for span in &hits {
                let (a, b) = (
                    span.start_row.max(calc.formula.first_row),
                    span.end_row.min(calc.formula.last_row),
                );
                if a > b {
                    continue;
                }
                if rows_hit.len() as u64 + (b - a + 1) > PARTIAL_ROWS {
                    fits = false;
                    break;
                }
                rows_hit.extend(a..=b);
            }
            fits.then_some(rows_hit)
        } else {
            None
        };
        if only_rows.as_ref().is_some_and(BTreeSet::is_empty) {
            continue;
        }
        let summary = compute(db, rows, calc, &marks, edits, only_rows.as_ref(), false)?;
        if summary.written > 0 {
            refreshed.push(calc.column());
            let spans = row_spans(&summary.written_rows, calc);
            changed.extend(spans);
        }
    }
    Ok(refreshed)
}

/// The rows a formula wrote, as spans of its column (one span for a big
/// rewrite, so later formulas recompute in full).
fn row_spans(written: &[u64], calc: &Calc) -> Vec<Span> {
    let column = calc.column();
    if written.len() as u64 > PARTIAL_ROWS {
        return vec![Span {
            start_row: calc.formula.first_row,
            end_row: calc.formula.last_row,
            start_column: column,
            end_column: column,
        }];
    }
    let mut spans: Vec<Span> = Vec::new();
    for &row in written {
        match spans.last_mut() {
            Some(last) if last.end_row + 1 == row => last.end_row = row,
            _ => spans.push(Span {
                start_row: row,
                end_row: row,
                start_column: column,
                end_column: column,
            }),
        }
    }
    spans
}

pub(crate) fn number_marks_pub(
    number_columns: &[NumberColumn],
    calcs: &[(u64, char)],
) -> HashMap<u64, char> {
    let mut marks: HashMap<u64, char> = number_columns
        .iter()
        .map(|c| (c.column, mark_of(&c.decimal)))
        .collect();
    for (column, mark) in calcs {
        marks.insert(*column, *mark);
    }
    marks
}

pub(crate) fn each_text_pub(
    array: &ArrayRef,
    f: impl FnMut(Option<&str>),
) -> Result<(), EngineError> {
    each_text(array, f)
}

/// Decimal marks of the number columns, the calculated ones included.
fn number_marks(number_columns: &[NumberColumn], calcs: &[Calc]) -> HashMap<u64, char> {
    let mut marks: HashMap<u64, char> = number_columns
        .iter()
        .map(|c| (c.column, mark_of(&c.decimal)))
        .collect();
    for calc in calcs.iter().filter(|c| c.active) {
        marks.insert(calc.column(), calc.mark);
    }
    marks
}

struct Summary {
    written: u64,
    /// rows written, when they are few enough to pass on as spans
    written_rows: Vec<u64>,
    errors: u64,
    first_error_row: Option<u64>,
}

fn cell_value(raw: Option<&str>, mark: Option<char>) -> Value {
    match raw {
        None | Some("") => Value::Empty,
        Some(text) => match mark.and_then(|m| parse_number_fast(text, m)) {
            Some(n) => Value::Num(n),
            None => Value::Text(text.to_owned()),
        },
    }
}

/// Every value of one Arrow text column, in order.
fn each_text(array: &ArrayRef, mut f: impl FnMut(Option<&str>)) -> Result<(), EngineError> {
    macro_rules! walk {
        ($t:ty) => {
            if let Some(a) = array.as_any().downcast_ref::<$t>() {
                for i in 0..a.len() {
                    f(if a.is_null(i) { None } else { Some(a.value(i)) });
                }
                return Ok(());
            }
        };
    }
    walk!(StringArray);
    walk!(LargeStringArray);
    walk!(StringViewArray);
    if array.null_count() == array.len() {
        for _ in 0..array.len() {
            f(None);
        }
        return Ok(());
    }
    Err(EngineError::new(
        "ENGINE",
        format!("unexpected column type {:?}", array.data_type()),
    ))
}

/// Loads what the formula reads and its own column's current text, then
/// evaluates every row (or only `only_rows`, for a row-local formula) and
/// writes the cells whose text changed. `fresh`: the column is known empty.
fn compute(
    db: &Connection,
    rows: u64,
    calc: &mut Calc,
    marks: &HashMap<u64, char>,
    edits: &GridEdits,
    only_rows: Option<&BTreeSet<u64>>,
    fresh: bool,
) -> Result<Summary, EngineError> {
    let profile_started = Instant::now();
    let width = table_width(db)?;
    let column = calc.column();
    let reads = &calc.formula.reads;
    let mut data = Data {
        rows,
        columns: HashMap::new(),
        cells: HashMap::new(),
    };
    // the column's current text, to write only what changed: by row for a
    // full run, by row number for a few rows
    let mut current_rows: Vec<Option<Box<str>>> = Vec::new();
    let mut current: HashMap<u64, String> = HashMap::new();
    let mut loaded: Vec<u64> = reads.iter().copied().filter(|c| *c < width).collect();
    let own_stored = column < width && !fresh;
    if own_stored && !loaded.contains(&column) {
        loaded.push(column);
    }
    let names: Vec<String> = loaded.iter().map(|c| column_name(*c)).collect();
    match only_rows {
        None => {
            let mut vectors: Vec<Vec<Value>> = loaded
                .iter()
                .map(|_| Vec::with_capacity(rows as usize))
                .collect();
            if !loaded.is_empty() {
                let sql = format!("SELECT {} FROM t ORDER BY rowid", names.join(", "));
                let mut statement = db.prepare(&sql)?;
                let mut base = 0u64;
                for batch in statement.query_arrow([])? {
                    for (i, col) in loaded.iter().enumerate() {
                        let mark = marks.get(col).copied();
                        let wanted = reads.contains(col);
                        let own = *col == column && own_stored;
                        let mut row = base;
                        let values = &mut vectors[i];
                        let current_rows = &mut current_rows;
                        each_text(batch.column(i), |raw| {
                            if own {
                                current_rows.push(raw.filter(|t| !t.is_empty()).map(Box::from));
                            }
                            if wanted {
                                values.push(cell_value(raw, mark));
                            }
                            row += 1;
                        })?;
                    }
                    base += batch.num_rows() as u64;
                }
            }
            for (i, col) in loaded.iter().enumerate() {
                if reads.contains(col) {
                    data.columns.insert(*col, std::mem::take(&mut vectors[i]));
                }
            }
            for col in reads {
                data.columns
                    .entry(*col)
                    .or_insert_with(|| vec![Value::Empty; rows as usize]);
            }
        }
        Some(only) => {
            if !loaded.is_empty() {
                let sql = format!(
                    "SELECT rowid, {} FROM t WHERE rowid BETWEEN ? AND ? ORDER BY rowid",
                    names.join(", ")
                );
                let mut statement = db.prepare(&sql)?;
                for (a, b) in runs(only) {
                    let mut cursor = statement.query(params![a as i64, b as i64])?;
                    while let Some(row) = cursor.next()? {
                        let index = row.get::<_, i64>(0)? as u64;
                        if !only.contains(&index) {
                            continue;
                        }
                        for (i, col) in loaded.iter().enumerate() {
                            let raw: Option<String> = row.get(i + 1)?;
                            if *col == column
                                && own_stored
                                && let Some(text) = raw.as_ref().filter(|t| !t.is_empty())
                            {
                                current.insert(index, text.clone());
                            }
                            if reads.contains(col) {
                                data.cells.insert(
                                    (index, *col),
                                    cell_value(raw.as_deref(), marks.get(col).copied()),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    // the grid's unsaved edits over what the formula reads (cells win)
    let mut put = |row: u64, col: u64, value: Value| {
        if let Some(values) = data.columns.get_mut(&col) {
            if let Some(slot) = values.get_mut(row as usize) {
                *slot = value;
            }
        } else if only_rows.is_some_and(|only| only.contains(&row)) {
            data.cells.insert((row, col), value);
        }
    };
    for fill in &edits.fills {
        let value = json_value(&fill.value);
        for col in (fill.start_column..=fill.end_column).filter(|c| reads.contains(c)) {
            match only_rows {
                Some(only) => {
                    for &row in only.range(fill.start_row..=fill.end_row) {
                        put(row, col, value.clone());
                    }
                }
                None => {
                    for row in fill.start_row..=fill.end_row.min(rows.saturating_sub(1)) {
                        put(row, col, value.clone());
                    }
                }
            }
        }
    }
    for cell in edits.cells.iter().filter(|c| reads.contains(&c.column)) {
        put(cell.row, cell.column, json_value(&cell.value));
    }
    let loaded_at = Instant::now();

    let mut changes: Vec<(u64, Option<String>)> = Vec::new();
    let mut errors = 0u64;
    let mut first_error_row = None;
    let mut sink = |row: u64, value: &Value| {
        if matches!(value, Value::Err(_)) {
            errors += 1;
            first_error_row.get_or_insert(row);
        }
        if calc.overridden(row) {
            return;
        }
        let text = stored_text(value, calc.mark);
        let now = match only_rows {
            None => current_rows.get(row as usize).and_then(|t| t.as_deref()),
            Some(_) => current.get(&row).map(String::as_str),
        };
        if now != text.as_deref() {
            changes.push((row, text));
        }
    };
    let mut evaluator = Evaluator::new(&calc.formula, &data);
    let failure = |e: crate::formula::FormulaError| EngineError::new(e.code, e.detail);
    match only_rows {
        None => evaluator.run(&mut sink).map_err(failure)?,
        Some(only) => {
            for &row in only {
                let value = evaluator.eval_row(row).map_err(failure)?;
                sink(row, &value);
            }
        }
    }
    let evaluated_at = Instant::now();
    write_column(db, column, &changes)?;
    if std::env::var_os("FARIV_CALC_PROFILE").is_some() {
        eprintln!(
            "calc load {:?} eval {:?} write {:?} ({} changes)",
            loaded_at - profile_started,
            evaluated_at - loaded_at,
            evaluated_at.elapsed(),
            changes.len()
        );
    }
    calc.edits_seen = Some(edits.fingerprint(&calc.formula.reads));
    let written_rows = if changes.len() as u64 > PARTIAL_ROWS {
        Vec::new()
    } else {
        changes.iter().map(|(row, _)| *row).collect()
    };
    Ok(Summary {
        written: changes.len() as u64,
        written_rows,
        errors,
        first_error_row,
    })
}

/// Consecutive rows of a set, as inclusive runs.
fn runs(rows: &BTreeSet<u64>) -> Vec<(u64, u64)> {
    let mut out: Vec<(u64, u64)> = Vec::new();
    for &row in rows {
        match out.last_mut() {
            Some(last) if last.1 + 1 == row => last.1 = row,
            _ => out.push((row, row)),
        }
    }
    out
}

fn clear_calc(db: &Connection, calc: &Calc) -> Result<(), EngineError> {
    let width = table_width(db)?;
    if calc.column() >= width {
        return Ok(());
    }
    let changes: Vec<(u64, Option<String>)> = (calc.formula.first_row..=calc.formula.last_row)
        .filter(|row| !calc.overridden(*row))
        .map(|row| (row, None))
        .collect();
    write_column(db, calc.column(), &changes)
}

fn write_column(
    db: &Connection,
    column: u64,
    changes: &[(u64, Option<String>)],
) -> Result<(), EngineError> {
    if changes.is_empty() && column < table_width(db)? {
        return Ok(());
    }
    db.execute_batch("BEGIN TRANSACTION")?;
    let result = (|| -> Result<(), EngineError> {
        let width = table_width(db)?;
        for index in width..=column {
            db.execute_batch(&format!(
                "ALTER TABLE t ADD COLUMN {} VARCHAR",
                column_name(index)
            ))?;
        }
        db.execute_batch("CREATE OR REPLACE TEMP TABLE fariv_calc (r BIGINT, v VARCHAR)")?;
        {
            let mut appender = db.appender("fariv_calc")?;
            for (row, value) in changes {
                appender.append_row(params![*row as i64, value])?;
            }
            appender.flush()?;
        }
        db.execute_batch(&format!(
            "UPDATE t SET {} = fariv_calc.v FROM fariv_calc WHERE t.rowid = fariv_calc.r; \
             DROP TABLE fariv_calc;",
            column_name(column)
        ))?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            db.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
