# speech-helper.ps1 - the agent's voice.
#
# Hearing is Whisper's job now (see whisper.js); this only speaks. That split
# matters for a practical reason as well as a quality one: the old
# System.Speech recognizer held the default input device open, which would stop
# the browser's getUserMedia from ever getting the microphone.
#
# One JSON command per line on stdin, one event per line on stdout.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

Add-Type -ReferencedAssemblies System.Speech @'
using System;
using System.Speech.Synthesis;

public class Voice {
    static SpeechSynthesizer syn;
    static readonly object sync = new object();

    static string Esc(string s) {
        if (s == null) return "";
        System.Text.StringBuilder b = new System.Text.StringBuilder();
        foreach (char c in s) {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c == '\n') b.Append("\\n");
            else if (c == '\r') b.Append("\\r");
            else if (c == '\t') b.Append("\\t");
            else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.ToString();
    }

    // Speech finishes on a background thread, so every write locks.
    public static void Emit(string json) {
        lock (sync) {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    public static string Init() {
        syn = new SpeechSynthesizer();
        syn.SetOutputToDefaultAudioDevice();
        // The UI un-mutes the microphone on this, so it has to fire even when a
        // line is cancelled part-way through.
        syn.SpeakCompleted += delegate(object s, SpeakCompletedEventArgs e) {
            Emit("{\"ev\":\"spoke\"}");
        };
        return syn.Voice.Name;
    }

    public static void Say(string text) {
        if (string.IsNullOrEmpty(text)) return;
        syn.SpeakAsyncCancelAll();
        syn.SpeakAsync(text);
    }

    public static void Hush() { syn.SpeakAsyncCancelAll(); }

    public static void SetRate(int rate) { syn.Rate = rate; }

    public static string SetVoice(string name) {
        foreach (InstalledVoice v in syn.GetInstalledVoices()) {
            if (v.VoiceInfo.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) {
                syn.SelectVoice(v.VoiceInfo.Name);
                return v.VoiceInfo.Name;
            }
        }
        return null;
    }

    public static string Voices() {
        string s = "";
        foreach (InstalledVoice v in syn.GetInstalledVoices()) {
            if (s.Length > 0) s += "|";
            s += v.VoiceInfo.Name;
        }
        return s;
    }
}
'@

try {
    $voice = [Voice]::Init()
    [Voice]::SetRate(1)
    [Voice]::Emit('{"ev":"ready","voice":"' + $voice + '","voices":"' + [Voice]::Voices() + '"}')
} catch {
    [Voice]::Emit('{"ev":"error","error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
    exit 1
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq "") { continue }

    try {
        $req = $line | ConvertFrom-Json
        switch ("$($req.cmd)".ToLower()) {
            "say"   { [Voice]::Say("$($req.text)") }
            "hush"  { [Voice]::Hush() }
            "rate"  { [Voice]::SetRate([int]$req.rate) }
            "voice" {
                $got = [Voice]::SetVoice("$($req.name)")
                if ($got) { [Voice]::Emit('{"ev":"voice","name":"' + $got + '"}') }
                else { [Voice]::Emit('{"ev":"error","error":"no voice matching ' + $req.name + '"}') }
            }
            "ping"  { [Voice]::Emit('{"ev":"pong"}') }
            default { [Voice]::Emit('{"ev":"error","error":"unknown command"}') }
        }
    } catch {
        [Voice]::Emit('{"ev":"error","error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
    }
}
