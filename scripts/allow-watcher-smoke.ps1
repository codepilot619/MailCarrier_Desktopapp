
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
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int bytes);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mouse; }
  public struct POINT { public int X; public int Y; }
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  static readonly IntPtr Topmost = new IntPtr(-1);
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
  public static void CloseWindow(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return;
    PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
  public static bool CoversDialog(int x, int y, IntPtr dialog) {
    var point = new POINT();
    point.X = x;
    point.Y = y;
    IntPtr hit = WindowFromPoint(point);
    if (hit == IntPtr.Zero || dialog == IntPtr.Zero) return false;
    if (hit == dialog) return true;
    return GetAncestor(hit, 2) == dialog;
  }
  public static void Raise(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return;
    SetWindowPos(hwnd, Topmost, 0, 0, 0, 0, 0x0003);
    uint pid;
    uint target = GetWindowThreadProcessId(hwnd, out pid);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, target, true);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    AttachThreadInput(me, target, false);
  }
  public static bool Click(int x, int y, IntPtr hwnd) {
    if (hwnd != IntPtr.Zero && !CoversDialog(x, y, hwnd)) return false;
    int left = GetSystemMetrics(76);
    int top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78);
    int height = GetSystemMetrics(79);
    if (width <= 1 || height <= 1) return false;
    int ax = (int)Math.Round((x - left) * 65535.0 / (width - 1));
    int ay = (int)Math.Round((y - top) * 65535.0 / (height - 1));
    var down = new INPUT();
    down.type = 0;
    down.mouse.dx = ax;
    down.mouse.dy = ay;
    down.mouse.dwFlags = 0x0001 | 0x8000 | 0x0002;
    var up = new INPUT();
    up.type = 0;
    up.mouse.dx = ax;
    up.mouse.dy = ay;
    up.mouse.dwFlags = 0x0001 | 0x8000 | 0x0004;
    if (SendInput(1, new[] { down }, Marshal.SizeOf(typeof(INPUT))) != 1) return false;
    Thread.Sleep(40);
    SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT)));
    return true;
  }
}
"@
[MailCarrierAllowClick]::SetProcessDPIAware() | Out-Null
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$deadline = (Get-Date).AddMilliseconds(1200)
function Find-AllowButton($node, $depth) {
  if ($depth -lt 0 -or -not $node) { return $null }
  $isButton = $node.Current.ControlType.ProgrammaticName -eq 'ControlType.Button'
  if ($isButton -and $node.Current.Name -eq 'Allow') { return $node }
  $child = $walker.GetFirstChild($node)
  while ($child) {
    $found = Find-AllowButton $child ($depth - 1)
    if ($found) { return $found }
    $child = $walker.GetNextSibling($child)
  }
  return $null
}
function Find-AllowFromTitle($root) {
  if (-not $root) { return $null }
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
function Click-Allow($root, $hwnd) {
  $button = Find-AllowFromTitle $root
  if (-not $button) { return $false }
  if ($button.Current.Name -ne 'Allow') { return $false }
  if ($button.Current.ControlType.ProgrammaticName -ne 'ControlType.Button') { return $false }
  $rect = $button.Current.BoundingRectangle
  if ($rect.Width -lt 8 -or $rect.Height -lt 8) { return $false }
  $x = [int][Math]::Round($rect.X + ($rect.Width / 2))
  $y = [int][Math]::Round($rect.Y + ($rect.Height / 2))
  [MailCarrierAllowClick]::Raise($hwnd)
  Start-Sleep -Milliseconds 120
  $underName = ''
  try {
    $point = New-Object System.Windows.Point -ArgumentList ([double]$x, [double]$y)
    $under = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    $underName = [string]$under.Current.Name
  } catch {}
  if ($underName -ne 'Allow') { return $false }
  return [MailCarrierAllowClick]::Click($x, $y, $hwnd)
}
function Inspect-SettingsModal($node, $depth, $state) {
  if ($depth -lt 0 -or -not $node -or $state.Allow) { return }
  $name = ''
  $type = ''
  try {
    $name = [string]$node.Current.Name
    $type = [string]$node.Current.ControlType.ProgrammaticName
  } catch { return }
  if ($name -match 'remote') { $state.Remote = $true }
  if ($type -eq 'ControlType.Button' -and $name -eq 'No') { $state.No = $true }
  if ($type -eq 'ControlType.Button' -and $name -eq 'Allow') { $state.Allow = $true }
  if ($type -eq 'ControlType.Button' -and $name -eq 'Restore') { $state.Restore = $true }
  $child = $walker.GetFirstChild($node)
  $count = 0
  while ($child -and $count -lt 30) {
    Inspect-SettingsModal $child ($depth - 1) $state
    if ($state.Allow -or $state.Restore) { return }
    $child = $walker.GetNextSibling($child)
    $count++
  }
}
function Remove-RemoteSettingsModal {
  foreach ($hwnd in [MailCarrierAllowClick]::SettingsCandidates()) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if (-not $root) { continue }
    $title = [string]$root.Current.Name
    if ($title -eq 'Allow remote debugging?' -or $title -eq 'Allow remote debugging' -or $title -eq 'Restore pages?') { continue }
    $state = @{ Remote = $false; No = $false; Allow = $false; Restore = $false }
    Inspect-SettingsModal $root 7 $state
    if ($state.Allow -or $state.Restore) { continue }
    $remoteTitle = $title -match 'remote' -and ($title -match 'setting' -or $title -match 'debug')
    if (($state.Remote -and $state.No) -or $remoteTitle) {
      [MailCarrierAllowClick]::CloseWindow($hwnd)
    }
  }
}
$nextDeep = Get-Date
$armedAt = @{}
while ((Get-Date) -lt $deadline) {
  $clicked = $false
  $dialogs = [MailCarrierAllowClick]::FindDialogs()
  Remove-RemoteSettingsModal
  foreach ($hwnd in $dialogs) {
    $key = [string]$hwnd.ToInt64()
    if (-not $armedAt.ContainsKey($key)) { $armedAt[$key] = (Get-Date).AddMilliseconds(700) }
    if ((Get-Date) -lt $armedAt[$key]) { continue }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if (Click-Allow $root $hwnd) { $clicked = $true }
  }
  if (-not $clicked) {
    foreach ($hwnd in [MailCarrierAllowClick]::ChromeWindows()) {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if (-not $root) { continue }
      $name = $root.Current.Name
      if ($name -eq 'Allow remote debugging?' -or $name -eq 'Allow remote debugging') {
        if (Click-Allow $root $hwnd) { $clicked = $true; break }
      }
    }
  }
  if (-not $clicked -and (Get-Date) -ge $nextDeep) {
    $nextDeep = (Get-Date).AddSeconds(1)
    $fg = [MailCarrierAllowClick]::GetForegroundWindow()
    if ($fg -ne [IntPtr]::Zero) {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
      if ($root -and $root.Current.ClassName -eq 'Chrome_WidgetWin_1') {
        if (Click-Allow $root $fg) { $clicked = $true }
      }
    }
  }
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
