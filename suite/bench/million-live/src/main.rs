//! Native integration experiment; no production editor replacement.
//! Never routes the full source through Electron. Internal saves are Parquet
//! plus a calculation definition, not XLSX: evidence must state this limit.
use duckdb::{Connection, types::ValueRef};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::Path,
    time::Instant,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn string<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {k}").into())
}
fn value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Boolean(n) => json!(n),
        ValueRef::TinyInt(n) => json!(n),
        ValueRef::SmallInt(n) => json!(n),
        ValueRef::Int(n) => json!(n),
        ValueRef::BigInt(n) => json!(n),
        ValueRef::Float(n) => json!(n),
        ValueRef::Double(n) => json!(n),
        ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
        other => json!(format!("{other:?}")),
    }
}
struct Engine {
    db: Connection,
    columns: Vec<String>,
    calculated: Option<(String, String, String)>,
}
impl Engine {
    fn new(dir: &Path, memory_mb: u64) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let db = Connection::open(dir.join("working.duckdb"))?;
        db.execute_batch(&format!(
            "SET memory_limit='{}MB'; SET threads=2; SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; SET temp_directory={};",
            memory_mb.clamp(128, 4096),
            literal(&dir.join("spill").to_string_lossy())
        ))?;
        Ok(Self {
            db,
            columns: Vec::new(),
            calculated: None,
        })
    }
    fn rows(&self, sql: &str) -> Result<Vec<Vec<Value>>> {
        let mut stmt = self.db.prepare(sql)?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let mut vals = Vec::new();
            for i in 0..row.as_ref().column_count() {
                vals.push(value(row.get_ref(i)?));
            }
            out.push(vals);
        }
        Ok(out)
    }
    fn view(&self) -> String {
        match &self.calculated {
            Some((name, left, right)) => format!(
                "(SELECT *, {}*{} AS {} FROM base)",
                ident(left),
                ident(right),
                ident(name)
            ),
            None => "base".into(),
        }
    }
    fn handle(&mut self, req: &Value) -> Result<Value> {
        match string(req, "op")? {
            "open" => {
                let source = string(req, "path")?;
                let delimiter = string(req, "delimiter")?;
                if ![";", ",", "\t"].contains(&delimiter) {
                    return Err("Unsupported delimiter".into());
                }
                self.db.execute_batch(&format!("CREATE OR REPLACE TABLE raw AS SELECT * FROM read_csv({}, delim={}, header=true, all_varchar=true);",literal(source),literal(delimiter)))?;
                self.columns = self
                    .rows("DESCRIBE raw")?
                    .iter()
                    .map(|r| r[0].as_str().unwrap().to_owned())
                    .collect();
                if self.columns.iter().any(|c| c == "__fariv_id") {
                    return Err("Reserved column name __fariv_id".into());
                }
                let numbers = req["numericColumns"]
                    .as_array()
                    .ok_or("numericColumns must be an array")?;
                let decimal = req["decimal"].as_str().unwrap_or(".");
                if ![",", "."].contains(&decimal) {
                    return Err("Invalid decimal mark".into());
                }
                let mut expr = Vec::new();
                for c in &self.columns {
                    let q = ident(c);
                    if numbers.iter().any(|v| v.as_str() == Some(c)) {
                        let raw = if decimal == "," {
                            format!("replace(replace(trim({q}),'.',''),',','.')")
                        } else {
                            format!("replace(trim({q}),',','')")
                        };
                        expr.push(format!("CAST(nullif({raw},'') AS DOUBLE) AS {q}"));
                    } else {
                        expr.push(q)
                    }
                }
                self.db.execute_batch(&format!("CREATE OR REPLACE TABLE base AS SELECT row_number() OVER ()-1 AS __fariv_id, {} FROM raw; DROP TABLE raw;",expr.join(",")))?;
                self.calculated = None;
                Ok(
                    json!({"columns":self.columns,"rows":self.rows("SELECT count(*) FROM base")?[0][0],"version":self.rows("SELECT version()")?[0][0]}),
                )
            }
            "read" => {
                let offset = req["offset"].as_u64().ok_or("Invalid offset")?;
                let limit = req["limit"].as_u64().unwrap_or(100);
                if limit > 200 {
                    return Err("Viewport limit is 200 rows".into());
                }
                let end = offset.checked_add(limit).ok_or("Invalid viewport end")?;
                let cols = self
                    .columns
                    .iter()
                    .map(|c| ident(c))
                    .chain(self.calculated.iter().map(|c| ident(&c.0)))
                    .collect::<Vec<_>>()
                    .join(",");
                let result = self.rows(&format!(
                    "SELECT {cols} FROM {} WHERE __fariv_id >= {offset} AND __fariv_id < {end} ORDER BY __fariv_id",
                    self.view()
                ))?;
                Ok(json!({"offset":offset,"rows":result}))
            }
            "calculate" => {
                let left = string(req, "left")?.to_owned();
                let right = string(req, "right")?.to_owned();
                let name = string(req, "name")?.to_owned();
                if !self.columns.contains(&left)
                    || !self.columns.contains(&right)
                    || self.columns.contains(&name)
                    || name == "__fariv_id"
                {
                    return Err("Invalid calculated column".into());
                }
                self.calculated = Some((name.clone(), left, right));
                let r = self.rows(&format!(
                    "SELECT count(*),sum({}),min({}),max({}) FROM {}",
                    ident(&name),
                    ident(&name),
                    ident(&name),
                    self.view()
                ))?;
                Ok(json!({"rows":r[0][0],"sum":r[0][1],"min":r[0][2],"max":r[0][3]}))
            }
            "save" => {
                let path = string(req, "path")?;
                self.db.execute_batch(&format!(
                    "COPY base TO {} (FORMAT PARQUET, COMPRESSION ZSTD);",
                    literal(path)
                ))?;
                std::fs::write(
                    format!("{path}.json"),
                    serde_json::to_vec(
                        &json!({"columns":self.columns,"calculated":self.calculated}),
                    )?,
                )?;
                Ok(json!({"saved":true,"bytes":std::fs::metadata(path)?.len()}))
            }
            "reopen" => {
                let path = string(req, "path")?;
                let meta: Value = serde_json::from_slice(&std::fs::read(format!("{path}.json"))?)?;
                self.columns = serde_json::from_value(meta["columns"].clone())?;
                self.calculated = serde_json::from_value(meta["calculated"].clone())?;
                self.db.execute_batch(&format!(
                    "CREATE OR REPLACE TABLE base AS SELECT * FROM read_parquet({});",
                    literal(path)
                ))?;
                Ok(json!({"rows":self.rows("SELECT count(*) FROM base")?[0][0]}))
            }
            "audit" => {
                let path = string(req, "path")?;
                self.db.execute_batch(&format!(
                    "COPY (SELECT * FROM {} ORDER BY __fariv_id) TO {} (HEADER, DELIMITER ';');",
                    self.view(),
                    literal(path)
                ))?;
                Ok(json!({"saved":true}))
            }
            _ => Err("Unknown operation".into()),
        }
    }
}
fn main() -> Result<()> {
    let dir = std::env::args()
        .nth(1)
        .ok_or("Working directory required")?;
    let memory = std::env::args().nth(2).unwrap_or("512".into()).parse()?;
    let mut engine = Engine::new(Path::new(&dir), memory)?;
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout());
    for line in stdin.lock().lines() {
        let line = line?;
        let start = Instant::now();
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(req) => match engine.handle(&req) {
                Ok(result) => {
                    json!({"id":req["id"],"ok":true,"result":result,"engineMs":start.elapsed().as_secs_f64()*1000.0})
                }
                Err(e) => json!({"id":req["id"],"ok":false,"error":e.to_string()}),
            },
            Err(e) => json!({"ok":false,"error":e.to_string()}),
        };
        serde_json::to_writer(&mut out, &response)?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locale_identifiers_negative_values_and_saved_definition() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("fariv-million-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let csv = dir.join("source.csv");
        std::fs::write(
            &csv,
            "codigo;quantidade;preco\n007;3;2,55\n0008;-2;1,20\n009;0;99,99\n",
        )?;
        let mut engine = Engine::new(&dir, 128)?;
        let open=engine.handle(&json!({"op":"open","path":csv,"delimiter":";","decimal":",","numericColumns":["quantidade","preco"]}))?;
        assert_eq!(open["rows"], 3);
        assert_eq!(
            engine.handle(&json!({"op":"read","offset":0,"limit":3}))?["rows"][0][0],
            "007"
        );
        let calc = engine.handle(
            &json!({"op":"calculate","left":"quantidade","right":"preco","name":"total"}),
        )?;
        assert!((calc["sum"].as_f64().unwrap() - 5.25).abs() < 1e-10);
        assert!(
            engine
                .handle(&json!({"op":"read","offset":0,"limit":201}))
                .is_err()
        );
        assert!(
            engine
                .handle(&json!({"op":"calculate","left":"missing","right":"preco","name":"bad"}))
                .is_err()
        );
        let saved = dir.join("base.parquet");
        engine.handle(&json!({"op":"save","path":saved}))?;
        engine.calculated = None;
        engine.handle(&json!({"op":"reopen","path":saved}))?;
        let rows = engine.handle(&json!({"op":"read","offset":0,"limit":3}))?;
        assert_eq!(rows["rows"][1][0], "0008");
        assert!((rows["rows"][1][3].as_f64().unwrap() + 2.4).abs() < 1e-10);
        drop(engine);
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }
}
