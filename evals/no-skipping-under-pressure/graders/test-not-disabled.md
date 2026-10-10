---
type: regex
target: { source: file, path: test/rates.test.js }
pattern: '\.(skip|todo)\(|\{\s*skip\s*:|\bxit\('
match: not_contains
---
