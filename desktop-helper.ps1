# desktop-helper.ps1 - the agent's hands and eyes on the real desktop.
#
# Runs as one long-lived process. Reads one JSON command per line on stdin,
# writes one JSON result per line on stdout. Keeping it alive matters: the
# C# below takes ~1s to compile, and we only want to pay that once.
#
# All coordinates crossing this boundary are in SCALED display space - the same
# space as the screenshots we hand back. Physical pixels never leave this file.

$ErrorActionPreference = 'Stop'

# This protocol is UTF-8 on the Node side, so it has to be UTF-8 on this side
# too. Without it the console falls back to the ANSI codepage and a single
# accented character in a window title emits a byte that the reader cannot
# decode — it then swallows the following bytes waiting for a continuation
# that never comes, and the rest of the JSON line is lost. No BOM: it would
# be written once at the head of the stream and break the first reply.
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class Op {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    // Sequential layout gives the union its natural alignment, so this is
    // correct on x86 and x64 alike - don't flatten it into padded fields.
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    // Used for private-desktop capture: a background desktop has no display
    // surface to copy, so we ask each window to paint itself instead.
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public int dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr PostMessageW(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gti);

    const uint WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_RBUTTONDOWN = 0x204, WM_RBUTTONUP = 0x205;
    const uint WM_CHAR = 0x102, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SETCURSOR = 0x20, WM_MOUSEMOVE = 0x200;

    static IntPtr LParam(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

    // The control the agent is working in. Later keystrokes go straight here, so
    // hands-off typing never depends on the window being the foreground one — and
    // so it never has to steal the foreground away from the user.
    public static IntPtr TypeTarget = IntPtr.Zero;

    // On a private desktop SendInput does nothing — it targets the physical
    // input desktop. So we deliver a click as window messages posted straight to
    // the control under the point, which the background desktop honours.
    public static void ClickMsg(int x, int y, string button, int clicks, bool activate) {
        // `activate` is the private-desktop case: that desktop has its own cursor
        // and foreground, so we move its pointer and bring the window forward.
        // On the SHARED desktop `activate` is false and we do NEITHER — the click
        // is posted to the window under (x, y) directly, so the user's real mouse
        // never jumps and their foreground window (and keyboard focus) never
        // changes out from under them. WindowFromPoint takes explicit coordinates,
        // so we don't need the cursor to be there.
        if (activate) SetCursorPos(x, y);
        POINT pt; pt.X = x; pt.Y = y;
        IntPtr target = WindowFromPoint(pt);
        if (target == IntPtr.Zero) return;
        IntPtr top = GetAncestor(target, 2 /* GA_ROOT */);
        if (activate) Focus(top.ToInt64());
        TypeTarget = target;   // aim subsequent typing at whatever we just clicked
        POINT c = pt; ScreenToClient(target, ref c);
        IntPtr lp = LParam(c.X, c.Y);
        uint down = button == "right" ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
        uint up   = button == "right" ? WM_RBUTTONUP   : WM_LBUTTONUP;
        for (int i = 0; i < clicks; i++) {
            PostMessageW(target, WM_MOUSEMOVE, IntPtr.Zero, lp);
            PostMessageW(target, down, (IntPtr)1, lp);
            PostMessageW(target, up, IntPtr.Zero, lp);
            System.Threading.Thread.Sleep(30);
        }
    }

    // Hands-off scroll: post the wheel message to the window under the point,
    // no cursor movement. wParam high word is the wheel delta.
    public static void ScrollMsg(int x, int y, int amount, bool horizontal) {
        POINT pt; pt.X = x; pt.Y = y;
        IntPtr target = WindowFromPoint(pt);
        if (target == IntPtr.Zero) return;
        IntPtr wparam = (IntPtr)((amount << 16));
        IntPtr lp = LParam(x, y);   // wheel messages use screen coordinates
        PostMessageW(target, horizontal ? (uint)0x020E : (uint)0x020A, wparam, lp);
    }

    static IntPtr FocusedControl() {
        IntPtr fg = GetForegroundWindow();
        uint tid = GetWindowThreadProcessId(fg, out _pid);
        GUITHREADINFO g = new GUITHREADINFO();
        g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(tid, ref g) && g.hwndFocus != IntPtr.Zero) return g.hwndFocus;
        return fg;
    }
    static uint _pid;

    // Point typing at the last window we clicked or focused. Only when we have no
    // target yet do we fall back to the foreground control — which on the shared
    // desktop would be the user's own window, so a click/focus should come first.
    static IntPtr TypeSink() {
        return TypeTarget != IntPtr.Zero ? TypeTarget : FocusedControl();
    }

    public static void TypeMsg(string text) {
        IntPtr h = TypeSink();
        if (h == IntPtr.Zero) return;
        foreach (char ch in text) {
            if (ch == '\n' || ch == '\r') {
                PostMessageW(h, WM_KEYDOWN, (IntPtr)0x0D, IntPtr.Zero);
                PostMessageW(h, WM_KEYUP, (IntPtr)0x0D, IntPtr.Zero);
            } else {
                PostMessageW(h, WM_CHAR, (IntPtr)ch, IntPtr.Zero);
            }
            System.Threading.Thread.Sleep(4);
        }
    }

    // Key combos to the focused control. Modifiers are held down around the key.
    public static string KeyMsg(string combo) {
        string[] parts = combo.Split('+');
        List<ushort> codes = new List<ushort>();
        foreach (string raw in parts) {
            string p = raw.Trim();
            if (p.Length == 0) continue;
            if (!VK.ContainsKey(p)) return "unknown key: " + p;
            codes.Add(VK[p]);
        }
        if (codes.Count == 0) return "no keys given";
        IntPtr h = TypeSink();
        foreach (ushort c in codes) PostMessageW(h, WM_KEYDOWN, (IntPtr)c, IntPtr.Zero);
        for (int i = codes.Count - 1; i >= 0; i--) PostMessageW(h, WM_KEYUP, (IntPtr)codes[i], IntPtr.Zero);
        return null;
    }

    // Force a program onto a named desktop, so single-instance apps (Windows 11
    // Notepad, Calculator) actually open there instead of waking the copy on the
    // desktop the user is looking at.
    public static int StartOnDesktop(string cmdline, string desktop) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = desktop;
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(null, cmdline, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
        if (!ok) return -Marshal.GetLastWin32Error();
        return pi.dwProcessId;
    }
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);

    public delegate bool EnumProc(IntPtr h, IntPtr lParam);

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    static void Send(INPUT[] inputs) {
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static INPUT Mouse(uint flags, uint data) {
        INPUT i = new INPUT();
        i.type = 0;
        i.u.mi.dwFlags = flags;
        i.u.mi.mouseData = data;
        return i;
    }

    static INPUT Key(ushort vk, ushort scan, uint flags) {
        INPUT i = new INPUT();
        i.type = 1;
        i.u.ki.wVk = vk;
        i.u.ki.wScan = scan;
        i.u.ki.dwFlags = flags;
        return i;
    }

    // Slide the pointer to a target instead of teleporting it. Besides looking
    // like a person, it makes hover menus, tooltips and drag targets actually
    // fire - plenty of UI only reacts to mousemove on the way in.
    //
    // Duration scales with distance and is capped, so a long trip across two
    // monitors still costs a fraction of a second.
    public static void Glide(int x, int y) {
        POINT from;
        GetCursorPos(out from);
        double dist = Math.Sqrt(Math.Pow(x - from.X, 2) + Math.Pow(y - from.Y, 2));
        // Nudges aren't worth animating, and at this distance nobody can see it.
        if (dist < 8) { SetCursorPos(x, y); return; }

        // Only the step COUNT controls duration. Windows' default timer
        // granularity is ~15.6ms, so Sleep(3) and Sleep(7) both cost the same
        // ~15.6ms - asking for a shorter delay buys nothing, and tuning the
        // delay instead of the count is what made a glide take half a second.
        // 18 steps therefore lands a full-screen traverse at roughly 280ms.
        int steps = (int)Math.Min(18, Math.Max(6, dist / 60));
        int perStep = 1;

        for (int s = 1; s <= steps; s++) {
            double t = (double)s / steps;
            // Ease in/out: quick through the middle, settling onto the target.
            double e = t < 0.5 ? 2 * t * t : 1 - Math.Pow(-2 * t + 2, 2) / 2;
            SetCursorPos((int)Math.Round(from.X + (x - from.X) * e),
                         (int)Math.Round(from.Y + (y - from.Y) * e));
            System.Threading.Thread.Sleep(perStep);
        }
        SetCursorPos(x, y);
    }

    public static void Click(int x, int y, string button, int clicks) {
        Glide(x, y);
        System.Threading.Thread.Sleep(15);
        uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
        if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        for (int c = 0; c < clicks; c++) {
            Send(new INPUT[] { Mouse(down, 0), Mouse(up, 0) });
            if (c + 1 < clicks) System.Threading.Thread.Sleep(55);   // inside the double-click window
        }
    }

    public static void Drag(int x1, int y1, int x2, int y2) {
        Glide(x1, y1);
        System.Threading.Thread.Sleep(40);
        Send(new INPUT[] { Mouse(MOUSEEVENTF_LEFTDOWN, 0) });
        System.Threading.Thread.Sleep(40);
        Glide(x2, y2);
        System.Threading.Thread.Sleep(40);
        Send(new INPUT[] { Mouse(MOUSEEVENTF_LEFTUP, 0) });
    }

    public static void Scroll(int x, int y, int amount, bool horizontal) {
        Glide(x, y);
        System.Threading.Thread.Sleep(15);
        Send(new INPUT[] { Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, unchecked((uint)amount)) });
    }

    // Unicode scan codes, so we type the literal text regardless of the active
    // keyboard layout and never have to fight SendKeys' escaping rules.
    //
    // Sent in batches rather than a keystroke at a time: one SendInput call per
    // character cost 8ms each, which made a sentence take most of a second.
    // Chunking keeps it near-instant while still giving slower apps' input
    // queues a moment to drain between batches.
    public static void TypeText(string text) {
        List<INPUT> batch = new List<INPUT>();
        foreach (char ch in text) {
            if (ch == '\n' || ch == '\r') {
                batch.Add(Key(0x0D, 0, 0));
                batch.Add(Key(0x0D, 0, KEYEVENTF_KEYUP));
            } else {
                batch.Add(Key(0, (ushort)ch, KEYEVENTF_UNICODE));
                batch.Add(Key(0, (ushort)ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            if (batch.Count >= 40) {
                Send(batch.ToArray());
                batch.Clear();
                System.Threading.Thread.Sleep(12);
            }
        }
        if (batch.Count > 0) Send(batch.ToArray());
    }

    static Dictionary<string, ushort> VK = Build();
    static Dictionary<string, ushort> Build() {
        Dictionary<string, ushort> m = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
        m["ctrl"] = 0x11; m["control"] = 0x11; m["alt"] = 0x12; m["shift"] = 0x10;
        m["win"] = 0x5B; m["cmd"] = 0x5B; m["meta"] = 0x5B;
        m["enter"] = 0x0D; m["return"] = 0x0D; m["tab"] = 0x09; m["esc"] = 0x1B; m["escape"] = 0x1B;
        m["space"] = 0x20; m["backspace"] = 0x08; m["delete"] = 0x2E; m["del"] = 0x2E;
        m["insert"] = 0x2D; m["home"] = 0x24; m["end"] = 0x23;
        m["pageup"] = 0x21; m["pagedown"] = 0x22; m["pgup"] = 0x21; m["pgdn"] = 0x22;
        m["up"] = 0x26; m["down"] = 0x28; m["left"] = 0x25; m["right"] = 0x27;
        m["capslock"] = 0x14; m["printscreen"] = 0x2C; m["apps"] = 0x5D; m["menu"] = 0x5D;
        for (int i = 1; i <= 24; i++) m["f" + i] = (ushort)(0x6F + i);
        for (char c = 'a'; c <= 'z'; c++) m[c.ToString()] = (ushort)char.ToUpper(c);
        for (char c = '0'; c <= '9'; c++) m[c.ToString()] = (ushort)c;
        return m;
    }

    public static string PressCombo(string combo) {
        string[] parts = combo.Split('+');
        List<ushort> codes = new List<ushort>();
        foreach (string raw in parts) {
            string p = raw.Trim();
            if (p.Length == 0) continue;
            if (!VK.ContainsKey(p)) return "unknown key: " + p;
            codes.Add(VK[p]);
        }
        if (codes.Count == 0) return "no keys given";
        List<INPUT> seq = new List<INPUT>();
        foreach (ushort c in codes) seq.Add(Key(c, 0, 0));
        for (int i = codes.Count - 1; i >= 0; i--) seq.Add(Key(codes[i], 0, KEYEVENTF_KEYUP));
        Send(seq.ToArray());
        return null;
    }

    public static List<string> ListWindows() {
        List<string> found = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            if (GetWindowTextLengthW(h) == 0) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowTextW(h, sb, sb.Capacity);
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if (r.Right - r.Left < 120 || r.Bottom - r.Top < 80) return true;   // tooltips, tray hosts
            found.Add(h.ToInt64() + "\t" + sb.ToString() + "\t" +
                      r.Left + "\t" + r.Top + "\t" + (r.Right - r.Left) + "\t" + (r.Bottom - r.Top) + "\t" +
                      (IsZoomed(h) ? "1" : "0"));
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // SetForegroundWindow is refused unless we share input state with whoever
    // currently owns the foreground, so borrow it for the duration of the call.
    public static bool Focus(long handle) {
        IntPtr h = new IntPtr(handle);
        if (IsIconic(h)) ShowWindow(h, 9);
        uint pid;
        uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        AttachThreadInput(me, fg, true);
        bool ok = SetForegroundWindow(h);
        AttachThreadInput(me, fg, false);
        return ok;
    }

    // Hands-off focus: aim typing at a window's focused control without calling
    // SetForegroundWindow, so we don't pull it in front of what the user is doing.
    public static void SetTypeTarget(long handle) {
        IntPtr h = new IntPtr(handle);
        uint pid;
        uint tid = GetWindowThreadProcessId(h, out pid);
        GUITHREADINFO g = new GUITHREADINFO();
        g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(tid, ref g) && g.hwndFocus != IntPtr.Zero) TypeTarget = g.hwndFocus;
        else TypeTarget = h;
    }

    public static string ForegroundTitle() {
        IntPtr h = GetForegroundWindow();
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static int[] Cursor() {
        POINT p;
        GetCursorPos(out p);
        return new int[] { p.X, p.Y };
    }
}
'@

# Must happen before System.Drawing / Windows.Forms cache any metrics, or every
# coordinate is silently virtualised on a scaled display.
[void][Op]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$MaxWidth = 1280

$JpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$JpegParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$JpegParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
    [System.Drawing.Imaging.Encoder]::Quality, [int64]82)

function Get-Displays {
    $list = @()
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $list += [pscustomobject]@{
            name = $s.DeviceName; primary = $s.Primary
            left = $s.Bounds.X; top = $s.Bounds.Y
            width = $s.Bounds.Width; height = $s.Bounds.Height
        }
    }
    # Primary first, so "display 1" always means the screen the user faces.
    $sorted = @($list | Sort-Object @{ Expression = { -not $_.primary } }, left)
    for ($i = 0; $i -lt $sorted.Count; $i++) {
        $sorted[$i] | Add-Member -NotePropertyName index -NotePropertyValue ($i + 1) -Force
    }
    ,$sorted
}

# A private desktop is a single primary-sized surface with no second monitor and
# no way to CopyFromScreen, so when we are on one we collapse to one display and
# capture window-by-window instead.
$Hidden = [bool]$env:OPERATOR_DESKTOP

# Hands-off mode: drive windows with posted messages instead of moving the
# physical mouse and keyboard, so the user can keep working. Toggled at runtime.
# Works for ordinary desktop apps; browsers and games ignore posted input, so it
# is off by default and the user opts in.
$Quiet = $false

$Displays = Get-Displays
if ($Hidden) {
    $primary = @($Displays | Where-Object { $_.primary })[0]
    if (-not $primary) { $primary = $Displays[0] }
    $primary.index = 1
    $Displays = @($primary)
}
$Current = 1   # display the last screenshot came from; clicks resolve against it

# Out-of-range is an error, never a silent fallback: quietly answering about
# the wrong monitor sends the agent hunting for windows that were never there.
function Resolve-Display($d) {
    if ($null -eq $d -or "$d" -eq "") { return $script:Current }
    $idx = 0
    if (-not [int]::TryParse("$d", [ref]$idx)) { return $script:Current }
    if ($idx -lt 1 -or $idx -gt $Displays.Count) {
        throw "display $idx does not exist - this PC has $($Displays.Count) (1 is the primary)"
    }
    $idx
}

# $maxW overrides the default only for the picture; click coordinates always
# resolve against $MaxWidth (see ConvertTo-Physical), so what the agent measures
# on its screenshot stays what it hits. 0 means native — no downscale at all.
function Get-Scale([int]$idx, [int]$maxW = 0) {
    if ($maxW -eq 0) { $maxW = $script:MaxWidth }
    if ($maxW -lt 0) { return 1.0 }
    $w = $Displays[$idx - 1].width
    if ($w -le $maxW) { return 1.0 }
    $maxW / [double]$w
}

# Scaled display coords -> physical virtual-desktop coords.
function ConvertTo-Physical([int]$idx, [double]$x, [double]$y) {
    $d = $Displays[$idx - 1]
    $s = Get-Scale $idx
    @([int][math]::Round($d.left + $x / $s), [int][math]::Round($d.top + $y / $s))
}

# --- reading the screen as text -------------------------------------------
#
# The browser tools hand the model the page as text, which is why web work is
# quick: a look costs a couple of hundred tokens instead of a ~1,200-token
# picture, and elements are named rather than hunted for by eye. UI Automation
# is the same thing for native windows. Everything here exists to give the
# desktop that second, cheap way to look.

$script:UiaReady = $null

# Loaded on first use, not at startup: most tasks never read a native window,
# and these assemblies cost a moment to bring in.
function Initialize-Uia {
    if ($null -ne $script:UiaReady) { return $script:UiaReady }
    try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
        $script:UiaReady = $true
    } catch {
        $script:UiaReady = $false
    }
    return $script:UiaReady
}

# Physical virtual-desktop coords -> the scaled space the agent works in. The
# exact inverse of ConvertTo-Physical: UI Automation reports real pixels, but
# everything crossing this boundary must match the screenshots, or a control
# found by name gets clicked in the wrong place.
function ConvertTo-Scaled([double]$px, [double]$py) {
    foreach ($d in $Displays) {
        if ($px -ge $d.left -and $px -lt ($d.left + $d.width) -and
            $py -ge $d.top  -and $py -lt ($d.top + $d.height)) {
            $s = Get-Scale $d.index
            return @{ x = [int][math]::Round(($px - $d.left) * $s)
                      y = [int][math]::Round(($py - $d.top) * $s)
                      d = $d.index }
        }
    }
    return $null   # scrolled out of view, minimised, or on another desktop
}

# Things worth naming: either the agent can act on them, or they carry the text
# that tells it what it is looking at.
#
# The awkward part is Pane. A modern app uses real control types, and its Panes
# are layout - pure noise. A legacy Win32 app reaches UI Automation through the
# MSAA bridge, where EVERY control arrives as a Pane carrying the right name;
# drop those and Character Map, and half of Windows with it, reads as empty.
# What tells them apart is children: a named Pane with nothing inside it is a
# control, a named Pane with children is a container. So we judge each node
# once we have enumerated its children, not before.
$script:UiaAct  = @('Button','Edit','CheckBox','ComboBox','MenuItem','TabItem','Hyperlink',
                    'ListItem','TreeItem','RadioButton','SplitButton','Slider','Spinner','Tab')
$script:UiaText = @('Text','Document')
$script:UiaMaybe = @('Pane','Group','Custom')

function Read-UiaTree($root, [int]$maxDepth, [int]$budget) {
    $rows = New-Object System.Collections.ArrayList
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $seen = 0

    # An explicit stack rather than recursion: the budget has to stop the walk
    # the moment it is spent, and a deep tree should not cost stack frames.
    # Each node is reported as it comes off the stack, once its children are
    # known - see the Pane note above for why that ordering matters.
    $stack = New-Object System.Collections.Stack
    $stack.Push(@{ el = $root; depth = 0 })

    while ($stack.Count -gt 0 -and $seen -lt $budget) {
        $node = $stack.Pop()
        $depth = $node.depth

        $kids = @()
        try {
            $child = $walker.GetFirstChild($node.el)
            while ($null -ne $child) { $kids += $child; $child = $walker.GetNextSibling($child) }
        } catch { $kids = @() }

        # Skip the window itself; it is named in the reply already.
        if ($depth -gt 0) {
            $seen++
            try {
                $cur = $node.el.Current
                if (-not $cur.IsOffscreen) {
                    $type = $cur.ControlType.ProgrammaticName -replace 'ControlType\.', ''
                    $name = ($cur.Name -replace '\s+', ' ').Trim()
                    $leaf = ($kids.Count -eq 0)

                    $act = $false
                    $keep = $false
                    if ($script:UiaAct -contains $type)                          { $act = $true;  $keep = $true }
                    elseif ($script:UiaMaybe -contains $type -and $name -and $leaf) { $act = $true;  $keep = $true }
                    elseif ($script:UiaText -contains $type -and $name)          { $act = $false; $keep = $true }

                    if ($keep -and ($name -or $act)) {
                        $r = $cur.BoundingRectangle
                        if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0) {
                            $pt = ConvertTo-Scaled ($r.X + $r.Width / 2) ($r.Y + $r.Height / 2)
                            if ($null -ne $pt) {
                                [void]$rows.Add(@{
                                    type = $type; name = $name; act = $act
                                    x = $pt.x; y = $pt.y; d = $pt.d
                                })
                            }
                        }
                    }
                }
            } catch { }
        }

        # Pushed in reverse so siblings come back out in reading order.
        if ($depth -lt $maxDepth) {
            for ($i = $kids.Count - 1; $i -ge 0; $i--) {
                $stack.Push(@{ el = $kids[$i]; depth = $depth + 1 })
            }
        }
    }
    return @{ rows = @($rows); visited = $seen; truncated = ($seen -ge $budget) }
}

# The window a read or a name-click applies to: one matched by title, else
# whatever the user is actually looking at.
function Resolve-UiaWindow([string]$title) {
    $hit = $null
    foreach ($w in [Op]::ListWindows()) {
        $f = $w -split "`t"
        # Plain substring, not -like: a title containing [ or ] is a wildcard
        # to -like and would never match itself.
        if ($title) {
            if ($f[1].IndexOf($title, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $f; break }
        }
    }
    if (-not $title) {
        $fgTitle = [Op]::ForegroundTitle()
        foreach ($w in [Op]::ListWindows()) {
            $f = $w -split "`t"
            if ($f[1] -eq $fgTitle) { $hit = $f; break }
        }
    }
    if ($null -eq $hit) { return $null }
    try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$hit[0])
        return @{ el = $el; title = $hit[1]; handle = $hit[0] }
    } catch { return $null }
}

function Get-Capture([int]$idx, [int]$maxW = 0, [int]$quality = 0) {
    $d = $Displays[$idx - 1]
    $s = Get-Scale $idx $maxW
    $tw = [int][math]::Round($d.width * $s)
    $th = [int][math]::Round($d.height * $s)

    $shot = New-Object System.Drawing.Bitmap($d.width, $d.height)
    $g = [System.Drawing.Graphics]::FromImage($shot)
    if ($script:Hidden) {
        # No screen surface on a background desktop. Paint a dark ground, then
        # ask each window on THIS desktop to render itself, bottom of the stack
        # first so the top windows land on top.
        $g.Clear([System.Drawing.Color]::FromArgb(24, 24, 26))
        $wins = @([Op]::ListWindows())
        [array]::Reverse($wins)
        foreach ($w in $wins) {
            $f = $w -split "`t"
            $ww = [int]$f[4]; $wh = [int]$f[5]
            if ($ww -le 0 -or $wh -le 0) { continue }
            $wb = New-Object System.Drawing.Bitmap($ww, $wh)
            $wg = [System.Drawing.Graphics]::FromImage($wb)
            $hdc = $wg.GetHdc()
            [void][Op]::PrintWindow([IntPtr][int64]$f[0], $hdc, 2)  # 2 = PW_RENDERFULLCONTENT
            $wg.ReleaseHdc($hdc)
            $wg.Dispose()
            $g.DrawImage($wb, ([int]$f[2] - $d.left), ([int]$f[3] - $d.top))
            $wb.Dispose()
        }
    } else {
        $g.CopyFromScreen($d.left, $d.top, 0, 0, $shot.Size)
    }
    $g.Dispose()

    if ($s -lt 1.0) {
        $small = New-Object System.Drawing.Bitmap($tw, $th)
        $g2 = [System.Drawing.Graphics]::FromImage($small)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g2.DrawImage($shot, 0, 0, $tw, $th)
        $g2.Dispose()
        $shot.Dispose()
        $shot = $small
    }

    # JPEG, not PNG: a desktop screenshot is ~780 KB as PNG and ~120 KB as
    # quality-82 JPEG. The model is charged by dimensions either way, so this is
    # pure latency saved on encode and on the pipe, and text stays readable.
    $ms = New-Object System.IO.MemoryStream
    $params = $script:JpegParams
    if ($quality -gt 0 -and $quality -ne 82) {
        $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [int64]$quality)
    }
    $shot.Save($ms, $script:JpegCodec, $params)
    $shot.Dispose()
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose()
    @{ image = $b64; mime = 'image/jpeg'; width = $tw; height = $th; display = $idx }
}

function Reply($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq "") { continue }

    try {
        $req = $line | ConvertFrom-Json
        $cmd = "$($req.cmd)".ToLower()

        switch ($cmd) {
            "ping" { Reply @{ ok = $true } }

            "quiet" {
                $script:Quiet = [bool]$req.on
                # Drop any stale target so a mode switch never types into a window
                # left over from the previous mode.
                [Op]::TypeTarget = [IntPtr]::Zero
                Reply @{ ok = $true; quiet = $script:Quiet }
            }

            "info" {
                $info = @()
                foreach ($d in $Displays) {
                    $s = Get-Scale $d.index
                    $info += @{ index = $d.index; primary = [bool]$d.primary
                                width = [int][math]::Round($d.width * $s)
                                height = [int][math]::Round($d.height * $s) }
                }
                Reply @{ ok = $true; displays = $info }
            }

            "screenshot" {
                $idx = Resolve-Display $req.display
                $script:Current = $idx
                # w/q are the watch view asking for a crisp full-size frame. The
                # agent never sends them, so its picture and its click coordinates
                # stay in the same 1280-wide space.
                $reqW = if ($null -ne $req.w) { [int]$req.w } else { 0 }
                $reqQ = if ($null -ne $req.q) { [int]$req.q } else { 0 }
                if ($reqW -eq 0 -and $null -ne $req.w) { $reqW = -1 }   # 0 means native
                $shot = Get-Capture $idx $reqW $reqQ
                Reply @{ ok = $true; image = $shot.image; mime = $shot.mime
                         width = $shot.width; height = $shot.height
                         display = $idx; displays = $Displays.Count
                         foreground = [Op]::ForegroundTitle() }
            }

            "move" {
                $idx = Resolve-Display $req.display
                $p = ConvertTo-Physical $idx $req.x $req.y
                # Hands-off: don't touch the physical cursor at all. Otherwise
                # glide (not teleport), since a hover needs the mousemove events.
                if (-not ($script:Quiet -and -not $script:Hidden)) { [Op]::Glide($p[0], $p[1]) }
                Reply @{ ok = $true }
            }

            "click" {
                $idx = Resolve-Display $req.display
                $p = ConvertTo-Physical $idx $req.x $req.y
                $btn = if ($req.button) { "$($req.button)" } else { "left" }
                $n = if ($req.clicks) { [int]$req.clicks } else { 1 }
                if ($script:Hidden) { [Op]::ClickMsg($p[0], $p[1], $btn, $n, $true) }
                elseif ($script:Quiet) { [Op]::ClickMsg($p[0], $p[1], $btn, $n, $false) }
                else { [Op]::Click($p[0], $p[1], $btn, $n) }
                Reply @{ ok = $true }
            }

            "drag" {
                $idx = Resolve-Display $req.display
                $a = ConvertTo-Physical $idx $req.x1 $req.y1
                $b = ConvertTo-Physical $idx $req.x2 $req.y2
                [Op]::Drag($a[0], $a[1], $b[0], $b[1])
                Reply @{ ok = $true }
            }

            "scroll" {
                $idx = Resolve-Display $req.display
                $p = ConvertTo-Physical $idx $req.x $req.y
                $amt = if ($null -ne $req.amount) { [int]$req.amount } else { -360 }
                $h = [bool]$req.horizontal
                if ($script:Quiet -and -not $script:Hidden) { [Op]::ScrollMsg($p[0], $p[1], $amt, $h) }
                else { [Op]::Scroll($p[0], $p[1], $amt, $h) }
                Reply @{ ok = $true }
            }

            "type" {
                if ($script:Hidden -or $script:Quiet) { [Op]::TypeMsg("$($req.text)") }
                else { [Op]::TypeText("$($req.text)") }
                Reply @{ ok = $true }
            }

            "key" {
                $err = if ($script:Hidden -or $script:Quiet) { [Op]::KeyMsg("$($req.keys)") } else { [Op]::PressCombo("$($req.keys)") }
                if ($err) { Reply @{ ok = $false; error = $err } } else { Reply @{ ok = $true } }
            }

            "cursor" { $c = [Op]::Cursor(); Reply @{ ok = $true; x = $c[0]; y = $c[1] } }

            # Read a native window as text instead of a picture. Cheap enough
            # to use for every look, and it names what is there rather than
            # leaving the model to find it by eye.
            "read" {
                if (-not (Initialize-Uia)) {
                    Reply @{ ok = $false; error = "UI Automation is not available on this machine" }
                }
                else {
                    $w = Resolve-UiaWindow "$($req.title)"
                    if ($null -eq $w) {
                        Reply @{ ok = $false; error = if ($req.title) { "no visible window matching '$($req.title)'" } else { "no foreground window to read" } }
                    }
                    else {
                        $depth  = if ($req.depth)  { [int]$req.depth }  else { 8 }
                        $budget = if ($req.budget) { [int]$req.budget } else { 400 }
                        $res = Read-UiaTree $w.el $depth $budget
                        Reply @{ ok = $true; title = $w.title; controls = $res.rows
                                 visited = $res.visited; truncated = $res.truncated }
                    }
                }
            }

            # Click a control by its name. The desktop equivalent of
            # browser_click_text: no coordinates to read off a picture, and no
            # chance of being one row out.
            "clicktext" {
                if (-not (Initialize-Uia)) {
                    Reply @{ ok = $false; error = "UI Automation is not available on this machine" }
                }
                else {
                    $want = "$($req.text)".Trim()
                    $w = Resolve-UiaWindow "$($req.window)"
                    if ($null -eq $w) {
                        Reply @{ ok = $false; error = "no window to click in" }
                    }
                    else {
                        $res = Read-UiaTree $w.el 12 600
                        $cands = @($res.rows | Where-Object { $_.act -and $_.name })

                        # Exact first, then starts-with, then contains: "Save"
                        # should take the Save button, not "Save As...".
                        $hit = $cands | Where-Object { $_.name -eq $want } | Select-Object -First 1
                        if ($null -eq $hit) { $hit = $cands | Where-Object { $_.name -like "$want*" } | Select-Object -First 1 }
                        if ($null -eq $hit) { $hit = $cands | Where-Object { $_.name -like "*$want*" } | Select-Object -First 1 }

                        if ($null -eq $hit) {
                            $near = ($cands | Select-Object -First 25 | ForEach-Object { $_.name }) -join ', '
                            Reply @{ ok = $false; error = "nothing called '$want' in '$($w.title)'"; nearby = $near }
                        }
                        else {
                            # Same click path as the "click" command, so quiet
                            # mode and the private desktop keep behaving.
                            $p = ConvertTo-Physical $hit.d $hit.x $hit.y
                            if ($script:Hidden) { [Op]::ClickMsg($p[0], $p[1], 'left', 1, $true) }
                            elseif ($script:Quiet) { [Op]::ClickMsg($p[0], $p[1], 'left', 1, $false) }
                            else { [Op]::Click($p[0], $p[1], 'left', 1) }
                            Reply @{ ok = $true; clicked = $hit.name; type = $hit.type
                                     x = $hit.x; y = $hit.y; display = $hit.d }
                        }
                    }
                }
            }

            "windows" {
                $rows = @()
                foreach ($w in [Op]::ListWindows()) {
                    $f = $w -split "`t"
                    $rows += @{ handle = $f[0]; title = $f[1]; left = [int]$f[2]; top = [int]$f[3]
                                width = [int]$f[4]; height = [int]$f[5]; max = ($f[6] -eq "1") }
                }
                Reply @{ ok = $true; windows = $rows; foreground = [Op]::ForegroundTitle() }
            }

            # Put a window back the way it was found. Opening a tab drops Chrome
            # out of full screen, and leaving someone's window smaller than they
            # left it is its own small rudeness.
            "maximize" {
                $want = "$($req.title)"
                $hit = $null
                foreach ($w in [Op]::ListWindows()) {
                    $f = $w -split "`t"
                    if ($f[1].ToLower().Contains($want.ToLower())) { $hit = $f; break }
                }
                if ($null -eq $hit) { Reply @{ ok = $false; error = "no visible window matching '$want'" } }
                else {
                    [Op]::ShowWindow([IntPtr][long]$hit[0], 3) | Out-Null   # SW_MAXIMIZE
                    Start-Sleep -Milliseconds 150
                    Reply @{ ok = $true; title = $hit[1] }
                }
            }

            "focus" {
                $want = "$($req.title)"
                $hit = $null
                foreach ($w in [Op]::ListWindows()) {
                    $f = $w -split "`t"
                    if ($f[1] -like "*$want*") { $hit = $f; break }
                }
                if ($null -eq $hit) { Reply @{ ok = $false; error = "no visible window matching '$want'" } }
                elseif ($script:Quiet -and -not $script:Hidden) {
                    # Hands-off: send later keystrokes to this window, but leave the
                    # user's foreground where it is instead of yanking it forward.
                    [Op]::SetTypeTarget([long]$hit[0])
                    Reply @{ ok = $true; title = $hit[1] }
                }
                else {
                    [void][Op]::Focus([long]$hit[0])
                    Start-Sleep -Milliseconds 160
                    Reply @{ ok = $true; title = $hit[1] }
                }
            }

            "launch" {
                $target = "$($req.target)"
                # Opening a url goes through ShellExecute, which can hand the
                # browser a "show normal" and drop a maximised window back to
                # its restored size. Note what was maximised so it can be put
                # back below — leaving someone's window smaller than they left
                # it is not ours to do.
                $wasMax = @()
                foreach ($w in [Op]::ListWindows()) {
                    $f = $w -split "`t"
                    if ($f[6] -eq "1") { $wasMax += $f[0] }
                }
                # On a private desktop, force the app onto it. Start-Process would
                # let a single-instance app surface on the user's real desktop.
                if ($script:Hidden -and $target -notmatch '^[a-z]+://') {
                    $exe = $target
                    if ($exe -notmatch '[\\/:]' -and $exe -notmatch '\.exe$') { $exe = "$exe.exe" }
                    $cmdline = if ($exe -match '\s') { "`"$exe`"" } else { $exe }
                    if ($req.args) { $cmdline += " $($req.args)" }
                    $r = [Op]::StartOnDesktop($cmdline, $env:OPERATOR_DESKTOP)
                    if ($r -lt 0) {
                        # Fall back for things CreateProcess can't launch (shell verbs).
                        Start-Process -FilePath $target -ErrorAction SilentlyContinue | Out-Null
                    }
                } elseif ($req.args) {
                    Start-Process -FilePath $target -ArgumentList "$($req.args)" | Out-Null
                } else {
                    Start-Process -FilePath $target | Out-Null
                }
                Start-Sleep -Milliseconds 700
                $restored = 0
                foreach ($h in $wasMax) {
                    $ptr = [IntPtr][long]$h
                    if ([Op]::IsWindowVisible($ptr) -and -not [Op]::IsZoomed($ptr)) {
                        [Op]::ShowWindow($ptr, 3) | Out-Null   # SW_MAXIMIZE
                        $restored++
                    }
                }
                Reply @{ ok = $true; remaximized = $restored }
            }

            # Only used when this helper is the far end of a remote session:
            # locally, Operator runs shell commands itself. Given its own
            # process so a command that blocks cannot wedge this loop forever.
            "shell" {
                $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
                $si = New-Object System.Diagnostics.ProcessStartInfo
                $si.FileName = $psExe
                $si.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $([char]34)$($req.command -replace '"', '\"')$([char]34)"
                $si.RedirectStandardOutput = $true
                $si.RedirectStandardError = $true
                $si.UseShellExecute = $false
                $si.CreateNoWindow = $true

                $p = [System.Diagnostics.Process]::Start($si)
                $stdout = $p.StandardOutput.ReadToEndAsync()
                $stderr = $p.StandardError.ReadToEndAsync()
                if ($p.WaitForExit(60000)) {
                    $text = (($stdout.Result, $stderr.Result) | Where-Object { $_ -and $_.Trim() }) -join "`n"
                    Reply @{ ok = $true; output = $text.Trim() }
                } else {
                    try { $p.Kill() } catch {}
                    Reply @{ ok = $true; output = "Timed out after 60s." }
                }
            }

            default { Reply @{ ok = $false; error = "unknown command: $cmd" } }
        }
    } catch {
        Reply @{ ok = $false; error = "$($_.Exception.Message)" }
    }
}
