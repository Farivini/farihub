//! Streaming port of the app's delimited-text reader
//! (`packages/xlsx-gateway/src/gateway/csv-import.ts`: `parseCsv` and
//! `splitSepDeclaration`). A large file must open with exactly the cells a
//! small one gets, so every rule below mirrors the TypeScript line by line;
//! `tests.rs` pins the edge cases.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use encoding_rs::{CoderResult, DecoderResult, Encoding};

/// Same caps as csv-import.ts.
pub const MAX_CSV_COLS: usize = 16_384;

const READ_CHUNK: usize = 1 << 20;

#[derive(Debug)]
pub enum ReadError {
    Io(std::io::Error),
    /// `strict` UTF-8 was requested and the file is not valid UTF-8: the host
    /// picks a legacy charset the way decodeCsvBuffer does and retries.
    NotUtf8,
    UnknownEncoding(String),
    TooManyColumns,
    Stopped(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Io(e) => write!(f, "{e}"),
            ReadError::NotUtf8 => write!(f, "the file is not valid UTF-8"),
            ReadError::UnknownEncoding(label) => write!(f, "unknown text encoding: {label}"),
            ReadError::TooManyColumns => {
                write!(
                    f,
                    "CSV import rejected: too many columns (cap {MAX_CSV_COLS})"
                )
            }
            ReadError::Stopped(message) => write!(f, "{message}"),
        }
    }
}

/// How the bytes become text: the host decides like decodeCsvBuffer.
#[derive(Clone, Debug)]
pub struct TextSource {
    /// WHATWG label (`utf-8`, `utf-16le`, `windows-1252`, ...): the same
    /// encoding standard TextDecoder implements.
    pub encoding: String,
    /// Bytes to skip first (a byte-order mark the host already recognized).
    pub skip_bytes: u64,
    /// Fail with NotUtf8 instead of replacing malformed sequences.
    pub strict: bool,
}

/// Decodes the file in chunks and hands the text to `sink`.
fn decode_file(
    path: &Path,
    source: &TextSource,
    mut sink: impl FnMut(&str) -> Result<(), ReadError>,
) -> Result<(), ReadError> {
    let encoding = Encoding::for_label(source.encoding.as_bytes())
        .ok_or_else(|| ReadError::UnknownEncoding(source.encoding.clone()))?;
    let mut file = File::open(path).map_err(ReadError::Io)?;
    if source.skip_bytes > 0 {
        std::io::copy(
            &mut (&mut file).take(source.skip_bytes),
            &mut std::io::sink(),
        )
        .map_err(ReadError::Io)?;
    }
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut input = vec![0u8; READ_CHUNK];
    let mut text = String::with_capacity(READ_CHUNK * 3 + 16);
    loop {
        let read = file.read(&mut input).map_err(ReadError::Io)?;
        let last = read == 0;
        let mut bytes = &input[..read];
        loop {
            text.clear();
            if source.strict {
                let (result, consumed) =
                    decoder.decode_to_string_without_replacement(bytes, &mut text, last);
                bytes = &bytes[consumed..];
                match result {
                    DecoderResult::InputEmpty => {
                        sink(&text)?;
                        break;
                    }
                    DecoderResult::OutputFull => sink(&text)?,
                    DecoderResult::Malformed(_, _) => return Err(ReadError::NotUtf8),
                }
            } else {
                let (result, consumed, _) = decoder.decode_to_string(bytes, &mut text, last);
                bytes = &bytes[consumed..];
                sink(&text)?;
                match result {
                    CoderResult::InputEmpty => break,
                    CoderResult::OutputFull => {}
                }
            }
            if text.capacity() < READ_CHUNK * 3 {
                text.reserve(READ_CHUNK * 3);
            }
        }
        if last {
            return Ok(());
        }
    }
}

/// Where the reader is between characters. Lookahead in the TypeScript
/// (`text[index + 1]`) becomes a pending state that the next character —
/// possibly from the next decoded chunk — resolves.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pending {
    None,
    /// A `"` inside a quoted field: `""` is a literal quote, anything else closes.
    QuoteInQuoted,
    /// A `\r` was consumed; an immediately following `\n` is part of it.
    CarriageReturn,
}

/// The sep= declaration and BOM prefix handling of splitSepDeclaration +
/// parseCsv, decided once the first characters are known.
enum Prefix {
    Collecting(String),
    Done,
}

const SEP_PREFIX_LIMIT: usize = 16;

/// `/^﻿?sep=(.)\r?\n/i` on the collected prefix: Some(len) of the match,
/// None when it cannot match, Err(()) when more characters are needed.
fn sep_declaration_len(prefix: &str, at_end: bool) -> Result<Option<usize>, ()> {
    let chars: Vec<char> = prefix.chars().collect();
    let mut index = 0;
    if chars.first() == Some(&'\u{feff}') {
        index += 1;
    }
    for expected in ['s', 'e', 'p', '='] {
        match chars.get(index) {
            None => return if at_end { Ok(None) } else { Err(()) },
            Some(c) if c.to_ascii_lowercase() == expected => index += 1,
            Some(_) => return Ok(None),
        }
    }
    // `(.)`: any character except a line terminator
    match chars.get(index) {
        None => return if at_end { Ok(None) } else { Err(()) },
        Some('\n' | '\r' | '\u{2028}' | '\u{2029}') => return Ok(None),
        Some(_) => index += 1,
    }
    match chars.get(index) {
        None => return if at_end { Ok(None) } else { Err(()) },
        Some('\r') => index += 1,
        Some(_) => {}
    }
    match chars.get(index) {
        None => {
            if at_end {
                Ok(None)
            } else {
                Err(())
            }
        }
        Some('\n') => Ok(Some(chars[..=index].iter().map(|c| c.len_utf8()).sum())),
        Some(_) => Ok(None),
    }
}

/// The parseCsv state machine, fed text in pieces; finished rows go to `emit`.
pub struct Parser<F: FnMut(&[String]) -> Result<(), ReadError>> {
    delimiter: char,
    prefix: Prefix,
    quoted: bool,
    pending: Pending,
    row: Vec<String>,
    field: String,
    /// Rows whose cells are all '' are held back: parseCsv drops the trailing
    /// ones, so they are released only when a non-empty row follows.
    held_empty: Vec<usize>,
    emit: F,
}

impl<F: FnMut(&[String]) -> Result<(), ReadError>> Parser<F> {
    pub fn new(delimiter: char, emit: F) -> Self {
        Self {
            delimiter,
            prefix: Prefix::Collecting(String::new()),
            quoted: false,
            pending: Pending::None,
            row: Vec::new(),
            field: String::new(),
            held_empty: Vec::new(),
            emit,
        }
    }

    pub fn feed(&mut self, text: &str) -> Result<(), ReadError> {
        if let Prefix::Collecting(collected) = &mut self.prefix {
            collected.push_str(text);
            if collected.chars().count() < SEP_PREFIX_LIMIT {
                return Ok(());
            }
            let collected = std::mem::take(collected);
            self.prefix = Prefix::Done;
            return self.feed_prefix(&collected, false);
        }
        for character in text.chars() {
            self.step(character)?;
        }
        Ok(())
    }

    fn feed_prefix(&mut self, collected: &str, at_end: bool) -> Result<(), ReadError> {
        let skip = sep_declaration_len(collected, at_end)
            .unwrap_or(None)
            .unwrap_or(0);
        let mut rest = &collected[skip..];
        // parseCsv strips one leading BOM after the sep= split
        if let Some(stripped) = rest.strip_prefix('\u{feff}') {
            rest = stripped;
        }
        for character in rest.chars() {
            self.step(character)?;
        }
        Ok(())
    }

    fn push_field(&mut self) -> Result<(), ReadError> {
        self.row.push(std::mem::take(&mut self.field));
        if self.row.len() > MAX_CSV_COLS {
            return Err(ReadError::TooManyColumns);
        }
        Ok(())
    }

    fn push_row(&mut self) -> Result<(), ReadError> {
        let row = std::mem::take(&mut self.row);
        if row.iter().all(|cell| cell.is_empty()) {
            self.held_empty.push(row.len());
            return Ok(());
        }
        for width in std::mem::take(&mut self.held_empty) {
            let empty = vec![String::new(); width];
            (self.emit)(&empty)?;
        }
        (self.emit)(&row)
    }

    fn step(&mut self, character: char) -> Result<(), ReadError> {
        match self.pending {
            Pending::QuoteInQuoted => {
                self.pending = Pending::None;
                if character == '"' {
                    self.field.push('"');
                    return Ok(());
                }
                self.quoted = false;
            }
            Pending::CarriageReturn => {
                self.pending = Pending::None;
                if character == '\n' {
                    return Ok(());
                }
            }
            Pending::None => {}
        }
        if self.quoted {
            match character {
                '"' => self.pending = Pending::QuoteInQuoted,
                '\r' => {
                    self.field.push('\n');
                    self.pending = Pending::CarriageReturn;
                }
                other => self.field.push(other),
            }
            return Ok(());
        }
        if character == '"' && self.field.is_empty() {
            self.quoted = true;
        } else if character == self.delimiter {
            self.push_field()?;
        } else if character == '\n' || character == '\r' {
            if character == '\r' {
                self.pending = Pending::CarriageReturn;
            }
            self.push_field()?;
            self.push_row()?;
        } else {
            self.field.push(character);
        }
        Ok(())
    }

    /// End of input: the final partial row, then the trailing empty rows drop.
    pub fn finish(mut self) -> Result<(), ReadError> {
        if let Prefix::Collecting(collected) = &mut self.prefix {
            let collected = std::mem::take(collected);
            self.prefix = Prefix::Done;
            self.feed_prefix(&collected, true)?;
        }
        if self.pending == Pending::QuoteInQuoted {
            self.quoted = false;
        }
        if !self.field.is_empty() || !self.row.is_empty() {
            self.push_field()?;
            self.push_row()?;
        }
        Ok(())
    }
}

/// Reads `path` as text and parses every row.
pub fn read_rows(
    path: &Path,
    source: &TextSource,
    delimiter: char,
    emit: impl FnMut(&[String]) -> Result<(), ReadError>,
) -> Result<(), ReadError> {
    let mut parser = Parser::new(delimiter, emit);
    decode_file(path, source, |text| parser.feed(text))?;
    parser.finish()
}

/// Test helper: parse a whole string.
#[cfg(test)]
pub fn parse_str(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut parser = Parser::new(delimiter, |row: &[String]| {
        rows.push(row.to_vec());
        Ok(())
    });
    parser.feed(text).unwrap();
    parser.finish().unwrap();
    rows
}
