# remote-node.ps1 - run this ON the machine you want Operator to drive.
#
# Turns that machine into Operator's computer. It listens on the LAN and hands
# every request to the ordinary desktop-helper.ps1 running beside it, so there
# is exactly one implementation of the mouse, keyboard and screen code - this
# file is only a doorway to it.
#
#   powershell -ExecutionPolicy Bypass -File remote-node.ps1
#
# On first run it writes a token next to itself and prints it, along with the
# address to give Operator. Requests without that token are refused.
#
# Run it as Administrator: binding a LAN port needs it, and so does sending
# input to windows that are themselves elevated.

param(
    [int]$Port = 8391,
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$helper = Join-Path $here 'desktop-helper.ps1'

if (-not (Test-Path $helper)) {
    Write-Host "desktop-helper.ps1 must sit next to this file. Copy both across." -ForegroundColor Red
    exit 1
}

# ── token ────────────────────────────────────────────────────────────────
$tokenFile = Join-Path $here 'operator-node.token'
if (-not $Token) {
    if (Test-Path $tokenFile) {
        $Token = (Get-Content $tokenFile -Raw).Trim()
    } else {
        $bytes = New-Object byte[] 24
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $Token = ([Convert]::ToBase64String($bytes) -replace '[^a-zA-Z0-9]', '').Substring(0, 24)
        Set-Content -Path $tokenFile -Value $Token -Encoding utf8
    }
}

# ── the helper, kept alive, spoken to over its stdin/stdout ──────────────
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $ps
$psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helper`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$helperProc = [System.Diagnostics.Process]::Start($psi)

# Drain stderr from the start. If the helper dies later we still have its last
# words, which is the difference between a useful error and "it stopped".
$errTask = $helperProc.StandardError.ReadToEndAsync()

# Don't just sleep and check it is alive: compiling the helper's C# takes well
# over a second, so a short sleep passes while it is still starting - and any
# failure after that went unnoticed and surfaced later as a bare 503.
# Ask it something instead, and wait for a real answer.
Write-Host "  starting the desktop helper..." -ForegroundColor DarkGray
$ready = $false
$deadline = (Get-Date).AddSeconds(25)

try {
    $helperProc.StandardInput.WriteLine('{"cmd":"ping"}')
    $helperProc.StandardInput.Flush()
    $readLine = $helperProc.StandardOutput.ReadLineAsync()
    while ((Get-Date) -lt $deadline) {
        if ($readLine.IsCompleted) { $ready = $true; break }
        if ($helperProc.HasExited) { break }
        Start-Sleep -Milliseconds 200
    }
} catch {}

if (-not $ready) {
    $err = ''
    if ($errTask.IsCompleted) { $err = $errTask.Result }
    Write-Host ""
    Write-Host "  The desktop helper would not start." -ForegroundColor Red
    if ($err.Trim()) { Write-Host $err.Trim() -ForegroundColor DarkGray }
    Write-Host ""
    if ($err -match 'malicious|antivirus|AMSI') {
        Write-Host "  Your antivirus blocked it. This machine needs an exclusion for:" -ForegroundColor Yellow
        Write-Host "    $here" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Windows Security > Virus & threat protection > Manage settings"
        Write-Host "  > Exclusions > Add an exclusion > Folder"
    } else {
        Write-Host "  It did not answer within 25 seconds." -ForegroundColor Yellow
        Write-Host "  Check desktop-helper.ps1 sits next to this file and is not blocked."
    }
    try { $helperProc.Kill() } catch {}
    exit 1
}
Write-Host "  desktop helper is up." -ForegroundColor DarkGray

# The helper answers exactly one line per command, so requests are serialised.
$gate = New-Object object

function Invoke-Helper([string]$json) {
    [System.Threading.Monitor]::Enter($gate)
    try {
        $helperProc.StandardInput.WriteLine($json)
        $helperProc.StandardInput.Flush()
        $line = $helperProc.StandardOutput.ReadLine()
        if ($null -eq $line) { return '{"ok":false,"error":"helper closed"}' }
        return $line
    } finally {
        [System.Threading.Monitor]::Exit($gate)
    }
}

# ── the doorway ──────────────────────────────────────────────────────────
$listener = New-Object System.Net.HttpListener
$lanOk = $true

# Listening on the LAN needs an admin URL reservation. Rather than refuse to
# start without one, fall back to localhost and say so - that still proves the
# setup works, it just cannot be reached from the other machine yet.
try {
    $listener.Prefixes.Add("http://+:$Port/")
    $listener.Start()
} catch {
    $lanOk = $false
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$Port/")
    try {
        $listener.Start()
    } catch {
        Write-Host "Could not listen on port $Port at all - something else may be using it." -ForegroundColor Red
        Write-Host "Try another port with -Port 8392." -ForegroundColor Yellow
        $helperProc.Kill()
        exit 1
    }
}

$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    Select-Object -ExpandProperty IPAddress)

Write-Host ""
Write-Host "  Operator node is up on $env:COMPUTERNAME" -ForegroundColor Green
Write-Host ""
Write-Host "  Give Operator these two things:"
if ($lanOk) {
    foreach ($ip in $ips) { Write-Host "     address   http://${ip}:$Port" -ForegroundColor Cyan }
} else {
    Write-Host "     address   http://localhost:$Port" -ForegroundColor Cyan
}
Write-Host "     token     $Token" -ForegroundColor Cyan
Write-Host ""

if (-not $lanOk) {
    Write-Host "  LOCALHOST ONLY - the other machine cannot reach this yet." -ForegroundColor Yellow
    Write-Host "  Close this and re-run the window as Administrator to accept LAN"
    Write-Host "  connections, and allow the port in Windows Firewall."
    Write-Host ""
}

Write-Host "  Anyone on this network with that token can control this machine."
Write-Host "  Close this window to stop it. Ctrl+C also works."
Write-Host ""

function Write-Json($ctx, [int]$code, [string]$body) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $ctx.Response.StatusCode = $code
    $ctx.Response.ContentType = 'application/json'
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        try {
            if ($helperProc.HasExited) {
                $why = ''
                if ($errTask.IsCompleted) { $why = $errTask.Result.Trim() }
                if (-not $why) { $why = 'no error output' }
                Write-Json $ctx 503 (@{ ok = $false
                    error = "the desktop helper died on $env:COMPUTERNAME - $why" } | ConvertTo-Json -Compress)
                continue
            }

            # Constant-time-ish compare, and checked before anything is parsed.
            $given = $ctx.Request.Headers['X-Operator-Token']
            # -cne, not -ne: PowerShell string comparison is case-insensitive by
            # default, which quietly threw away part of the token's keyspace.
            if (-not $given -or $given -cne $Token) {
                Write-Host "  refused a request from $($ctx.Request.RemoteEndPoint.Address) - bad token" -ForegroundColor DarkYellow
                Write-Json $ctx 401 '{"ok":false,"error":"bad or missing token"}'
                continue
            }

            if ($ctx.Request.Url.AbsolutePath -eq '/ping') {
                Write-Json $ctx 200 (@{ ok = $true; host = $env:COMPUTERNAME } | ConvertTo-Json -Compress)
                continue
            }

            if ($ctx.Request.Url.AbsolutePath -ne '/cmd' -or $ctx.Request.HttpMethod -ne 'POST') {
                Write-Json $ctx 404 '{"ok":false,"error":"not found"}'
                continue
            }

            $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
            $body = $reader.ReadToEnd()
            $reader.Close()

            Write-Json $ctx 200 (Invoke-Helper ($body -replace "[`r`n]", ' '))
        } catch {
            try { Write-Json $ctx 500 (@{ ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress) } catch {}
        }
    }
} finally {
    Write-Host "  shutting down..."
    try { $listener.Stop() } catch {}
    try { $helperProc.Kill() } catch {}
}
