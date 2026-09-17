# desk-probe.ps1 - feasibility probe, not shipped code.
#
# Question: can Operator have a Windows desktop of its own - its own cursor and
# its own input queue - that we can still screenshot while the user works on
# theirs? The known risk is that a desktop nobody is looking at captures black,
# because nothing composites it.
#
# Run: powershell -File desk-probe.ps1 parent
#      (it re-launches itself with "child" ON the new desktop)

param([string]$role = 'parent', [string]$out = 'D:\whisper\desk-probe.jpg')

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public class Desk {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktopW(string name, IntPtr dev, IntPtr dm, uint flags, uint access, IntPtr sa);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    const uint GENERIC_ALL = 0x10000000;

    public static string Spawn(string desktop, string cmdline) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = desktop;
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(null, cmdline, IntPtr.Zero, IntPtr.Zero, false,
                                 0x00000010 /* CREATE_NEW_CONSOLE */, IntPtr.Zero, null, ref si, out pi);
        if (!ok) return "CreateProcess failed: " + Marshal.GetLastWin32Error();
        return "pid " + pi.dwProcessId;
    }

    public static string Make(string name) {
        IntPtr h = CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (h == IntPtr.Zero) return "CreateDesktop failed: " + Marshal.GetLastWin32Error();
        return "ok";
    }
}
'@

[void][Desk]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

if ($role -eq 'parent') {
    Write-Output "create desktop : $([Desk]::Make('OperatorDesk'))"

    $me = $MyInvocation.MyCommand.Path
    $cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$me`" child `"$out`""
    Write-Output "spawn child    : $([Desk]::Spawn('OperatorDesk', $cmd))"

    # Note where the user's cursor is, so we can prove the child never moved it.
    $before = New-Object Desk+POINT
    [void][Desk]::GetCursorPos([ref]$before)
    Write-Output "cursor before  : $($before.X),$($before.Y)"

    Start-Sleep -Seconds 12

    $after = New-Object Desk+POINT
    [void][Desk]::GetCursorPos([ref]$after)
    Write-Output "cursor after   : $($after.X),$($after.Y)"
    Write-Output "cursor moved   : $(($before.X -ne $after.X) -or ($before.Y -ne $after.Y))"
    Write-Output "capture exists : $(Test-Path $out)"
    if (Test-Path $out) { Write-Output "capture size   : $((Get-Item $out).Length) bytes" }
    exit
}

# ── child: we are running ON OperatorDesk ───────────────────────────────
try {
    Start-Process notepad.exe
    Start-Sleep -Seconds 3

    # Move this desktop's cursor somewhere obvious. The parent checks whether
    # the real cursor followed - it must not.
    [void][Desk]::SetCursorPos(900, 600)

    $b = ([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Primary }).Bounds
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $g.Dispose()

    # How much of it is not black? A desktop nobody composites comes back empty,
    # and that is the whole question this probe exists to answer.
    $lit = 0
    for ($x = 0; $x -lt $b.Width; $x += 37) {
        for ($y = 0; $y -lt $b.Height; $y += 37) {
            $p = $bmp.GetPixel($x, $y)
            if ($p.R + $p.G + $p.B -gt 40) { $lit++ }
        }
    }
    $total = [math]::Ceiling($b.Width / 37) * [math]::Ceiling($b.Height / 37)

    $small = New-Object System.Drawing.Bitmap($bmp, 1280, 720)
    $bmp.Dispose()
    $small.Save($out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $small.Dispose()

    Set-Content -Path "$out.txt" -Value "lit $lit of $total sampled pixels" -Encoding utf8
} catch {
    Set-Content -Path "$out.txt" -Value "child failed: $($_.Exception.Message)" -Encoding utf8
}
