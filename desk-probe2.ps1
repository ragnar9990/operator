# desk-probe2.ps1 - second feasibility probe, not shipped code.
#
# Probe 1 proved input is isolated on a private desktop but CopyFromScreen fails
# there: a desktop nobody is looking at has no display surface. PrintWindow asks
# a window to paint itself into a DC instead, which does not need one. Question:
# does it actually produce pixels for windows on a hidden desktop?

param([string]$role = 'parent', [string]$out = 'D:\whisper\desk-probe2.jpg')

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class Desk2 {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktopW(string n, IntPtr d, IntPtr dm, uint f, uint a, IntPtr sa);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public delegate bool EnumProc(IntPtr h, IntPtr l);
    const uint GENERIC_ALL = 0x10000000;

    public static string Make(string name) {
        IntPtr h = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        return h == IntPtr.Zero ? "failed: " + Marshal.GetLastWin32Error() : "ok";
    }

    public static string Spawn(string desktop, string cmdline) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = desktop;
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(null, cmdline, IntPtr.Zero, IntPtr.Zero, false, 0x10, IntPtr.Zero, null, ref si, out pi);
        return ok ? "pid " + pi.dwProcessId : "failed: " + Marshal.GetLastWin32Error();
    }

    // EnumWindows only ever sees the CALLING thread's desktop, which is exactly
    // what we want from the child: the agent's windows and nothing of the user's.
    public static List<string> Windows() {
        List<string> found = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            if (GetWindowTextLengthW(h) == 0) return true;
            StringBuilder sb = new StringBuilder(400);
            GetWindowTextW(h, sb, sb.Capacity);
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if (r.Right - r.Left < 60 || r.Bottom - r.Top < 40) return true;
            found.Add(h.ToInt64() + "\t" + sb + "\t" + r.Left + "\t" + r.Top + "\t" +
                      (r.Right - r.Left) + "\t" + (r.Bottom - r.Top));
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

[void][Desk2]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing

if ($role -eq 'parent') {
    Write-Output "desktop : $([Desk2]::Make('OperatorDesk'))"
    $me = $MyInvocation.MyCommand.Path
    $q = [char]34
    $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $q$me$q child $q$out$q"
    Write-Output "child   : $([Desk2]::Spawn('OperatorDesk', $cmd))"
    Start-Sleep -Seconds 14
    if (Test-Path "$out.txt") { Get-Content "$out.txt" | ForEach-Object { Write-Output "report  : $_" } }
    else { Write-Output "report  : child produced nothing" }
    exit
}

# ── child: running ON OperatorDesk ──────────────────────────────────────
try {
    Start-Process notepad.exe
    Start-Sleep -Seconds 4

    $lines = @()
    $wins = [Desk2]::Windows()
    $lines += "windows on this desktop: $($wins.Count)"
    foreach ($w in $wins) { $f = $w -split "`t"; $lines += "  - $($f[1]) [$($f[4])x$($f[5])]" }

    $target = $wins | Where-Object { ($_ -split "`t")[1] -match 'Notepad' } | Select-Object -First 1
    if (-not $target) { $target = $wins | Select-Object -First 1 }

    if ($target) {
        $f = $target -split "`t"
        $h = [IntPtr][int64]$f[0]
        $w = [int]$f[4]; $ht = [int]$f[5]

        $bmp = New-Object System.Drawing.Bitmap($w, $ht)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        # 2 = PW_RENDERFULLCONTENT, needed for anything GPU-composited.
        $ok = [Desk2]::PrintWindow($h, $hdc, 2)
        $g.ReleaseHdc($hdc)
        $g.Dispose()
        $lines += "PrintWindow returned: $ok"

        $lit = 0; $n = 0
        for ($x = 0; $x -lt $w; $x += 17) {
            for ($y = 0; $y -lt $ht; $y += 17) {
                $n++
                $p = $bmp.GetPixel($x, $y)
                if ($p.R + $p.G + $p.B -gt 40) { $lit++ }
            }
        }
        $lines += "non-black: $lit of $n sampled ($([math]::Round(100 * $lit / [math]::Max(1,$n)))%)"
        $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
        $bmp.Dispose()
    } else {
        $lines += "no window to capture"
    }
    Set-Content -Path "$out.txt" -Value ($lines -join "`n") -Encoding utf8
} catch {
    Set-Content -Path "$out.txt" -Value "child failed: $($_.Exception.Message)" -Encoding utf8
}
