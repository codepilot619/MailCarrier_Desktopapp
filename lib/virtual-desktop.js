const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// Windows 11 24H2/25H2 virtual desktops. Desktop 2 is index 1.
// MoveViewToDesktop does not change the desktop the user is looking at.
// SwitchDesktop is only used to undo a create that switched away.
function desktopTypeSource() {
  return `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("372E1D3B-38D3-42E4-A15B-8AB2B178F513")]
internal interface IMailCarrierApplicationView {
  void Placeholder();
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9")]
internal interface IMailCarrierObjectArray {
  void GetCount(out int count);
  void GetAt(int index, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object obj);
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5")]
internal interface IMailCarrierViewCollection {
  int GetViews(out IMailCarrierObjectArray array);
  int GetViewsByZOrder(out IMailCarrierObjectArray array);
  int GetViewsByAppUserModelId([MarshalAs(UnmanagedType.LPWStr)] string id, out IMailCarrierObjectArray array);
  int GetViewForHwnd(IntPtr hwnd, out IMailCarrierApplicationView view);
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("3F07F4BE-B107-441A-AF0F-39D82529072C")]
internal interface IMailCarrierVirtualDesktop {
  bool IsViewVisible(IMailCarrierApplicationView view);
  Guid GetId();
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("53F5CA0B-158F-4124-900C-057158060B27")]
internal interface IMailCarrierDesktopInternal {
  int GetCount();
  void MoveViewToDesktop(IMailCarrierApplicationView view, IMailCarrierVirtualDesktop desktop);
  bool CanViewMoveDesktops(IMailCarrierApplicationView view);
  IMailCarrierVirtualDesktop GetCurrentDesktop();
  void GetDesktops(out IMailCarrierObjectArray desktops);
  int GetAdjacentDesktop(IMailCarrierVirtualDesktop from, int direction, out IMailCarrierVirtualDesktop desktop);
  void SwitchDesktop(IMailCarrierVirtualDesktop desktop);
  void SwitchDesktopAndMoveForegroundView(IMailCarrierVirtualDesktop desktop);
  IMailCarrierVirtualDesktop CreateDesktop();
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
internal interface IMailCarrierServiceProvider {
  [return: MarshalAs(UnmanagedType.IUnknown)]
  object QueryService(ref Guid service, ref Guid riid);
}

public class MailCarrierDesktop {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  static EnumProc heldProc;
  static List<string> chromeHwnds = new List<string>();
  static IMailCarrierDesktopInternal manager;
  static IMailCarrierViewCollection views;

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  static bool IsChromeProcess(IntPtr hWnd) {
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    if (pid == 0) return false;
    try {
      return string.Equals(Process.GetProcessById((int)pid).ProcessName, "chrome", StringComparison.OrdinalIgnoreCase);
    } catch (Exception) {
      return false;
    }
  }

  static bool OnWindow(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd) || !IsChromeProcess(hWnd)) return true;
    var name = new StringBuilder(256);
    GetClassName(hWnd, name, name.Capacity);
    if (name.ToString() != "Chrome_WidgetWin_1") return true;
    var title = new StringBuilder(512);
    GetWindowText(hWnd, title, title.Capacity);
    chromeHwnds.Add(hWnd.ToInt64().ToString() + "\\t" + title.ToString().Replace("\\t", " "));
    return true;
  }

  static IMailCarrierServiceProvider Shell() {
    return (IMailCarrierServiceProvider)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239")));
  }

  static IMailCarrierDesktopInternal Manager() {
    if (manager != null) return manager;
    Guid service = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
    Guid iid = typeof(IMailCarrierDesktopInternal).GUID;
    manager = (IMailCarrierDesktopInternal)Shell().QueryService(ref service, ref iid);
    return manager;
  }

  static IMailCarrierViewCollection Views() {
    if (views != null) return views;
    Guid service = typeof(IMailCarrierViewCollection).GUID;
    Guid iid = service;
    views = (IMailCarrierViewCollection)Shell().QueryService(ref service, ref iid);
    return views;
  }

  static IMailCarrierVirtualDesktop DesktopAt(int index) {
    IMailCarrierObjectArray desktops;
    Manager().GetDesktops(out desktops);
    object obj;
    Guid iid = typeof(IMailCarrierVirtualDesktop).GUID;
    desktops.GetAt(index, ref iid, out obj);
    return (IMailCarrierVirtualDesktop)obj;
  }

  static int IndexOf(IMailCarrierVirtualDesktop desktop) {
    Guid id = desktop.GetId();
    int count = Manager().GetCount();
    for (int i = 0; i < count; i++) {
      if (DesktopAt(i).GetId() == id) return i;
    }
    return -1;
  }

  static void StayOn(IMailCarrierVirtualDesktop desktop) {
    var now = Manager().GetCurrentDesktop();
    if (now.GetId() != desktop.GetId()) Manager().SwitchDesktop(desktop);
  }

  static int DesktopIndex(IMailCarrierApplicationView view) {
    int count = Manager().GetCount();
    for (int i = 0; i < count; i++) {
      try {
        if (DesktopAt(i).IsViewVisible(view)) return i;
      } catch (Exception) {}
    }
    return -1;
  }

  public static string Status() {
    try {
      var current = Manager().GetCurrentDesktop();
      return "count=" + Manager().GetCount() + " current=" + IndexOf(current);
    } catch (Exception ex) {
      return "fail " + ex.GetType().Name;
    }
  }

  public static string Where(long hwndValue) {
    try {
      IMailCarrierApplicationView view;
      int hr = Views().GetViewForHwnd(new IntPtr(hwndValue), out view);
      if (hr != 0 || view == null) return "fail";
      var current = Manager().GetCurrentDesktop();
      return "current=" + IndexOf(current) + " window=" + DesktopIndex(view);
    } catch (Exception ex) {
      return "fail " + ex.GetType().Name;
    }
  }

  public static string MoveToSecond(long hwndValue) {
    try {
      if (hwndValue == 0) return "fail";
      var current = Manager().GetCurrentDesktop();
      if (Manager().GetCount() < 2) {
        Manager().CreateDesktop();
        StayOn(current);
      }
      if (Manager().GetCount() < 2) return "fail";
      IMailCarrierApplicationView view;
      int hr = Views().GetViewForHwnd(new IntPtr(hwndValue), out view);
      if (hr != 0 || view == null) return "fail";
      Manager().MoveViewToDesktop(view, DesktopAt(1));
      StayOn(current);
      return "ok";
    } catch (Exception) {
      return "fail";
    }
  }

  public static string ListChrome() {
    try {
      chromeHwnds = new List<string>();
      heldProc = OnWindow;
      EnumWindows(heldProc, IntPtr.Zero);
      if (chromeHwnds.Count == 0) return "none";
      return string.Join("\\n", chromeHwnds);
    } catch (Exception) {
      return "fail";
    }
  }
}`;
}

function scriptFor(body) {
  return `$ErrorActionPreference = 'Stop'\r\nAdd-Type -TypeDefinition @"\r\n${desktopTypeSource()}\r\n"@\r\n${body}\r\n`;
}

function runScript(body, timeoutMs = 20000) {
  if (process.platform !== "win32") return Promise.resolve("");
  const file = path.join(os.tmpdir(), `mail-carrier-desktop-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  try {
    fs.writeFileSync(file, scriptFor(body), "utf8");
  } catch (error) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    let child = null;
    const timer = setTimeout(() => {
      try { if (child) child.kill(); } catch (error) {}
    }, timeoutMs);
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (error) {
      clearTimeout(timer);
      try { fs.rmSync(file, { force: true }); } catch (removeError) {}
      resolve("");
      return;
    }
    let output = "";
    if (child.stdout) child.stdout.on("data", (chunk) => { output += String(chunk || ""); });
    child.on("error", () => {
      clearTimeout(timer);
      try { fs.rmSync(file, { force: true }); } catch (error) {}
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      try { fs.rmSync(file, { force: true }); } catch (error) {}
      resolve(output.trim());
    });
  });
}

function hwndText(hwnd) {
  const text = String(hwnd || "").trim();
  return /^\d+$/.test(text) ? text : "";
}

function hwndFromBuffer(buffer) {
  if (!buffer || !buffer.length) return "";
  if (buffer.length >= 8) {
    const value = buffer.readBigUInt64LE(0);
    if (value <= 0n) return "";
    return value.toString();
  }
  const value = buffer.readUInt32LE(0);
  return value ? String(value) : "";
}

function moveHwndToSecondDesktop(hwnd) {
  const text = hwndText(hwnd);
  if (!text) return Promise.resolve(false);
  return runScript(`[MailCarrierDesktop]::MoveToSecond([int64]${text})`).then((output) => output.includes("ok"));
}

function listChromeHwnds() {
  if (process.platform !== "win32") return Promise.resolve([]);
  return runScript("[MailCarrierDesktop]::ListChrome()").then((output) => {
    const text = String(output || "").trim();
    if (!text || text.startsWith("fail")) return null;
    if (text === "none") return [];
    const hwnds = text.split(/\r?\n/).map((line) => line.split("\t")[0]).filter((item) => /^\d+$/.test(item));
    return hwnds;
  });
}

function listChromeWindows() {
  if (process.platform !== "win32") return Promise.resolve([]);
  return runScript("[MailCarrierDesktop]::ListChrome()").then((output) => {
    const text = String(output || "").trim();
    if (!text || text === "none" || text.startsWith("fail")) return [];
    return text.split(/\r?\n/).map((line) => {
      const [hwnd, ...title] = line.split("\t");
      return { hwnd: hwndText(hwnd), title: title.join("\t") };
    }).filter((item) => item.hwnd);
  });
}

function desktopOf(hwnd) {
  const text = hwndText(hwnd);
  if (!text) return Promise.resolve("");
  return runScript(`[MailCarrierDesktop]::Where([int64]${text})`);
}

function desktopStatus() {
  return runScript("[MailCarrierDesktop]::Status()");
}

function startChromePlacement(existing, timeoutMs = 20000) {
  if (process.platform !== "win32") return { stop() {} };
  const known = (Array.isArray(existing) ? existing : []).map(hwndText).filter(Boolean);
  const ms = Math.max(1000, Math.min(120000, Number(timeoutMs) || 20000));
  const lines = known.map((item) => `[void]$known.Add('${item}')`).join("\r\n");
  const body = `
$known = New-Object 'System.Collections.Generic.HashSet[string]'
${lines}
$deadline = (Get-Date).AddMilliseconds(${ms})
while ((Get-Date) -lt $deadline) {
  foreach ($line in (([MailCarrierDesktop]::ListChrome()) -split "[\\r\\n]+")) {
    $hwnd = ($line -split "\\t")[0]
    if ($hwnd -notmatch '^\\d+$' -or $known.Contains($hwnd)) { continue }
    [void]$known.Add($hwnd)
    [MailCarrierDesktop]::MoveToSecond([int64]$hwnd) | Out-Null
  }
  Start-Sleep -Milliseconds 40
}
`;
  const file = path.join(os.tmpdir(), `mail-carrier-place-${process.pid}-${Date.now()}.ps1`);
  let child = null;
  try {
    fs.writeFileSync(file, scriptFor(body), "utf8");
    child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { windowsHide: true, stdio: "ignore" }
    );
  } catch (error) {
    try { fs.rmSync(file, { force: true }); } catch (removeError) {}
    return { stop() {} };
  }
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { if (child) child.kill(); } catch (error) {}
      try { fs.rmSync(file, { force: true }); } catch (error) {}
    },
  };
}

module.exports = {
  desktopOf,
  desktopStatus,
  desktopTypeSource,
  hwndFromBuffer,
  listChromeHwnds,
  listChromeWindows,
  moveHwndToSecondDesktop,
  runScript,
  startChromePlacement,
};
