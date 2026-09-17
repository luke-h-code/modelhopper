mod tools;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Registered for one caller: tools::choose_folder. The plugin's own IPC
    // commands come with it but stay unreachable — the capability grants
    // core:default and no dialog permission, so the webview cannot open one.
    .plugin(tauri_plugin_dialog::init())
    // Commands the model can ask for, one named operation at a time. The
    // webview never gets a general filesystem or shell capability.
    .invoke_handler(tauri::generate_handler![
      tools::tool_root,
      tools::validate_root,
      tools::choose_folder,
      tools::probe_env,
      tools::list_dir,
      tools::run_command,
      tools::cancel_commands
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
