//! Port of `packages/xlsx-gateway/src/gateway/csv-number-format.ts`:
//! `numberShape` (what one value can be) and `parseNumberWithMark`. The host
//! keeps the column decision itself (`decideCsvColumns`); this side counts the
//! shapes over the whole file and reads values with the decided mark.

use std::sync::OnceLock;

use regex::Regex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Int,
    Comma,
    Point,
    Ambiguous,
    Code,
}

/// CPF has 11 digits, CNPJ 14 (same constant as the TypeScript).
const CODE_DIGITS: usize = 11;
/// Past 15 significant digits a double cannot hold the value exactly.
const MAX_EXACT_DIGITS: usize = 15;

/// JavaScript's String.prototype.trim whitespace set (WhiteSpace + LineTerminator).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

struct Patterns {
    digits: Regex,
    grouped_thousand: Regex,
    leading_zero: Regex,
    comma_decimal: Regex,
    point_decimal: Regex,
    comma_grouped: Regex,
    point_grouped: Regex,
    point_forms: Regex,
    grouped_comma_mark: Regex,
    grouped_point_mark: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        digits: Regex::new(r"^[0-9]+$").unwrap(),
        grouped_thousand: Regex::new(r"^[1-9][0-9]{0,2}[.,][0-9]{3}$").unwrap(),
        leading_zero: Regex::new(r"^0[0-9]").unwrap(),
        comma_decimal: Regex::new(r"^[0-9]+,[0-9]+$").unwrap(),
        point_decimal: Regex::new(r"^[0-9]+\.[0-9]+$").unwrap(),
        comma_grouped: Regex::new(r"^[1-9][0-9]{0,2}(?:\.[0-9]{3})+(?:,[0-9]+)?$").unwrap(),
        point_grouped: Regex::new(r"^[1-9][0-9]{0,2}(?:,[0-9]{3})+(?:\.[0-9]+)?$").unwrap(),
        point_forms: Regex::new(
            r"^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$",
        )
        .unwrap(),
        grouped_comma_mark: Regex::new(
            r"^(-?)((?:[1-9][0-9]{0,2}(?:\.[0-9]{3})+)|[0-9]+)(?:,([0-9]+))?$",
        )
        .unwrap(),
        grouped_point_mark: Regex::new(
            r"^(-?)((?:[1-9][0-9]{0,2}(?:,[0-9]{3})+)|[0-9]+)(?:\.([0-9]+))?$",
        )
        .unwrap(),
    })
}

/// Cheap pre-filter: a number-like value only holds these characters.
fn could_be_number(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b',' | b'-' | b'+' | b'e' | b'E'))
}

/// numberShape: None when the value is not a number in either convention.
pub fn number_shape(raw: &str) -> Option<Shape> {
    let value = js_trim(raw);
    if value.is_empty() || !could_be_number(value) {
        return None;
    }
    let p = patterns();
    let unsigned = value.strip_prefix('-').unwrap_or(value);
    if p.digits.is_match(unsigned) {
        if (unsigned.len() > 1 && unsigned.starts_with('0')) || unsigned.len() >= CODE_DIGITS {
            return Some(Shape::Code);
        }
        return Some(Shape::Int);
    }
    if p.grouped_thousand.is_match(unsigned) {
        return Some(Shape::Ambiguous);
    }
    let leading_zero = p.leading_zero.is_match(unsigned);
    if p.comma_decimal.is_match(unsigned) {
        return Some(if leading_zero {
            Shape::Code
        } else {
            Shape::Comma
        });
    }
    if p.point_decimal.is_match(unsigned) {
        return Some(if leading_zero {
            Shape::Code
        } else {
            Shape::Point
        });
    }
    if p.comma_grouped.is_match(unsigned) {
        return Some(Shape::Comma);
    }
    if p.point_grouped.is_match(unsigned) {
        return Some(Shape::Point);
    }
    if p.point_forms.is_match(unsigned) {
        return Some(Shape::Point);
    }
    None
}

/// parseNumberWithMark: the number `raw` holds read with `mark`, or None (text).
pub fn parse_number_with_mark(raw: &str, mark: char) -> Option<f64> {
    let value = js_trim(raw);
    let p = patterns();
    let pattern = if mark == ',' {
        &p.grouped_comma_mark
    } else {
        &p.grouped_point_mark
    };
    if let Some(captures) = pattern.captures(value) {
        let sign = captures.get(1).map_or("", |m| m.as_str());
        let whole = captures.get(2).map_or("", |m| m.as_str());
        let fraction = captures.get(3).map(|m| m.as_str());
        let digits: String = whole.chars().filter(|c| *c != '.' && *c != ',').collect();
        if digits.len() > 1 && digits.starts_with('0') {
            return None;
        }
        let significant = format!("{digits}{}", fraction.unwrap_or(""));
        if significant.trim_start_matches('0').len() > MAX_EXACT_DIGITS {
            return None;
        }
        let text = match fraction {
            Some(fraction) if !fraction.is_empty() => format!("{sign}{digits}.{fraction}"),
            _ => format!("{sign}{digits}"),
        };
        return text.parse::<f64>().ok().filter(|n| n.is_finite());
    }
    if mark == '.' && number_shape(value) == Some(Shape::Point) {
        return js_number(value);
    }
    None
}

/// `Number(value)` for the point forms numberShape accepts (`.5`, `1.`, `1e10`, `-.5`).
fn js_number(value: &str) -> Option<f64> {
    let normalized = if let Some(rest) = value.strip_prefix("-.") {
        format!("-0.{rest}")
    } else if let Some(rest) = value.strip_prefix('.') {
        format!("0.{rest}")
    } else {
        value.to_owned()
    };
    let normalized = normalized.replace(".e", ".0e").replace(".E", ".0E");
    let normalized = if normalized.ends_with('.') {
        format!("{normalized}0")
    } else {
        normalized
    };
    normalized.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// Per-column shape counts: the input of the host's column decision.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnCounts {
    pub int: u64,
    pub comma: u64,
    pub point: u64,
    pub ambiguous: u64,
    pub code: u64,
    pub text: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_ambiguous: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_conflict: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_code: Option<String>,
}

impl ColumnCounts {
    /// One value, as analyzeCsvColumns counts it (blank values do not count).
    pub fn add(&mut self, value: &str) {
        if js_trim(value).is_empty() {
            return;
        }
        match number_shape(value) {
            None => self.text += 1,
            Some(Shape::Int) => self.int += 1,
            Some(Shape::Comma) => {
                self.comma += 1;
                self.first_conflict.get_or_insert_with(|| value.to_owned());
            }
            Some(Shape::Point) => {
                self.point += 1;
                self.first_conflict.get_or_insert_with(|| value.to_owned());
            }
            Some(Shape::Ambiguous) => {
                self.ambiguous += 1;
                self.first_ambiguous.get_or_insert_with(|| value.to_owned());
            }
            Some(Shape::Code) => {
                self.code += 1;
                self.first_code.get_or_insert_with(|| value.to_owned());
            }
        }
    }
}

/// Univer's extractPureValue text for a number (JS Number#toString).
pub fn js_number_text(number: f64) -> String {
    let magnitude = number.abs();
    if magnitude != 0.0 && !(1e-6..1e21).contains(&magnitude) {
        let exp = format!("{number:e}");
        return match exp.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{mantissa}e+{exponent}")
            }
            _ => exp,
        };
    }
    format!("{number}")
}

/// parseNumberWithMark for the plain forms (`-1234,5`, `42`) without the
/// regexes: a million cells read in a fraction of the time. Anything else
/// (grouping, exponents, spaces) takes the full rules.
pub fn parse_number_fast(raw: &str, mark: char) -> Option<f64> {
    let bytes = raw.as_bytes();
    let body = bytes.strip_prefix(b"-").unwrap_or(bytes);
    let mark = mark as u8;
    let whole = body.iter().take_while(|b| b.is_ascii_digit()).count();
    let mut end = whole;
    let mut fraction = 0;
    if whole > 0 && body.get(whole) == Some(&mark) {
        fraction = body[whole + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        end = whole + 1 + fraction;
    }
    if whole == 0 || end != body.len() || (end > whole && fraction == 0) {
        return parse_number_with_mark(raw, mark as char);
    }
    // the same rules the full reader applies to these forms
    if whole > 1 && body[0] == b'0' {
        return None;
    }
    let significant = body[..whole]
        .iter()
        .chain(body.get(whole + 1..end).unwrap_or(&[]))
        .skip_while(|b| **b == b'0')
        .count();
    if significant > MAX_EXACT_DIGITS {
        return None;
    }
    let text = if fraction > 0 && mark != b'.' {
        raw.replacen(mark as char, ".", 1)
    } else {
        raw.to_owned()
    };
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}
