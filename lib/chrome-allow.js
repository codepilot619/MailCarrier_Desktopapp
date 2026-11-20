const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function allowWatcherScript(timeoutMs) {
  const ms = Math.max(1000, Math.min(120000, Number(timeoutMs) || 90000));
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class MailCarrierAllowClick {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  static EnumProc heldProc;
  static List<IntPtr> found = new List<IntPtr>();
  static List<IntPtr> chrome = new List<IntPtr>();
  static List<IntPtr> settings = new List<IntPtr>();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct POINT { public int X; public int Y; }
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  static bool OnWindow(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd)) return true;
    var sb = new StringBuilder(512);
    GetWindowText(hWnd, sb, sb.Capacity);
    var title = sb.ToString();
    if (title == "Allow remote debugging?" || title == "Allow remote debugging") found.Add(hWnd);
    var cb = new StringBuilder(256);
    GetClassName(hWnd, cb, cb.Capacity);
    if (cb.ToString() == "Chrome_WidgetWin_1") {
      chrome.Add(hWnd);
      if (IsSettingsCandidate(hWnd, title)) settings.Add(hWnd);
    }
    return true;
  }
  static bool IsSettingsCandidate(IntPtr hWnd, string title) {
    if (title == "Allow remote debugging?" || title == "Allow remote debugging") return false;
    if (title == "Restore pages?") return false;
    if (title.IndexOf("Gmail", StringComparison.OrdinalIgnoreCase) >= 0) return false;
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) return false;
    int width = rect.Right - rect.Left;
    int height = rect.Bottom - rect.Top;
    if (width < 120 || height < 80 || width > 720 || height > 560) return false;
    return true;
  }
  public static IntPtr[] FindDialogs() {
    found = new List<IntPtr>();
    chrome = new List<IntPtr>();
    settings = new List<IntPtr>();
    heldProc = OnWindow;
    EnumWindows(heldProc, IntPtr.Zero);
    return found.ToArray();
  }
  public static IntPtr[] ChromeWindows() { return chrome.ToArray(); }
  public static IntPtr[] SettingsCandidates() { return settings.ToArray(); }
  public static bool WindowAlive(IntPtr hwnd) {
    return hwnd != IntPtr.Zero && IsWindow(hwnd) && IsWindowVisible(hwnd);
  }
  public static bool Press(int x, int y, IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    var point = new POINT();
    point.X = x;
    point.Y = y;
    if (!ScreenToClient(hwnd, ref point)) return false;
    uint coord = (uint)(((point.Y & 0xFFFF) << 16) | (point.X & 0xFFFF));
    SendMessage(hwnd, 0x0200, IntPtr.Zero, (IntPtr)coord);
    SendMessage(hwnd, 0x0201, (IntPtr)1, (IntPtr)coord);
    SendMessage(hwnd, 0x0202, IntPtr.Zero, (IntPtr)coord);
    return true;
  }
}
"@
[MailCarrierAllowClick]::SetProcessDPIAware() | Out-Null
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$deadline = (Get-Date).AddMilliseconds(${ms})
function Find-AllowButton($node, $depth) {
  if ($depth -lt 0 -or -not $node) { return $null }
  try {
    $isButton = $node.Current.ControlType.ProgrammaticName -eq 'ControlType.Button'
    if ($isButton -and $node.Current.Name -eq 'Allow') { return $node }
  } catch { return $null }
  try { $child = $walker.GetFirstChild($node) } catch { return $null }
  $count = 0
  while ($child -and $count -lt 40) {
    $found = Find-AllowButton $child ($depth - 1)
    if ($found) { return $found }
    try { $child = $walker.GetNextSibling($child) } catch { return $null }
    $count++
  }
  return $null
}
function Find-AllowFromTitle($root) {
  if (-not $root) { return $null }
  $buttonCond = New-Object System.Windows.Automation.AndCondition @(
    (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty, 'Allow')),
    (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
  )
  $title = $null
  if ($root.Current.Name -eq 'Allow remote debugging?' -or $root.Current.Name -eq 'Allow remote debugging') { $title = $root }
  if (-not $title) {
    $titleCond = New-Object System.Windows.Automation.OrCondition @(
      (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty, 'Allow remote debugging?')),
      (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty, 'Allow remote debugging'))
    )
    $title = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $titleCond)
  }
  if (-not $title) { return $null }
  $direct = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCond)
  if ($direct) { return $direct }
  $node = $title
  for ($i = 0; $i -lt 8 -and $node; $i++) {
    $class = $node.Current.ClassName
    $name = $node.Current.Name
    $browserWindow = $class -eq 'Chrome_WidgetWin_1' -and $name -ne 'Allow remote debugging?' -and $name -ne 'Allow remote debugging'
    if ($browserWindow -and $node -ne $title) { break }
    $button = Find-AllowButton $node 6
    if ($button) { return $button }
    $node = $walker.GetParent($node)
  }
  return $null
}
function Dialog-StillOpen($root) {
  if (-not $root) { return $false }
  if ($root.Current.Name -eq 'Allow remote debugging?' -or $root.Current.Name -eq 'Allow remote debugging') { return $true }
  $titleCond = New-Object System.Windows.Automation.OrCondition @(
    (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty, 'Allow remote debugging?')),
    (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty, 'Allow remote debugging'))
  )
  return [bool]$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $titleCond)
}
function Invoke-NamedButton($button) {
  try {
    $invoke = [System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($invoke) { $invoke.Invoke(); return $true }
  } catch {}
  try {
    $legacy = [System.Windows.Automation.LegacyIAccessiblePattern]$button.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    if ($legacy) { $legacy.DoDefaultAction(); return $true }
  } catch {}
  return $false
}
function Press-Button($button, $hwnd) {
  if (-not $button) { return $false }
  $rect = $button.Current.BoundingRectangle
  if ($rect.Width -lt 8 -or $rect.Height -lt 8) { return $false }
  $x = [int][Math]::Round($rect.X + ($rect.Width / 2))
  $y = [int][Math]::Round($rect.Y + ($rect.Height / 2))
  return [MailCarrierAllowClick]::Press($x, $y, $hwnd)
}
function Click-ExactButton($button, $hwnd, $label) {
  if (-not $button) { return $false }
  if ($button.Current.Name -ne $label) { return $false }
  if ($button.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { return $false }
  if (Invoke-NamedButton $button) { return $true }
  return Press-Button $button $hwnd
}
function Click-Allow($root, $hwnd) {
  $button = Find-AllowFromTitle $root
  if (-not $button) { return $false }
  if ($button.Current.Name -ne 'Allow') { return $false }
  if ($button.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { return $false }
  # This modal belongs to the Chrome window. Moving it to another desktop
  # detaches it, so Allow is pressed and the dialog stays open.
  Invoke-NamedButton $button | Out-Null
  Start-Sleep -Milliseconds 250
  if (-not [MailCarrierAllowClick]::WindowAlive($hwnd)) { return $true }
  $button = Find-AllowFromTitle $root
  Press-Button $button $hwnd | Out-Null
  Start-Sleep -Milliseconds 250
  return -not [MailCarrierAllowClick]::WindowAlive($hwnd)
}
function Find-ExactButton($node, $depth, $label) {
  if ($depth -lt 0 -or -not $node) { return $null }
  try {
    $isButton = $node.Current.ControlType.ProgrammaticName -eq 'ControlType.Button'
    if ($isButton -and $node.Current.Name -eq $label) { return $node }
  } catch { return $null }
  try { $child = $walker.GetFirstChild($node) } catch { return $null }
  $count = 0
  while ($child -and $count -lt 40) {
    $found = Find-ExactButton $child ($depth - 1) $label
    if ($found) { return $found }
    try { $child = $walker.GetNextSibling($child) } catch { return $null }
    $count++
  }
  return $null
}
function Inspect-ProfileModal($node, $depth, $state) {
  if ($depth -lt 0 -or -not $node -or $state.Restore) { return }
  $name = ''
  $type = ''
  try {
    $name = [string]$node.Current.Name
    $type = [string]$node.Current.ControlType.ProgrammaticName
  } catch { return }
  if ($name -match 'remote debugging' -or $name -match 'remote setting') { $state.Remote = $true }
  if ($name -match 'profile') { $state.Profile = $true }
  if ($name -match 'Gmail') { $state.Gmail = $true }
  if ($type -eq 'ControlType.Button' -and $name -eq 'Yes') { $state.Yes = $true }
  if ($type -eq 'ControlType.Button' -and $name -eq 'Restore') { $state.Restore = $true }
  $child = $walker.GetFirstChild($node)
  $count = 0
  while ($child -and $count -lt 30) {
    Inspect-ProfileModal $child ($depth - 1) $state
    if ($state.Restore) { return }
    $child = $walker.GetNextSibling($child)
    $count++
  }
}
function Click-ProfileYes {
  foreach ($hwnd in [MailCarrierAllowClick]::SettingsCandidates()) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if (-not $root) { continue }
    $title = [string]$root.Current.Name
    if ($title -eq 'Allow remote debugging?' -or $title -eq 'Allow remote debugging' -or $title -eq 'Restore pages?') { continue }
    $state = @{ Remote = $false; Profile = $false; Gmail = $false; Yes = $false; Restore = $false }
    Inspect-ProfileModal $root 7 $state
    if ($state.Restore -or -not $state.Yes) { continue }
    if (-not ($state.Remote -or $state.Profile -or $state.Gmail)) { continue }
    $button = Find-ExactButton $root 7 'Yes'
    if (Click-ExactButton $button $hwnd 'Yes') { return $true }
  }
  return $false
}
while ((Get-Date) -lt $deadline) {
  $clicked = $false
  $dialogs = [MailCarrierAllowClick]::FindDialogs()
  foreach ($hwnd in $dialogs) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if (Click-Allow $root $hwnd) { $clicked = $true }
    } catch {}
  }
  if (Click-ProfileYes) { $clicked = $true }
  if ($clicked) {
    Start-Sleep -Milliseconds 300
    $still = @([MailCarrierAllowClick]::FindDialogs()).Count -gt 0
    if (-not $still) {
      $fg = [MailCarrierAllowClick]::GetForegroundWindow()
      if ($fg -ne [IntPtr]::Zero) {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
        $still = Dialog-StillOpen $root
      }
    }
    if (-not $still -and -not $script:announced) { 'clicked'; $script:announced = $true }
  }
  Start-Sleep -Milliseconds 200
}
'none'
`;
}

function startAllowWatcher(timeoutMs) {
  if (process.platform !== "win32") return { clicked() { return false; }, stop() {} };
  const file = path.join(os.tmpdir(), `mail-carrier-allow-${process.pid}-${Date.now()}.ps1`);
  let child = null;
  try {
    fs.writeFileSync(file, allowWatcherScript(timeoutMs), "utf8");
    child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch (error) {
    try { fs.rmSync(file, { force: true }); } catch (removeError) {}
    return { clicked() { return false; }, stop() {} };
  }
  let output = "";
  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      output += String(chunk || "");
    });
  }
  let stopped = false;
  return {
    clicked() {
      return output.includes("clicked");
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { if (child) child.kill(); } catch (error) {}
      try { fs.rmSync(file, { force: true }); } catch (error) {}
    },
  };
}

module.exports = {
  allowWatcherScript,
  startAllowWatcher,
};
