use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, process::{Command, Stdio}};
use tauri::{path::BaseDirectory, Manager};

static REGISTRATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Fixed ID of the bundled extension: manifest.json carries a public "key",
/// so every computer gets the same ID and registration needs no manual input.
pub const EXTENSION_ID: &str = "cbalbbednlnkjakimgigdnfmkgdpccbi";

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|value| (b'a'..=b'p').contains(&value))
}

fn trusted_registration(source: &[u8]) -> bool {
    if source.is_empty() || !source.is_ascii() { return false; }
    let checksum = format!("{:x}", Sha256::digest(source));
    matches!(checksum.as_str(),
        "7f8bc952e1e6544683a02d2603506067ebe96b082ff9dcd372b156561f6e8bce" |
        "e70d2f5b19a9aaa3ffd70c23f00f1e81af660698b3ab8c79e0d0c3d2e20cfd56")
}

fn resource(app: &tauri::AppHandle, relative: &str) -> Result<PathBuf, String> {
    app.path().resolve(relative, BaseDirectory::Resource)
        .map_err(|_| "Не найдены файлы расширения. Переустановите Малению.".to_string())
}

fn saved_id() -> Option<String> {
    let path = PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
        .join("Malenia").join("browser_bridge.json");
    if fs::metadata(&path).ok()?.len() > 8192 { return None; }
    let config: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let id = config.get("extension_id")?.as_str()?;
    valid_id(id).then(|| id.to_owned())
}

pub fn status(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let script = resource(app, "resources/browser-setup/register_browser_bridge.ps1")?;
    let host = resource(app, "resources/malenia-native-host/malenia-native-host.exe")?;
    let manifest = resource(app, "resources/browser-extension/manifest.json")?;
    let available = host.is_file() && manifest.is_file() &&
        fs::read(script).map(|source| trusted_registration(&source)).unwrap_or(false);
    // A saved ID is not proof that the extension is running or may read sites.
    Ok(serde_json::json!({"available":available, "saved_extension_id":saved_id(), "bundled_extension_id": EXTENSION_ID}))
}

/// Register the native host for the bundled extension on every start when
/// it is missing or points to another ID. This is what fixes "host not found"
/// on a colleague's computer where nobody ran the manual registration.
pub fn ensure_registered(app: &tauri::AppHandle) -> Result<bool, String> {
    if !cfg!(windows) { return Ok(false); }
    let manifest_ok = std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("Malenia").join("browser-bridge").join("com.malenia.browser.json"))
        .and_then(|path| fs::read(path).ok())
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .map(|manifest| {
            let origin = format!("chrome-extension://{EXTENSION_ID}/");
            let allowed = manifest.get("allowed_origins").and_then(|v| v.as_array())
                .map(|items| items.iter().any(|item| item.as_str() == Some(origin.as_str()))).unwrap_or(false);
            let host = manifest.get("path").and_then(|v| v.as_str())
                .map(|path| PathBuf::from(path).is_file()).unwrap_or(false);
            allowed && host
        })
        .unwrap_or(false);
    if manifest_ok && saved_id().as_deref() == Some(EXTENSION_ID) { return Ok(false); }
    register(app, EXTENSION_ID)?;
    Ok(true)
}

pub fn open_folder(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let folder = resource(app, "resources/browser-extension")?;
    if !folder.join("manifest.json").is_file() {
        return Err("Расширение не найдено в установке. Переустановите Малению.".into());
    }
    app.opener().open_path(folder.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|_| "Не удалось открыть папку расширения.".into())
}

pub fn register(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let _guard = REGISTRATION_LOCK.try_lock().map_err(|_| "Настройка уже выполняется. Подождите её завершения.")?;
    if !valid_id(id) { return Err("ID должен содержать 32 строчные буквы от a до p.".into()); }
    if !cfg!(windows) { return Err("Настройка связи поддерживается в Windows.".into()); }
    let script = resource(app, "resources/browser-setup/register_browser_bridge.ps1")?;
    let host = resource(app, "resources/malenia-native-host/malenia-native-host.exe")?;
    let source = fs::read(&script).map_err(|_| "Не найден файл настройки браузера.")?;
    if !trusted_registration(&source) {
        return Err("Файл настройки повреждён. Переустановите Малению.".into());
    }
    if !host.is_file() || !host.parent().is_some_and(|parent| parent.join("_internal").is_dir()) {
        return Err("Не найден встроенный компонент связи. Переустановите Малению.".into());
    }
    // Use the system PowerShell and fixed bundled script; never a shell-built command.
    let powershell = PathBuf::from(std::env::var_os("SystemRoot")
        .unwrap_or_else(|| r"C:\Windows".into()))
        .join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let mut command = Command::new(powershell);
    command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script).arg("-ExtensionId").arg(id).arg("-NativeHostPath").arg(host)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let exit = command.status().map_err(|_| "Не удалось запустить настройку связи с браузером.")?;
    if !exit.success() || saved_id().as_deref() != Some(id) {
        return Err("Регистрация не завершилась. Проверьте ограничения Windows и повторите попытку.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_extension_id_is_valid() {
        assert!(valid_id(EXTENSION_ID));
    }

    #[test]
    fn accepts_only_extension_ids_not_paths_or_commands() {
        assert!(valid_id(&"a".repeat(32)));
        assert!(valid_id(&"p".repeat(32)));
        for invalid in ["", "../register.ps1", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"] {
            assert!(!valid_id(invalid), "{invalid:?}");
        }
    }
    #[test]
    fn accepts_pinned_registration_and_rejects_modified_scripts() {
        let source = include_bytes!("../../../packaging/register_browser_bridge.ps1");
        assert!(trusted_registration(source));
        let mut modified = source.to_vec();
        modified.extend_from_slice(b"\nWrite-Output altered");
        assert!(!trusted_registration(&modified));
        assert!(!trusted_registration(b""));
        assert!(!trusted_registration("неизвестный скрипт".as_bytes()));
    }
}
