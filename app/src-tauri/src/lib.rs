// SPDX-License-Identifier: AGPL-3.0-or-later
//! OpenPrintHQ Cloud Client — a thin tray / menu-bar app that supervises the
//! bundled connector agent (a zero-dependency Node process) and gives the user
//! status, token entry, "open dashboard", a connectivity self-test, and an
//! update check.
//!
//! The same agent can also be run headlessly by the platform service
//! (Windows Service / launchd LaunchDaemon / systemd) for boot-without-login.
//! When such a service is detected running, this app monitors rather than
//! spawning its own copy, so the connector is never double-started.

use std::collections::HashMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// The releases LIST endpoint (newest first), NOT /releases/latest: Gitea's
// `/latest` only returns a STABLE release and 404s when every release is a
// prerelease (which ours are, during beta) — that 404 was surfacing as
// "Update check failed". The list endpoint returns prereleases too.
pub const REPO_API: &str =
    "https://api.github.com/repos/norjms/openprinthq-cloud-client/releases?per_page=10";
pub const RELEASES_URL: &str =
    "https://github.com/norjms/openprinthq-cloud-client/releases";

/// Set when the user chooses Quit, so the tray-keepalive doesn't veto the exit.
static QUITTING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    #[serde(default)]
    pub control_url: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub allow: String,
    #[serde(default)]
    pub allow_ports: String,
    #[serde(default)]
    pub log_url: String,
    #[serde(default)]
    pub signing_pubkey: String,
    /// Optional "host" or "host:port" used by the connectivity self-test.
    #[serde(default)]
    pub test_printer: String,
    /// Verbose connector logging (sets OPHQ_DEBUG for the agent).
    #[serde(default)]
    pub debug: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct ConnectorStatus {
    pub running: bool,
    pub connected: bool,
    pub managed_by_service: bool,
    pub message: String,
}

pub struct AppState {
    config_path: PathBuf,
    key_path: PathBuf,
    status: Mutex<ConnectorStatus>,
    desired: AtomicBool,
    loop_running: AtomicBool,
    child: Mutex<Option<CommandChild>>,
    tray_status_item: Mutex<Option<MenuItem<Wry>>>,
    logs: Mutex<std::collections::VecDeque<String>>,
}

impl AppState {
    fn push_log(&self, line: &str) {
        let mut l = self.logs.lock().unwrap();
        for part in line.split('\n') {
            let t = part.trim_end();
            if t.is_empty() {
                continue;
            }
            Self::append_log_file(t);
            l.push_back(t.to_string());
            while l.len() > 800 {
                l.pop_front();
            }
        }
    }

    /// Mirror the connector's output to a file next to its config.
    ///
    /// The in-memory ring buffer above is only visible in the app window, which
    /// is no help when the machine is remote, when the app is running headless,
    /// or when diagnosing something that happened before anyone opened the UI.
    /// Capped so an unattended connector cannot fill the disk.
    fn append_log_file(line: &str) {
        use std::io::Write;
        let dir = std::path::PathBuf::from(
            std::env::var("PROGRAMDATA").unwrap_or_else(|_| "/var/lib".into()),
        )
        .join("openprinthq");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("connector.log");
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > 8 * 1024 * 1024 {
                let _ = std::fs::rename(&path, dir.join("connector.log.1"));
            }
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{} {}", chrono_now(), line);
        }
    }
}

impl AppState {
    fn set_status(&self, app: &AppHandle, mutate: impl FnOnce(&mut ConnectorStatus)) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            mutate(&mut s);
            s.clone()
        };
        if let Some(item) = self.tray_status_item.lock().unwrap().as_ref() {
            let label = if snapshot.managed_by_service {
                "Status: managed by service".to_string()
            } else if snapshot.connected {
                "Status: connected".to_string()
            } else if snapshot.running {
                format!("Status: {}", short(&snapshot.message))
            } else {
                "Status: stopped".to_string()
            };
            let _ = item.set_text(label);
        }
        let _ = app.emit("connector-status", &snapshot);
    }
}

fn short(s: &str) -> String {
    if s.chars().count() > 40 {
        let t: String = s.chars().take(40).collect();
        format!("{t}…")
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------------
// Config file location: prefer a machine-wide dir (shared with the service),
// fall back to the user's app-config dir when that isn't writable.
// ---------------------------------------------------------------------------
fn machine_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
        PathBuf::from(base).join("OpenPrintHQ")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/OpenPrintHQ")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        PathBuf::from("/etc/openprinthq")
    }
}

fn dir_writable(dir: &PathBuf) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".ophq-write-test");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn resolve_config_dir(app: &AppHandle) -> PathBuf {
    let m = machine_dir();
    let user = app.path().app_config_dir().ok();

    // READ path must not depend on WRITE access. A tray app running as the
    // logged-in user often cannot write-probe the machine dir (SYSTEM-owned
    // after a service/elevated install), which previously made it silently
    // fall back to an empty user dir and show blank settings even though a
    // populated config already existed in the machine dir (issue #3).
    // So: if a config.json already exists somewhere, always read from there.
    if m.join("config.json").exists() {
        return m;
    }
    if let Some(ref u) = user {
        if u.join("config.json").exists() {
            return u.clone();
        }
    }

    // No config yet (fresh install): choose the most durable writable dir,
    // preferring the machine-wide dir so a later service shares it.
    if dir_writable(&m) {
        return m;
    }
    if let Some(u) = user {
        let _ = std::fs::create_dir_all(&u);
        return u;
    }
    m
}

fn load_config(path: &PathBuf) -> Config {
    match std::fs::read_to_string(path) {
        Ok(txt) => serde_json::from_str(&txt).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

fn save_config_file(path: &PathBuf, cfg: &Config) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let txt = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, txt).map_err(|e| e.to_string())
}

fn agent_env(cfg: &Config, key_path: &PathBuf) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if !cfg.control_url.is_empty() {
        env.insert("OPHQ_CONTROL_URL".into(), cfg.control_url.clone());
    }
    if !cfg.token.is_empty() {
        env.insert("OPHQ_CONNECTOR_TOKEN".into(), cfg.token.clone());
    }
    let name = if cfg.name.is_empty() {
        "cloud-client".into()
    } else {
        cfg.name.clone()
    };
    env.insert("OPHQ_CONNECTOR_NAME".into(), name);
    if !cfg.allow.is_empty() {
        env.insert("OPHQ_ALLOW".into(), cfg.allow.clone());
    }
    // Opt-in log shipping. Empty means the connector ships nothing, which is the
    // default: these logs describe the user's own printers and network, so the
    // destination is theirs to choose and there is no vendor fallback.
    if !cfg.log_url.is_empty() {
        env.insert("OPHQ_LOG_URL".into(), cfg.log_url.clone());
    }
    if !cfg.allow_ports.is_empty() {
        env.insert("OPHQ_ALLOW_PORTS".into(), cfg.allow_ports.clone());
    }
    if !cfg.signing_pubkey.is_empty() {
        env.insert("OPHQ_SIGNING_PUBKEY".into(), cfg.signing_pubkey.clone());
    }
    env.insert(
        "OPHQ_CLIENT_KEY_FILE".into(),
        key_path.to_string_lossy().to_string(),
    );
    if cfg.debug {
        env.insert("OPHQ_DEBUG".into(), "1".into());
    }
    env
}

fn agent_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("agent").join("src").join("agent.js"))
}

// ---------------------------------------------------------------------------
// Detect a platform service already running the connector.
// ---------------------------------------------------------------------------
fn service_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("sc")
            .args(["query", "OpenPrintHQConnector"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("RUNNING"))
            .unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("launchctl")
            .args(["print", "system/com.openprinthq.connector"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("systemctl")
            .args(["is-active", "--quiet", "openprinthq-connector"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// Supervisor: keep the agent alive with exponential backoff while `desired`.
// ---------------------------------------------------------------------------
fn ensure_supervisor(app: AppHandle, st: Arc<AppState>) {
    st.desired.store(true, Ordering::SeqCst);
    if st.loop_running.swap(true, Ordering::SeqCst) {
        return; // a loop is already running
    }
    tauri::async_runtime::spawn(async move {
        let mut backoff_ms: u64 = 2000;
        while st.desired.load(Ordering::SeqCst) {
            match run_agent_once(&app, &st).await {
                Ok(_) => backoff_ms = 2000,
                Err(e) => {
                    st.set_status(&app, |s| {
                        s.connected = false;
                        s.message = e.clone();
                    });
                }
            }
            if !st.desired.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms as f64 * 1.7).min(30000.0) as u64;
        }
        st.loop_running.store(false, Ordering::SeqCst);
        st.set_status(&app, |s| {
            s.running = false;
            s.connected = false;
            if s.message.is_empty() {
                s.message = "stopped".into();
            }
        });
    });
}

async fn run_agent_once(app: &AppHandle, st: &Arc<AppState>) -> Result<(), String> {
    let cfg = load_config(&st.config_path);
    if cfg.control_url.is_empty() || cfg.token.is_empty() {
        st.set_status(app, |s| {
            s.running = false;
            s.connected = false;
            s.message = "not configured — paste your instance URL and token".into();
        });
        tokio::time::sleep(Duration::from_secs(5)).await;
        return Ok(());
    }

    let script = agent_script(app)?;
    let mut env = agent_env(&cfg, &st.key_path);

    // Camera relay (OctoEverywhere-style): tell the agent where the bundled
    // go2rtc / ffmpeg sidecars live so it can hold the printer camera locally
    // and relay frames up. Sidecars are installed next to the app executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            let ext = if cfg!(windows) { ".exe" } else { "" };
            let go2rtc = bin_dir.join(format!("go2rtc{}", ext));
            let ffmpeg = bin_dir.join(format!("ffmpeg{}", ext));
            if go2rtc.exists() {
                env.insert("OPHQ_GO2RTC_BIN".into(), go2rtc.to_string_lossy().to_string());
            }
            if ffmpeg.exists() {
                env.insert("OPHQ_FFMPEG_BIN".into(), ffmpeg.to_string_lossy().to_string());
            }
        }
    }

    let (mut rx, child) = app
        .shell()
        .sidecar("ophq-node")
        .map_err(|e| e.to_string())?
        .args([script.to_string_lossy().to_string()])
        .envs(env)
        .spawn()
        .map_err(|e| e.to_string())?;

    *st.child.lock().unwrap() = Some(child);
    st.set_status(app, |s| {
        s.running = true;
        s.connected = false;
        s.message = "starting…".into();
    });

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) | CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                st.push_log(&line);
                update_from_line(app, st, &line);
            }
            CommandEvent::Terminated(_) => break,
            CommandEvent::Error(e) => {
                st.set_status(app, |s| s.message = e.clone());
            }
            _ => {}
        }
    }
    *st.child.lock().unwrap() = None;
    Ok(())
}

fn update_from_line(app: &AppHandle, st: &Arc<AppState>, line: &str) {
    if line.contains("connected to") {
        st.set_status(app, |s| {
            s.connected = true;
            s.running = true;
            s.message = "connected — waiting for jobs".into();
        });
    } else if line.contains("disconnected") {
        st.set_status(app, |s| {
            s.connected = false;
            s.message = "reconnecting…".into();
        });
    } else if line.contains("FATAL") || line.contains("rejected the connector") {
        let msg = line
            .split_once("FATAL:")
            .map(|(_, m)| m.trim())
            .unwrap_or(line)
            .to_string();
        st.set_status(app, |s| {
            s.connected = false;
            s.message = short(&msg);
        });
    }
}

fn stop_connector_internal(st: &Arc<AppState>) {
    st.desired.store(false, Ordering::SeqCst);
    if let Some(child) = st.child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (called from the webview UI).
// ---------------------------------------------------------------------------
#[tauri::command]
fn get_config(state: State<'_, Arc<AppState>>) -> Config {
    load_config(&state.config_path)
}

#[tauri::command]
fn get_status(state: State<'_, Arc<AppState>>) -> ConnectorStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    config: Config,
) -> Result<(), String> {
    save_config_file(&state.config_path, &config)?;
    let st = state.inner().clone();
    stop_connector_internal(&st);
    if !st.status.lock().unwrap().managed_by_service {
        ensure_supervisor(app, st);
    }
    Ok(())
}

#[tauri::command]
fn start_connector(app: AppHandle, state: State<'_, Arc<AppState>>) {
    let st = state.inner().clone();
    ensure_supervisor(app, st);
}

#[tauri::command]
fn stop_connector(app: AppHandle, state: State<'_, Arc<AppState>>) {
    let st = state.inner().clone();
    stop_connector_internal(&st);
    st.set_status(&app, |s| {
        s.running = false;
        s.connected = false;
        s.message = "stopped".into();
    });
}

#[tauri::command]
fn open_dashboard(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let cfg = load_config(&state.config_path);
    let url = if cfg.control_url.is_empty() {
        "https://openprinthq.com".to_string()
    } else {
        cfg.control_url
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_logs(state: State<'_, Arc<AppState>>) -> Vec<String> {
    state.logs.lock().unwrap().iter().cloned().collect()
}

#[derive(Serialize)]
pub struct UpdateInfo {
    current: String,
    latest: String,
    up_to_date: bool,
    url: String,
}

/// Check the repo's latest release. Done in Rust (not the webview) so it isn't
/// blocked by CORS — the WebKit webview can't fetch the Gitea API cross-origin.
#[tauri::command]
async fn check_update() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = env!("CARGO_PKG_VERSION").to_string();
        let json: serde_json::Value = ureq::get(REPO_API)
            .set("accept", "application/vnd.github+json")
            // GitHub's API rejects requests without a User-Agent (HTTP 403),
            // so this header is required, not optional.
            .set("user-agent", concat!("openprinthq-cloud-client/", env!("CARGO_PKG_VERSION")))
            .set("x-github-api-version", "2022-11-28")
            .timeout(std::time::Duration::from_secs(12))
            .call()
            .map_err(|e| format!("network error: {e}"))?
            .into_json()
            .map_err(|e| format!("bad response: {e}"))?;
        // Newest non-draft release (prereleases included).
        let rel = json
            .as_array()
            .and_then(|arr| arr.iter().find(|r| !r.get("draft").and_then(|v| v.as_bool()).unwrap_or(false)))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let latest = rel
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_start_matches('v')
            .to_string();
        let url = rel
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or(RELEASES_URL)
            .to_string();
        let up_to_date = latest.is_empty() || latest == current;
        Ok(UpdateInfo {
            current,
            latest,
            up_to_date,
            url,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn chrono_now() -> String {
    // Seconds since the epoch is enough to correlate with server-side logs and
    // avoids adding a date dependency for one line of output.
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => format!("[{}]", d.as_secs()),
        Err(_) => "[?]".to_string(),
    }
}

#[derive(Serialize, Deserialize)]
pub struct ValidateResult {
    ok: bool,
    status: u16,
    reason: String,
}

/// Onboarding pre-check: confirm the instance URL is reachable and the token is
/// accepted, before saving.
///
/// This delegates to the bundled agent (`agent.js --validate`) rather than
/// making the request here. Once the control-plane has locked onto a client key
/// (trust-on-first-use), it requires every connect to carry a signature over
/// `token.timestamp`. The private key lives with the agent, so a check made
/// from this process cannot sign and is rejected with 401 even when the token
/// is valid — which made the wizard tell users to reset a working pairing.
/// The agent can sign, so it can answer truthfully.
#[tauri::command]
async fn validate_connection(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
    token: String,
) -> Result<ValidateResult, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Ok(ValidateResult { ok: false, status: 0, reason: "Enter your instance URL.".into() });
    }
    if token.trim().is_empty() {
        return Ok(ValidateResult { ok: false, status: 0, reason: "Enter your connector token.".into() });
    }
    let script = agent_script(&app)?;
    let mut env = HashMap::new();
    env.insert(
        "OPHQ_CLIENT_KEY_FILE".to_string(),
        state.key_path.to_string_lossy().to_string(),
    );
    env.insert("OPHQ_CONTROL_URL".to_string(), base.clone());
    env.insert("OPHQ_CONNECTOR_TOKEN".to_string(), token.trim().to_string());
    let out = app
        .shell()
        .sidecar("ophq-node")
        .map_err(|e| e.to_string())?
        .args([script.to_string_lossy().to_string(), "--validate".to_string()])
        .envs(env)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match serde_json::from_str::<ValidateResult>(&text) {
        Ok(v) => Ok(v),
        Err(_) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Ok(ValidateResult {
                ok: false,
                status: 0,
                reason: if err.is_empty() {
                    "Could not run the connection check.".to_string()
                } else {
                    format!("Could not run the connection check. ({err})")
                },
            })
        }
    }
}

/// Print this connector's public key (for Settings → Connectors → Key).
#[tauri::command]
async fn connector_pubkey(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let script = agent_script(&app)?;
    let mut env = HashMap::new();
    env.insert(
        "OPHQ_CLIENT_KEY_FILE".to_string(),
        state.key_path.to_string_lossy().to_string(),
    );
    let out = app
        .shell()
        .sidecar("ophq-node")
        .map_err(|e| e.to_string())?
        .args([script.to_string_lossy().to_string(), "--pubkey".to_string()])
        .envs(env)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    } else {
        Ok(text)
    }
}

#[derive(Serialize)]
pub struct SelfTest {
    cloud_ok: bool,
    cloud_detail: String,
    printer_ok: Option<bool>,
    printer_detail: String,
}

fn tcp_ok(host: &str, port: u16) -> Result<(), String> {
    let addr = format!("{host}:{port}");
    let mut addrs = addr
        .to_socket_addrs()
        .map_err(|e| format!("cannot resolve {host}: {e}"))?;
    let sa = addrs.next().ok_or_else(|| format!("no address for {host}"))?;
    TcpStream::connect_timeout(&sa, Duration::from_secs(6))
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn run_self_test(state: State<'_, Arc<AppState>>) -> SelfTest {
    let cfg = load_config(&state.config_path);
    let (chost, cport) = split_url_host(&cfg.control_url);
    let (cloud_ok, cloud_detail) = match tcp_ok(&chost, cport) {
        Ok(_) => (true, format!("reached {chost}:{cport}")),
        Err(e) => (false, e),
    };
    let (printer_ok, printer_detail) = if cfg.test_printer.trim().is_empty() {
        (None, "no test printer set".into())
    } else {
        let (phost, pport) = split_hostport(&cfg.test_printer, 80);
        match tcp_ok(&phost, pport) {
            Ok(_) => (Some(true), format!("reached {phost}:{pport}")),
            Err(e) => (Some(false), e),
        }
    };
    SelfTest {
        cloud_ok,
        cloud_detail,
        printer_ok,
        printer_detail,
    }
}

fn split_url_host(url: &str) -> (String, u16) {
    let u = url.trim();
    let rest = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .unwrap_or(u);
    let port = if u.starts_with("http://") { 80 } else { 443 };
    let hostport = rest.split('/').next().unwrap_or(rest);
    split_hostport(hostport, port)
}

fn split_hostport(hp: &str, default_port: u16) -> (String, u16) {
    match hp.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(default_port)),
        None => (hp.to_string(), default_port),
    }
}

// ---------------------------------------------------------------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // Login auto-start launches with --hidden so the app comes up quietly
            // in the tray. A manual / installer launch (no --hidden) shows the
            // window; see the first-run logic in setup().
            Some(vec!["--hidden"]),
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = resolve_config_dir(&handle);
            let _ = std::fs::create_dir_all(&config_dir);
            let state = Arc::new(AppState {
                config_path: config_dir.join("config.json"),
                key_path: config_dir.join("connector-key.pem"),
                status: Mutex::new(ConnectorStatus::default()),
                desired: AtomicBool::new(false),
                loop_running: AtomicBool::new(false),
                child: Mutex::new(None),
                tray_status_item: Mutex::new(None),
                logs: Mutex::new(std::collections::VecDeque::new()),
            });
            app.manage(state.clone());

            // Relaunch the tray app at login (best-effort).
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // ---- tray menu ----
            let status_i =
                MenuItem::with_id(app, "status", "Status: starting…", false, None::<&str>)?;
            *state.tray_status_item.lock().unwrap() = Some(status_i.clone());
            let open_i =
                MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let update_i =
                MenuItem::with_id(app, "check_update", "Check for Updates…", true, None::<&str>)?;
            let start_i = MenuItem::with_id(app, "start", "Start Connector", true, None::<&str>)?;
            let stop_i = MenuItem::with_id(app, "stop", "Stop Connector", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &status_i,
                    &PredefinedMenuItem::separator(app)?,
                    &open_i,
                    &settings_i,
                    &update_i,
                    &PredefinedMenuItem::separator(app)?,
                    &start_i,
                    &stop_i,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_i,
                ],
            )?;

            // Dedicated tray/menu-bar mark (the OpenPrintHQ logo). On macOS the
            // menu bar wants a monochrome template that adapts to light/dark; on
            // Windows/Linux the tray sits on a dark taskbar, so we use the
            // solid-white-background mark (matches the app icon) for visibility.
            #[cfg(target_os = "macos")]
            let (tray_bytes, as_template): (&[u8], bool) =
                (include_bytes!("../icons/tray.png").as_slice(), true);
            #[cfg(not(target_os = "macos"))]
            let (tray_bytes, as_template): (&[u8], bool) =
                (include_bytes!("../icons/tray-solid.png").as_slice(), false);
            let tray_icon = match tauri::image::Image::from_bytes(tray_bytes) {
                Ok(img) => img,
                Err(_) => app
                    .default_window_icon()
                    .cloned()
                    .expect("bundled default window icon"),
            };
            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(as_template)
                .tooltip("OpenPrintHQ Cloud Client")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open_dashboard" => {
                        let st = app.state::<Arc<AppState>>();
                        let cfg = load_config(&st.config_path);
                        let url = if cfg.control_url.is_empty() {
                            "https://openprinthq.com".to_string()
                        } else {
                            cfg.control_url
                        };
                        let _ = app.opener().open_url(url, None::<&str>);
                    }
                    "settings" => show_window(app),
                    "check_update" => {
                        show_window(app);
                        let _ = app.emit("open-updates", ());
                    }
                    "start" => {
                        let st = app.state::<Arc<AppState>>().inner().clone();
                        ensure_supervisor(app.clone(), st);
                    }
                    "stop" => {
                        let st = app.state::<Arc<AppState>>().inner().clone();
                        stop_connector_internal(&st);
                        st.set_status(app, |s| {
                            s.running = false;
                            s.connected = false;
                            s.message = "stopped".into();
                        });
                    }
                    "quit" => {
                        let st = app.state::<Arc<AppState>>().inner().clone();
                        stop_connector_internal(&st);
                        QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Hide (don't quit) when the window is closed.
            if let Some(win) = app.get_webview_window("main") {
                let w = win.clone();
                win.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            // macOS: run as a menu-bar-only (accessory) app — no Dock icon.
            // Windows/Linux get the same "tray only, no taskbar button" effect
            // from the window's skipTaskbar setting in tauri.conf.json.
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Whether to show the window on launch:
            //  - login auto-start passes --hidden -> stay in the tray, UNLESS
            //    this is a first run with no token yet (then show so the user
            //    can configure).
            //  - a manual / installer launch (no --hidden) always shows.
            let launched_hidden = std::env::args().any(|a| a == "--hidden");
            let has_token = !load_config(&state.config_path).token.trim().is_empty();
            if !launched_hidden || !has_token {
                show_window(&handle);
            }

            // If a platform service already runs the connector, monitor only;
            // otherwise supervise our own copy.
            if service_running() {
                state.set_status(&handle, |s| {
                    s.managed_by_service = true;
                    s.running = true;
                    s.message = "managed by background service".into();
                });
            } else {
                ensure_supervisor(handle, state.clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_status,
            save_config,
            start_connector,
            stop_connector,
            open_dashboard,
            connector_pubkey,
            run_self_test,
            app_version,
            open_external,
            get_logs,
            check_update,
            validate_connection
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpenPrintHQ Cloud Client")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}

fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        // Raise reliably to the front even for a menu-bar (accessory) app: a
        // brief always-on-top toggle pulls it above other windows without
        // permanently pinning it.
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
        let _ = win.set_always_on_top(false);
    }
}
