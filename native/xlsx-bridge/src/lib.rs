//! XLSX <-> IronCalc workbook bytes for Farcel, using IronCalc's own importer and exporter.
//!
//! The spreadsheet engine in the app is `@ironcalc/wasm`; it never sees XLSX. This module
//! only converts between an .xlsx package and the bytes of `Model.toBytes()` /
//! `Model.fromBytes()`, and reports what the package holds that the conversion does not keep.

use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Read};

use ironcalc::{export::save_xlsx_to_writer, import::load_from_xlsx_bytes};
use ironcalc_base::types::{Font, SheetState, Workbook};
use ironcalc_base::Model;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(getter_with_clone)]
pub struct ImportedXlsx {
    /// The workbook in the engine's representation, for `Model.fromBytes()`.
    pub workbook: Vec<u8>,
    /// JSON: `{ lost: {code: count}, kept: {code: count}, cells, formulas, sheets }`.
    pub report: String,
}

/// Reads an .xlsx file with IronCalc's importer.
#[wasm_bindgen(js_name = importXlsx)]
pub fn import_xlsx(xlsx: &[u8], name: &str, locale: &str, timezone: &str) -> Result<ImportedXlsx, JsError> {
    let lost = scan_package(xlsx).map_err(|e| JsError::new(&format!("Arquivo XLSX ilegível: {e}")))?;
    let normalized = normalize_package(xlsx).map_err(|e| JsError::new(&format!("Arquivo XLSX ilegível: {e}")))?;
    let workbook = load_from_xlsx_bytes(normalized.as_deref().unwrap_or(xlsx), name, locale, timezone)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let mut lost = lost;
    // Imported by IronCalc but neither shown by Farcel nor written back by the exporter.
    bump(&mut lost, "comments", workbook.worksheets.iter().map(|s| s.comments.len()).sum());
    bump(&mut lost, "tables", workbook.tables.len());
    let report = report_json(&lost, &workbook);
    Ok(ImportedXlsx { workbook: bitcode::encode(&workbook), report })
}

/// Writes the engine's workbook bytes as .xlsx with IronCalc's exporter.
#[wasm_bindgen(js_name = workbookToXlsx)]
pub fn workbook_to_xlsx(bytes: &[u8], language: &str) -> Result<Vec<u8>, JsError> {
    let model = Model::from_bytes(bytes, language).map_err(|e| JsError::new(&e))?;
    let writer = save_xlsx_to_writer(&model, Cursor::new(Vec::new())).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(writer.into_inner())
}

/// Rewrites what IronCalc 0.9.1 misreads in valid packages from other writers. Returns None
/// (no copy) when nothing needs it.
/// * Worksheet relationships with absolute targets ("/xl/comments/comment1.xml", written by
///   openpyxl): the comments part is resolved assuming "../comments1.xml" and the import fails.
/// * `showGridLines="true"`/`"false"` (xsd:boolean, written by LibreOffice): only "1" is read
///   as true, so the sheet would lose its gridlines here and in the exported file.
fn normalize_package(xlsx: &[u8]) -> Result<Option<Vec<u8>>, zip::result::ZipError> {
    const HEAD: usize = 1 << 16;
    let mut archive = zip::ZipArchive::new(Cursor::new(xlsx))?;
    let mut rewrites = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry.name()?.to_string();
        if name.starts_with("xl/worksheets/_rels/") && name.ends_with(".rels") {
            let mut xml = String::new();
            entry.read_to_string(&mut xml)?;
            if xml.contains("Target=\"/xl/") {
                rewrites.push(index);
            }
        } else if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
            // sheetViews comes right after the sheet properties, at the start of the part.
            let mut head = Vec::new();
            (&mut entry).take(HEAD as u64).read_to_end(&mut head)?;
            if contains(&head, b"showGridLines=\"true\"") || contains(&head, b"showGridLines=\"false\"") {
                rewrites.push(index);
            }
        }
    }
    if rewrites.is_empty() {
        return Ok(None);
    }
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::with_capacity(xlsx.len())));
    let options = zip::write::SimpleFileOptions::default();
    for index in 0..archive.len() {
        if !rewrites.contains(&index) {
            out.raw_copy_file(archive.by_index_raw(index)?)?;
            continue;
        }
        let mut entry = archive.by_index(index)?;
        let name = entry.name()?.to_string();
        out.start_file(name.as_str(), options)?;
        if name.ends_with(".rels") {
            let mut xml = String::new();
            entry.read_to_string(&mut xml)?;
            std::io::Write::write_all(&mut out, xml.replace("Target=\"/xl/", "Target=\"../").as_bytes())?;
        } else {
            let mut head = Vec::new();
            (&mut entry).take(HEAD as u64).read_to_end(&mut head)?;
            // Byte level: the cut at HEAD may fall inside a multi-byte character.
            let head = replace(&replace(&head, b"showGridLines=\"true\"", b"showGridLines=\"1\""), b"showGridLines=\"false\"", b"showGridLines=\"0\"");
            std::io::Write::write_all(&mut out, &head)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(Some(out.finish()?.into_inner()))
}

fn replace(haystack: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(haystack.len());
    let mut i = 0;
    while i < haystack.len() {
        if haystack[i..].starts_with(from) {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(haystack[i]);
            i += 1;
        }
    }
    out
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

type Counts = BTreeMap<&'static str, usize>;

fn bump(counts: &mut Counts, code: &'static str, n: usize) {
    if n > 0 {
        *counts.entry(code).or_default() += n;
    }
}

/// Parts and worksheet elements of the package that IronCalc 0.9.1 does not import.
fn scan_package(xlsx: &[u8]) -> Result<Counts, zip::result::ZipError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(xlsx))?;
    let mut lost = Counts::new();
    let names: Vec<String> = archive.file_names().map(|n| n.map(|s| s.to_string())).collect::<Result<_, _>>()?;
    for name in &names {
        let part = |prefix: &str| name.starts_with(prefix) && name.ends_with(".xml") && !name.contains("/_rels/");
        if part("xl/charts/chart") { bump(&mut lost, "charts", 1) }
        if part("xl/chartsheets/sheet") { bump(&mut lost, "chartSheets", 1) }
        if name.starts_with("xl/media/") { bump(&mut lost, "images", 1) }
        if part("xl/drawings/drawing") { bump(&mut lost, "drawings", 1) }
        if part("xl/pivotTables/") { bump(&mut lost, "pivotTables", 1) }
        if name == "xl/vbaProject.bin" { bump(&mut lost, "macros", 1) }
        if part("xl/externalLinks/externalLink") { bump(&mut lost, "externalLinks", 1) }
        if part("xl/slicers/") || part("xl/timelines/") { bump(&mut lost, "slicers", 1) }
        if name == "xl/connections.xml" || part("xl/queryTables/") { bump(&mut lost, "connections", 1) }
        if name.starts_with("xl/activeX/") || name.starts_with("xl/ctrlProps/") { bump(&mut lost, "controls", 1) }
    }
    for name in &names {
        let worksheet = name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml");
        let workbook = name == "xl/workbook.xml";
        let strings = name == "xl/sharedStrings.xml";
        if !(worksheet || workbook || strings) {
            continue;
        }
        let patterns: &[(&[u8], &'static str)] = if worksheet {
            &[
                (b"<dataValidation ", "dataValidation"),
                (b"<x14:dataValidation ", "dataValidation"),
                (b"<autoFilter", "autoFilter"),
                (b"<sheetProtection ", "protection"),
                (b"sparklineGroup ", "sparklines"),
                (b"<pageSetup", "printSettings"),
                (b"<headerFooter", "printSettings"),
                (b"<rowBreaks", "printSettings"),
            ]
        } else if workbook {
            &[(b"<workbookProtection ", "protection")]
        } else {
            &[(b"<r>", "richText")]
        };
        let mut entry = archive.by_name(name)?;
        let found = count_patterns(&mut entry, patterns).map_err(zip::result::ZipError::Io)?;
        for (code, n) in found {
            // A single sheet with page setup and a header counts once.
            let n = if code == "printSettings" || code == "protection" || code == "autoFilter" { n.min(1) } else { n };
            bump(&mut lost, code, n);
        }
    }
    Ok(lost)
}

/// Counts byte patterns in a stream without holding the whole part in memory.
fn count_patterns(reader: &mut impl Read, patterns: &[(&[u8], &'static str)]) -> std::io::Result<Counts> {
    let overlap = patterns.iter().map(|(p, _)| p.len()).max().unwrap_or(0);
    let mut counts = Counts::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        carry.extend_from_slice(&buffer[..read]);
        // Search only windows that start before the retained tail, so no match is counted twice.
        let limit = carry.len().saturating_sub(overlap.saturating_sub(1));
        for (pattern, code) in patterns {
            let n = carry.windows(pattern.len()).take(limit).filter(|w| w == pattern).count();
            bump(&mut counts, code, n);
        }
        carry.drain(..limit);
    }
    for (pattern, code) in patterns {
        let n = carry.windows(pattern.len()).filter(|w| w == pattern).count();
        bump(&mut counts, code, n);
    }
    Ok(counts)
}

/// Features the engine keeps (and writes back on export) that the Farcel grid does not
/// display yet, plus cell and formula counts.
fn report_json(lost: &Counts, workbook: &Workbook) -> String {
    let mut kept = Counts::new();
    let styles = &workbook.styles;
    let base_font = styles.fonts.first();
    let mut used = HashSet::new();
    let mut cells = 0usize;
    let mut formulas = 0usize;
    for sheet in &workbook.worksheets {
        for (_, _, cell) in sheet.sheet_data.cells() {
            cells += 1;
            if cell.has_formula() {
                formulas += 1;
            }
            used.insert(cell.get_style());
        }
        bump(&mut kept, "mergedCells", sheet.merged_cells.len());
        bump(&mut kept, "frozenPanes", usize::from(sheet.frozen_rows > 0 || sheet.frozen_columns > 0));
        bump(&mut kept, "columnWidths", sheet.cols.iter().filter(|c| c.custom_width && !c.hidden).count());
        bump(&mut kept, "rowHeights", sheet.rows.iter().filter(|r| r.custom_height && !r.hidden).count());
        bump(&mut kept, "hiddenRowsColumns", sheet.cols.iter().filter(|c| c.hidden).count() + sheet.rows.iter().filter(|r| r.hidden).count());
        bump(&mut kept, "conditionalFormatting", sheet.conditional_formatting.len());
        bump(&mut kept, "hyperlinks", sheet.links.len());
        bump(&mut kept, "hiddenSheets", usize::from(sheet.state != SheetState::Visible));
        bump(&mut kept, "gridlinesHidden", usize::from(!sheet.show_grid_lines));
    }
    bump(&mut kept, "definedNames", workbook.defined_names.len());
    let (mut fonts, mut fills, mut borders, mut wrap) = (0, 0, 0, 0);
    for style in used {
        let Some(xf) = styles.cell_xfs.get(style as usize) else { continue };
        if let (Some(font), Some(base)) = (styles.fonts.get(xf.font_id as usize), base_font) {
            // A font record that leaves name, size or colour out inherits them (openpyxl writes
            // `<font><b/></font>` for bold); the importer fills a missing name with its own
            // default, so that name does not count as different.
            let unnamed = Font::default().name;
            let differs = font.u
                || font.strike
                || (font.sz > 0 && font.sz != base.sz)
                || (!font.name.is_empty() && font.name != unnamed && font.name != base.name)
                || (font.color.is_some() && font.color != base.color);
            if differs {
                fonts += 1;
            }
        }
        if styles.fills.get(xf.fill_id as usize).is_some_and(|f| f.color.is_some()) {
            fills += 1;
        }
        if styles.borders.get(xf.border_id as usize).is_some_and(|b| b.left.is_some() || b.right.is_some() || b.top.is_some() || b.bottom.is_some()) {
            borders += 1;
        }
        if xf.alignment.as_ref().is_some_and(|a| a.wrap_text || a.vertical != Default::default()) {
            wrap += 1;
        }
    }
    bump(&mut kept, "fontStyles", fonts);
    bump(&mut kept, "fills", fills);
    bump(&mut kept, "borders", borders);
    bump(&mut kept, "wrapVertical", wrap);
    serde_json::json!({
        "lost": lost,
        "kept": kept,
        "cells": cells,
        "formulas": formulas,
        "sheets": workbook.worksheets.len(),
    })
    .to_string()
}
