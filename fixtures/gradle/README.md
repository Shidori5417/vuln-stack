# Gradle fixtures (Maven ecosystem)

| Folder | What it covers |
|---|---|
| `kotlin-dsl` | `build.gradle.kts` + `gradle/libs.versions.toml` + `gradle.lockfile` (full classpath, test-only configs) |
| `groovy` | `build.gradle` without lock: string/map notations, `ext`/`def` variables, dynamic `1.4.+`, unresolvable variable, BOM-managed dep |
