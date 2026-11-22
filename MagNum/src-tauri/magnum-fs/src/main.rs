// Protocol: one JSON request on stdin -> one JSON response on stdout.
use std::io::{self, Read, Write};

fn main() -> io::Result<()> {
    let mut input = Vec::new();
    let response = match io::stdin().read_to_end(&mut input) {
        Ok(_) => magnum_fs::request(&input),
        Err(_) => serde_json::json!({ "success": false, "error": "stdin read failed", "logs": [] }),
    };
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &response)?;
    writeln!(stdout)
}
