//! Everyday comfort: tray icon, quick-ask window on a global hotkey, start with
//! Windows, notifications and updates from GitHub Releases.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

pub const HIDDEN_ARG: &str = "--hidden";
pub const QUIT_ARG: &str = "--quit";
const RELEASES: &str = "https://api.github.com/repos/DoctorStrangeSH/Malenia/releases/latest";
const MAX_INSTALLER: u64 = 400 * 1024 * 1024;

static TRAY_HINT_SHOWN: AtomicBool = AtomicBool::new(false);
static LAST_UI_BEAT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The page reports that it is alive every few seconds.
#[tauri::command]
pub fn ui_alive() { LAST_UI_BEAT.store(now_secs(), Ordering::SeqCst); }

/// If the page in the main window died (for example WebView2 ran out of memory
/// and shows a blank or error page), load the app again instead of leaving
/// the user with a white screen.
pub fn start_ui_watchdog(app: &AppHandle) {
    let app = app.clone();
    LAST_UI_BEAT.store(now_secs(), Ordering::SeqCst);
    // The app's own address, remembered while the page is healthy.
    let home = app.get_webview_window("main").and_then(|w| w.url().ok());
    std::thread::spawn(move || {
        let mut visible_since: Option<u64> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(10));
            if quitting() { return; }
            let Some(window) = app.get_webview_window("main") else { continue };
            let shown = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
            let now = now_secs();
            if !shown { visible_since = None; continue; }
            let since = *visible_since.get_or_insert(now);
            let silent = now.saturating_sub(LAST_UI_BEAT.load(Ordering::SeqCst));
            if now.saturating_sub(since) >= 20 && silent >= 45 {
                let fallback: Option<tauri::Url> = if cfg!(windows) { "http://tauri.localhost/".parse().ok() } else { "tauri://localhost/".parse().ok() };
                if let Some(target) = home.clone().filter(|u| u.scheme() != "about").or(fallback) {
                    let _ = window.navigate(target);
                }
                LAST_UI_BEAT.store(now, Ordering::SeqCst);
                visible_since = Some(now);
            }
        }
    });
}
static QUITTING: AtomicBool = AtomicBool::new(false);
static HOTKEY: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

pub fn quitting() -> bool { QUITTING.load(Ordering::SeqCst) }

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Stop the agent and leave for real (tray "Выход", `Malenia.exe --quit`, updates).
pub fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.state::<crate::AgentState>().shutdown();
    app.exit(0);
}

/// Closing the main window keeps Malenia running in the tray, like messengers do,
/// so long inventory checks continue in the background.
pub fn hide_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if !TRAY_HINT_SHOWN.swap(true, Ordering::SeqCst) {
        let _ = app.notification().builder()
            .title("Маления работает в фоне")
            .body("Открыть — значок в трее или Alt+Space. Выйти — правой кнопкой по значку → «Выход».")
            .show();
    }
}

pub fn toggle_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("quick") {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return;
    }
    let built = WebviewWindowBuilder::new(app, "quick", WebviewUrl::App("index.html#quick".into()))
        .title("Маления — быстрый вопрос")
        .inner_size(680.0, 560.0)
        .min_inner_size(420.0, 360.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build();
    if let Ok(window) = built {
        let handle = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = handle.hide();
            }
        });
    }
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let open = MenuItem::with_id(handle, "open", "Открыть Малению", true, None::<&str>)?;
    let quick = MenuItem::with_id(handle, "quick", "Быстрый вопрос", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let exit = MenuItem::with_id(handle, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&open, &quick, &separator, &exit])?;
    let mut tray = TrayIconBuilder::with_id("malenia")
        .tooltip("Маления")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quick" => toggle_quick(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = handle.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(handle)?;

    // Alt+Space like ChatGPT; fall back to Ctrl+Alt+Space if it is taken.
    // Registered off the main thread once the event loop runs (never blocks startup).
    let later = handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let shortcuts = later.global_shortcut();
        for (modifiers, label) in [(Modifiers::ALT, "Alt+Space"), (Modifiers::CONTROL | Modifiers::ALT, "Ctrl+Alt+Space")] {
            if shortcuts.register(Shortcut::new(Some(modifiers), Code::Space)).is_ok() {
                if let Ok(mut current) = HOTKEY.lock() { *current = label.to_string(); }
                break;
            }
        }
    });
    Ok(())
}

pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_quick(app);
            }
        })
        .build()
}

// ---- commands -------------------------------------------------------------

#[tauri::command]
pub fn comfort_status(app: AppHandle) -> Value {
    json!({
        "autostart": app.autolaunch().is_enabled().unwrap_or(false),
        "hotkey": HOTKEY.lock().map(|h| h.clone()).unwrap_or_default(),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    let result = if enabled { manager.enable() } else { manager.disable() };
    result.map_err(|_| "Не удалось изменить автозапуск".to_string())?;
    Ok(manager.is_enabled().unwrap_or(enabled))
}

/// A system notification, shown only when Malenia is not in front of the user.
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String, force: Option<bool>) -> Result<(), String> {
    let focused = ["main", "quick"].iter().any(|label| app.get_webview_window(label)
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)).unwrap_or(false));
    if focused && !force.unwrap_or(false) {
        return Ok(());
    }
    let title: String = title.chars().take(80).collect();
    let body: String = body.chars().take(240).collect();
    app.notification().builder().title(title).body(body).show().map_err(|_| "Уведомление не показано".to_string())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) { show_main(&app); }

#[tauri::command]
pub fn hide_quick_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("quick") { let _ = window.hide(); }
}

fn version_tuple(text: &str) -> Vec<u64> {
    text.trim_start_matches('v').split(|c: char| c == '.' || c == '-')
        .take(3).map(|part| part.parse().unwrap_or(0)).collect()
}

pub fn is_newer(candidate: &str, current: &str) -> bool { version_tuple(candidate) > version_tuple(current) }

fn client(timeout: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .user_agent(concat!("Malenia/", env!("CARGO_PKG_VERSION")))
        .build().map_err(|_| "Не удалось подготовить проверку обновлений".to_string())
}

fn latest_release() -> Result<Value, String> {
    let response = client(20)?.get(RELEASES).header("Accept", "application/vnd.github+json").send()
        .map_err(|_| "Нет связи с GitHub".to_string())?;
    if response.status().as_u16() == 404 { return Ok(json!({})); }
    if !response.status().is_success() { return Err("GitHub не ответил на проверку обновлений".to_string()); }
    response.json::<Value>().map_err(|_| "Некорректный ответ GitHub".to_string())
}

fn asset<'a>(release: &'a Value, predicate: impl Fn(&str) -> bool) -> Option<&'a Value> {
    release.get("assets")?.as_array()?.iter()
        .find(|item| item.get("name").and_then(Value::as_str).map(&predicate).unwrap_or(false))
}

#[tauri::command]
pub async fn check_update() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let release = latest_release()?;
        let tag = release.get("tag_name").and_then(Value::as_str).unwrap_or("");
        let current = env!("CARGO_PKG_VERSION");
        let installer = asset(&release, |name| name.ends_with("-setup.exe"));
        let available = !tag.is_empty() && is_newer(tag, current) && installer.is_some();
        let notes: String = release.get("body").and_then(Value::as_str).unwrap_or("").chars().take(4000).collect();
        Ok(json!({"available": available, "current": current, "version": tag.trim_start_matches('v'), "notes": notes}))
    }).await.map_err(|_| "Проверка обновлений прервалась".to_string())?
}

/// Download the installer from the latest release, verify its SHA-256 against
/// SHA256SUMS.txt from the same release, start it and exit.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let path = tauri::async_runtime::spawn_blocking(|| -> Result<std::path::PathBuf, String> {
        let release = latest_release()?;
        let tag = release.get("tag_name").and_then(Value::as_str).unwrap_or("");
        if !is_newer(tag, env!("CARGO_PKG_VERSION")) { return Err("Установлена последняя версия".to_string()); }
        let installer = asset(&release, |name| name.ends_with("-setup.exe")).ok_or("В релизе нет установщика")?;
        let sums = asset(&release, |name| name == "SHA256SUMS.txt").ok_or("В релизе нет контрольных сумм")?;
        let name = installer.get("name").and_then(Value::as_str).unwrap_or("");
        if name.contains(['/', '\\']) || name.contains("..") { return Err("Некорректное имя файла".to_string()); }
        let url = |item: &Value| item.get("browser_download_url").and_then(Value::as_str).unwrap_or("").to_string();
        let http = client(900)?;
        let sums_text = http.get(url(sums)).send().and_then(|r| r.error_for_status()).and_then(|r| r.text())
            .map_err(|_| "Не удалось скачать контрольные суммы".to_string())?;
        let expected = sums_text.lines().find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let file = parts.next()?.trim_start_matches('*');
            (file == name).then(|| hash.to_ascii_lowercase())
        }).ok_or("Нет контрольной суммы установщика")?;
        let mut response = http.get(url(installer)).send().and_then(|r| r.error_for_status())
            .map_err(|_| "Не удалось скачать обновление".to_string())?;
        let mut bytes = Vec::new();
        (&mut response).take(MAX_INSTALLER + 1).read_to_end(&mut bytes).map_err(|_| "Загрузка прервалась".to_string())?;
        if bytes.len() as u64 > MAX_INSTALLER { return Err("Установщик слишком большой".to_string()); }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != expected { return Err("Файл обновления повреждён — не устанавливаю".to_string()); }
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, &bytes).map_err(|_| "Не удалось сохранить обновление".to_string())?;
        Ok(path)
    }).await.map_err(|_| "Обновление прервалось".to_string())??;
    std::process::Command::new(&path).spawn().map_err(|_| "Не удалось запустить установщик".to_string())?;
    quit(&app);
    Ok(())
}

pub fn autostart_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG]))
}

#[cfg(test)]
mod tests {
    use super::is_newer;
    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("v0.14.0", "0.13.0"));
        assert!(is_newer("0.13.10", "0.13.9"));
        assert!(!is_newer("v0.13.0", "0.13.0"));
        assert!(!is_newer("v0.9.9", "0.13.0"));
    }
}
