# MagNum Android release

The release build uses application ID `com.green.magnum`, supports Android 7.0 or later (API 24), and targets Android 16 (API 36). The sideloading artifact contains the ARM64 (`arm64-v8a`) native library. Version 0.2.1 uses Android version code 2001. Keep the application ID and signing key for updates, and increase the version code for each new release.

## Build the APK

Install Node.js 22.12 or later, stable Rust, JDK 17, and Android SDK command-line tools. Set `JAVA_HOME` and `ANDROID_HOME` to your installations. With those set, run the following in Bash from the repository root.

```bash
export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager --licenses
sdkmanager 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' 'ndk;26.1.10909125'
rustup target add aarch64-linux-android

cd MagNum
npm ci
npm run android:init -- --ci --skip-targets-install
gradle_file=src-tauri/gen/android/app/build.gradle.kts
sed -i.bak -E 's/(compileSdk|targetSdk) = [0-9]+/\1 = 36/' "$gradle_file"
rm "$gradle_file.bak"
cp -R src-tauri/icons/android/. src-tauri/gen/android/app/src/main/res/
npm run android:build -- --target aarch64 --split-per-abi --ci
```

Run `android:init` on a fresh checkout to create the ignored Gradle project. If you reuse an older generated project, preserve any local customizations and make sure `app/src/main/assets/backend` is absent. That directory may contain stale desktop resources. Set both launcher labels in `app/src/main/res/values/strings.xml` to `MagNum` if they were generated with an earlier app name.

## Sign and verify

For an update, use the keystore and alias that signed the previous APK. Keep the private key and password backed up outside the repository. For a separate distribution signing its first APK, create a key once with `keytool -genkeypair -storetype PKCS12 -keyalg RSA -keysize 3072 -validity 10000 -alias magnum-android -keystore /private/path/magnum-android.p12`.

From `MagNum/`, set `MAGNUM_ANDROID_KEYSTORE` to the private keystore path. `apksigner` will prompt for its password. Use the version in `src-tauri/tauri.android.conf.json` for the release you are building.

```bash
build_tools="$ANDROID_HOME/build-tools/36.0.0"
unsigned=src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release-unsigned.apk
version=$(node -p "require('./src-tauri/tauri.android.conf.json').version")
out=../release
name="MagNum-$version-android-arm64.apk"
work_dir=$(mktemp -d)
mkdir -p "$out"

"$build_tools/zipalign" -P 16 -f 4 "$unsigned" "$work_dir/aligned.apk"
"$build_tools/apksigner" sign --ks "$MAGNUM_ANDROID_KEYSTORE" \
  --ks-key-alias magnum-android --out "$out/$name" "$work_dir/aligned.apk"
"$build_tools/apksigner" verify --verbose --print-certs "$out/$name"
"$build_tools/zipalign" -c -P 16 4 "$out/$name"
"$build_tools/aapt" dump badging "$out/$name"
(cd "$out" && sha256sum "$name" > "$name.sha256")
rm "$work_dir/aligned.apk"
rmdir "$work_dir"
```

Confirm the expected package, version, ABI, and minimum SDK in the metadata. Extract `lib/arm64-v8a/libmagnum_lib.so` from the APK and run `llvm-readelf -lW` on it. The `LOAD` segments should report `0x4000` alignment. This checks the native library itself in addition to the APK alignment check above.

For an install check, run `adb install -r "$out/$name"` on an ARM64 device with a clean install or a prior release signed with the same key. Launch MagNum and follow the [Android usage guide](android-plan.md).

See the [Android APK signing reference](https://developer.android.com/tools/apksigner) and [APK alignment reference](https://developer.android.com/tools/zipalign) for the signing tools.

## Publish on GitHub

Push the release commit, then create a GitHub Release from that commit with a version tag such as `v0.2.1-android`. Attach the signed APK and its `.sha256` file from `release/`. List the supported Android version and ABI in the release notes.
