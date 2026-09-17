Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class U{
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);}
"@
function Get-ChromeAll {
  $script:list=@()
  $cb=[U+EnumWindowsProc]{param($h,$l) $sb=New-Object Text.StringBuilder 512;[U]::GetWindowText($h,$sb,512)|Out-Null; if([U]::IsWindowVisible($h) -and $sb.ToString() -like "*Google Chrome*"){$script:list+=$h}; return $true}
  [U]::EnumWindows($cb,[IntPtr]::Zero)|Out-Null
  return $script:list
}
function Get-Url($h){ try{ $el=[System.Windows.Automation.AutomationElement]::FromHandle($h)
  $c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
  $e=$el.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$c)
  return $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }catch{ return "" } }
function Get-Chrome { $all=Get-ChromeAll; foreach($h in $all){ if((Get-Url $h) -like "*accounts.google.com*"){return $h} }; if($all.Count -gt 0){return $all[0]}; return [IntPtr]::Zero }
function Focus-Chrome { $h=Get-Chrome; [U]::ShowWindow($h,9)|Out-Null;[U]::BringWindowToTop($h)|Out-Null;[U]::SetForegroundWindow($h)|Out-Null; Start-Sleep 1; return $h }
function Click-At($x,$y){ [U]::SetCursorPos($x,$y)|Out-Null; Start-Sleep -Milliseconds 200; [U]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 80; [U]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero); Start-Sleep 3 }
function Dump-Page {
  $h=Get-Chrome
  $sb=New-Object Text.StringBuilder 512;[U]::GetWindowText($h,$sb,512)|Out-Null;"TITLE: "+$sb.ToString()
  "URL: "+(Get-Url $h)
  $el=[System.Windows.Automation.AutomationElement]::FromHandle($h)
  $all=$el.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($e in $all){ try{$n=$e.Current.Name; $ct=$e.Current.ControlType.ProgrammaticName.Replace('ControlType.',''); $r=$e.Current.BoundingRectangle; if($n -and $r.Y -gt 120 -and $ct -in @('Text','Button','ListItem','RadioButton','Edit','Hyperlink','CheckBox')){ "{0} :: {1} @ [{2},{3} {4}x{5}]" -f $ct,$n.Substring(0,[Math]::Min(120,$n.Length)),[int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height }}catch{} }
}
function Send-Text($t){ $ws=New-Object -ComObject WScript.Shell; $ws.SendKeys($t) }
