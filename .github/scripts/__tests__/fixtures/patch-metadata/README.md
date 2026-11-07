# Real CLI fixture

`piko-3.74.0-cli-2.0.0.txt` is captured stdout from the actual upstream
`patches-3.74.0.mpp` (crimera/piko-newx v3.74.0) loaded by
`morphe-desktop-2.0.0-all.jar` (MorpheApp/morphe-desktop v2.0.0):

```sh
java -jar morphe-desktop-2.0.0-all.jar list-patches --patches=patches-3.74.0.mpp -p -v -o
```

Only the JAR-adjacent local data-root path has been sanitized. Stderr was
empty. Both binary digests matched the exact GitHub release API assets.
No binaries, authentication state, or delivery URLs are included here.
Other parser edge cases in the tests are synthetic and are not live captures.

`synthetic-optional.txt` is source-shaped synthetic output, not a live capture. It covers omitted descriptions, universal compatibility (both absent package section and `(universal)`), and optional version-code rows from the v2.0.0 `ListPatchesCommand` grammar. Actual derivation omits options and descriptions with `-p -v --with-descriptions=false`; the captured fixture above retains its original command and informational fields.

`morphe-2.1.0-excerpt.json` is an unchanged patch-object excerpt from
https://raw.githubusercontent.com/MorpheApp/morphe-patches/v2.1.0/patches-list.json
(retaining the original NOTE and version). It contains the AI channel filter, both App refresh rate entries, and all Spoof
signature entries alongside all five universal patches with explicit null
compatibility and default false. Repeated names are authentic structured metadata.

`hoodles-1.47.0-excerpt.json` retains the root metadata and unchanged Unlimited
skips patch from https://raw.githubusercontent.com/hoo-dles/morphe-patches/v1.47.0/patches-list.json.
Its explicit null version is an unrestricted target, not a missing version field.
