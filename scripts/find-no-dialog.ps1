Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Walk($node, $depth, $path) {
  if ($depth -lt 0 -or -not $node) { return }
  $name = ""
  $type = ""
  try { $name = [string]$node.Current.Name; $type = [string]$node.Current.ControlType.ProgrammaticName } catch { return }
  $here = "$path > [$type] $name"
  if ($name -match 'remote|debugging|Turn off|Allow remote' -or ($type -eq 'ControlType.Button' -and $name -match '^(No|Yes|Deny|Cancel|Allow|Turn off)$')) {
    Write-Output $here
  }
  if ($depth -eq 0) { return }
  $child = $walker.GetFirstChild($node)
  $count = 0
  while ($child -and $count -lt 40) {
    Walk $child ($depth - 1) $here
    $child = $walker.GetNextSibling($child)
    $count++
  }
}
$handles = New-Object System.Collections.Generic.List[object]
$proc = [WinEnum2+EnumProc]{
  param($h, $l)
  if (-not [WinEnum2]::IsWindowVisible($h)) { return $true }
  $cb = New-Object System.Text.StringBuilder 128
  [void][WinEnum2]::GetClassName($h, $cb, 128)
  if ($cb.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
  $sb = New-Object System.Text.StringBuilder 300
  [void][WinEnum2]::GetWindowText($h, $sb, 300)
  $title = $sb.ToString()
  if ($title.Length -lt 80 -or $title -match 'Allow|remote|Restore|Settings|inspect') {
    $script:handles.Add(@{ H = $h; T = $title })
  }
  return $true
}
$script:handles = $handles
[void][WinEnum2]::EnumWindows($proc, [IntPtr]::Zero)
"windows $($handles.Count)"
foreach ($item in $handles) {
  "WINDOW $($item.T)"
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($item.H)
  Walk $root 5 "root"
}
