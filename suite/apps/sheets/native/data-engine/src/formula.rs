//! Excel formulas over a whole column of the base: a calculated column.
//!
//! The grid hands over the formula of one cell (`=D2*F2`, Excel's English
//! function names, as the grid stores them) and the row it was typed in. Every
//! data row of the column then takes that formula with its relative rows moved,
//! as Excel's fill down or a table's calculated column would write it. This
//! module parses the formula once and evaluates it row by row over columns
//! loaded from the base, with Excel's rules for values, coercion and errors.
//!
//! Ranges that move with the row are the costly part of a filled column (a
//! running `SUM($D$2:D2)` is a million sums of growing ranges). They are kept
//! incrementally: rows are evaluated top to bottom and a running range's state
//! advances with them, adding cells in the same order a fresh sum would, so the
//! result is the same double Excel computes. Ranges that do not move are
//! evaluated once; equality lookups and criteria build one hash index.
//!
//! What this module does not run yet is refused up front with a reason
//! (`FormulaError`), never computed differently from Excel.

use std::collections::{BTreeSet, HashMap};

/// Rows a moving range may span and still be summed directly on every row.
const DIRECT_RANGE_CELLS: u64 = 256;
/// Cell checks the slow criteria path may spend on one column before the
/// column is refused as too slow (a criterion with an operator on each row).
const SCAN_BUDGET: u64 = 200_000_000;
/// Excel's limit for one text value.
const MAX_TEXT_CHARS: usize = 32_767;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    Div0,
    Value,
    Ref,
    Na,
    Num,
    Name,
    Null,
}

impl ErrorKind {
    pub fn text(self) -> &'static str {
        match self {
            ErrorKind::Div0 => "#DIV/0!",
            ErrorKind::Value => "#VALUE!",
            ErrorKind::Ref => "#REF!",
            ErrorKind::Na => "#N/A",
            ErrorKind::Num => "#NUM!",
            ErrorKind::Name => "#NAME?",
            ErrorKind::Null => "#NULL!",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Empty,
    Num(f64),
    Text(String),
    Bool(bool),
    Err(ErrorKind),
}

/// Why a formula does not run over the base, for the message the person sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormulaError {
    /// SYNTAX, UNSUPPORTED_FUNCTION, UNSUPPORTED_REFERENCE, CIRCULAR,
    /// APPROXIMATE_LOOKUP, UNSUPPORTED_RANGE
    pub code: &'static str,
    pub detail: String,
}

impl FormulaError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tokens

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Num(f64),
    Str(String),
    Bool(bool),
    Error(ErrorKind),
    Cell { col: u64, row: u64, row_abs: bool },
    Columns { first: u64, last: u64 },
    Func(String),
    LParen,
    RParen,
    Sep,
    Colon,
    Op(&'static str),
}

fn column_index(letters: &str) -> Option<u64> {
    let mut index = 0u64;
    for c in letters.chars() {
        let digit = (c.to_ascii_uppercase() as u8).checked_sub(b'A')? as u64;
        if digit >= 26 {
            return None;
        }
        index = index * 26 + digit + 1;
    }
    (1..=16_384).contains(&index).then(|| index - 1)
}

fn tokenize(text: &str, sheet_name: &str) -> Result<Vec<Token>, FormulaError> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    let syntax = |detail: &str| FormulaError::new("SYNTAX", detail.to_owned());
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        match c {
            '"' => {
                let mut value = String::new();
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(syntax("unterminated text")),
                        Some('"') if chars.get(i + 1) == Some(&'"') => {
                            value.push('"');
                            i += 2;
                        }
                        Some('"') => {
                            i += 1;
                            break;
                        }
                        Some(other) => {
                            value.push(*other);
                            i += 1;
                        }
                    }
                }
                tokens.push(Token::Str(value));
                continue;
            }
            '(' => {
                tokens.push(Token::LParen);
                i += 1;
                continue;
            }
            ')' => {
                tokens.push(Token::RParen);
                i += 1;
                continue;
            }
            ',' | ';' => {
                tokens.push(Token::Sep);
                i += 1;
                continue;
            }
            ':' => {
                tokens.push(Token::Colon);
                i += 1;
                continue;
            }
            '+' | '-' | '*' | '/' | '^' | '&' | '%' | '=' => {
                let op = match c {
                    '+' => "+",
                    '-' => "-",
                    '*' => "*",
                    '/' => "/",
                    '^' => "^",
                    '&' => "&",
                    '%' => "%",
                    _ => "=",
                };
                tokens.push(Token::Op(op));
                i += 1;
                continue;
            }
            '<' | '>' => {
                let next = chars.get(i + 1).copied();
                let op = match (c, next) {
                    ('<', Some('=')) => "<=",
                    ('<', Some('>')) => "<>",
                    ('>', Some('=')) => ">=",
                    ('<', _) => "<",
                    _ => ">",
                };
                i += op.len();
                tokens.push(Token::Op(op));
                continue;
            }
            '#' => {
                let rest: String = chars[i..].iter().collect::<String>().to_ascii_uppercase();
                let kinds = [
                    ("#DIV/0!", ErrorKind::Div0),
                    ("#VALUE!", ErrorKind::Value),
                    ("#REF!", ErrorKind::Ref),
                    ("#N/A", ErrorKind::Na),
                    ("#NUM!", ErrorKind::Num),
                    ("#NAME?", ErrorKind::Name),
                    ("#NULL!", ErrorKind::Null),
                ];
                let Some((literal, kind)) = kinds.iter().find(|(l, _)| rest.starts_with(l)) else {
                    return Err(syntax("unknown error value"));
                };
                tokens.push(Token::Error(*kind));
                i += literal.chars().count();
                continue;
            }
            _ => {}
        }
        if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()))
        {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                let mut j = i + 1;
                if j < chars.len() && (chars[j] == '+' || chars[j] == '-') {
                    j += 1;
                }
                if j < chars.len() && chars[j].is_ascii_digit() {
                    i = j;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            // a row range (`2:5`) starts with digits too
            if chars.get(i) == Some(&':') {
                return Err(FormulaError::new(
                    "UNSUPPORTED_REFERENCE",
                    chars[start..].iter().collect::<String>(),
                ));
            }
            let literal: String = chars[start..i].iter().collect();
            let number = literal.parse::<f64>().map_err(|_| syntax("bad number"))?;
            tokens.push(Token::Num(number));
            continue;
        }
        // a sheet qualifier: 'Name'! or Name! — only this base's own sheet
        if c == '\'' {
            let mut name = String::new();
            let mut j = i + 1;
            loop {
                match chars.get(j) {
                    None => return Err(syntax("unterminated sheet name")),
                    Some('\'') if chars.get(j + 1) == Some(&'\'') => {
                        name.push('\'');
                        j += 2;
                    }
                    Some('\'') => {
                        j += 1;
                        break;
                    }
                    Some(other) => {
                        name.push(*other);
                        j += 1;
                    }
                }
            }
            if chars.get(j) != Some(&'!') {
                return Err(syntax("sheet name without a reference"));
            }
            if !name.eq_ignore_ascii_case(sheet_name)
                && name.to_lowercase() != sheet_name.to_lowercase()
            {
                return Err(FormulaError::new(
                    "UNSUPPORTED_REFERENCE",
                    format!("'{name}'!"),
                ));
            }
            i = j + 1;
            continue;
        }
        if c.is_alphabetic() || c == '_' || c == '$' || c == '\\' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '.' | '$' | '\\'))
            {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if chars.get(i) == Some(&'!') {
                if word.to_lowercase() != sheet_name.to_lowercase() {
                    return Err(FormulaError::new(
                        "UNSUPPORTED_REFERENCE",
                        format!("{word}!"),
                    ));
                }
                i += 1;
                continue;
            }
            if chars.get(i) == Some(&'(') {
                let upper = word.to_ascii_uppercase();
                let name = upper
                    .strip_prefix("_XLFN.")
                    .or_else(|| upper.strip_prefix("_XLWS."))
                    .unwrap_or(&upper)
                    .to_owned();
                tokens.push(Token::Func(name));
                i += 1;
                continue;
            }
            // a cell (`$D$2`) or a column range (`D:D`, `$A:$C`)
            if let Some(token) = cell_token(&word) {
                tokens.push(token);
                continue;
            }
            if chars.get(i) == Some(&':') {
                let first = word.trim_start_matches('$');
                let mut j = i + 1;
                let second_start = j;
                while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '$') {
                    j += 1;
                }
                let second: String = chars[second_start..j].iter().collect();
                let second = second.trim_start_matches('$');
                if !first.contains('$')
                    && first.chars().all(|c| c.is_ascii_alphabetic())
                    && second.chars().all(|c| c.is_ascii_alphabetic())
                    && !second.is_empty()
                    && let (Some(a), Some(b)) = (column_index(first), column_index(second))
                {
                    tokens.push(Token::Columns {
                        first: a.min(b),
                        last: a.max(b),
                    });
                    i = j;
                    continue;
                }
            }
            match word.to_ascii_uppercase().as_str() {
                "TRUE" => tokens.push(Token::Bool(true)),
                "FALSE" => tokens.push(Token::Bool(false)),
                _ => {
                    // a defined name or a table reference: the base has none
                    return Err(FormulaError::new("UNSUPPORTED_REFERENCE", word));
                }
            }
            continue;
        }
        if c == '[' || c == '{' {
            return Err(FormulaError::new(
                "UNSUPPORTED_REFERENCE",
                chars[i..].iter().collect::<String>(),
            ));
        }
        return Err(syntax(&format!("unexpected '{c}'")));
    }
    Ok(tokens)
}

/// `$D$2`, `D2`, `$D2`, `D$2` (columns are the same on every row of a
/// filled column, so a `$` on the column changes nothing here).
fn cell_token(word: &str) -> Option<Token> {
    let rest = word.strip_prefix('$').unwrap_or(word);
    let letters_end = rest.find(|c: char| !c.is_ascii_alphabetic())?;
    let (letters, rest) = rest.split_at(letters_end);
    if letters.is_empty() || letters.len() > 3 {
        return None;
    }
    let (row_abs, digits) = match rest.strip_prefix('$') {
        Some(digits) => (true, digits),
        None => (false, rest),
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) || digits.len() > 7 {
        return None;
    }
    let row: u64 = digits.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some(Token::Cell {
        col: column_index(letters)?,
        row: row - 1,
        row_abs,
    })
}

// ---------------------------------------------------------------------------
// Expressions

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowPos {
    /// a fixed row (0-based)
    Abs(u64),
    /// rows below (+) or above (-) the row being evaluated
    Rel(i64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RangeRef {
    pub first_col: u64,
    pub last_col: u64,
    /// None: whole columns
    pub rows: Option<(RowPos, RowPos)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Concat,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Func {
    If,
    IfError,
    IfNa,
    And,
    Or,
    Not,
    Sum,
    Average,
    Min,
    Max,
    Count,
    CountA,
    CountBlank,
    Product,
    Round,
    RoundUp,
    RoundDown,
    Int,
    Trunc,
    Abs,
    Mod,
    Power,
    Sqrt,
    Sign,
    SumIf,
    CountIf,
    AverageIf,
    SumIfs,
    CountIfs,
    AverageIfs,
    VLookup,
    XLookup,
    Match,
    Index,
    Len,
    Left,
    Right,
    Mid,
    Upper,
    Lower,
    Trim,
    Concatenate,
    Concat,
    Substitute,
    Replace,
    Rept,
    Exact,
    Find,
    Search,
    ValueFn,
    IsBlank,
    IsNumber,
    IsText,
    IsError,
    IsErr,
    IsNa,
    IsLogical,
    TrueFn,
    FalseFn,
    Na,
}

fn func_by_name(name: &str) -> Option<(Func, usize, usize)> {
    use Func::*;
    const MANY: usize = 255;
    Some(match name {
        "IF" => (If, 2, 3),
        "IFERROR" => (IfError, 2, 2),
        "IFNA" => (IfNa, 2, 2),
        "AND" => (And, 1, MANY),
        "OR" => (Or, 1, MANY),
        "NOT" => (Not, 1, 1),
        "SUM" => (Sum, 1, MANY),
        "AVERAGE" => (Average, 1, MANY),
        "MIN" => (Min, 1, MANY),
        "MAX" => (Max, 1, MANY),
        "COUNT" => (Count, 1, MANY),
        "COUNTA" => (CountA, 1, MANY),
        "COUNTBLANK" => (CountBlank, 1, 1),
        "PRODUCT" => (Product, 1, MANY),
        "ROUND" => (Round, 2, 2),
        "ROUNDUP" => (RoundUp, 2, 2),
        "ROUNDDOWN" => (RoundDown, 2, 2),
        "INT" => (Int, 1, 1),
        "TRUNC" => (Trunc, 1, 2),
        "ABS" => (Abs, 1, 1),
        "MOD" => (Mod, 2, 2),
        "POWER" => (Power, 2, 2),
        "SQRT" => (Sqrt, 1, 1),
        "SIGN" => (Sign, 1, 1),
        "SUMIF" => (SumIf, 2, 3),
        "COUNTIF" => (CountIf, 2, 2),
        "AVERAGEIF" => (AverageIf, 2, 3),
        "SUMIFS" => (SumIfs, 3, MANY),
        "COUNTIFS" => (CountIfs, 2, MANY),
        "AVERAGEIFS" => (AverageIfs, 3, MANY),
        "VLOOKUP" => (VLookup, 3, 4),
        "XLOOKUP" => (XLookup, 3, 6),
        "MATCH" => (Match, 2, 3),
        "INDEX" => (Index, 2, 3),
        "LEN" => (Len, 1, 1),
        "LEFT" => (Left, 1, 2),
        "RIGHT" => (Right, 1, 2),
        "MID" => (Mid, 3, 3),
        "UPPER" => (Upper, 1, 1),
        "LOWER" => (Lower, 1, 1),
        "TRIM" => (Trim, 1, 1),
        "CONCATENATE" => (Concatenate, 1, MANY),
        "CONCAT" => (Concat, 1, MANY),
        "SUBSTITUTE" => (Substitute, 3, 4),
        "REPLACE" => (Replace, 4, 4),
        "REPT" => (Rept, 2, 2),
        "EXACT" => (Exact, 2, 2),
        "FIND" => (Find, 2, 3),
        "SEARCH" => (Search, 2, 3),
        "VALUE" => (ValueFn, 1, 1),
        "ISBLANK" => (IsBlank, 1, 1),
        "ISNUMBER" => (IsNumber, 1, 1),
        "ISTEXT" => (IsText, 1, 1),
        "ISERROR" => (IsError, 1, 1),
        "ISERR" => (IsErr, 1, 1),
        "ISNA" => (IsNa, 1, 1),
        "ISLOGICAL" => (IsLogical, 1, 1),
        "TRUE" => (TrueFn, 0, 0),
        "FALSE" => (FalseFn, 0, 0),
        "NA" => (Na, 0, 0),
        _ => return None,
    })
}

#[derive(Clone, Debug)]
enum Expr {
    Lit(Value),
    /// an argument left empty (`IF(A2,,1)`)
    Missing,
    Cell {
        col: u64,
        row: RowPos,
    },
    Range(RangeRef),
    Neg(Box<Node>),
    Pct(Box<Node>),
    Bin(BinOp, Box<Node>, Box<Node>),
    Call(Func, Vec<Node>),
}

#[derive(Clone, Debug)]
struct Node {
    id: usize,
    /// no row-relative reference anywhere below: the same value on every row
    invariant: bool,
    expr: Expr,
}

struct Parser<'a> {
    tokens: &'a [Token],
    at: usize,
    anchor: u64,
    next_id: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn node(&mut self, expr: Expr) -> Node {
        let invariant = match &expr {
            Expr::Lit(_) | Expr::Missing => true,
            Expr::Cell { row, .. } => matches!(row, RowPos::Abs(_)),
            Expr::Range(range) => match range.rows {
                None => true,
                Some((a, b)) => matches!(a, RowPos::Abs(_)) && matches!(b, RowPos::Abs(_)),
            },
            Expr::Neg(inner) | Expr::Pct(inner) => inner.invariant,
            Expr::Bin(_, a, b) => a.invariant && b.invariant,
            Expr::Call(_, args) => args.iter().all(|a| a.invariant),
        };
        self.next_id += 1;
        Node {
            id: self.next_id,
            invariant,
            expr,
        }
    }

    fn row_pos(&self, row: u64, abs: bool) -> RowPos {
        if abs {
            RowPos::Abs(row)
        } else {
            RowPos::Rel(row as i64 - self.anchor as i64)
        }
    }

    fn comparison(&mut self) -> Result<Node, FormulaError> {
        let mut left = self.concat()?;
        loop {
            let op = match self.peek() {
                Some(Token::Op("=")) => BinOp::Eq,
                Some(Token::Op("<>")) => BinOp::Ne,
                Some(Token::Op("<")) => BinOp::Lt,
                Some(Token::Op("<=")) => BinOp::Le,
                Some(Token::Op(">")) => BinOp::Gt,
                Some(Token::Op(">=")) => BinOp::Ge,
                _ => return Ok(left),
            };
            self.at += 1;
            let right = self.concat()?;
            left = self.node(Expr::Bin(op, Box::new(left), Box::new(right)));
        }
    }

    fn concat(&mut self) -> Result<Node, FormulaError> {
        let mut left = self.additive()?;
        while self.peek() == Some(&Token::Op("&")) {
            self.at += 1;
            let right = self.additive()?;
            left = self.node(Expr::Bin(BinOp::Concat, Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn additive(&mut self) -> Result<Node, FormulaError> {
        let mut left = self.multiplicative()?;
        loop {
            let op = match self.peek() {
                Some(Token::Op("+")) => BinOp::Add,
                Some(Token::Op("-")) => BinOp::Sub,
                _ => return Ok(left),
            };
            self.at += 1;
            let right = self.multiplicative()?;
            left = self.node(Expr::Bin(op, Box::new(left), Box::new(right)));
        }
    }

    fn multiplicative(&mut self) -> Result<Node, FormulaError> {
        let mut left = self.power()?;
        loop {
            let op = match self.peek() {
                Some(Token::Op("*")) => BinOp::Mul,
                Some(Token::Op("/")) => BinOp::Div,
                _ => return Ok(left),
            };
            self.at += 1;
            let right = self.power()?;
            left = self.node(Expr::Bin(op, Box::new(left), Box::new(right)));
        }
    }

    // Excel: negation binds tighter than %, which binds tighter than ^
    // (-2^2 is 4), and ^ associates to the left.
    fn power(&mut self) -> Result<Node, FormulaError> {
        let mut left = self.percent()?;
        while self.peek() == Some(&Token::Op("^")) {
            self.at += 1;
            let right = self.percent()?;
            left = self.node(Expr::Bin(BinOp::Pow, Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn percent(&mut self) -> Result<Node, FormulaError> {
        let mut inner = self.unary()?;
        while self.peek() == Some(&Token::Op("%")) {
            self.at += 1;
            inner = self.node(Expr::Pct(Box::new(inner)));
        }
        Ok(inner)
    }

    fn unary(&mut self) -> Result<Node, FormulaError> {
        match self.peek() {
            Some(Token::Op("-")) => {
                self.at += 1;
                let inner = self.unary()?;
                Ok(self.node(Expr::Neg(Box::new(inner))))
            }
            Some(Token::Op("+")) => {
                self.at += 1;
                self.unary()
            }
            _ => self.primary(),
        }
    }

    fn primary(&mut self) -> Result<Node, FormulaError> {
        let token = self
            .peek()
            .cloned()
            .ok_or_else(|| FormulaError::new("SYNTAX", "formula ends early"))?;
        self.at += 1;
        match token {
            Token::Num(n) => Ok(self.node(Expr::Lit(Value::Num(n)))),
            Token::Str(s) => Ok(self.node(Expr::Lit(Value::Text(s)))),
            Token::Bool(b) => Ok(self.node(Expr::Lit(Value::Bool(b)))),
            Token::Error(kind) => Ok(self.node(Expr::Lit(Value::Err(kind)))),
            Token::Columns { first, last } => Ok(self.node(Expr::Range(RangeRef {
                first_col: first,
                last_col: last,
                rows: None,
            }))),
            Token::Cell { col, row, row_abs } => {
                if self.peek() == Some(&Token::Colon) {
                    self.at += 1;
                    let Some(Token::Cell {
                        col: col2,
                        row: row2,
                        row_abs: row_abs2,
                    }) = self.peek().cloned()
                    else {
                        return Err(FormulaError::new("SYNTAX", "range without an end"));
                    };
                    self.at += 1;
                    let a = self.row_pos(row, row_abs);
                    let b = self.row_pos(row2, row_abs2);
                    return Ok(self.node(Expr::Range(RangeRef {
                        first_col: col.min(col2),
                        last_col: col.max(col2),
                        rows: Some((a, b)),
                    })));
                }
                let row = self.row_pos(row, row_abs);
                Ok(self.node(Expr::Cell { col, row }))
            }
            Token::LParen => {
                let inner = self.comparison()?;
                if self.peek() != Some(&Token::RParen) {
                    return Err(FormulaError::new("SYNTAX", "missing ')'"));
                }
                self.at += 1;
                Ok(inner)
            }
            Token::Func(name) => {
                let Some((func, min, max)) = func_by_name(&name) else {
                    return Err(FormulaError::new("UNSUPPORTED_FUNCTION", name));
                };
                let mut args = Vec::new();
                if self.peek() == Some(&Token::RParen) {
                    self.at += 1;
                } else {
                    loop {
                        let arg = if matches!(self.peek(), Some(Token::Sep | Token::RParen)) {
                            self.node(Expr::Missing)
                        } else {
                            self.comparison()?
                        };
                        args.push(arg);
                        match self.peek() {
                            Some(Token::Sep) => self.at += 1,
                            Some(Token::RParen) => {
                                self.at += 1;
                                break;
                            }
                            _ => return Err(FormulaError::new("SYNTAX", "missing ')'")),
                        }
                    }
                }
                if args.len() < min || args.len() > max {
                    return Err(FormulaError::new(
                        "SYNTAX",
                        format!("{name}: wrong number of arguments"),
                    ));
                }
                Ok(self.node(Expr::Call(func, args)))
            }
            other => Err(FormulaError::new("SYNTAX", format!("unexpected {other:?}"))),
        }
    }
}

/// A formula ready to fill rows `first_row..=last_row` of column `column`.
#[derive(Clone, Debug)]
pub struct Formula {
    root: Node,
    pub column: u64,
    pub first_row: u64,
    pub last_row: u64,
    /// every column the formula reads (its own column included when it reads
    /// rows above, as a running balance does)
    pub reads: BTreeSet<u64>,
    /// reads only cells of its own row (`=D2*F2`): an edit changes the
    /// result of that row alone
    pub row_local: bool,
}

impl Formula {
    /// `text` is the formula as typed in row `anchor_row` (with or without
    /// the leading `=`).
    pub fn parse(
        text: &str,
        anchor_row: u64,
        column: u64,
        first_row: u64,
        last_row: u64,
        sheet_name: &str,
    ) -> Result<Self, FormulaError> {
        let body = text.trim().strip_prefix('=').unwrap_or(text.trim());
        let tokens = tokenize(body, sheet_name)?;
        if tokens.is_empty() {
            return Err(FormulaError::new("SYNTAX", "empty formula"));
        }
        let mut parser = Parser {
            tokens: &tokens,
            at: 0,
            anchor: anchor_row,
            next_id: 0,
        };
        let root = parser.comparison()?;
        if parser.at != tokens.len() {
            return Err(FormulaError::new(
                "SYNTAX",
                "unexpected text after the formula",
            ));
        }
        let mut formula = Formula {
            root,
            column,
            first_row,
            last_row,
            reads: BTreeSet::new(),
            row_local: false,
        };
        let mut reads = BTreeSet::new();
        formula.check(&formula.root, &mut reads)?;
        formula.row_local = !reads.contains(&column) && row_local(&formula.root);
        formula.reads = reads;
        Ok(formula)
    }

    /// Columns a range argument needs: VLOOKUP with a typed column number
    /// reads its key column and the returned one, not the columns between.
    fn range_reads(
        &self,
        range: &RangeRef,
        columns: &mut dyn Iterator<Item = u64>,
        reads: &mut BTreeSet<u64>,
    ) -> Result<(), FormulaError> {
        let mut touches_own = false;
        for col in columns {
            reads.insert(col);
            touches_own |= col == self.column;
        }
        if touches_own {
            let reaches_calc = match range.rows {
                None => true,
                Some((a, b)) => {
                    let touches = |pos: RowPos| match pos {
                        RowPos::Rel(offset) => offset >= 0,
                        RowPos::Abs(r) => r >= self.first_row,
                    };
                    touches(a) || touches(b)
                }
            };
            if reaches_calc {
                return Err(FormulaError::new("CIRCULAR", String::new()));
            }
        }
        Ok(())
    }

    /// References the column cannot take: its own cells at or below the row
    /// being computed (Excel's circular reference), approximate lookups.
    fn check(&self, node: &Node, reads: &mut BTreeSet<u64>) -> Result<(), FormulaError> {
        let own = |col: u64| col == self.column;
        let circular = || FormulaError::new("CIRCULAR", String::new());
        let in_calc = |row: u64| row >= self.first_row && row <= self.last_row;
        match &node.expr {
            Expr::Lit(_) | Expr::Missing => {}
            Expr::Cell { col, row } => {
                reads.insert(*col);
                if own(*col) {
                    match row {
                        RowPos::Rel(offset) if *offset >= 0 => return Err(circular()),
                        RowPos::Abs(r) if in_calc(*r) => return Err(circular()),
                        _ => {}
                    }
                }
            }
            Expr::Range(range) => {
                self.range_reads(range, &mut (range.first_col..=range.last_col), reads)?;
            }
            Expr::Neg(inner) | Expr::Pct(inner) => self.check(inner, reads)?,
            Expr::Bin(_, a, b) => {
                self.check(a, reads)?;
                self.check(b, reads)?;
            }
            Expr::Call(func, args) => {
                if *func == Func::VLookup {
                    let exact = match args.get(3).map(|a| &a.expr) {
                        Some(Expr::Lit(Value::Bool(false))) => true,
                        Some(Expr::Lit(Value::Num(n))) => *n == 0.0,
                        _ => false,
                    };
                    if !exact {
                        return Err(FormulaError::new("APPROXIMATE_LOOKUP", "VLOOKUP"));
                    }
                }
                if *func == Func::Match {
                    let exact = matches!(
                        args.get(2).map(|a| &a.expr),
                        Some(Expr::Lit(Value::Num(n))) if *n == 0.0
                    );
                    if !exact {
                        return Err(FormulaError::new("APPROXIMATE_LOOKUP", "MATCH"));
                    }
                }
                if *func == Func::XLookup {
                    let literal_or_missing =
                        |index: usize, allowed: &[f64]| match args.get(index).map(|a| &a.expr) {
                            None | Some(Expr::Missing) => true,
                            Some(Expr::Lit(Value::Num(n))) => allowed.contains(n),
                            _ => false,
                        };
                    if !literal_or_missing(4, &[0.0]) || !literal_or_missing(5, &[1.0, -1.0]) {
                        return Err(FormulaError::new("APPROXIMATE_LOOKUP", "XLOOKUP"));
                    }
                }
                if *func == Func::VLookup
                    && let (Expr::Range(range), Expr::Lit(Value::Num(n))) =
                        (&args[1].expr, &args[2].expr)
                    && *n >= 1.0
                    && range.first_col + (*n as u64) - 1 <= range.last_col
                {
                    let returned = range.first_col + (*n as u64) - 1;
                    self.range_reads(range, &mut [range.first_col, returned].into_iter(), reads)?;
                    for (i, arg) in args.iter().enumerate() {
                        if i != 1 {
                            self.check(arg, reads)?;
                        }
                    }
                    return Ok(());
                }
                for arg in args {
                    self.check(arg, reads)?;
                }
            }
        }
        Ok(())
    }
}

/// Only same-row cells: no ranges, no fixed rows, no rows above or below.
fn row_local(node: &Node) -> bool {
    match &node.expr {
        Expr::Lit(_) | Expr::Missing => true,
        Expr::Cell { row, .. } => *row == RowPos::Rel(0),
        Expr::Range(_) => false,
        Expr::Neg(inner) | Expr::Pct(inner) => row_local(inner),
        Expr::Bin(_, a, b) => row_local(a) && row_local(b),
        Expr::Call(_, args) => args.iter().all(row_local),
    }
}

// ---------------------------------------------------------------------------
// Values

/// Excel's number-to-text: 15 significant digits, no trailing zeros, the
/// General format's exponent form for very large or small magnitudes.
pub fn number_text(n: f64) -> String {
    if n == 0.0 {
        return "0".to_owned();
    }
    let rounded = round_significant(n);
    let magnitude = rounded.abs();
    if !(1e-9..1e15).contains(&magnitude) {
        let text = format!("{:.14E}", rounded);
        let (mantissa, exponent) = text.split_once('E').unwrap_or((&text, "0"));
        let mantissa = mantissa.trim_end_matches('0').trim_end_matches('.');
        let exponent: i32 = exponent.parse().unwrap_or(0);
        let sign = if exponent < 0 { '-' } else { '+' };
        return format!("{mantissa}E{sign}{:02}", exponent.abs());
    }
    plain_decimal(rounded)
}

/// The double nearest to `n` written with 15 significant digits (Excel's
/// precision for display, text and CSV).
pub fn round_significant(n: f64) -> f64 {
    if n == 0.0 || !n.is_finite() {
        return n;
    }
    format!("{:.14e}", n).parse::<f64>().unwrap_or(n)
}

/// Plain decimal text with at most 15 significant digits. Most values
/// already print that short (Rust's `{}` never uses an exponent).
pub fn excel_digits(n: f64) -> String {
    let n = if n == 0.0 { 0.0 } else { n };
    let text = format!("{n}");
    let significant = text
        .bytes()
        .filter(u8::is_ascii_digit)
        .skip_while(|b| *b == b'0')
        .count();
    if significant <= 15 {
        return text;
    }
    format!("{}", round_significant(n))
}

/// Shortest round-trip digits, never in exponent form.
pub fn plain_decimal(n: f64) -> String {
    let text = format!("{n:e}");
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let (sign, mantissa) = match mantissa.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", mantissa),
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let point = exponent + 1;
    if point <= 0 {
        format!("{sign}0.{}{digits}", "0".repeat((-point) as usize))
    } else if point as usize >= digits.len() {
        format!(
            "{sign}{digits}{}",
            "0".repeat(point as usize - digits.len())
        )
    } else {
        let (whole, fraction) = digits.split_at(point as usize);
        format!("{sign}{whole}.{fraction}")
    }
}

/// Text that reads as a number in arithmetic (`" 12.5 "`, `1e3`, `-.5`).
fn text_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let body = trimmed.trim_start_matches(['+', '-']);
    if body.len() + 1 < trimmed.len() {
        return None;
    }
    let ok = body
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
        && body
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit() || c == '.');
    if !ok {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn to_number(value: &Value) -> Result<f64, ErrorKind> {
    match value {
        Value::Empty => Ok(0.0),
        Value::Num(n) => Ok(*n),
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Text(t) => text_number(t).ok_or(ErrorKind::Value),
        Value::Err(e) => Err(*e),
    }
}

fn to_text(value: &Value) -> Result<String, ErrorKind> {
    match value {
        Value::Empty => Ok(String::new()),
        Value::Num(n) => Ok(number_text(*n)),
        Value::Bool(b) => Ok(if *b { "TRUE" } else { "FALSE" }.to_owned()),
        Value::Text(t) => Ok(t.clone()),
        Value::Err(e) => Err(*e),
    }
}

fn to_bool(value: &Value) -> Result<bool, ErrorKind> {
    match value {
        Value::Empty => Ok(false),
        Value::Num(n) => Ok(*n != 0.0),
        Value::Bool(b) => Ok(*b),
        Value::Text(t) => {
            if t.eq_ignore_ascii_case("TRUE") {
                Ok(true)
            } else if t.eq_ignore_ascii_case("FALSE") {
                Ok(false)
            } else {
                Err(ErrorKind::Value)
            }
        }
        Value::Err(e) => Err(*e),
    }
}

fn num(n: f64) -> Value {
    if n.is_finite() {
        Value::Num(if n == 0.0 { 0.0 } else { n })
    } else {
        Value::Err(ErrorKind::Num)
    }
}

/// Excel's comparison: numbers < text < logicals; text without case; numbers
/// equal at 15 significant digits (`0.1+0.2=0.3` is TRUE in Excel).
fn compare(a: &Value, b: &Value) -> Result<std::cmp::Ordering, ErrorKind> {
    use std::cmp::Ordering;
    fn rank(v: &Value) -> u8 {
        match v {
            Value::Num(_) | Value::Empty => 0,
            Value::Text(_) => 1,
            Value::Bool(_) => 2,
            Value::Err(_) => 3,
        }
    }
    if let Value::Err(e) = a {
        return Err(*e);
    }
    if let Value::Err(e) = b {
        return Err(*e);
    }
    // an empty cell compares as the other side's empty value
    let (a, b) = match (a, b) {
        (Value::Empty, Value::Text(_)) => (Value::Text(String::new()), b.clone()),
        (Value::Text(_), Value::Empty) => (a.clone(), Value::Text(String::new())),
        (Value::Empty, Value::Bool(_)) => (Value::Bool(false), b.clone()),
        (Value::Bool(_), Value::Empty) => (a.clone(), Value::Bool(false)),
        _ => (a.clone(), b.clone()),
    };
    if rank(&a) != rank(&b) {
        return Ok(rank(&a).cmp(&rank(&b)));
    }
    Ok(match (&a, &b) {
        (Value::Text(x), Value::Text(y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        _ => {
            let x = round_significant(to_number(&a).unwrap_or(0.0));
            let y = round_significant(to_number(&b).unwrap_or(0.0));
            x.partial_cmp(&y).unwrap_or(Ordering::Equal)
        }
    })
}

/// A value as a hash key for exact lookups (VLOOKUP, MATCH 0, XLOOKUP):
/// text without case, numbers at 15 digits; text "5" and number 5 differ.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key {
    Num(u64),
    Text(String),
    Bool(bool),
    Empty,
}

fn num_key(n: f64) -> Key {
    let r = round_significant(n);
    Key::Num(if r == 0.0 { 0u64 } else { r.to_bits() })
}

fn lookup_key(value: &Value) -> Option<Key> {
    match value {
        Value::Num(n) => Some(num_key(*n)),
        Value::Text(t) => Some(Key::Text(t.to_lowercase())),
        Value::Bool(b) => Some(Key::Bool(*b)),
        Value::Empty => Some(Key::Empty),
        Value::Err(_) => None,
    }
}

/// A cell as COUNTIF/SUMIF see it for an equality criterion: numeric text
/// matches the number.
fn criteria_cell_key(value: &Value) -> Option<Key> {
    match value {
        Value::Text(t) => match text_number(t) {
            Some(n) => Some(num_key(n)),
            None => Some(Key::Text(t.to_lowercase())),
        },
        other => lookup_key(other),
    }
}

#[derive(Clone, Debug)]
enum Criterion {
    /// equality, through the hash index
    Key(Key),
    /// `""` or `"="`: empty cells (and empty text)
    Blank,
    /// `"<>"`: anything not empty
    NotBlank,
    Wild {
        pattern: Vec<char>,
        negate: bool,
    },
    NotKey(Key),
    Cmp(BinOp, Value),
}

fn parse_criterion(value: &Value) -> Result<Criterion, ErrorKind> {
    let text = match value {
        Value::Err(e) => return Err(*e),
        Value::Num(n) => return Ok(Criterion::Key(num_key(*n))),
        Value::Bool(b) => return Ok(Criterion::Key(Key::Bool(*b))),
        Value::Empty => return Ok(Criterion::Key(num_key(0.0))),
        Value::Text(t) => t.as_str(),
    };
    let (op, rest) = if let Some(rest) = text.strip_prefix("<=") {
        (Some(BinOp::Le), rest)
    } else if let Some(rest) = text.strip_prefix(">=") {
        (Some(BinOp::Ge), rest)
    } else if let Some(rest) = text.strip_prefix("<>") {
        (Some(BinOp::Ne), rest)
    } else if let Some(rest) = text.strip_prefix('<') {
        (Some(BinOp::Lt), rest)
    } else if let Some(rest) = text.strip_prefix('>') {
        (Some(BinOp::Gt), rest)
    } else if let Some(rest) = text.strip_prefix('=') {
        (Some(BinOp::Eq), rest)
    } else {
        (None, text)
    };
    let wild = rest.contains(['*', '?', '~']);
    Ok(match op {
        None | Some(BinOp::Eq) => {
            if rest.is_empty() {
                Criterion::Blank
            } else if let Some(n) = text_number(rest) {
                Criterion::Key(num_key(n))
            } else if wild {
                Criterion::Wild {
                    pattern: rest.to_lowercase().chars().collect(),
                    negate: false,
                }
            } else if rest.eq_ignore_ascii_case("TRUE") || rest.eq_ignore_ascii_case("FALSE") {
                Criterion::Key(Key::Bool(rest.eq_ignore_ascii_case("TRUE")))
            } else {
                Criterion::Key(Key::Text(rest.to_lowercase()))
            }
        }
        Some(BinOp::Ne) => {
            if rest.is_empty() {
                Criterion::NotBlank
            } else if let Some(n) = text_number(rest) {
                Criterion::NotKey(num_key(n))
            } else if wild {
                Criterion::Wild {
                    pattern: rest.to_lowercase().chars().collect(),
                    negate: true,
                }
            } else {
                Criterion::NotKey(Key::Text(rest.to_lowercase()))
            }
        }
        Some(op) => match text_number(rest) {
            Some(n) => Criterion::Cmp(op, Value::Num(n)),
            None => Criterion::Cmp(op, Value::Text(rest.to_owned())),
        },
    })
}

fn wild_match(pattern: &[char], text: &[char]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some(('*', rest)) => (0..=text.len()).any(|skip| wild_match(rest, &text[skip..])),
        Some(('?', rest)) => !text.is_empty() && wild_match(rest, &text[1..]),
        Some(('~', rest)) if !rest.is_empty() => {
            text.first() == rest.first() && wild_match(&rest[1..], &text[1..])
        }
        Some((c, rest)) => text.first() == Some(c) && wild_match(rest, &text[1..]),
    }
}

fn criterion_matches(criterion: &Criterion, cell: &Value) -> bool {
    match criterion {
        Criterion::Key(key) => criteria_cell_key(cell).as_ref() == Some(key),
        Criterion::NotKey(key) => criteria_cell_key(cell).as_ref() != Some(key),
        Criterion::Blank => {
            matches!(cell, Value::Empty) || matches!(cell, Value::Text(t) if t.is_empty())
        }
        Criterion::NotBlank => {
            !(matches!(cell, Value::Empty) || matches!(cell, Value::Text(t) if t.is_empty()))
        }
        Criterion::Wild { pattern, negate } => {
            let hit = match cell {
                Value::Text(t) => {
                    wild_match(pattern, &t.to_lowercase().chars().collect::<Vec<_>>())
                }
                _ => false,
            };
            hit != *negate
        }
        Criterion::Cmp(op, operand) => {
            // a comparison matches cells of the operand's own kind only
            let same_kind = match (operand, cell) {
                (Value::Num(_), Value::Num(_)) => true,
                (Value::Num(_), Value::Text(t)) => text_number(t).is_some(),
                (Value::Text(_), Value::Text(_)) => true,
                _ => false,
            };
            if !same_kind {
                return false;
            }
            let cell = match (operand, cell) {
                (Value::Num(_), Value::Text(t)) => Value::Num(text_number(t).unwrap_or(0.0)),
                _ => cell.clone(),
            };
            let Ok(order) = compare(&cell, operand) else {
                return false;
            };
            use std::cmp::Ordering::*;
            match op {
                BinOp::Lt => order == Less,
                BinOp::Le => order != Greater,
                BinOp::Gt => order == Greater,
                BinOp::Ge => order != Less,
                _ => false,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Rounding (decimal, as Excel rounds: 2.675 to two places is 2.68)

#[derive(Clone, Copy)]
enum RoundMode {
    HalfAway,
    Up,
    Down,
}

fn round_decimal(x: f64, places: f64, mode: RoundMode) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return x;
    }
    let places = places.trunc() as i64;
    let text = format!("{:.14e}", x.abs());
    let (mantissa, exponent) = text.split_once('e').unwrap();
    let exponent: i64 = exponent.parse().unwrap();
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    // |x| = digits * 10^(exponent - 14)
    let scale = exponent - 14;
    let shift = scale + places; // digits to drop when negative
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    if shift >= 0 {
        return x;
    }
    let drop = (-shift) as usize;
    let mut kept: u128 = if drop >= digits.len() {
        0
    } else {
        digits[..digits.len() - drop].parse().unwrap_or(0)
    };
    let tail: &str = if drop >= digits.len() {
        &digits
    } else {
        &digits[digits.len() - drop..]
    };
    let tail_nonzero = tail.chars().any(|c| c != '0');
    let leading_digit = if drop > digits.len() {
        0
    } else {
        tail.chars()
            .next()
            .and_then(|c| c.to_digit(10))
            .unwrap_or(0)
    };
    match mode {
        RoundMode::HalfAway => {
            if leading_digit >= 5 {
                kept += 1;
            }
        }
        RoundMode::Up => {
            if tail_nonzero {
                kept += 1;
            }
        }
        RoundMode::Down => {}
    }
    let text = format!("{kept}e{}", -places);
    sign * text.parse::<f64>().unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// Evaluation

/// The columns a formula reads, every row of the base, as the grid shows them.
pub struct Data {
    pub rows: u64,
    pub columns: HashMap<u64, Vec<Value>>,
    /// single cells, for a refresh of a few rows of a row-local formula
    pub cells: HashMap<(u64, u64), Value>,
}

impl Data {
    fn cell(&self, row: u64, col: u64) -> &Value {
        static EMPTY: Value = Value::Empty;
        match self.columns.get(&col) {
            Some(values) => values.get(row as usize).unwrap_or(&EMPTY),
            None => self.cells.get(&(row, col)).unwrap_or(&EMPTY),
        }
    }
}

#[derive(Default)]
struct RunningAgg {
    /// next row to add
    next: u64,
    started: bool,
    sum: f64,
    product: f64,
    numbers: u64,
    non_empty: u64,
    blanks: u64,
    min: Option<f64>,
    max: Option<f64>,
    error: Option<ErrorKind>,
}

#[derive(Default, Clone)]
struct KeyAgg {
    sum: f64,
    count: u64,
    numbers: u64,
    error: Option<ErrorKind>,
}

/// Criteria ranges and an optional value range, as one index over a fixed
/// row span (built once) or a running span (grown with the rows).
struct CriteriaIndex {
    next: u64,
    map: HashMap<Vec<Key>, KeyAgg>,
}

pub struct Evaluator<'a> {
    formula: &'a Formula,
    data: &'a Data,
    /// results of this column so far (rows first_row..), for a running balance
    results: Vec<Value>,
    row: u64,
    cache: HashMap<usize, Value>,
    running: HashMap<usize, RunningAgg>,
    criteria: HashMap<usize, CriteriaIndex>,
    lookups: HashMap<usize, HashMap<Key, u64>>,
    scan_budget: u64,
    failure: Option<FormulaError>,
}

/// Rows of one range on the current row: (first_row, last_row, first_col, last_col).
type Span = (u64, u64, u64, u64);

impl<'a> Evaluator<'a> {
    pub fn new(formula: &'a Formula, data: &'a Data) -> Self {
        Self {
            formula,
            data,
            results: Vec::new(),
            row: 0,
            cache: HashMap::new(),
            running: HashMap::new(),
            criteria: HashMap::new(),
            lookups: HashMap::new(),
            scan_budget: SCAN_BUDGET,
            failure: None,
        }
    }

    /// Every row of the column, top to bottom. `sink` gets each result.
    pub fn run(mut self, mut sink: impl FnMut(u64, &Value)) -> Result<(), FormulaError> {
        // the column's own results are kept only for a formula that reads
        // its rows above (a running balance)
        let keep = self.formula.reads.contains(&self.formula.column);
        for row in self.formula.first_row..=self.formula.last_row {
            let value = self.eval_row(row)?;
            sink(row, &value);
            if keep {
                self.results.push(value);
            }
        }
        Ok(())
    }

    /// One row's result. Rows of a row-local formula may come in any order.
    pub fn eval_row(&mut self, row: u64) -> Result<Value, FormulaError> {
        self.row = row;
        let value = self.eval(&self.formula.root);
        if let Some(failure) = self.failure.take() {
            return Err(failure);
        }
        Ok(match value {
            // a formula that only points at an empty cell shows 0
            Value::Empty => Value::Num(0.0),
            Value::Text(t) if t.chars().count() > MAX_TEXT_CHARS => Value::Err(ErrorKind::Value),
            other => other,
        })
    }

    fn fail(&mut self, code: &'static str, detail: &str) -> Value {
        if self.failure.is_none() {
            self.failure = Some(FormulaError::new(code, detail.to_owned()));
        }
        Value::Err(ErrorKind::Value)
    }

    fn cell(&self, row: u64, col: u64) -> Value {
        let f = self.formula;
        if col == f.column && row >= f.first_row && row <= f.last_row {
            // rows above the current one only (checked at parse)
            return self
                .results
                .get((row - f.first_row) as usize)
                .cloned()
                .unwrap_or(Value::Empty);
        }
        self.data.cell(row, col).clone()
    }

    fn resolve_row(&self, pos: RowPos) -> Option<u64> {
        match pos {
            RowPos::Abs(r) => Some(r),
            RowPos::Rel(offset) => {
                let r = self.row as i64 + offset;
                (r >= 0).then_some(r as u64)
            }
        }
    }

    fn span(&self, range: &RangeRef) -> Option<Span> {
        match range.rows {
            None => Some((
                0,
                self.data.rows.saturating_sub(1),
                range.first_col,
                range.last_col,
            )),
            Some((a, b)) => {
                let a = self.resolve_row(a)?;
                let b = self.resolve_row(b)?;
                Some((a.min(b), a.max(b), range.first_col, range.last_col))
            }
        }
    }

    fn eval(&mut self, node: &Node) -> Value {
        if node.invariant {
            if let Some(value) = self.cache.get(&node.id) {
                return value.clone();
            }
            let value = self.eval_uncached(node);
            self.cache.insert(node.id, value.clone());
            return value;
        }
        self.eval_uncached(node)
    }

    fn eval_uncached(&mut self, node: &Node) -> Value {
        match &node.expr {
            Expr::Lit(v) => v.clone(),
            Expr::Missing => Value::Empty,
            Expr::Cell { col, row } => match self.resolve_row(*row) {
                Some(r) => self.cell(r, *col),
                None => Value::Err(ErrorKind::Ref),
            },
            Expr::Range(range) => {
                // a range where one value is wanted: Excel's implicit
                // intersection with the formula's own row
                let Some((r0, r1, c0, c1)) = self.span(range) else {
                    return Value::Err(ErrorKind::Ref);
                };
                if c0 != c1 {
                    return if r0 == r1 && c0 == c1 {
                        self.cell(r0, c0)
                    } else {
                        Value::Err(ErrorKind::Value)
                    };
                }
                if r0 == r1 {
                    self.cell(r0, c0)
                } else if (r0..=r1).contains(&self.row) {
                    self.cell(self.row, c0)
                } else {
                    Value::Err(ErrorKind::Value)
                }
            }
            Expr::Neg(inner) => match to_number(&self.eval(inner)) {
                Ok(n) => num(-n),
                Err(e) => Value::Err(e),
            },
            Expr::Pct(inner) => match to_number(&self.eval(inner)) {
                Ok(n) => num(n / 100.0),
                Err(e) => Value::Err(e),
            },
            Expr::Bin(op, a, b) => {
                let a = self.eval(a);
                let b = self.eval(b);
                binary(*op, &a, &b)
            }
            Expr::Call(func, args) => self.call(node, *func, args),
        }
    }

    /// The values of a range argument, or of a scalar argument, for the
    /// aggregate functions. `direct` tells whether the value was typed
    /// directly in the argument list (text and logicals count there).
    fn arg_values(&mut self, arg: &Node, out: &mut Vec<(Value, bool)>) -> Result<(), ()> {
        if let Expr::Range(range) = &arg.expr {
            let Some((r0, r1, c0, c1)) = self.span(range) else {
                out.push((Value::Err(ErrorKind::Ref), true));
                return Ok(());
            };
            let cells = (r1 - r0 + 1) * (c1 - c0 + 1);
            if !arg.invariant && cells > DIRECT_RANGE_CELLS {
                return Err(());
            }
            for r in r0..=r1 {
                for c in c0..=c1 {
                    out.push((self.cell(r, c), false));
                }
            }
            return Ok(());
        }
        if let Expr::Cell { .. } = arg.expr {
            let v = self.eval(arg);
            out.push((v, false));
            return Ok(());
        }
        let v = self.eval(arg);
        out.push((v, true));
        Ok(())
    }

    /// A range that starts on a fixed row and ends on the current one (a
    /// running total), with its end row on this evaluation.
    fn running_span(&self, node: &Node) -> Option<(u64, u64, u64, u64)> {
        let Expr::Range(range) = &node.expr else {
            return None;
        };
        let (RowPos::Abs(start), end) = range.rows? else {
            return None;
        };
        let RowPos::Rel(_) = end else { return None };
        let end = self.resolve_row(end)?;
        (end >= start).then_some((start, end, range.first_col, range.last_col))
    }

    fn aggregate(&mut self, node: &Node, func: Func, args: &[Node]) -> Value {
        // one running range: kept incrementally, in a fresh sum's order
        if args.len() == 1
            && !args[0].invariant
            && let Some((start, end, c0, c1)) = self.running_span(&args[0])
            && (end - start + 1) * (c1 - c0 + 1) > DIRECT_RANGE_CELLS
        {
            let mut state = self.running.remove(&node.id).unwrap_or_default();
            if !state.started {
                state.started = true;
                state.next = start;
                state.product = 1.0;
            }
            while state.next <= end {
                for c in c0..=c1 {
                    let v = self.cell(state.next, c);
                    match v {
                        Value::Num(n) => {
                            state.sum += n;
                            state.product *= n;
                            state.numbers += 1;
                            state.non_empty += 1;
                            state.min = Some(state.min.map_or(n, |m| m.min(n)));
                            state.max = Some(state.max.map_or(n, |m| m.max(n)));
                        }
                        Value::Empty => state.blanks += 1,
                        Value::Text(ref t) => {
                            state.non_empty += 1;
                            if t.is_empty() {
                                state.blanks += 1;
                            }
                        }
                        Value::Bool(_) => state.non_empty += 1,
                        Value::Err(e) => {
                            state.non_empty += 1;
                            state.error.get_or_insert(e);
                        }
                    }
                }
                state.next += 1;
            }
            let result = finish_aggregate(
                func,
                state.error,
                state.sum,
                state.product,
                state.numbers,
                state.non_empty,
                state.blanks,
                state.min,
                state.max,
            );
            self.running.insert(node.id, state);
            return result;
        }
        let mut values = Vec::new();
        for arg in args {
            if self.arg_values(arg, &mut values).is_err() {
                return self.fail("UNSUPPORTED_RANGE", "moving range");
            }
        }
        let (mut sum, mut product, mut numbers, mut non_empty, mut blanks) =
            (0.0, 1.0, 0u64, 0u64, 0u64);
        let (mut min, mut max): (Option<f64>, Option<f64>) = (None, None);
        let mut error = None;
        let counting = matches!(func, Func::Count | Func::CountA | Func::CountBlank);
        for (value, direct) in values {
            // values typed in the argument list are coerced; cells of a
            // reference that are text or logical are skipped (Excel's rule)
            let number = match &value {
                Value::Num(n) => Some(*n),
                Value::Empty => {
                    if !direct {
                        blanks += 1;
                    }
                    continue;
                }
                Value::Err(e) => {
                    non_empty += 1;
                    if !counting {
                        error.get_or_insert(*e);
                    }
                    continue;
                }
                Value::Bool(b) => {
                    non_empty += 1;
                    if direct {
                        Some(if *b { 1.0 } else { 0.0 })
                    } else {
                        continue;
                    }
                }
                Value::Text(t) => {
                    non_empty += 1;
                    if !direct {
                        if t.is_empty() {
                            blanks += 1;
                        }
                        continue;
                    }
                    match text_number(t) {
                        Some(n) => Some(n),
                        None => {
                            if !counting {
                                error.get_or_insert(ErrorKind::Value);
                            }
                            continue;
                        }
                    }
                }
            };
            if let Some(n) = number {
                if matches!(value, Value::Num(_)) {
                    non_empty += 1;
                }
                sum += n;
                product *= n;
                numbers += 1;
                min = Some(min.map_or(n, |m: f64| m.min(n)));
                max = Some(max.map_or(n, |m: f64| m.max(n)));
            }
        }
        finish_aggregate(
            func, error, sum, product, numbers, non_empty, blanks, min, max,
        )
    }

    fn call(&mut self, node: &Node, func: Func, args: &[Node]) -> Value {
        use Func::*;
        match func {
            Sum | Average | Min | Max | Count | CountA | CountBlank | Product => {
                self.aggregate(node, func, args)
            }
            If => {
                let condition = self.eval(&args[0]);
                match to_bool(&condition) {
                    Err(e) => Value::Err(e),
                    Ok(true) => self.eval(&args[1]),
                    Ok(false) => match args.get(2) {
                        Some(arg) => self.eval(arg),
                        None => Value::Bool(false),
                    },
                }
            }
            IfError => match self.eval(&args[0]) {
                Value::Err(_) => self.eval(&args[1]),
                v => v,
            },
            IfNa => match self.eval(&args[0]) {
                Value::Err(ErrorKind::Na) => self.eval(&args[1]),
                v => v,
            },
            And | Or => {
                let mut values = Vec::new();
                for arg in args {
                    if self.arg_values(arg, &mut values).is_err() {
                        return self.fail("UNSUPPORTED_RANGE", "moving range");
                    }
                }
                let mut seen = false;
                let mut acc = func == And;
                for (value, direct) in values {
                    let b = match (&value, direct) {
                        (Value::Err(e), _) => return Value::Err(*e),
                        (Value::Text(_), false) | (Value::Empty, false) => continue,
                        (Value::Empty, true) => false,
                        (v, _) => match to_bool(v) {
                            Ok(b) => b,
                            Err(e) => return Value::Err(e),
                        },
                    };
                    seen = true;
                    acc = if func == And { acc && b } else { acc || b };
                }
                if seen {
                    Value::Bool(acc)
                } else {
                    Value::Err(ErrorKind::Value)
                }
            }
            Not => match to_bool(&self.eval(&args[0])) {
                Ok(b) => Value::Bool(!b),
                Err(e) => Value::Err(e),
            },
            Round | RoundUp | RoundDown => {
                let x = to_number(&self.eval(&args[0]));
                let places = to_number(&self.eval(&args[1]));
                match (x, places) {
                    (Err(e), _) | (_, Err(e)) => Value::Err(e),
                    (Ok(x), Ok(p)) => {
                        let mode = match func {
                            Round => RoundMode::HalfAway,
                            RoundUp => RoundMode::Up,
                            _ => RoundMode::Down,
                        };
                        num(round_decimal(x, p, mode))
                    }
                }
            }
            Trunc => {
                let x = to_number(&self.eval(&args[0]));
                let places = match args.get(1) {
                    Some(a) => to_number(&self.eval(a)),
                    None => Ok(0.0),
                };
                match (x, places) {
                    (Err(e), _) | (_, Err(e)) => Value::Err(e),
                    (Ok(x), Ok(p)) => num(round_decimal(x, p, RoundMode::Down)),
                }
            }
            Int | Abs | Sqrt | Sign => match to_number(&self.eval(&args[0])) {
                Err(e) => Value::Err(e),
                Ok(x) => match func {
                    Int => num(x.floor()),
                    Abs => num(x.abs()),
                    Sign => num(if x > 0.0 {
                        1.0
                    } else if x < 0.0 {
                        -1.0
                    } else {
                        0.0
                    }),
                    _ => {
                        if x < 0.0 {
                            Value::Err(ErrorKind::Num)
                        } else {
                            num(x.sqrt())
                        }
                    }
                },
            },
            Mod => {
                let a = to_number(&self.eval(&args[0]));
                let b = to_number(&self.eval(&args[1]));
                match (a, b) {
                    (Err(e), _) | (_, Err(e)) => Value::Err(e),
                    (Ok(_), Ok(0.0)) => Value::Err(ErrorKind::Div0),
                    (Ok(n), Ok(d)) => num(n - d * (n / d).floor()),
                }
            }
            Power => {
                let a = self.eval(&args[0]);
                let b = self.eval(&args[1]);
                binary(BinOp::Pow, &a, &b)
            }
            SumIf | CountIf | AverageIf | SumIfs | CountIfs | AverageIfs => {
                self.conditional(node, func, args)
            }
            VLookup | XLookup | Match => self.lookup(node, func, args),
            Index => self.index(args),
            Len | Upper | Lower | Trim => match to_text(&self.eval(&args[0])) {
                Err(e) => Value::Err(e),
                Ok(t) => match func {
                    Len => Value::Num(t.chars().count() as f64),
                    Upper => Value::Text(t.to_uppercase()),
                    Lower => Value::Text(t.to_lowercase()),
                    _ => Value::Text(
                        t.split(' ')
                            .filter(|p| !p.is_empty())
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                },
            },
            Left | Right => {
                let text = to_text(&self.eval(&args[0]));
                let count = match args.get(1) {
                    Some(a) => to_number(&self.eval(a)),
                    None => Ok(1.0),
                };
                match (text, count) {
                    (Err(e), _) | (_, Err(e)) => Value::Err(e),
                    (Ok(_), Ok(n)) if n < 0.0 => Value::Err(ErrorKind::Value),
                    (Ok(t), Ok(n)) => {
                        let chars: Vec<char> = t.chars().collect();
                        let n = (n.trunc() as usize).min(chars.len());
                        let slice = if func == Left {
                            &chars[..n]
                        } else {
                            &chars[chars.len() - n..]
                        };
                        Value::Text(slice.iter().collect())
                    }
                }
            }
            Mid => {
                let text = to_text(&self.eval(&args[0]));
                let start = to_number(&self.eval(&args[1]));
                let count = to_number(&self.eval(&args[2]));
                match (text, start, count) {
                    (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => Value::Err(e),
                    (Ok(t), Ok(s), Ok(n)) => {
                        if s < 1.0 || n < 0.0 {
                            return Value::Err(ErrorKind::Value);
                        }
                        let chars: Vec<char> = t.chars().collect();
                        let s = (s.trunc() as usize - 1).min(chars.len());
                        let e = (s + n.trunc() as usize).min(chars.len());
                        Value::Text(chars[s..e].iter().collect())
                    }
                }
            }
            Concatenate | Concat => {
                let mut out = String::new();
                for arg in args {
                    if func == Concat {
                        let mut values = Vec::new();
                        if self.arg_values(arg, &mut values).is_err() {
                            return self.fail("UNSUPPORTED_RANGE", "moving range");
                        }
                        for (value, _) in values {
                            match to_text(&value) {
                                Ok(t) => out.push_str(&t),
                                Err(e) => return Value::Err(e),
                            }
                        }
                    } else {
                        match to_text(&self.eval(arg)) {
                            Ok(t) => out.push_str(&t),
                            Err(e) => return Value::Err(e),
                        }
                    }
                }
                Value::Text(out)
            }
            Substitute => {
                let mut parts = Vec::new();
                for arg in &args[..3] {
                    match to_text(&self.eval(arg)) {
                        Ok(t) => parts.push(t),
                        Err(e) => return Value::Err(e),
                    }
                }
                let (text, old, new) = (&parts[0], &parts[1], &parts[2]);
                if old.is_empty() {
                    return Value::Text(text.clone());
                }
                match args.get(3) {
                    None => Value::Text(text.replace(old.as_str(), new)),
                    Some(arg) => match to_number(&self.eval(arg)) {
                        Err(e) => Value::Err(e),
                        Ok(n) if n < 1.0 => Value::Err(ErrorKind::Value),
                        Ok(n) => {
                            let which = n.trunc() as usize;
                            match text.match_indices(old.as_str()).nth(which - 1) {
                                None => Value::Text(text.clone()),
                                Some((at, _)) => Value::Text(format!(
                                    "{}{}{}",
                                    &text[..at],
                                    new,
                                    &text[at + old.len()..]
                                )),
                            }
                        }
                    },
                }
            }
            Replace => {
                let text = to_text(&self.eval(&args[0]));
                let start = to_number(&self.eval(&args[1]));
                let count = to_number(&self.eval(&args[2]));
                let new = to_text(&self.eval(&args[3]));
                match (text, start, count, new) {
                    (Err(e), ..) | (_, Err(e), ..) | (_, _, Err(e), _) | (.., Err(e)) => {
                        Value::Err(e)
                    }
                    (Ok(t), Ok(s), Ok(n), Ok(new)) => {
                        if s < 1.0 || n < 0.0 {
                            return Value::Err(ErrorKind::Value);
                        }
                        let chars: Vec<char> = t.chars().collect();
                        let s = (s.trunc() as usize - 1).min(chars.len());
                        let e = (s + n.trunc() as usize).min(chars.len());
                        let mut out: String = chars[..s].iter().collect();
                        out.push_str(&new);
                        out.extend(chars[e..].iter());
                        Value::Text(out)
                    }
                }
            }
            Rept => {
                let text = to_text(&self.eval(&args[0]));
                let count = to_number(&self.eval(&args[1]));
                match (text, count) {
                    (Err(e), _) | (_, Err(e)) => Value::Err(e),
                    (Ok(_), Ok(n)) if n < 0.0 => Value::Err(ErrorKind::Value),
                    (Ok(t), Ok(n)) => {
                        let n = n.trunc() as usize;
                        if t.chars().count().saturating_mul(n) > MAX_TEXT_CHARS {
                            Value::Err(ErrorKind::Value)
                        } else {
                            Value::Text(t.repeat(n))
                        }
                    }
                }
            }
            Exact => {
                let a = to_text(&self.eval(&args[0]));
                let b = to_text(&self.eval(&args[1]));
                match (a, b) {
                    (Err(e), _) | (_, Err(e)) => Value::Err(e),
                    (Ok(a), Ok(b)) => Value::Bool(a == b),
                }
            }
            Find | Search => {
                let needle = to_text(&self.eval(&args[0]));
                let hay = to_text(&self.eval(&args[1]));
                let start = match args.get(2) {
                    Some(a) => to_number(&self.eval(a)),
                    None => Ok(1.0),
                };
                match (needle, hay, start) {
                    (Err(e), ..) | (_, Err(e), _) | (.., Err(e)) => Value::Err(e),
                    (Ok(needle), Ok(hay), Ok(start)) => {
                        let hay_chars: Vec<char> = hay.chars().collect();
                        if start < 1.0 || start.trunc() as usize > hay_chars.len() + 1 {
                            return Value::Err(ErrorKind::Value);
                        }
                        let from = start.trunc() as usize - 1;
                        let (needle, hay_chars): (Vec<char>, Vec<char>) = if func == Search {
                            (
                                needle.to_lowercase().chars().collect(),
                                hay_chars
                                    .iter()
                                    .collect::<String>()
                                    .to_lowercase()
                                    .chars()
                                    .collect(),
                            )
                        } else {
                            (needle.chars().collect(), hay_chars)
                        };
                        if func == Search && needle.iter().any(|c| matches!(c, '*' | '?' | '~')) {
                            for at in from..=hay_chars.len() {
                                for end in at..=hay_chars.len() {
                                    if wild_match(&needle, &hay_chars[at..end]) {
                                        return Value::Num((at + 1) as f64);
                                    }
                                }
                            }
                            return Value::Err(ErrorKind::Value);
                        }
                        if needle.is_empty() {
                            return Value::Num((from + 1) as f64);
                        }
                        (from..hay_chars.len())
                            .find(|&at| hay_chars[at..].starts_with(&needle))
                            .map_or(Value::Err(ErrorKind::Value), |at| {
                                Value::Num((at + 1) as f64)
                            })
                    }
                }
            }
            ValueFn => match self.eval(&args[0]) {
                Value::Err(e) => Value::Err(e),
                Value::Num(n) => Value::Num(n),
                Value::Empty => Value::Num(0.0),
                Value::Bool(_) => Value::Err(ErrorKind::Value),
                Value::Text(t) => match text_number(&t) {
                    Some(n) => Value::Num(n),
                    None => Value::Err(ErrorKind::Value),
                },
            },
            IsBlank | IsNumber | IsText | IsError | IsErr | IsNa | IsLogical => {
                let v = self.eval(&args[0]);
                Value::Bool(match func {
                    IsBlank => matches!(v, Value::Empty),
                    IsNumber => matches!(v, Value::Num(_)),
                    IsText => matches!(v, Value::Text(_)),
                    IsError => matches!(v, Value::Err(_)),
                    IsErr => matches!(v, Value::Err(e) if e != ErrorKind::Na),
                    IsNa => matches!(v, Value::Err(ErrorKind::Na)),
                    _ => matches!(v, Value::Bool(_)),
                })
            }
            TrueFn => Value::Bool(true),
            FalseFn => Value::Bool(false),
            Na => Value::Err(ErrorKind::Na),
        }
    }

    /// SUMIF/COUNTIF/AVERAGEIF and their *IFS forms. Equality criteria go
    /// through one hash index over the ranges (fixed or running); other
    /// criteria scan the rows, within a budget.
    fn conditional(&mut self, node: &Node, func: Func, args: &[Node]) -> Value {
        use Func::*;
        // (criteria range, criterion) pairs and the value range
        let (pairs, value_range): (Vec<(&Node, &Node)>, Option<&Node>) = match func {
            SumIf | AverageIf => (
                vec![(&args[0], &args[1])],
                Some(args.get(2).unwrap_or(&args[0])),
            ),
            CountIf => (vec![(&args[0], &args[1])], None),
            SumIfs | AverageIfs => {
                if args.len().is_multiple_of(2) {
                    return Value::Err(ErrorKind::Value);
                }
                (
                    args[1..].chunks(2).map(|p| (&p[0], &p[1])).collect(),
                    Some(&args[0]),
                )
            }
            _ => {
                if args.len() % 2 == 1 {
                    return Value::Err(ErrorKind::Value);
                }
                (args.chunks(2).map(|p| (&p[0], &p[1])).collect(), None)
            }
        };
        let range_of = |n: &Node| match &n.expr {
            Expr::Range(r) => Some(*r),
            Expr::Cell { col, row } => Some(RangeRef {
                first_col: *col,
                last_col: *col,
                rows: Some((*row, *row)),
            }),
            _ => None,
        };
        let mut ranges = Vec::new();
        for (range_node, _) in &pairs {
            match range_of(range_node) {
                Some(r) if r.first_col == r.last_col => ranges.push(r),
                _ => return self.fail("UNSUPPORTED_RANGE", "criteria range"),
            }
        }
        let value_ref = match value_range.map(range_of) {
            None => None,
            Some(Some(r)) if r.first_col == r.last_col => Some(r),
            Some(_) => return self.fail("UNSUPPORTED_RANGE", "value range"),
        };
        let mut criteria = Vec::new();
        for (_, criterion) in &pairs {
            match parse_criterion(&self.eval(criterion)) {
                Ok(c) => criteria.push(c),
                Err(e) => return Value::Err(e),
            }
        }
        // spans on this row; every range must cover the same number of rows
        let mut spans = Vec::new();
        for r in &ranges {
            match self.span(r) {
                Some(s) => spans.push(s),
                None => return Value::Err(ErrorKind::Ref),
            }
        }
        let value_span = match &value_ref {
            Some(r) => match self.span(r) {
                // Excel sizes the value range like the first criteria range
                Some((r0, _, c, _)) => Some((r0, c)),
                None => return Value::Err(ErrorKind::Ref),
            },
            None => None,
        };
        let height = spans[0].1 - spans[0].0;
        if spans.iter().any(|s| s.1 - s.0 != height) {
            return Value::Err(ErrorKind::Value);
        }
        let all_fixed = ranges.iter().chain(value_ref.iter()).all(|r| {
            r.rows
                .is_none_or(|(a, b)| matches!((a, b), (RowPos::Abs(_), RowPos::Abs(_))))
        });
        let all_running = ranges.iter().chain(value_ref.iter()).all(|r| {
            matches!(r.rows, Some((RowPos::Abs(_), RowPos::Rel(o))) if o == match ranges[0].rows {
                Some((_, RowPos::Rel(o0))) => o0,
                _ => i64::MIN,
            })
        });
        let keys: Option<Vec<Key>> = criteria
            .iter()
            .map(|c| match c {
                Criterion::Key(k) => Some(k.clone()),
                _ => None,
            })
            .collect();
        let finish = |agg: &KeyAgg| -> Value {
            if let Some(e) = agg.error {
                return Value::Err(e);
            }
            match func {
                CountIf | CountIfs => Value::Num(agg.count as f64),
                SumIf | SumIfs => num(agg.sum),
                _ => {
                    if agg.numbers == 0 {
                        Value::Err(ErrorKind::Div0)
                    } else {
                        num(agg.sum / agg.numbers as f64)
                    }
                }
            }
        };
        if let Some(keys) = keys
            .as_ref()
            .filter(|_| (all_fixed || all_running) && height > 0)
        {
            // index rows offsets 0..=height of the spans, built once (fixed)
            // or advanced with the row (running)
            let base_rows: Vec<u64> = spans.iter().map(|s| s.0).collect();
            let value_base = value_span;
            let mut index = self.criteria.remove(&node.id).unwrap_or(CriteriaIndex {
                next: 0,
                map: HashMap::new(),
            });
            while index.next <= height {
                let offset = index.next;
                let mut key = Vec::with_capacity(spans.len());
                let mut usable = true;
                for (i, s) in spans.iter().enumerate() {
                    match criteria_cell_key(&self.cell(base_rows[i] + offset, s.2)) {
                        Some(k) => key.push(k),
                        None => {
                            usable = false;
                            break;
                        }
                    }
                }
                if usable {
                    let entry = index.map.entry(key).or_default();
                    entry.count += 1;
                    if let Some((r0, c)) = value_base {
                        match self.cell(r0 + offset, c) {
                            Value::Num(n) => {
                                entry.sum += n;
                                entry.numbers += 1;
                            }
                            Value::Err(e) => {
                                entry.error.get_or_insert(e);
                            }
                            _ => {}
                        }
                    }
                }
                index.next += 1;
            }
            let result = index
                .map
                .get(keys)
                .map_or_else(|| finish(&KeyAgg::default()), finish);
            self.criteria.insert(node.id, index);
            return result;
        }
        // the slow path: every row of the spans, every row of the column
        let cells = (height + 1) * spans.len() as u64;
        if !(all_fixed || all_running || cells <= DIRECT_RANGE_CELLS) {
            return self.fail("UNSUPPORTED_RANGE", "moving criteria range");
        }
        if cells > self.scan_budget {
            return self.fail("UNSUPPORTED_RANGE", "criteria too slow");
        }
        self.scan_budget -= cells;
        let mut agg = KeyAgg::default();
        for offset in 0..=height {
            let hit = spans
                .iter()
                .zip(&criteria)
                .all(|(s, c)| criterion_matches(c, &self.cell(s.0 + offset, s.2)));
            if !hit {
                continue;
            }
            agg.count += 1;
            if let Some((r0, c)) = value_span {
                match self.cell(r0 + offset, c) {
                    Value::Num(n) => {
                        agg.sum += n;
                        agg.numbers += 1;
                    }
                    Value::Err(e) => {
                        agg.error.get_or_insert(e);
                    }
                    _ => {}
                }
            }
        }
        finish(&agg)
    }

    /// Exact VLOOKUP/XLOOKUP/MATCH through a hash of the lookup column
    /// (first match from the top, or from the bottom for XLOOKUP -1).
    fn lookup(&mut self, node: &Node, func: Func, args: &[Node]) -> Value {
        let key_value = self.eval(&args[0]);
        let Some(key) = lookup_key(&key_value) else {
            return key_value;
        };
        let range = match &args[1].expr {
            Expr::Range(r) if args[1].invariant => *r,
            _ => return self.fail("UNSUPPORTED_RANGE", "lookup range"),
        };
        let Some((r0, r1, c0, c1)) = self.span(&range) else {
            return Value::Err(ErrorKind::Ref);
        };
        let from_bottom = func == Func::XLookup
            && matches!(args.get(5).map(|a| &a.expr), Some(Expr::Lit(Value::Num(n))) if *n == -1.0);
        let vertical = func != Func::Match || c0 == c1;
        if func == Func::Match && c0 != c1 && r0 != r1 {
            return Value::Err(ErrorKind::Na);
        }
        if !self.lookups.contains_key(&node.id) {
            let mut map = HashMap::new();
            if vertical {
                for r in r0..=r1 {
                    if let Some(k) = lookup_key(&self.cell(r, c0)) {
                        if from_bottom {
                            map.insert(k, r - r0);
                        } else {
                            map.entry(k).or_insert(r - r0);
                        }
                    }
                }
            } else {
                for c in c0..=c1 {
                    if let Some(k) = lookup_key(&self.cell(r0, c)) {
                        map.entry(k).or_insert(c - c0);
                    }
                }
            }
            self.lookups.insert(node.id, map);
        }
        // an empty key finds nothing (Excel looks for 0 / "" and rarely hits)
        let found = if key == Key::Empty {
            None
        } else {
            self.lookups[&node.id].get(&key).copied()
        };
        match func {
            Func::Match => match found {
                Some(offset) => Value::Num((offset + 1) as f64),
                None => Value::Err(ErrorKind::Na),
            },
            Func::VLookup => {
                let column = match to_number(&self.eval(&args[2])) {
                    Ok(n) => n.trunc(),
                    Err(e) => return Value::Err(e),
                };
                if column < 1.0 {
                    return Value::Err(ErrorKind::Value);
                }
                if column as u64 > c1 - c0 + 1 {
                    return Value::Err(ErrorKind::Ref);
                }
                match found {
                    Some(offset) => {
                        let v = self.cell(r0 + offset, c0 + column as u64 - 1);
                        if matches!(v, Value::Empty) {
                            Value::Num(0.0)
                        } else {
                            v
                        }
                    }
                    None => Value::Err(ErrorKind::Na),
                }
            }
            _ => {
                let returns = match &args[2].expr {
                    Expr::Range(r) if args[2].invariant => *r,
                    _ => return self.fail("UNSUPPORTED_RANGE", "return range"),
                };
                let Some((q0, q1, d0, _)) = self.span(&returns) else {
                    return Value::Err(ErrorKind::Ref);
                };
                if q1 - q0 != r1 - r0 {
                    return Value::Err(ErrorKind::Value);
                }
                match found {
                    Some(offset) => {
                        let v = self.cell(q0 + offset, d0);
                        if matches!(v, Value::Empty) {
                            Value::Num(0.0)
                        } else {
                            v
                        }
                    }
                    None => match args.get(3) {
                        Some(arg) if !matches!(arg.expr, Expr::Missing) => self.eval(arg),
                        _ => Value::Err(ErrorKind::Na),
                    },
                }
            }
        }
    }

    fn index(&mut self, args: &[Node]) -> Value {
        let range = match &args[0].expr {
            Expr::Range(r) => *r,
            _ => return self.fail("UNSUPPORTED_RANGE", "INDEX range"),
        };
        let Some((r0, r1, c0, c1)) = self.span(&range) else {
            return Value::Err(ErrorKind::Ref);
        };
        let row = match to_number(&self.eval(&args[1])) {
            Ok(n) => n.trunc(),
            Err(e) => return Value::Err(e),
        };
        let col = match args.get(2) {
            Some(a) => match to_number(&self.eval(a)) {
                Ok(n) => n.trunc(),
                Err(e) => return Value::Err(e),
            },
            None => 0.0,
        };
        let height = r1 - r0 + 1;
        let width = c1 - c0 + 1;
        // INDEX(column, n) and INDEX(row, n) pick along the one dimension
        let (row, col) = if args.len() == 2 && height == 1 && width > 1 {
            (1.0, row)
        } else {
            (row, if col == 0.0 && width == 1 { 1.0 } else { col })
        };
        if row < 1.0 || col < 1.0 || row as u64 > height || col as u64 > width {
            return Value::Err(ErrorKind::Ref);
        }
        let v = self.cell(r0 + row as u64 - 1, c0 + col as u64 - 1);
        if matches!(v, Value::Empty) {
            Value::Num(0.0)
        } else {
            v
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_aggregate(
    func: Func,
    error: Option<ErrorKind>,
    sum: f64,
    product: f64,
    numbers: u64,
    non_empty: u64,
    blanks: u64,
    min: Option<f64>,
    max: Option<f64>,
) -> Value {
    match func {
        Func::Count => return Value::Num(numbers as f64),
        Func::CountA => return Value::Num(non_empty as f64),
        Func::CountBlank => return Value::Num(blanks as f64),
        _ => {}
    }
    if let Some(e) = error {
        return Value::Err(e);
    }
    match func {
        Func::Sum => num(sum),
        Func::Product => num(if numbers == 0 { 0.0 } else { product }),
        Func::Average => {
            if numbers == 0 {
                Value::Err(ErrorKind::Div0)
            } else {
                num(sum / numbers as f64)
            }
        }
        Func::Min => num(min.unwrap_or(0.0)),
        _ => num(max.unwrap_or(0.0)),
    }
}

fn binary(op: BinOp, a: &Value, b: &Value) -> Value {
    use std::cmp::Ordering::*;
    match op {
        BinOp::Concat => match (to_text(a), to_text(b)) {
            (Err(e), _) | (_, Err(e)) => Value::Err(e),
            (Ok(x), Ok(y)) => Value::Text(x + &y),
        },
        BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
            match compare(a, b) {
                Err(e) => Value::Err(e),
                Ok(order) => Value::Bool(match op {
                    BinOp::Eq => order == Equal,
                    BinOp::Ne => order != Equal,
                    BinOp::Lt => order == Less,
                    BinOp::Le => order != Greater,
                    BinOp::Gt => order == Greater,
                    _ => order != Less,
                }),
            }
        }
        _ => {
            let (x, y) = match (to_number(a), to_number(b)) {
                (Err(e), _) | (_, Err(e)) => return Value::Err(e),
                (Ok(x), Ok(y)) => (x, y),
            };
            match op {
                BinOp::Add => num(x + y),
                BinOp::Sub => num(x - y),
                BinOp::Mul => num(x * y),
                BinOp::Div => {
                    if y == 0.0 {
                        Value::Err(ErrorKind::Div0)
                    } else {
                        num(x / y)
                    }
                }
                _ => {
                    if x == 0.0 && y < 0.0 {
                        Value::Err(ErrorKind::Div0)
                    } else if x == 0.0 && y == 0.0 {
                        Value::Err(ErrorKind::Num)
                    } else {
                        num(x.powf(y))
                    }
                }
            }
        }
    }
}

/// A result as the base stores it: in the file's convention, with Excel's 15
/// significant digits (what Excel shows and writes to CSV).
pub fn stored_text(value: &Value, mark: char) -> Option<String> {
    match value {
        Value::Empty => None,
        Value::Num(n) => {
            let text = excel_digits(*n);
            Some(if mark == ',' {
                text.replace('.', ",")
            } else {
                text
            })
        }
        Value::Text(t) if t.is_empty() => None,
        Value::Text(t) => Some(t.clone()),
        Value::Bool(b) => Some(if *b { "TRUE" } else { "FALSE" }.to_owned()),
        Value::Err(e) => Some(e.text().to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(columns: &[(u64, Vec<Value>)]) -> Data {
        let rows = columns
            .iter()
            .map(|(_, v)| v.len() as u64)
            .max()
            .unwrap_or(0);
        Data {
            rows,
            columns: columns.iter().cloned().collect(),
            cells: HashMap::new(),
        }
    }

    fn run(text: &str, column: u64, data: &Data) -> Result<Vec<Value>, FormulaError> {
        let formula = Formula::parse(text, 1, column, 1, data.rows - 1, "Sheet1")?;
        let mut out = Vec::new();
        Evaluator::new(&formula, data).run(|_, v| out.push(v.clone()))?;
        Ok(out)
    }

    fn n(x: f64) -> Value {
        Value::Num(x)
    }
    fn t(x: &str) -> Value {
        Value::Text(x.to_owned())
    }

    #[test]
    fn arithmetic_and_errors() {
        let d = data(&[
            (
                0,
                vec![t("q"), n(2.0), n(3.0), Value::Empty, t("x"), n(0.0)],
            ),
            (1, vec![t("p"), n(1.5), n(0.1), n(4.0), n(1.0), n(5.0)]),
        ]);
        let out = run("=A2*B2", 3, &d).unwrap();
        assert_eq!(
            out,
            vec![
                n(3.0),
                n(3.0 * 0.1),
                n(0.0),
                Value::Err(ErrorKind::Value),
                n(0.0)
            ]
        );
        let out = run("=B2/A2", 3, &d).unwrap();
        assert_eq!(out[2], Value::Err(ErrorKind::Div0));
        assert_eq!(out[4], Value::Err(ErrorKind::Div0));
        let out = run("=IFERROR(B2/A2,\"-\")", 3, &d).unwrap();
        assert_eq!(out[2], t("-"));
        assert_eq!(run("=-2^2", 3, &d).unwrap()[0], n(4.0));
        assert_eq!(run("=2^3^2", 3, &d).unwrap()[0], n(64.0));
        assert_eq!(run("=50%", 3, &d).unwrap()[0], n(0.5));
        assert_eq!(run("=0.1+0.2=0.3", 3, &d).unwrap()[0], Value::Bool(true));
        assert_eq!(run("=A2&\"-\"&B2", 3, &d).unwrap()[1], t("3-0.1"));
        assert_eq!(run("=\"a\"=\"A\"", 3, &d).unwrap()[0], Value::Bool(true));
        assert_eq!(run("=A2", 3, &d).unwrap()[2], n(0.0));
    }

    #[test]
    fn if_and_text() {
        let d = data(&[(0, vec![t("h"), n(5.0), n(-1.0), t("  ab  cd ")])]);
        let out = run("=IF(A2>0,\"pos\",\"neg\")", 1, &d).unwrap();
        assert_eq!(out[0], t("pos"));
        assert_eq!(out[1], t("neg"));
        // text ranks above every number in Excel's comparison
        assert_eq!(out[2], t("pos"));
        let out = run("=TRIM(A2)", 1, &d).unwrap();
        assert_eq!(out[2], t("ab cd"));
        assert_eq!(run("=LEN(A2)", 1, &d).unwrap()[1], n(2.0));
        assert_eq!(
            run("=LEFT(\"abc\",2)&MID(\"abcdef\",3,2)&RIGHT(\"xyz\")", 1, &d).unwrap()[0],
            t("abcdz")
        );
        assert_eq!(run("=IF(A2>0,1)", 1, &d).unwrap()[1], Value::Bool(false));
    }

    #[test]
    fn running_totals_and_groups() {
        let values: Vec<Value> = std::iter::once(t("v"))
            .chain((1..=1000).map(|i| n(i as f64 * 0.1)))
            .collect();
        let keys: Vec<Value> = std::iter::once(t("k"))
            .chain((1..=1000).map(|i| t(if i % 3 == 0 { "A" } else { "b" })))
            .collect();
        let d = data(&[(0, keys.clone()), (1, values.clone())]);
        let out = run("=SUM($B$2:B2)", 2, &d).unwrap();
        let mut acc = 0.0;
        for (i, v) in out.iter().enumerate() {
            acc += (i + 1) as f64 * 0.1;
            assert_eq!(*v, n(acc));
        }
        let out = run("=SUMIF($A$2:A2,A2,$B$2:B2)", 2, &d).unwrap();
        let (mut a, mut b) = (0.0, 0.0);
        for (i, v) in out.iter().enumerate() {
            let x = (i + 1) as f64 * 0.1;
            if (i + 1) % 3 == 0 {
                a += x;
                assert_eq!(*v, n(a));
            } else {
                b += x;
                assert_eq!(*v, n(b));
            }
        }
        let out = run("=COUNTIF(A:A,A2)", 2, &d).unwrap();
        assert_eq!(out[2], n(333.0));
        assert_eq!(out[0], n(667.0));
        let out = run("=SUMIF(A:A,\"a\",B:B)", 2, &d).unwrap();
        let total_a: f64 = (1..=1000)
            .filter(|i| i % 3 == 0)
            .map(|i| i as f64 * 0.1)
            .sum();
        assert_eq!(out[5], n(total_a));
        let out = run("=B2/SUM(B:B)", 2, &d).unwrap();
        let total: f64 = (1..=1000).map(|i| i as f64 * 0.1).sum();
        assert_eq!(out[0], n(0.1 / total));
        let out = run("=COUNTIFS(A:A,A2,B:B,\">50\")", 2, &d).unwrap();
        assert_eq!(
            out[2],
            n((501..=1000).filter(|i| i % 3 == 0).count() as f64)
        );
        // previous row of its own column: a running balance
        let out = run("=IF(ISNUMBER(C1),C1,0)+B2", 2, &d).unwrap();
        assert_eq!(out[999], n((1..=1000).fold(0.0, |s, i| s + i as f64 * 0.1)));
    }

    #[test]
    fn lookups() {
        let d = data(&[
            (0, vec![t("code"), t("P1"), t("p2"), t("P9"), n(7.0)]),
            (5, vec![t("id"), t("P2"), t("P1"), n(7.0), Value::Empty]),
            (
                6,
                vec![t("name"), t("two"), t("one"), t("seven"), Value::Empty],
            ),
        ]);
        let out = run("=VLOOKUP(A2,$F$2:$G$5,2,FALSE)", 2, &d).unwrap();
        assert_eq!(
            out,
            vec![t("one"), t("two"), Value::Err(ErrorKind::Na), t("seven")]
        );
        let out = run("=XLOOKUP(A2,F:F,G:G,\"none\")", 2, &d).unwrap();
        assert_eq!(out[2], t("none"));
        assert_eq!(out[0], t("one"));
        let out = run("=MATCH(A2,$F$2:$F$5,0)", 2, &d).unwrap();
        assert_eq!(out[1], n(1.0));
        assert_eq!(run("=INDEX($G$2:$G$5,2)", 2, &d).unwrap()[0], t("one"));
        let err = Formula::parse("=VLOOKUP(A2,F:G,2)", 1, 2, 1, 4, "S").unwrap_err();
        assert_eq!(err.code, "APPROXIMATE_LOOKUP");
    }

    #[test]
    fn refused_up_front() {
        let parse = |f: &str| {
            Formula::parse(f, 1, 3, 1, 10, "Base")
                .map(|_| ())
                .unwrap_err()
                .code
        };
        assert_eq!(parse("=TEXT(A2,\"0\")"), "UNSUPPORTED_FUNCTION");
        assert_eq!(parse("=Outra!A2"), "UNSUPPORTED_REFERENCE");
        assert_eq!(parse("=D2+1"), "CIRCULAR");
        assert_eq!(parse("=SUM(D:D)"), "CIRCULAR");
        assert_eq!(parse("=minha_taxa*A2"), "UNSUPPORTED_REFERENCE");
        assert_eq!(parse("=A2*"), "SYNTAX");
        assert!(Formula::parse("=Base!A2*2", 1, 3, 1, 10, "Base").is_ok());
        assert!(Formula::parse("=D1+A2", 1, 3, 1, 10, "Base").is_ok());
    }

    #[test]
    fn rounding_like_excel() {
        assert_eq!(round_decimal(2.675, 2.0, RoundMode::HalfAway), 2.68);
        assert_eq!(round_decimal(-2.5, 0.0, RoundMode::HalfAway), -3.0);
        assert_eq!(round_decimal(1234.5678, -2.0, RoundMode::HalfAway), 1200.0);
        assert_eq!(round_decimal(1.001, 2.0, RoundMode::Up), 1.01);
        assert_eq!(round_decimal(1.999, 2.0, RoundMode::Down), 1.99);
        assert_eq!(round_decimal(0.004, 2.0, RoundMode::HalfAway), 0.0);
        assert_eq!(round_decimal(0.005, 2.0, RoundMode::HalfAway), 0.01);
        assert_eq!(
            stored_text(&Value::Num(2.55 * 3.0), ','),
            Some("7,65".to_owned())
        );
        assert_eq!(
            stored_text(&Value::Num(0.1 + 0.2), '.'),
            Some("0.3".to_owned())
        );
        assert_eq!(
            stored_text(&Value::Num(1e-7), '.'),
            Some("0.0000001".to_owned())
        );
        assert_eq!(number_text(1e20), "1E+20");
        assert_eq!(number_text(123.25), "123.25");
    }
}
