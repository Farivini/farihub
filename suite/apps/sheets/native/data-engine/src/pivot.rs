//! Pivot tables over the whole base: rows, columns, filters and values
//! computed in one pass in the engine, with the grid's unsaved edits on top.
//! A field change is a new query (tenths of a second on a million rows); the
//! grid never recomputes anything.
//!
//! Layout is Excel's tabular form without subtotals: one label column per row
//! field, one block of value columns per column-field member, a total per row,
//! per column and the grand total. Totals are aggregated from the rows
//! themselves (a distinct count or an average is not a sum of its cells).
//!
//! Dates are grouped by year, quarter, month or day from the text the base
//! holds (dd/mm/yyyy, d/m/yy, yyyy-mm-dd, with or without a time). Whether a
//! column writes day or month first is read from the column itself: a first
//! part above 12 means day first, a second part above 12 means month first,
//! and pt-BR (day first) breaks the tie. Values that are not dates keep their
//! own text as the label.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use duckdb::params;
use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::calc::{GridEdits, each_text_pub, number_marks_pub};
use crate::formula::Value;
use crate::numbers::{js_number_text, parse_number_fast};
use crate::{Engine, EngineError, NumberColumn, column_name};

/// Columns a session keeps read for pivots (each about 4 bytes a row plus
/// its distinct values).
const MAX_CACHED_COLUMNS: usize = 24;

/// A column's data rows, dictionary-encoded: one id per row, one value per
/// distinct cell text. A pivot works on ids, so a million rows cost one
/// lookup each and labels, dates and numbers are worked out once per
/// distinct value.
pub(crate) struct DictColumn {
    ids: Vec<u32>,
    values: Vec<Value>,
    /// values read from the base (unique by text); edits add past it
    base: usize,
    /// identity of each value for distinct counts, worked out once
    distinct: std::sync::OnceLock<Vec<Option<u32>>>,
    /// the column's labels per grouping, worked out once
    dims: std::sync::Mutex<HashMap<(DateGroup, Option<char>), Arc<DimColumn>>>,
}

impl DictColumn {
    fn patched(&self) -> DictColumn {
        DictColumn {
            ids: self.ids.clone(),
            values: self.values.clone(),
            base: self.base,
            distinct: std::sync::OnceLock::new(),
            dims: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn dim(&self, group: DateGroup, mark: Option<char>) -> Arc<DimColumn> {
        if let Some(dim) = self.dims.lock().unwrap().get(&(group, mark)) {
            return dim.clone();
        }
        let dim = Arc::new(dim_column(self, group, mark));
        self.dims.lock().unwrap().insert((group, mark), dim.clone());
        dim
    }

    fn distinct_ids(&self) -> &[Option<u32>] {
        self.distinct.get_or_init(|| distinct_ids(self))
    }
}

/// Row fields and column fields a pivot takes.
const MAX_ROW_FIELDS: usize = 4;
const MAX_COLUMN_FIELDS: usize = 2;
/// Column members past this are refused: the answer would not fit a sheet.
const MAX_COLUMN_MEMBERS: usize = 2_000;
/// Members a filter list shows.
const MAX_MEMBERS_LISTED: usize = 10_000;

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "camelCase")]
pub enum DateGroup {
    #[default]
    None,
    Year,
    Quarter,
    Month,
    Day,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PivotDim {
    pub column: u64,
    #[serde(default)]
    pub group: DateGroup,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PivotFilter {
    pub column: u64,
    #[serde(default)]
    pub group: DateGroup,
    /// labels kept (as the members list gives them)
    pub include: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Agg {
    Sum,
    Count,
    CountDistinct,
    Average,
    Min,
    Max,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PivotValue {
    pub column: u64,
    pub agg: Agg,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PivotRequest {
    #[serde(default)]
    pub rows: Vec<PivotDim>,
    #[serde(default)]
    pub columns: Vec<PivotDim>,
    #[serde(default)]
    pub filters: Vec<PivotFilter>,
    #[serde(default)]
    pub values: Vec<PivotValue>,
    /// row groups returned (the rest is counted, totals cover all)
    #[serde(default = "default_max_rows")]
    pub max_rows: usize,
    /// rows by their first value, largest first (Pareto, top N), instead of
    /// by their labels
    #[serde(default)]
    pub sort_by_value: bool,
}

fn default_max_rows() -> usize {
    100_000
}

/// One aggregate's running state (distinct counts are kept apart, as
/// sorted pairs).
#[derive(Clone, Copy, Default)]
struct Acc {
    non_empty: u64,
    numbers: u64,
    sum: f64,
    min: Option<f64>,
    max: Option<f64>,
}

impl Acc {
    #[inline]
    fn add(&mut self, value: &Value) {
        match value {
            Value::Empty => return,
            Value::Text(t) if t.is_empty() => return,
            Value::Num(n) => {
                self.numbers += 1;
                self.sum += n;
                self.min = Some(self.min.map_or(*n, |m| m.min(*n)));
                self.max = Some(self.max.map_or(*n, |m| m.max(*n)));
            }
            _ => {}
        }
        self.non_empty += 1;
    }

    fn result(&self, agg: Agg, distinct: u64) -> Json {
        match agg {
            Agg::Sum => json!(self.sum),
            Agg::Count => json!(self.non_empty),
            Agg::CountDistinct => json!(distinct),
            Agg::Average if self.numbers > 0 => json!(self.sum / self.numbers as f64),
            Agg::Min => self.min.map_or(Json::Null, |v| json!(v)),
            Agg::Max => self.max.map_or(Json::Null, |v| json!(v)),
            Agg::Average => Json::Null,
        }
    }
}

/// FxHash: the pivot's keys are small integers; SipHash costs more than
/// the whole aggregation.
#[derive(Default, Clone, Copy)]
struct Fx(u64);

impl Fx {
    #[inline]
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

impl std::hash::Hasher for Fx {
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for chunk in &mut chunks {
            self.add(u64::from_le_bytes(chunk.try_into().unwrap()));
        }
        let mut tail = 0u64;
        for (i, b) in chunks.remainder().iter().enumerate() {
            tail |= (*b as u64) << (8 * i);
        }
        self.add(tail ^ (bytes.len() as u64) << 56);
    }
    fn write_u32(&mut self, n: u32) {
        self.add(n as u64);
    }
    fn write_u64(&mut self, n: u64) {
        self.add(n);
    }
    fn write_u128(&mut self, n: u128) {
        self.add(n as u64);
        self.add((n >> 64) as u64);
    }
    fn finish(&self) -> u64 {
        // splitmix64's finalizer: the multiply only carries low bits upward,
        // and the table indexes by the low bits ("T1".."T999999" share them)
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

type FxMap<K, V> = HashMap<K, V, std::hash::BuildHasherDefault<Fx>>;

/// Group numbers of composite keys: a direct table when the members of the
/// fields multiply to a small number, a hash map otherwise.
struct Groups {
    radices: Vec<u64>,
    table: Option<Vec<u32>>,
    map: FxMap<u128, u32>,
    keys: Vec<u128>,
}

impl Groups {
    fn new(dims: &[Arc<DimColumn>]) -> Self {
        let radices: Vec<u64> = dims
            .iter()
            .map(|d| d.labels.names.len().max(1) as u64)
            .collect();
        let product = radices.iter().try_fold(1u64, |a, r| a.checked_mul(*r));
        let table = product
            .filter(|p| *p <= 1 << 24)
            .map(|p| vec![u32::MAX; p as usize]);
        Groups {
            radices,
            table,
            map: FxMap::default(),
            keys: Vec::new(),
        }
    }

    /// The group of `row`, numbered in order of appearance.
    #[inline]
    fn of(&mut self, dims: &[Arc<DimColumn>], row: usize) -> u32 {
        let mut key: u128 = 0;
        let mut slot: u64 = 0;
        for (dim, radix) in dims.iter().zip(&self.radices) {
            let id = dim.ids[row];
            key = (key << 32) | id as u128;
            slot = slot * radix + id as u64;
        }
        let next = self.keys.len() as u32;
        let found = match self.table.as_mut() {
            Some(table) => {
                let entry = &mut table[slot as usize];
                if *entry == u32::MAX {
                    *entry = next;
                }
                *entry
            }
            None => *self.map.entry(key).or_insert(next),
        };
        if found == next {
            self.keys.push(key);
        }
        found
    }
}

/// Distinct values per group from (group, value) pairs.
fn distinct_counts(mut pairs: Vec<u64>, groups: usize) -> Vec<u64> {
    pairs.sort_unstable();
    pairs.dedup();
    let mut counts = vec![0u64; groups];
    for pair in pairs {
        counts[(pair >> 32) as usize] += 1;
    }
    counts
}

/// Labels of one field, interned: id -> label and a numeric sort key.
#[derive(Default)]
struct Labels {
    ids: FxMap<String, u32>,
    names: Vec<String>,
    numbers: Vec<Option<f64>>,
    dates: Vec<bool>,
}

impl Labels {
    fn intern(&mut self, label: String, number: Option<f64>, date: bool) -> u32 {
        if let Some(id) = self.ids.get(&label) {
            return *id;
        }
        let id = self.names.len() as u32;
        self.ids.insert(label.clone(), id);
        self.names.push(label);
        self.numbers.push(number);
        self.dates.push(date);
        id
    }

    /// Each label's place in Excel's order (numbers, then dates — ISO labels
    /// sort by time —, then text case-insensitive, the blank last), worked
    /// out once: sorting a million groups then compares integers.
    fn ranks(&self) -> Vec<u32> {
        let kind = |i: usize| -> u8 {
            if self.names[i].is_empty() {
                3
            } else if self.numbers[i].is_some() {
                0
            } else if self.dates[i] {
                1
            } else {
                2
            }
        };
        let lower: Vec<Option<String>> = (0..self.names.len())
            .map(|i| {
                (kind(i) == 2 && self.names[i].chars().any(char::is_uppercase))
                    .then(|| self.names[i].to_lowercase())
            })
            .collect();
        let folded = |i: usize| lower[i].as_deref().unwrap_or(&self.names[i]);
        let mut order: Vec<usize> = (0..self.names.len()).collect();
        order.sort_unstable_by(|&a, &b| {
            kind(a)
                .cmp(&kind(b))
                .then_with(|| match (self.numbers[a], self.numbers[b]) {
                    (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
                    _ if self.dates[a] => self.names[a].cmp(&self.names[b]),
                    _ => folded(a)
                        .cmp(folded(b))
                        .then_with(|| self.names[a].cmp(&self.names[b])),
                })
        });
        let mut ranks = vec![0u32; self.names.len()];
        for (rank, id) in order.into_iter().enumerate() {
            ranks[id] = rank as u32;
        }
        ranks
    }
}

/// A field's label for every data row.
struct DimColumn {
    labels: Labels,
    ids: Vec<u32>,
    /// each label's place in Excel's order
    ranks: std::sync::OnceLock<Vec<u32>>,
}

impl DimColumn {
    fn ranks(&self) -> &[u32] {
        self.ranks.get_or_init(|| self.labels.ranks())
    }
}

fn number_label(n: f64, mark: Option<char>) -> String {
    let text = js_number_text(n);
    if mark == Some(',') {
        text.replace('.', ",")
    } else {
        text
    }
}

fn value_label(value: &Value, mark: Option<char>) -> (String, Option<f64>) {
    match value {
        Value::Empty => (String::new(), None),
        Value::Num(n) => (number_label(*n, mark), Some(*n)),
        Value::Text(t) => (t.clone(), None),
        Value::Bool(b) => ((if *b { "TRUE" } else { "FALSE" }).to_owned(), None),
        Value::Err(e) => (e.text().to_owned(), None),
    }
}

/// The three numeric parts of a date-like text (before any time), as written.
fn date_parts(text: &str) -> Option<(u32, u32, u32, usize)> {
    let day = text.trim().split([' ', 'T']).next()?;
    let separator = day.chars().find(|c| matches!(c, '/' | '-' | '.'))?;
    let mut parts = day.split(separator);
    let (a, b, c) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let digits = |s: &str| !s.is_empty() && s.len() <= 4 && s.bytes().all(|b| b.is_ascii_digit());
    if !(digits(a) && digits(b) && digits(c)) {
        return None;
    }
    // which part is the year: 4 digits first (ISO), else the last
    let year_first = a.len() == 4;
    if year_first && !(b.len() <= 2 && c.len() <= 2) {
        return None;
    }
    if !year_first && !(a.len() <= 2 && b.len() <= 2 && (c.len() == 2 || c.len() == 4)) {
        return None;
    }
    let width = if year_first { a.len() } else { c.len() };
    Some((
        a.parse().ok()?,
        b.parse().ok()?,
        c.parse().ok()?,
        width + if year_first { 10 } else { 0 },
    ))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

/// (year, month, day) of a date-like text; `day_first` for d/m/y columns.
pub(crate) fn parse_date(text: &str, day_first: bool) -> Option<(u32, u32, u32)> {
    let (a, b, c, width) = date_parts(text)?;
    let (year, month, day) = if width >= 10 {
        (a, b, c)
    } else {
        // Excel's two-digit years: 00-29 are 2000s, 30-99 are 1900s
        let year = match width {
            2 if c < 30 => 2000 + c,
            2 => 1900 + c,
            _ => c,
        };
        if day_first {
            (year, b, a)
        } else {
            (year, a, b)
        }
    };
    ((1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month))
        .then_some((year, month, day))
}

/// Whether most of a column's first distinct values read as dates (the
/// view groups such a field by day).
fn looks_dated(dict: &DictColumn) -> bool {
    let sample: Vec<&str> = dict
        .values
        .iter()
        .filter_map(|v| match v {
            Value::Text(t) if !t.is_empty() => Some(t.as_str()),
            _ => None,
        })
        .take(200)
        .collect();
    !sample.is_empty()
        && sample.iter().filter(|t| date_parts(t).is_some()).count() * 10 >= sample.len() * 8
}

/// Whether a column writes the day first, read from its values.
fn column_day_first(values: &[Value]) -> bool {
    let (mut first_max, mut second_max) = (0, 0);
    for value in values {
        if let Value::Text(t) = value
            && let Some((a, b, _, width)) = date_parts(t)
            && width < 10
        {
            first_max = first_max.max(a);
            second_max = second_max.max(b);
        }
    }
    !(first_max <= 12 && second_max > 12)
}

fn date_label(date: (u32, u32, u32), group: DateGroup) -> String {
    let (year, month, day) = date;
    match group {
        DateGroup::Year => format!("{year:04}"),
        DateGroup::Quarter => format!("{year:04}-T{}", (month - 1) / 3 + 1),
        DateGroup::Month => format!("{year:04}-{month:02}"),
        DateGroup::Day | DateGroup::None => format!("{year:04}-{month:02}-{day:02}"),
    }
}

fn dim_column(dict: &DictColumn, group: DateGroup, mark: Option<char>) -> DimColumn {
    let mut labels = Labels::default();
    let day_first = group != DateGroup::None && column_day_first(&dict.values);
    let map: Vec<u32> = dict
        .values
        .iter()
        .map(|value| {
            if group != DateGroup::None
                && let Value::Text(t) = value
                && let Some(date) = parse_date(t, day_first)
            {
                return labels.intern(date_label(date, group), None, true);
            }
            let (label, number) = value_label(value, mark);
            labels.intern(label, number, false)
        })
        .collect();
    let ids = dict.ids.iter().map(|id| map[*id as usize]).collect();
    DimColumn {
        labels,
        ids,
        ranks: std::sync::OnceLock::new(),
    }
}

/// Exact identity of each distinct value for distinct counts: its type and
/// text, numbers as the grid reads them (1,5 and 1,50 are one value). Texts
/// read from the base are unique already; numbers meet by value; an edit's
/// text meets the base text it equals.
fn distinct_ids(dict: &DictColumn) -> Vec<Option<u32>> {
    let mut numbers: FxMap<u64, u32> = FxMap::default();
    let mut booleans: [Option<u32>; 2] = [None, None];
    let mut texts: Option<FxMap<&str, u32>> = None;
    let mut out = Vec::with_capacity(dict.values.len());
    for (id, value) in dict.values.iter().enumerate() {
        let id = id as u32;
        out.push(match value {
            Value::Empty => None,
            Value::Text(t) if t.is_empty() => None,
            Value::Num(n) => {
                let bits = if *n == 0.0 { 0 } else { n.to_bits() };
                Some(*numbers.entry(bits).or_insert(id))
            }
            Value::Bool(b) => Some(*booleans[*b as usize].get_or_insert(id)),
            Value::Text(t) if (id as usize) < dict.base => Some(id),
            Value::Text(_) | Value::Err(_) => {
                let text = match value {
                    Value::Err(e) => e.text(),
                    Value::Text(t) => t.as_str(),
                    _ => unreachable!(),
                };
                let map = texts.get_or_insert_with(|| {
                    dict.values[..dict.base]
                        .iter()
                        .enumerate()
                        .filter_map(|(i, v)| match v {
                            Value::Text(t) => Some((t.as_str(), i as u32)),
                            _ => None,
                        })
                        .collect()
                });
                Some(*map.entry(text).or_insert(id))
            }
        });
    }
    out
}

impl Engine {
    /// The data rows (below the header) of one column as the base holds
    /// them, read once per version of the base.
    fn pivot_base_column(
        &self,
        session_id: &str,
        column: u64,
        mark: Option<char>,
        logical: bool,
    ) -> Result<Arc<DictColumn>, EngineError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| EngineError::new("UNKNOWN_SESSION", "Unknown data session."))?;
        let key = (column, mark.unwrap_or(' '), logical);
        let (db, rows, width, version) = {
            let locked = session.lock().unwrap();
            if let Some((version, cached)) = locked.pivot_cache.get(&key)
                && *version == locked.version
            {
                return Ok(cached.clone());
            }
            (
                locked.db.try_clone()?,
                locked.rows,
                locked.width(),
                locked.version,
            )
        };
        let height = rows.saturating_sub(1) as usize;
        let mut dict = DictColumn {
            ids: Vec::with_capacity(height),
            values: vec![Value::Empty],
            base: 0,
            distinct: std::sync::OnceLock::new(),
            dims: std::sync::Mutex::new(HashMap::new()),
        };
        if column < width && height > 0 {
            let mut index: FxMap<String, u32> = FxMap::default();
            let sql = format!(
                "SELECT {} FROM t WHERE rowid BETWEEN 1 AND ? ORDER BY rowid",
                column_name(column)
            );
            let mut statement = db.prepare(&sql)?;
            for batch in statement.query_arrow(params![(rows - 1) as i64])? {
                each_text_pub(batch.column(0), |raw| {
                    let id = match raw {
                        None | Some("") => 0,
                        Some(text) => match index.get(text) {
                            Some(id) => *id,
                            None => {
                                let id = dict.values.len() as u32;
                                dict.values.push(match text {
                                    "TRUE" if logical => Value::Bool(true),
                                    "FALSE" if logical => Value::Bool(false),
                                    _ => match mark.and_then(|m| parse_number_fast(text, m)) {
                                        Some(n) => Value::Num(n),
                                        None => Value::Text(text.to_owned()),
                                    },
                                });
                                index.insert(text.to_owned(), id);
                                id
                            }
                        },
                    };
                    dict.ids.push(id);
                })?;
            }
        }
        dict.ids.resize(height, 0);
        dict.base = dict.values.len();
        let dict = Arc::new(dict);
        let mut locked = session.lock().unwrap();
        if locked.pivot_cache.len() >= MAX_CACHED_COLUMNS {
            locked.pivot_cache.clear();
        }
        locked.pivot_cache.insert(key, (version, dict.clone()));
        Ok(dict)
    }

    /// One column's data rows with the grid's unsaved edits on top.
    fn pivot_column(
        &self,
        session_id: &str,
        column: u64,
        rows: u64,
        marks: &HashMap<u64, char>,
        logical: &HashSet<u64>,
        edits: &GridEdits,
    ) -> Result<Arc<DictColumn>, EngineError> {
        let base = self.pivot_base_column(
            session_id,
            column,
            marks.get(&column).copied(),
            logical.contains(&column),
        )?;
        let last = rows.saturating_sub(1);
        let patches: Vec<(u64, u64, Value)> = edits
            .column_edits(column)
            .into_iter()
            .filter(|(first, end, _)| *end >= 1 && *first <= last)
            .collect();
        if patches.is_empty() {
            return Ok(base);
        }
        let mut owned = base.patched();
        for (first, end, value) in patches {
            let id = owned.values.len() as u32;
            owned.values.push(value);
            for row in first.max(1)..=end.min(last) {
                owned.ids[(row - 1) as usize] = id;
            }
        }
        Ok(Arc::new(owned))
    }

    fn pivot_marks(
        &self,
        session_id: &str,
        number_columns: &[NumberColumn],
    ) -> Result<(HashMap<u64, char>, HashSet<u64>), EngineError> {
        let calcs = self.calc_columns(session_id)?;
        let logical = calcs.iter().map(|(c, _)| *c).collect();
        Ok((number_marks_pub(number_columns, &calcs), logical))
    }

    pub(crate) fn pivot(
        &self,
        session_id: &str,
        request: &PivotRequest,
        number_columns: &[NumberColumn],
        edits: &GridEdits,
    ) -> Result<Json, EngineError> {
        let started = Instant::now();
        if request.rows.len() > MAX_ROW_FIELDS || request.columns.len() > MAX_COLUMN_FIELDS {
            return Err(EngineError::new(
                "TOO_MANY_FIELDS",
                "Too many row or column fields.",
            ));
        }
        let (_, rows, _) = self.session(session_id)?;
        let (marks, logical) = self.pivot_marks(session_id, number_columns)?;
        let height = rows.saturating_sub(1) as usize;
        // every column read once
        let mut loaded: HashMap<u64, Arc<DictColumn>> = HashMap::new();
        let wanted = request
            .rows
            .iter()
            .chain(&request.columns)
            .map(|d| d.column)
            .chain(request.filters.iter().map(|f| f.column))
            .chain(request.values.iter().map(|v| v.column));
        for column in wanted {
            if let std::collections::hash_map::Entry::Vacant(e) = loaded.entry(column) {
                let values =
                    self.pivot_column(session_id, column, rows, &marks, &logical, edits)?;
                e.insert(values);
            }
        }
        let dims = |list: &[PivotDim]| -> Vec<Arc<DimColumn>> {
            list.iter()
                .map(|d| loaded[&d.column].dim(d.group, marks.get(&d.column).copied()))
                .collect()
        };
        let row_dims = dims(&request.rows);
        let col_dims = dims(&request.columns);
        // rows a filter keeps
        let mut keep = vec![true; height];
        for filter in &request.filters {
            let dim = loaded[&filter.column].dim(filter.group, marks.get(&filter.column).copied());
            let allowed: HashSet<u32> = filter
                .include
                .iter()
                .filter_map(|label| dim.labels.ids.get(label).copied())
                .collect();
            for (row, id) in dim.ids.iter().enumerate() {
                if !allowed.contains(id) {
                    keep[row] = false;
                }
            }
        }
        let distinct: Vec<&[Option<u32>]> = request
            .values
            .iter()
            .map(|v| {
                if v.agg == Agg::CountDistinct {
                    loaded[&v.column].distinct_ids()
                } else {
                    &[]
                }
            })
            .collect();
        let value_dicts: Vec<Arc<DictColumn>> = request
            .values
            .iter()
            .map(|v| loaded[&v.column].clone())
            .collect();
        let nv = request.values.len();
        let by_cell = !col_dims.is_empty();
        let mut row_groups = Groups::new(&row_dims);
        let mut col_groups = Groups::new(&col_dims);
        let mut cell_index: FxMap<u64, u32> = FxMap::default();
        let mut cell_accs: Vec<Acc> = Vec::new();
        let mut cell_of: Vec<(u32, u32)> = Vec::new();
        let mut row_accs: Vec<Acc> = Vec::new();
        let mut col_accs: Vec<Acc> = Vec::new();
        let mut grand = vec![Acc::default(); nv];
        // distinct counts: (group, value id) pairs per level
        let counting: Vec<usize> = (0..nv).filter(|i| !distinct[*i].is_empty()).collect();
        let mut cell_pairs: Vec<Vec<u64>> = vec![Vec::new(); nv];
        let mut row_pairs: Vec<Vec<u64>> = vec![Vec::new(); nv];
        let mut col_pairs: Vec<Vec<u64>> = vec![Vec::new(); nv];
        let mut grand_seen: Vec<Vec<bool>> =
            (0..nv).map(|i| vec![false; distinct[i].len()]).collect();
        let mut kept = 0u64;
        for row in 0..height {
            if !keep[row] {
                continue;
            }
            kept += 1;
            let r = row_groups.of(&row_dims, row);
            if r as usize * nv >= row_accs.len() {
                row_accs.resize((r as usize + 1) * nv, Acc::default());
            }
            let c = col_groups.of(&col_dims, row);
            if c as usize >= MAX_COLUMN_MEMBERS {
                return Err(EngineError::new(
                    "TOO_MANY_COLUMNS",
                    "The column field has too many members.",
                ));
            }
            if c as usize * nv >= col_accs.len() {
                col_accs.resize((c as usize + 1) * nv, Acc::default());
            }
            let cell = if by_cell {
                let next = cell_of.len() as u32;
                let cell = *cell_index
                    .entry(((r as u64) << 32) | c as u64)
                    .or_insert(next);
                if cell == next {
                    cell_of.push((r, c));
                    cell_accs.resize(cell_of.len() * nv, Acc::default());
                }
                cell
            } else {
                r
            };
            for i in 0..nv {
                let dict = &value_dicts[i];
                let raw = dict.ids[row] as usize;
                let value = &dict.values[raw];
                if by_cell {
                    cell_accs[cell as usize * nv + i].add(value);
                }
                row_accs[r as usize * nv + i].add(value);
                col_accs[c as usize * nv + i].add(value);
                grand[i].add(value);
            }
            for &i in &counting {
                let raw = value_dicts[i].ids[row] as usize;
                if let Some(id) = distinct[i][raw] {
                    let id = id as u64;
                    row_pairs[i].push(((r as u64) << 32) | id);
                    if by_cell {
                        cell_pairs[i].push(((cell as u64) << 32) | id);
                        col_pairs[i].push(((c as u64) << 32) | id);
                    }
                    grand_seen[i][id as usize] = true;
                }
            }
        }
        let row_count = row_groups.keys.len();
        let col_count = col_groups.keys.len();
        let cell_count = if by_cell { cell_of.len() } else { row_count };
        let mut row_distinct: Vec<Vec<u64>> = vec![Vec::new(); nv];
        let mut col_distinct: Vec<Vec<u64>> = vec![Vec::new(); nv];
        let mut cell_distinct: Vec<Vec<u64>> = vec![Vec::new(); nv];
        let mut grand_distinct = vec![0u64; nv];
        for &i in &counting {
            let grand_count = grand_seen[i].iter().filter(|seen| **seen).count() as u64;
            grand_distinct[i] = grand_count;
            row_distinct[i] = distinct_counts(std::mem::take(&mut row_pairs[i]), row_count);
            if by_cell {
                cell_distinct[i] = distinct_counts(std::mem::take(&mut cell_pairs[i]), cell_count);
                col_distinct[i] = distinct_counts(std::mem::take(&mut col_pairs[i]), col_count);
            } else {
                cell_distinct[i] = row_distinct[i].clone();
                col_distinct[i] = vec![grand_count; col_count];
            }
        }
        let results = |accs: &[Acc], level: &[Vec<u64>], group: usize| -> Vec<Json> {
            (0..nv)
                .map(|i| {
                    let distinct = level[i].get(group).copied().unwrap_or(0);
                    accs[i].result(request.values[i].agg, distinct)
                })
                .collect()
        };
        let cell_lookup: FxMap<u64, u32> = if by_cell {
            cell_index
        } else {
            FxMap::default()
        };
        let row_keys = row_groups.keys;
        let col_keys = col_groups.keys;

        // members of each key, in Excel's order
        let split = |key: u128, dims: &[Arc<DimColumn>]| -> Vec<u32> {
            let n = dims.len();
            (0..n)
                .map(|i| ((key >> (32 * (n - 1 - i))) & 0xFFFF_FFFF) as u32)
                .collect()
        };
        let order = |keys: &[u128], dims: &[Arc<DimColumn>]| -> Vec<usize> {
            // each key as its members' ranks packed in one integer
            let ranks: Vec<&[u32]> = dims.iter().map(|dim| dim.ranks()).collect();
            let n = dims.len();
            let packed: Vec<u128> = keys
                .iter()
                .map(|key| {
                    (0..n).fold(0u128, |acc, i| {
                        let id = ((key >> (32 * (n - 1 - i))) & 0xFFFF_FFFF) as usize;
                        (acc << 32) | ranks[i][id] as u128
                    })
                })
                .collect();
            let mut order: Vec<usize> = (0..keys.len()).collect();
            order.sort_unstable_by_key(|&i| packed[i]);
            order
        };
        // the sum of every row's first value: what a Pareto's shares divide
        // by (a distinct count's rows add up past its grand total)
        let first_value_sum: f64 = if nv > 0 {
            (0..row_keys.len())
                .filter_map(|r| {
                    results(&row_accs[r * nv..(r + 1) * nv], &row_distinct, r)[0].as_f64()
                })
                .sum()
        } else {
            0.0
        };
        let mut row_order = order(&row_keys, &row_dims);
        if request.sort_by_value && nv > 0 {
            let first = |r: usize| -> Option<f64> {
                results(&row_accs[r * nv..(r + 1) * nv], &row_distinct, r)[0].as_f64()
            };
            let keys: Vec<Option<f64>> = (0..row_keys.len()).map(first).collect();
            // largest first, the empty last; ties keep the label order
            row_order.sort_by(|&a, &b| match (keys[a], keys[b]) {
                (Some(x), Some(y)) => y.partial_cmp(&x).unwrap_or(Ordering::Equal),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            });
        }
        let col_order = order(&col_keys, &col_dims);
        let labels_of = |key: u128, dims: &[Arc<DimColumn>]| -> Vec<String> {
            split(key, dims)
                .iter()
                .zip(dims)
                .map(|(id, dim)| dim.labels.names[*id as usize].clone())
                .collect()
        };
        let shown = row_order.len().min(request.max_rows);
        let mut out_rows = Vec::with_capacity(shown);
        for &r in row_order.iter().take(shown) {
            let row_cells: Vec<Json> = col_order
                .iter()
                .map(|&c| {
                    let cell = if by_cell {
                        cell_lookup.get(&(((r as u64) << 32) | c as u64)).copied()
                    } else {
                        Some(r as u32)
                    };
                    cell.map_or(Json::Null, |cell| {
                        let accs = if by_cell {
                            &cell_accs[cell as usize * nv..(cell as usize + 1) * nv]
                        } else {
                            &row_accs[r * nv..(r + 1) * nv]
                        };
                        json!(results(accs, &cell_distinct, cell as usize))
                    })
                })
                .collect();
            out_rows.push(json!({
                "labels": labels_of(row_keys[r], &row_dims),
                "cells": row_cells,
                "total": results(&row_accs[r * nv..(r + 1) * nv], &row_distinct, r),
            }));
        }
        let out_columns: Vec<Json> = col_order
            .iter()
            .map(|&c| {
                json!({
                    "labels": labels_of(col_keys[c], &col_dims),
                    "total": results(&col_accs[c * nv..(c + 1) * nv], &col_distinct, c),
                })
            })
            .collect();
        let grand_level: Vec<Vec<u64>> = grand_distinct.iter().map(|g| vec![*g]).collect();
        Ok(json!({
            "rows": out_rows,
            "rowCount": row_order.len(),
            "columns": out_columns,
            "grandTotal": results(&grand, &grand_level, 0),
            "firstValueSum": first_value_sum,
            "sourceRows": kept,
            "ms": started.elapsed().as_millis() as u64,
        }))
    }

    /// Reads columns ahead of the first pivot (the pivot view opening), so
    /// a field change only aggregates.
    pub(crate) fn pivot_warm(
        &self,
        session_id: &str,
        columns: &[u64],
        number_columns: &[NumberColumn],
    ) -> Result<Json, EngineError> {
        let started = Instant::now();
        let (marks, logical) = self.pivot_marks(session_id, number_columns)?;
        for column in columns {
            let dict = self.pivot_base_column(
                session_id,
                *column,
                marks.get(column).copied(),
                logical.contains(column),
            )?;
            dict.distinct_ids();
            // the labels and their order as Rows/Columns take them
            let mark = marks.get(column).copied();
            dict.dim(DateGroup::None, mark).ranks();
            if looks_dated(&dict) {
                dict.dim(DateGroup::Day, mark).ranks();
            }
        }
        Ok(json!({ "ms": started.elapsed().as_millis() as u64 }))
    }

    /// A field's members (labels as the pivot groups them) with their row
    /// counts, in Excel's order: what a filter list offers.
    pub(crate) fn pivot_members(
        &self,
        session_id: &str,
        column: u64,
        group: DateGroup,
        number_columns: &[NumberColumn],
        edits: &GridEdits,
    ) -> Result<Json, EngineError> {
        let (_, rows, _) = self.session(session_id)?;
        let (marks, logical) = self.pivot_marks(session_id, number_columns)?;
        let values = self.pivot_column(session_id, column, rows, &marks, &logical, edits)?;
        let dim = values.dim(group, marks.get(&column).copied());
        let mut counts = vec![0u64; dim.labels.names.len()];
        for id in &dim.ids {
            counts[*id as usize] += 1;
        }
        // labels no row holds (the blank, edits overwritten) are not members
        let mut order: Vec<u32> = (0..dim.labels.names.len() as u32)
            .filter(|id| counts[*id as usize] > 0)
            .collect();
        let ranks = dim.ranks();
        order.sort_unstable_by_key(|id| ranks[*id as usize]);
        let members: Vec<Json> = order
            .iter()
            .take(MAX_MEMBERS_LISTED)
            .map(|id| json!({ "label": dim.labels.names[*id as usize], "count": counts[*id as usize] }))
            .collect();
        Ok(json!({ "members": members, "total": order.len() }))
    }
}
