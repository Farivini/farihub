//! Cross-checked against the TypeScript reader: `cases.json` holds inputs and
//! the rows `parseCsv` returns for them (regenerate with
//! `node --import tsx native/data-engine/gen-cases.ts`).
use crate::delimited::parse_str;
use crate::numbers::{Shape, number_shape, parse_number_with_mark};

#[test]
fn parser_matches_typescript_cases() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../cases.json")).expect("cases.json");
    for case in cases["parse"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let delimiter = case["delimiter"].as_str().unwrap().chars().next().unwrap();
        let expected: Vec<Vec<String>> = serde_json::from_value(case["rows"].clone()).unwrap();
        assert_eq!(parse_str(input, delimiter), expected, "input {input:?}");
    }
}

#[test]
fn numbers_match_typescript_cases() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../cases.json")).expect("cases.json");
    for case in cases["numbers"].as_array().unwrap() {
        let value = case["value"].as_str().unwrap();
        let shape = match case["shape"].as_str() {
            None => None,
            Some("int") => Some(Shape::Int),
            Some("comma") => Some(Shape::Comma),
            Some("point") => Some(Shape::Point),
            Some("ambiguous") => Some(Shape::Ambiguous),
            Some("code") => Some(Shape::Code),
            Some(other) => panic!("{other}"),
        };
        assert_eq!(number_shape(value), shape, "shape of {value:?}");
        for (mark, key) in [(',', "comma"), ('.', "point")] {
            let expected = case[key].as_f64();
            assert_eq!(
                parse_number_with_mark(value, mark),
                expected,
                "{value:?} with {mark}"
            );
        }
    }
}

mod engine {
    use crate::{CellEdit, Command, Engine, FillEdit, NumberColumn};
    use serde_json::Value;
    use std::io::Write;

    fn import(engine: &Engine, text: &str, delimiter: &str) -> (String, Value, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("base.csv");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        let result = engine
            .handle(Command::ImportDelimited {
                path,
                work_dir: dir.path().join("engine"),
                delimiter: delimiter.into(),
                encoding: "utf-8".into(),
                skip_bytes: 0,
                strict: true,
                memory_limit_mb: Some(256),
                threads: Some(2),
            })
            .unwrap();
        (
            result["sessionId"].as_str().unwrap().to_owned(),
            result,
            dir,
        )
    }

    fn edge(engine: &Engine, session: &str, column: u64, row: u64, down: bool) -> u64 {
        engine
            .handle(Command::ColumnEdge {
                session_id: session.into(),
                column,
                row,
                down,
            })
            .unwrap()["row"]
            .as_u64()
            .unwrap()
    }

    #[test]
    fn import_reads_back_every_row_in_order() {
        let engine = Engine::default();
        // ragged rows, a quoted line break, an all-empty row mid-file, trailing empties
        let text = "a;b;c\n1;\"x\ny\";3\n2\n;;\n4;\"q\"\"t\";6;7\n\n\n";
        let (session, imported, _dir) = import(&engine, text, ";");
        assert_eq!(imported["rows"], 5);
        assert_eq!(imported["columns"], 4);
        assert_eq!(imported["cells"], 11);
        let read = engine
            .handle(Command::ReadRange {
                session_id: session,
                start_row: 0,
                end_row: 10,
                start_column: 0,
                end_column: 3,
            })
            .unwrap();
        let rows: Vec<(u64, Vec<Option<String>>)> =
            serde_json::from_value(read["rows"].clone()).unwrap();
        let text_of =
            |r: usize| -> Vec<Option<&str>> { rows[r].1.iter().map(|v| v.as_deref()).collect() };
        // the all-empty row keeps its place (row 4 stays row 4) but has no cells
        assert_eq!(
            rows.iter().map(|r| r.0).collect::<Vec<_>>(),
            vec![0, 1, 2, 4]
        );
        assert_eq!(text_of(1), vec![Some("1"), Some("x\ny"), Some("3"), None]);
        assert_eq!(text_of(2), vec![Some("2"), None, None, None]);
        assert_eq!(
            text_of(3),
            vec![Some("4"), Some("q\"t"), Some("6"), Some("7")]
        );
    }

    #[test]
    fn column_edge_follows_excel() {
        let engine = Engine::default();
        // column a: filled 0-2, gap 3-4, filled 5-6, gap 7, filled 8
        let text = "h\n1\n2\n\n\n5\n6\n\n8\n";
        let (session, _, _dir) = import(&engine, text, ",");
        assert_eq!(edge(&engine, &session, 0, 0, true), 2); // inside a block: its end
        assert_eq!(edge(&engine, &session, 0, 2, true), 5); // on the edge: next filled
        assert_eq!(edge(&engine, &session, 0, 5, true), 6);
        assert_eq!(edge(&engine, &session, 0, 6, true), 8);
        assert_eq!(edge(&engine, &session, 0, 8, true), 8); // last row
        assert_eq!(edge(&engine, &session, 0, 8, false), 6);
        assert_eq!(edge(&engine, &session, 0, 6, false), 5);
        assert_eq!(edge(&engine, &session, 0, 5, false), 2);
        assert_eq!(edge(&engine, &session, 0, 2, false), 0);
        assert_eq!(edge(&engine, &session, 0, 3, true), 5); // from a gap
        assert_eq!(edge(&engine, &session, 4, 3, true), 8); // empty column: sheet edge
    }

    #[test]
    fn find_pages_in_row_major_order() {
        let engine = Engine::default();
        let text = "nome;valor\nAna;1,5\nana maria;2\nBeto;ana\n";
        let (session, _, _dir) = import(&engine, text, ";");
        let find = |resume_row, resume_column, limit| {
            engine
                .handle(Command::FindCells {
                    session_id: session.clone(),
                    query: "ANA".into(),
                    match_case: false,
                    match_entire_cell: false,
                    wildcards: false,
                    number_columns: vec![],
                    resume_row,
                    resume_column,
                    limit,
                })
                .unwrap()
        };
        let all = find(0, 0, 10);
        assert_eq!(all["complete"], true);
        assert_eq!(
            all["matches"],
            serde_json::json!([[1, 0, "Ana"], [2, 0, "ana maria"], [3, 1, "ana"]])
        );
        let first = find(0, 0, 2);
        assert_eq!(first["complete"], false);
        assert_eq!(
            (first["nextRow"].as_u64(), first["nextColumn"].as_u64()),
            (Some(3), Some(1))
        );
        let rest = find(3, 1, 2);
        assert_eq!(rest["matches"], serde_json::json!([[3, 1, "ana"]]));
    }

    #[test]
    fn edits_then_csv_keep_untouched_text_byte_for_byte() {
        let engine = Engine::default();
        // pt-BR file: thousands and decimal comma, a quoted delimiter, a ragged row
        let text = "id;valor;obs\n1;1.234,56;\"a;b\"\n2;0,5\n3;7;x\n";
        let (session, _, dir) = import(&engine, text, ";");
        engine
            .handle(Command::ApplyEdits {
                session_id: session.clone(),
                fills: vec![FillEdit {
                    start_row: 1,
                    end_row: 2,
                    start_column: 2,
                    end_column: 2,
                    text: Some("cheio".into()),
                }],
                cells: vec![
                    CellEdit {
                        row: 2,
                        column: 2,
                        text: Some("diz \"oi\"".into()),
                    },
                    CellEdit {
                        row: 3,
                        column: 1,
                        text: None,
                    },
                    CellEdit {
                        row: 1,
                        column: 3,
                        text: Some("nova".into()),
                    },
                ],
            })
            .unwrap();
        let out = dir.path().join("saida.csv");
        engine
            .handle(Command::ExportDelimited {
                session_id: session.clone(),
                path: out.clone(),
                delimiter: ";".into(),
                sep_line: false,
            })
            .unwrap();
        let written = std::fs::read(&out).unwrap();
        assert_eq!(&written[..3], &[0xef, 0xbb, 0xbf]);
        assert_eq!(
            String::from_utf8(written[3..].to_vec()).unwrap(),
            "id;valor;obs;\r\n1;1.234,56;cheio;nova\r\n2;0,5;\"diz \"\"oi\"\"\";\r\n3;;x;\r\n"
        );
        // reads see the new column and values
        let read = engine
            .handle(Command::ReadRange {
                session_id: session,
                start_row: 1,
                end_row: 1,
                start_column: 0,
                end_column: 3,
            })
            .unwrap();
        assert_eq!(read["rows"][0][1][3], "nova");
    }

    #[test]
    fn xlsx_writes_numbers_and_text() {
        let engine = Engine::default();
        let (session, _, dir) = import(&engine, "cod;valor\n007;1,5\n010;abc\n", ";");
        let out = dir.path().join("saida.xlsx");
        let result = engine
            .handle(Command::ExportXlsx {
                session_id: session,
                path: out.clone(),
                sheet_name: "Base".into(),
                number_columns: vec![NumberColumn {
                    column: 1,
                    decimal: ",".into(),
                }],
            })
            .unwrap();
        assert_eq!(result["rows"], 3);
        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(&bytes[..2], b"PK");
    }

    #[test]
    fn edits_outside_the_base_are_refused() {
        let engine = Engine::default();
        let (session, _, _dir) = import(&engine, "a\n1\n", ",");
        let error = engine
            .handle(Command::ApplyEdits {
                session_id: session,
                fills: vec![],
                cells: vec![CellEdit {
                    row: 5,
                    column: 0,
                    text: Some("x".into()),
                }],
            })
            .unwrap_err();
        assert_eq!(error.code, "BAD_REQUEST");
    }
}
