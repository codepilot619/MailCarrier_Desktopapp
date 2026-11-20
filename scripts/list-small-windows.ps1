Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum3 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
}
"@
$proc = [WinEnum3+EnumProc]{
  param($h, $l)
  if (-not [WinEnum3]::IsWindowVisible($h)) { return $true }
  $rect = New-Object WinEnum3+RECT
  [void][WinEnum3]::GetWindowRect($h, [ref]$rect)
  $w = $rect.R - $rect.L
  $hh = $rect.B - $rect.T
  if ($w -lt 80 -or $hh -lt 40 -or $w -gt 900 -or $hh -gt 700) { return $true }
  $sb = New-Object System.Text.StringBuilder 400
  [void][WinEnum3]::GetWindowText($h, $sb, 400)
  $cb = New-Object System.Text.StringBuilder 160
  [void][WinEnum3]::GetClassName($h, $cb, 160)
  $title = $sb.ToString()
  if (-not $title) { $title = "(no title)" }
  Write-Output "$($cb.ToString()) | $title | $($rect.L),$($rect.T) ${w}x${hh}"
  return $true
}
[void][WinEnum3]::EnumWindows($proc, [IntPtr]::Zero)
