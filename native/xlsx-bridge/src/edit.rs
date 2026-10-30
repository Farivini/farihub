//! Table operations applied to the engine's workbook data (`Model.toBytes()`), where IronCalc
//! itself is quadratic or lacks the operation:
//! * reordering rows (sort): cells are moved as they are stored. Formulas are kept in R1C1
//!   form, so a relative reference keeps its offset (`=B2*C2` moved to row 5 reads `=B5*C5`)
//!   and absolute references and references from outside the block do not change, which is
//!   how Excel sorts;
//! * hiding rows (filters): `Worksheet::set_row_hidden` scans the row list for every row, so
//!   hiding n rows costs O(n²); here the list is rebuilt once.
//!
//! The engine loads the result with `Model.fromBytes()` and recalculates; it stays the only
//! source of truth for values.

use std::collections::{HashMap, HashSet};

use ironcalc_base::types::{Cell, FormulaValue, Row, Workbook, Worksheet};
use ironcalc_base::ROW_HEIGHT_FACTOR;
use wasm_bindgen::prelude::*;

/// IronCalc's default row height (25 px), in the units stored in `Row::height`.
const DEFAULT_ROW_HEIGHT: f64 = 25.0 / ROW_HEIGHT_FACTOR;

#[wasm_bindgen]
pub struct WorkbookEdit {
    workbook: Workbook,
}

/// Values of one column for sorting. `kinds`: 0 empty, 1 number, 2 text, 3 boolean, 4 error.
/// `numbers` holds numbers (and booleans as 0/1); `texts` holds text, empty otherwise.
#[wasm_bindgen(getter_with_clone)]
pub struct SortKeys {
    pub kinds: Vec<u8>,
    pub numbers: Vec<f64>,
    pub texts: Vec<String>,
}

fn sheet_mut(workbook: &mut Workbook, sheet: u32) -> Result<&mut Worksheet, JsError> {
    workbook.worksheets.get_mut(sheet as usize).ok_or_else(|| JsError::new("Planilha inexistente"))
}

#[wasm_bindgen]
impl WorkbookEdit {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<WorkbookEdit, JsError> {
        let workbook: Workbook = bitcode::decode(bytes).map_err(|e| JsError::new(&format!("Dados do motor ilegíveis: {e}")))?;
        Ok(WorkbookEdit { workbook })
    }

    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        bitcode::encode(&self.workbook)
    }

    /// The stored (evaluated) value of each cell of `column` in rows `top..=bottom`.
    #[wasm_bindgen(js_name = sortKeys)]
    pub fn sort_keys(&self, sheet: u32, top: i32, bottom: i32, column: i32) -> Result<SortKeys, JsError> {
        let worksheet = self.workbook.worksheets.get(sheet as usize).ok_or_else(|| JsError::new("Planilha inexistente"))?;
        let n = (bottom - top + 1).max(0) as usize;
        let mut keys = SortKeys { kinds: vec![0; n], numbers: vec![0.0; n], texts: vec![String::new(); n] };
        for i in 0..n {
            let Some(cell) = worksheet.sheet_data.cell(top + i as i32, column) else { continue };
            let (kind, number, text) = match cell.as_ref() {
                Cell::EmptyCell { .. } | Cell::SpillCell { .. } => (0, 0.0, None),
                Cell::NumberCell { v, .. } => (1, *v, None),
                Cell::BooleanCell { v, .. } => (3, f64::from(u8::from(*v)), None),
                Cell::ErrorCell { .. } => (4, 0.0, None),
                Cell::SharedString { si, .. } => (2, 0.0, self.workbook.shared_strings.get(*si as usize).cloned()),
                Cell::CellFormula { v, .. } | Cell::ArrayFormula { v, .. } => match v {
                    FormulaValue::Number(x) => (1, *x, None),
                    FormulaValue::Boolean(b) => (3, f64::from(u8::from(*b)), None),
                    // A formula that returns "" sorts with the empty cells, as in Excel.
                    FormulaValue::Text(t) if t.is_empty() => (0, 0.0, None),
                    FormulaValue::Text(t) => (2, 0.0, Some(t.clone())),
                    FormulaValue::Error { .. } => (4, 0.0, None),
                    FormulaValue::Unevaluated => (0, 0.0, None),
                },
            };
            keys.kinds[i] = kind;
            keys.numbers[i] = number;
            if let Some(text) = text {
                keys.texts[i] = text;
            }
        }
        Ok(keys)
    }

    /// Moves the rows of the block `top..top+n-1` × `left..=right` so that new row `top + i`
    /// holds what was in row `top + order[i]`. Cells (values, formulas, styles), hyperlinks and
    /// comments move; row heights and hidden flags stay with the row numbers. Refuses blocks
    /// with merged cells or array formulas, which IronCalc ties to fixed positions.
    #[wasm_bindgen(js_name = reorderRows)]
    pub fn reorder_rows(&mut self, sheet: u32, top: i32, left: i32, right: i32, order: Vec<u32>) -> Result<(), JsError> {
        let n = order.len();
        let mut seen = vec![false; n];
        for &o in &order {
            if o as usize >= n || std::mem::replace(&mut seen[o as usize], true) {
                return Err(JsError::new("Ordem inválida"));
            }
        }
        let bottom = top + n as i32 - 1;
        let worksheet = sheet_mut(&mut self.workbook, sheet)?;
        if worksheet.merged_cells.iter().any(|m| m.row <= bottom && m.row + m.height - 1 >= top && m.column <= right && m.column + m.width - 1 >= left) {
            return Err(JsError::new("O intervalo tem células mescladas; desfaça a mesclagem para ordenar."));
        }
        for row in top..=bottom {
            for column in left..=right {
                if matches!(worksheet.sheet_data.cell(row, column).as_deref(), Some(Cell::ArrayFormula { .. } | Cell::SpillCell { .. })) {
                    return Err(JsError::new("O intervalo tem fórmulas matriciais; elas não podem ser ordenadas."));
                }
            }
        }
        // Destination row of each source row.
        let mut target = vec![0i32; n];
        for (i, &o) in order.iter().enumerate() {
            target[o as usize] = top + i as i32;
        }
        for column in left..=right {
            let mut cells: Vec<Option<Cell>> = (0..n).map(|i| worksheet.sheet_data.remove_cell(top + i as i32, column)).collect();
            for (i, &o) in order.iter().enumerate() {
                if let Some(cell) = cells[o as usize].take() {
                    worksheet.sheet_data.set_cell(top + i as i32, column, cell);
                }
            }
        }
        let in_block = |row: i32, column: i32| row >= top && row <= bottom && column >= left && column <= right;
        let links = std::mem::take(&mut worksheet.links);
        worksheet.links = links
            .into_iter()
            .map(|((row, column), link)| if in_block(row, column) { ((target[(row - top) as usize], column), link) } else { ((row, column), link) })
            .collect();
        for comment in &mut worksheet.comments {
            if let Some((column, row)) = parse_cell(&comment.cell_ref) {
                if in_block(row, column) {
                    comment.cell_ref = format!("{}{}", column_name(column), target[(row - top) as usize]);
                }
            }
        }
        Ok(())
    }

    /// Sets which rows in `from..=to` are hidden: exactly those inside the `ranges` pairs
    /// (start, end, start, end, ...). Rows outside `from..=to` are not touched.
    #[wasm_bindgen(js_name = setHiddenRows)]
    pub fn set_hidden_rows(&mut self, sheet: u32, from: i32, to: i32, ranges: Vec<i32>) -> Result<(), JsError> {
        let mut hidden = HashSet::new();
        for pair in ranges.chunks(2) {
            if let [start, end] = *pair {
                for row in start.max(from)..=end.min(to) {
                    hidden.insert(row);
                }
            }
        }
        let worksheet = sheet_mut(&mut self.workbook, sheet)?;
        let mut existing: HashMap<i32, Row> = HashMap::new();
        let mut rows: Vec<Row> = Vec::with_capacity(worksheet.rows.len() + hidden.len());
        for row in std::mem::take(&mut worksheet.rows) {
            if row.r >= from && row.r <= to {
                existing.insert(row.r, row);
            } else {
                rows.push(row);
            }
        }
        for (r, mut row) in existing {
            row.hidden = hidden.remove(&r);
            // A row entry that only marked the row hidden is dropped when it is shown again.
            if row.hidden || row.custom_height || row.custom_format || row.s != 0 {
                rows.push(row);
            }
        }
        for r in hidden {
            rows.push(Row { r, height: DEFAULT_ROW_HEIGHT, custom_format: false, custom_height: false, s: 0, hidden: true });
        }
        rows.sort_by_key(|row| row.r);
        worksheet.rows = rows;
        Ok(())
    }

    /// Hidden rows of a sheet as (start, end) pairs, ascending.
    #[wasm_bindgen(js_name = hiddenRows)]
    pub fn hidden_rows(&self, sheet: u32) -> Result<Vec<i32>, JsError> {
        let worksheet = self.workbook.worksheets.get(sheet as usize).ok_or_else(|| JsError::new("Planilha inexistente"))?;
        let mut rows: Vec<i32> = worksheet.rows.iter().filter(|row| row.hidden).map(|row| row.r).collect();
        rows.sort_unstable();
        let mut pairs = Vec::new();
        for r in rows {
            match pairs.last_mut() {
                Some(end) if *end + 1 == r => *end = r,
                _ => {
                    pairs.push(r);
                    pairs.push(r);
                }
            }
        }
        Ok(pairs)
    }
}

fn parse_cell(reference: &str) -> Option<(i32, i32)> {
    let split = reference.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = reference.split_at(split);
    if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let column = letters.to_ascii_uppercase().bytes().fold(0i32, |acc, b| acc * 26 + i32::from(b - b'A' + 1));
    Some((column, digits.parse().ok()?))
}

fn column_name(mut column: i32) -> String {
    let mut name = Vec::new();
    while column > 0 {
        let rem = (column - 1) % 26;
        name.push(b'A' + rem as u8);
        column = (column - 1) / 26;
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_default()
}
