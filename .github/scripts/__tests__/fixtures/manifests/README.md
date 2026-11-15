# Binary AndroidManifest.xml fixtures

Compiled with AAPT2 34.0.0 against android-34 `android.jar`, then taken out of the APK:

```sh
aapt2 link --manifest <case>.xml -I android.jar -o <case>.apk
unzip -p <case>.apk AndroidManifest.xml > <case>.axml
```

Each source manifest is `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example" ATTRS><application android:label="LABEL">BODY</application></manifest>`:

| Fixture | ATTRS | LABEL | BODY |
|---|---|---|---|
| `abi-required` | `android:requiredSplitTypes="base__abi" android:splitTypes=""` | `App` | |
| `abi-and-density` | `android:requiredSplitTypes="base__density,base__abi"` | `App` | |
| `density-only` | `android:requiredSplitTypes="base__density"` | `App` | |
| `density-label-abi` | `android:requiredSplitTypes="base__density"` | `base__abi` | |
| `unrelated-strings` | | `requiredSplitTypes` | `<meta-data android:name="x" android:value="base__abi"/>` |
| `no-split` | | `App` | |
