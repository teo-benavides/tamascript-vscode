# TamaScript

Language support for **TamaScript** (`.tama`, `.tam`), an indentation-based DSL for describing bullet-hell patterns in the Tama/Godot 4 framework.

## Features

- Syntax highlighting
- Diagnostics — unknown `fire`/`act`/`bullet` references flagged as errors
- Completions — context-aware keyword and definition name suggestions
- Hover — keyword documentation and definition signatures
- Go to definition — jump to any `fire`, `act`, or `bullet` definition, including across `include`d files
- Ctrl+click on `include` filenames to open the included file directly
- Signature help — parameter hints when calling `fire`/`act`/`bullet` definitions
