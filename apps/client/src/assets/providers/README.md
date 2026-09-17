# Provider logos

From [Simple Icons](https://simpleicons.org) (CC0). The **marks themselves
remain the trademarks of their owners** and are used here only to identify
which model produced a given reply — nominative use, not endorsement.

`providerMarks.tsx` loads this directory with `import.meta.glob`, keyed on
filename: the stem must match the provider key (`anthropic`, `openai`,
`google`, `meta`, `deepseek`). Overwrite a file to swap the artwork; delete one
and that provider falls back to a built-in geometric glyph, so a missing file
is never a build error.

Only `viewBox` and the `d` attributes are read, and every mark is drawn in one
neutral ink so the badge row stays legible in both themes. Gradients, embedded
images and multi-colour artwork will not survive — use a monochrome variant.
