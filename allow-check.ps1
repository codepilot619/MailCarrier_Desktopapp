
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
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
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  static bool OnWindow(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd)) return true;
    var sb = new StringBuilder(512);
    GetWindowText(hWnd, sb, sb.Capacity);
    var title = sb.ToString();
    if (title == "Allow remote debugging?" || title == "Allow remote debugging") found.Add(hWnd);
    var cb = new StringBuilder(256);
    GetClassName(hWnd, cb, cb.Capacity);
    if (cb.ToString() == "Chrome_WidgetWin_1") chrome.Add(hWnd);
    return true;
  }
  public static IntPtr[] FindDialogs() {
    found = new List<IntPtr>();
    chrome = new List<IntPtr>();
    heldProc = OnWindow;
    EnumWindows(heldProc, IntPtr.Zero);
    return found.ToArray();
  }
  public static IntPtr[] ChromeWindows() { return chrome.ToArray(); }
  public static void Click(int x, int y, IntPtr hwnd) {
    if (hwnd != IntPtr.Zero) {
      uint pid;
      uint target = GetWindowThreadProcessId(hwnd, out pid);
      uint me = GetCurrentThreadId();
      AttachThreadInput(me, target, true);
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
      AttachThreadInput(me, target, false);
    }
    SetCursorPos(x, y);
    Thread.Sleep(60);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    Thread.Sleep(50);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
[MailCarrierAllowClick]::SetProcessDPIAware() | Out-Null
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$deadline = (Get-Date).AddMilliseconds(2500)
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
  try {
    $legacy = $button.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $legacy.DoDefaultAction()
  } catch {}
  $x = [int]($rect.X + ($rect.Width / 2))
  $y = [int]($rect.Y + ($rect.Height / 2))
  [MailCarrierAllowClick]::Click($x, $y, $hwnd)
  return $true
}
$nextDeep = Get-Date
while ((Get-Date) -lt $deadline) {
  $clicked = $false
  $dialogs = [MailCarrierAllowClick]::FindDialogs()
  foreach ($hwnd in $dialogs) {
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
    if (-not $still) { 'clicked'; exit 0 }
  }
  Start-Sleep -Milliseconds 200
}
'none'
