$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName WindowsBase
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class DbgAllow {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  static EnumProc held;
  static List<IntPtr> found = new List<IntPtr>();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int bytes);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  static readonly IntPtr Topmost = new IntPtr(-1);
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mouse; }
  static bool OnWindow(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd)) return true;
    var sb = new StringBuilder(512);
    GetWindowText(hWnd, sb, sb.Capacity);
    if (sb.ToString() == "Allow remote debugging?") found.Add(hWnd);
    return true;
  }
  public static IntPtr[] Find() {
    found = new List<IntPtr>();
    held = OnWindow;
    EnumWindows(held, IntPtr.Zero);
    return found.ToArray();
  }
  public static void Raise(IntPtr hwnd) { SetWindowPos(hwnd, Topmost, 0, 0, 0, 0, 0x0003); }
  public static string Metrics(int x, int y) {
    int left = GetSystemMetrics(76);
    int top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78);
    int height = GetSystemMetrics(79);
    int ax = (int)Math.Round((x - left) * 65535.0 / (width - 1));
    int ay = (int)Math.Round((y - top) * 65535.0 / (height - 1));
    return "screen " + left + "," + top + " " + width + "x" + height + " abs " + ax + "," + ay;
  }
  public static string MoveAbsolute(int x, int y) {
    int left = GetSystemMetrics(76);
    int top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78);
    int height = GetSystemMetrics(79);
    int ax = (int)Math.Round((x - left) * 65535.0 / (width - 1));
    int ay = (int)Math.Round((y - top) * 65535.0 / (height - 1));
    var move = new INPUT();
    move.type = 0;
    move.mouse.dx = ax;
    move.mouse.dy = ay;
    move.mouse.dwFlags = 0x0001 | 0x8000;
    SendInput(1, new[] { move }, Marshal.SizeOf(typeof(INPUT)));
    POINT point;
    GetCursorPos(out point);
    return point.X + "," + point.Y;
  }
  public static string MoveCursor(int x, int y) {
    bool ok = SetCursorPos(x, y);
    POINT point;
    GetCursorPos(out point);
    return "ok=" + ok + " at " + point.X + "," + point.Y;
  }
  public static void PhysicalClick(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
  public static int Click(int x, int y, IntPtr hwnd) {
    if (hwnd != IntPtr.Zero) {
      var point = new POINT(); point.X = x; point.Y = y;
      IntPtr hit = WindowFromPoint(point);
      if (hit != hwnd && GetAncestor(hit, 2) != hwnd) return -2;
    }
    int left = GetSystemMetrics(76);
    int top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78);
    int height = GetSystemMetrics(79);
    if (width <= 1 || height <= 1) return -3;
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
    uint sent = SendInput(1, new[] { down }, Marshal.SizeOf(typeof(INPUT)));
    if (sent != 1) return -1;
    System.Threading.Thread.Sleep(40);
    SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT)));
    return 1;
  }
  public static string Hit(int x, int y, IntPtr dialog) {
    var point = new POINT(); point.X = x; point.Y = y;
    IntPtr hit = WindowFromPoint(point);
    if (hit == dialog) return "dialog";
    if (GetAncestor(hit, 2) == dialog) return "child";
    return "other " + hit.ToInt64();
  }
}
"@
[DbgAllow]::SetProcessDPIAware() | Out-Null
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Find-Btn($node, $depth) {
  if ($depth -lt 0 -or -not $node) { return $null }
  try {
    if ($node.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $node.Current.Name -eq 'Allow') { return $node }
  } catch {}
  $child = $walker.GetFirstChild($node)
  $n = 0
  while ($child -and $n -lt 40) {
    $found = Find-Btn $child ($depth - 1)
    if ($found) { return $found }
    $child = $walker.GetNextSibling($child)
    $n++
  }
  return $null
}
function Button-Depth($node, $depth) {
  if ($depth -gt 16 -or -not $node) { return $null }
  try {
    if ($node.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $node.Current.Name -eq 'Allow') { return $depth }
  } catch {}
  $child = $walker.GetFirstChild($node)
  $n = 0
  while ($child -and $n -lt 40) {
    $found = Button-Depth $child ($depth + 1)
    if ($found) { return $found }
    $child = $walker.GetNextSibling($child)
    $n++
  }
  return $null
}
$dialogs = [DbgAllow]::Find()
"dialogs $($dialogs.Count)"
foreach ($hwnd in $dialogs) {
  "hwnd $hwnd"
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  "root $($root.Current.Name) $($root.Current.ClassName)"
  "button-depth $(Button-Depth $root 0)"
  $shallow = Find-Btn $root 6
  "depth6 $(if ($shallow) { 'found' } else { 'miss' })"
  $button = Find-Btn $root 8
  if (-not $button) { "no-button-depth8"; continue }
  $rect = $button.Current.BoundingRectangle
  $x = [int][Math]::Round($rect.X + ($rect.Width / 2))
  $y = [int][Math]::Round($rect.Y + ($rect.Height / 2))
  "rect $($rect.X),$($rect.Y) $($rect.Width)x$($rect.Height) center $x,$y"
  "hit-before $([DbgAllow]::Hit($x, $y, $hwnd))"
  [DbgAllow]::Raise($hwnd)
  Start-Sleep -Milliseconds 200
  "hit-after $([DbgAllow]::Hit($x, $y, $hwnd))"
  try {
    $point = New-Object System.Windows.Point -ArgumentList ([double]$x, [double]$y)
    $under = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    "under [$($under.Current.Name)] [$($under.Current.ControlType.ProgrammaticName)]"
  } catch { "frompoint-fail $_" }
  "metrics $([DbgAllow]::Metrics($x, $y))"
  "send-move $([DbgAllow]::MoveAbsolute($x, $y)) target $x,$y"
  "set-cursor $([DbgAllow]::MoveCursor($x, $y))"
  [DbgAllow]::PhysicalClick($x, $y)
  Start-Sleep -Milliseconds 500
  "left $([DbgAllow]::Find().Count)"
  break
}
