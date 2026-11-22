fn main() {
    tauri_plugin::Builder::new(&["provider", "android_agent"])
        .android_path("android")
        .build();
}
