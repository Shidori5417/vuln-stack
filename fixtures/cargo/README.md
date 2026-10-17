# Cargo fixtures

Hand-written in the real `Cargo.lock` v3 format. Old versions (`time 0.1.43`, `regex 1.5.4`) are intentional for demos. Never build them.

| Folder | What it covers |
|---|---|
| `app` | `Cargo.lock` with a workspace/root package (no `source`), registry crates, a git source, and `[dev-dependencies]` (`tempfile`) |
| `manifest-only` | `Cargo.toml` without a lock file: requirements, a path dependency, dev dependency |
