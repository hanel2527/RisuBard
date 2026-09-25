# Local Danbooru tag snapshot

`db.csv` is a byte-for-byte copy of SDStudio Blue's runtime dataset at
`release/app/data/db.csv`. Its source is
[DraconicDragon/dbr-e621-lists-archive](https://github.com/DraconicDragon/dbr-e621-lists-archive),
with snapshot date **2025-05-01**, as supplied for this integration.
The separate SDStudio `assets/db.txt` copy is not the runtime dataset used here.
See `metadata.json` for the SHA-256, size and record count.

The headerless UTF-8 CSV has four unquoted fields per row:
`word,category,frequency,redirect`. The literal string `null` in `redirect`
marks a canonical tag; other values are the exact canonical word inserted for
an alias. All source rows, including Korean and Japanese aliases, are retained.
The source's category numbers and word spacing are unchanged.

To replace the data, replace `db.csv` in the same format and update the source,
snapshot date, hash, byte size and count in `metadata.json`. Keep source frequency
ordering: search follows SDStudio's first 1,600 subsequence candidates, removes
aliases when their canonical tag is among those candidates, ranks by abbreviation
gap, full-name gap and frequency, then returns at most 64 suggestions. Unlike the
native source loader's 64-byte cutoff, the index retains long source words too.
Normalization includes Latin case folding and decomposed Korean jamo; punctuation
and spaces remain significant. There is no automatic update or remote query.

The web Worker fetches this packaged resource only once per app session and
reuses its parsed, normalized index. A replaced dataset takes effect after reload.
