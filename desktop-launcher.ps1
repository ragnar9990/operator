# desktop-launcher.ps1 — runs desktop-helper.ps1 on a PRIVATE desktop.
#
# Windows lets a process live on a desktop of its own: its own cursor, its own
# keyboard queue, its own set of windows. Nothing it does shows on the desktop
# you are looking at, and your mouse is never dragged around.
#
# This launcher creates that desktop, starts the ordinary helper ON it (so the
# helper's input and the apps it opens all land there), and then just pipes the
# JSON protocol straight through — Operator talks to it exactly as if the helper
# were local. The helper switches to window-by-window capture on its own when it
# sees it is running on a named desktop.

param([string]$DesktopName = 'OperatorDesk')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$helper = Join-Path $here 'desktop-helper.ps1'

if (-not (Test-Path $helper)) {
    [Console]::Error.WriteLine("desktop-helper.ps1 not found next to the launcher")
    exit 1
}

Add-Type @'
using System;
using System.Runtime.InteropServices;

public class Launch {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktopW(string name, IntPtr dev, IntPtr dm, uint flags, uint access, IntPtr sa);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int n);

    const uint GENERIC_ALL = 0x10000000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const int  STD_ERROR_HANDLE = -12;

    public static IntPtr Desktop(string name) {
        return CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
    }

    public static int Spawn(string desktop, string cmdline, IntPtr stdIn, IntPtr stdOut) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = desktop;
        si.dwFlags = (int)STARTF_USESTDHANDLES;
        si.hStdInput = stdIn;
        si.hStdOutput = stdOut;
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        PROCESS_INFORMATION pi;
        // Env is inherited (NULL), so OPERATOR_DESKTOP set below reaches the child
        // and tells the helper it is on a private desktop.
        bool ok = CreateProcessW(null, cmdline, IntPtr.Zero, IntPtr.Zero, true,
                                 CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi);
        if (!ok) return -Marshal.GetLastWin32Error();
        return pi.dwProcessId;
    }
}
'@

$hDesk = [Launch]::Desktop($DesktopName)
if ($hDesk -eq [IntPtr]::Zero) {
    [Console]::Error.WriteLine("could not create desktop '$DesktopName' (err $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))")
    exit 1
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# Inheritable pipes become the child's stdin/stdout; we keep the server ends.
$inPipe  = New-Object System.IO.Pipes.AnonymousPipeServerStream('Out', 'Inheritable')
$outPipe = New-Object System.IO.Pipes.AnonymousPipeServerStream('In',  'Inheritable')

$env:OPERATOR_DESKTOP = $DesktopName
$cmd = "`"$psExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helper`""

$pid2 = [Launch]::Spawn($DesktopName, $cmd,
    $inPipe.ClientSafePipeHandle.DangerousGetHandle(),
    $outPipe.ClientSafePipeHandle.DangerousGetHandle())

if ($pid2 -lt 0) {
    [Console]::Error.WriteLine("could not start the helper on the private desktop (err $([math]::Abs($pid2)))")
    exit 1
}

# Only the child should hold the client ends now, or EOF never propagates.
$inPipe.DisposeLocalCopyOfClientHandle()
$outPipe.DisposeLocalCopyOfClientHandle()

# Pipe Operator's stdin to the child and the child's stdout back. When Operator
# closes our stdin, inPipe breaks, the helper reads EOF and exits, the desktop
# is released — no orphan, no leftover desktop.
$myIn  = [Console]::OpenStandardInput()
$myOut = [Console]::OpenStandardOutput()
$feed  = $myIn.CopyToAsync($inPipe)
$drain = $outPipe.CopyToAsync($myOut)

try {
    $child = [System.Diagnostics.Process]::GetProcessById($pid2)
    $child.WaitForExit()
} catch {
    # child already gone
}
