Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
}
"@
$script:rows = New-Object System.Collections.Generic.List[string]
$proc = [WinEnum+EnumProc]{
  param($h, $l)
  if (-not [WinEnum]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinEnum]::GetWindowText($h, $sb, 512)
  $title = $sb.ToString()
  if (-not $title) { return $true }
  $cb = New-Object System.Text.StringBuilder 128
  [void][WinEnum]::GetClassName($h, $cb, 128)
  $cls = $cb.ToString()
  $rect = New-Object WinEnum+RECT
  [void][WinEnum]::GetWindowRect($h, [ref]$rect)
  $w = $rect.R - $rect.L
  $hh = $rect.B - $rect.T
  if ($cls -like "Chrome*" -or $title -match "remote|Allow|debug|setting|Gmail|Mail Carrier|Restore|No") {
    $script:rows.Add("$cls | $title | $($rect.L),$($rect.T) ${w}x${hh}")
  }
  return $true
}
[void][WinEnum]::EnumWindows($proc, [IntPtr]::Zero)
$script:rows
