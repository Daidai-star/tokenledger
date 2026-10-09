// TokenLedger 桌面壳。
//
// 职责很薄，只有四件事：
//   1. 挑一个空闲端口，拉起随包分发的 Node 后端
//   2. 等它开始监听
//   3. 用系统 WebView 打开本地地址
//   4. 退出时收掉子进程
//
// 所有统计逻辑都在 Node 侧，这里不碰业务。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WindowEvent};

/// 随包分发的后端子进程，退出时要杀掉
static SERVER: Mutex<Option<Child>> = Mutex::new(None);

/// sidecar 资源目录。各平台下 .app / .exe 内的资源位置不同，交给 Tauri 解析。
fn resource_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .resource_dir()
        .expect("无法定位资源目录")
        .join("sidecar")
}

/// 向系统要一个当前空闲的端口。
///
/// 监听后立刻释放再交给子进程，中间有极小的竞争窗口；
/// 但同一时刻只可能有本应用在挑端口，且失败时下面会重试，风险可忽略。
fn pick_free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// 拉起后端，返回它监听的端口。
fn spawn_server(app: &tauri::AppHandle) -> Result<u16, String> {
    let sidecar = resource_dir(app);
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(sidecar.join("rt.json")).map_err(|e| e.to_string())?)
            .map_err(|e| format!("rt.json 解析失败：{e}"))?;
    let binary = meta["binary"].as_str().unwrap_or("node");

    let node = sidecar.join("runtime").join(binary);
    let server = sidecar.join("server.mjs");
    if !node.exists() {
        return Err(format!("缺少 Node 运行时：{}", node.display()));
    }
    if !server.exists() {
        return Err(format!("缺少后端脚本：{}", server.display()));
    }

    // 数据目录走系统标准位置：mac 的 Application Support / win 的 AppData
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data");

    let mut last_err = String::from("未知错误");
    for _ in 0..3 {
        let port = match pick_free_port() {
            Ok(p) => p,
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };
        let child = Command::new(&node)
            .arg(&server)
            .env("PORT", port.to_string())
            .env("TOKENLEDGER_UI", sidecar.join("ui"))
            .env("TOKENLEDGER_DATA", &data_dir)
            .env("TOKENLEDGER_HOST", "127.0.0.1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn();

        let child = match child {
            Ok(c) => c,
            Err(e) => {
                last_err = format!("启动后端失败：{e}");
                continue;
            }
        };
        let pid = child.id();
        *SERVER.lock().unwrap() = Some(child);

        if wait_for_port(port, Duration::from_secs(20)) {
            eprintln!("[shell] 后端就绪 pid={pid} port={port}");
            return Ok(port);
        }
        // 端口被抢走或后端起不来：杀掉重试
        kill_server();
        last_err = format!("后端在端口 {port} 上未就绪");
    }
    Err(last_err)
}

/// 轮询直到后端响应健康检查，或超时。
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if probe(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

/// 发一个最小 HTTP 请求，只看响应首行状态码。
fn probe(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let mut s = match TcpStream::connect(&addr) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(600)));
    let req = b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if s.write_all(req).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match s.read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).contains("200"),
        Err(_) => false,
    }
}

fn kill_server() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
}

fn main() {
    let mut builder = tauri::Builder::default();

    // 单实例：第二次启动时把已有窗口拉到前台，而不是再起一个后端
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            match spawn_server(&handle) {
                Ok(port) => {
                    let url = format!("http://127.0.0.1:{port}");
                    // 后端就绪前窗口保持隐藏，避免闪一下空白页
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        if let Some(w) = h.get_webview_window("main") {
                            if let Ok(parsed) = url.parse::<tauri::Url>() {
                                let _ = w.navigate(parsed);
                            }
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    });
                    Ok(())
                }
                Err(e) => {
                    // 起不来就在窗口里直说，别让用户对着空白页发呆
                    eprintln!("[shell] {e}");
                    show_error(&handle, &e);
                    Ok(())
                }
            }
        })
        .on_window_event(|_window, event| {
            if let WindowEvent::Destroyed = event {
                kill_server();
                std::process::exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("初始化失败")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                kill_server();
            }
        });
}

/// 后端起不来时把错误写进窗口，别让用户对着空白页发呆。
fn show_error(app: &tauri::AppHandle, msg: &str) {
    let html = format!(
        r#"<!doctype html><meta charset="utf-8">
<style>
 body{{margin:0;min-height:100vh;display:grid;place-content:center;justify-items:center;
      gap:14px;background:#faf9f5;color:#1a1917;
      font:14px/1.6 -apple-system,"PingFang SC",sans-serif;text-align:center;padding:40px;box-sizing:border-box}}
 h1{{font:400 22px/1.3 ui-serif,Georgia,serif;margin:0}}
 p{{color:#5d5b55;margin:0;max-width:46ch}}
 pre{{background:#f4f2ec;border:1px solid #e8e5dc;border-radius:6px;padding:10px 14px;margin:0;
      color:#c15f3c;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;max-width:46ch}}
</style>
<h1>无法启动本地服务</h1>
<pre>{}</pre>
<p>请重新安装应用；若问题持续，可清除应用数据目录后重试。</p>"#,
        html_escape(msg)
    );

    if let Some(w) = app.get_webview_window("main") {
        // 用 data URL 直接把错误页塞进 webview
        if let Ok(url) = format!("data:text/html;charset=utf-8,{}", url_encode(&html))
            .parse::<tauri::Url>()
        {
            let _ = w.navigate(url);
        }
        let _ = w.show();
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// data URL 需要 percent-encoding，只处理错误文案用得到的少数字符。
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' | b' ' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}