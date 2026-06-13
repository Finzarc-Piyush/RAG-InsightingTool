# Composite Map keys — use the shared KEY_SEP, never a literal control byte

When you build one `Map` key out of several field values (`outer` + sep + `inner`),
use the shared helper instead of inventing a delimiter:

- **Server:** `import { KEY_SEP, compositeKey, splitCompositeKey } from "<rel>/compositeKey.js"`
- **Client:** `import { KEY_SEP, compositeKey, splitCompositeKey } from "@/lib/charts/compositeKey"`

`KEY_SEP` is the ASCII Unit Separator (codepoint U+001F), written in source as a
**unicode escape** (`backslash-u-001f`). It is a non-printable control character
that never appears in real tabular data, so it can't collide with a field value.
Always build AND decompose keys through these helpers so the two sides can't drift.

## Never embed a *literal* control byte in source

Typing a raw control byte (NUL, SOH, Unit Separator, …) directly into a string
literal makes `file(1)` classify the whole source file as **binary**, which makes
**ripgrep — and therefore the Grep tool, the shell `grep`/`rg` wrappers, and most
editor search — silently skip the file**. That hid ~10 real duplications during
the 2026-06 dedup audit and produced a phantom "bug" report (an invisible NUL
mis-read as a space). See lessons **L-012**.

Always write the unicode escape, not the byte. Established by Wave Dup2 (Dup2a
converted four files' literal bytes to escapes; Dup2c introduced the shared
`compositeKey`/`KEY_SEP`).
