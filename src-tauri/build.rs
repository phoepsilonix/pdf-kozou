fn main() {
 #[cfg(target_os = "windows")]
  {
    println!("cargo:rustc-link-arg=/SUBSYSTEM:WINDOWS");
  }
  tauri_build::build()
}
