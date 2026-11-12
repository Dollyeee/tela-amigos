// AudioHelper: captura de áudio por app (process loopback, Win10 2004+) e de vídeo (WGC + H.264 por hardware).
//
// Protocolo:
//   stdin  -> uma linha JSON por comando; "id" (opcional) volta na resposta:
//             {"id":1,"cmd":"list","selfPid":123}
//             {"id":2,"cmd":"start","mode":"all-except","selfPid":123}   (tudo exceto Discord e o próprio app)
//             {"id":3,"cmd":"start","mode":"app","pid":456,"selfPid":123} (só um app e seus filhos)
//             {"id":4,"cmd":"stop"}
//             {"id":5,"cmd":"video-start", ...} / video-stop / video-key / video-bitrate
//             (video-start com "light":{maxWidth,maxHeight,fps,kbps} abre também a versão leve; video-key e
//              video-bitrate com "light":true valem para ela)
//   stdout -> pacotes [tipo:1 byte][tamanho:uint32 LE][dados]
//             1 = JSON, 2 = PCM s16le estéreo 48 kHz, 3 = quadro H.264 ([flags][int64 µs][Annex B]),
//             4 = PCM do PC inteiro (clipes), 5 = quadro da versão leve (mesmo formato do 3)
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

static class Program
{
    public const int SampleRate = 48000;
    public const int Channels = 2;
    static Mixer? mixer;
    static volatile VideoStreamer? video; // só a thread "video-cmd" cria/encerra
    static volatile VideoStreamer? videoLight; // a versão leve da mesma tela (2ª qualidade), quando pedida
    static GameWatcher? gameWatcher;
    static Mixer? clipMixer; // áudio do PC inteiro (menos este app) para os clipes

    // ---- saída: fila com escritor próprio; quem captura nunca fica preso esperando o app ler ----
    static readonly BlockingCollection<byte[]> outQueue = new(new ConcurrentQueue<byte[]>(), 400);
    static readonly Stream stdout = Console.OpenStandardOutput();

    /// Chamado quando um quadro de vídeo teve que ser descartado (app não está lendo rápido o bastante).
    public static Action? OnVideoDropped;
    public static Action? OnVideoDroppedLight;

    static void StartWriter()
    {
        new Thread(() =>
        {
            try
            {
                foreach (var p in outQueue.GetConsumingEnumerable()) stdout.Write(p);
            }
            catch
            {
                // o app fechou o pipe. NÃO sair na hora: encerrar com a captura "process loopback"
                // ligada derruba o serviço de áudio do Windows. Descarta o que chegar e deixa o Main
                // ver o stdin fechado e parar tudo direito.
                try { foreach (var _ in outQueue.GetConsumingEnumerable()) { } } catch { }
            }
        }) { IsBackground = true, Name = "stdout" }.Start();
    }

    public static void Send(byte type, ReadOnlySpan<byte> data)
    {
        var p = new byte[5 + data.Length];
        p[0] = type;
        BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(1), (uint)data.Length);
        data.CopyTo(p.AsSpan(5));
        if (type == 1) { outQueue.Add(p); return; }       // mensagens nunca são descartadas
        if (!outQueue.TryAdd(p)) { if (type == 3) OnVideoDropped?.Invoke(); else if (type == 5) OnVideoDroppedLight?.Invoke(); }
    }

    public static void SendJson(object obj) => Send(1, JsonSerializer.SerializeToUtf8Bytes(obj));

    // ---- vídeo numa fila própria: uma chamada da placa que trava (driver, notebook com duas placas)
    // não pode deixar o som e a lista de programas sem resposta
    static readonly BlockingCollection<(string what, Action run)> videoQueue = new();
    static long videoBusySince;       // Stopwatch.GetTimestamp() do comando em andamento; 0 = livre
    static volatile string videoBusyWhat = "";
    static int videoGen;              // cada video-start/stop novo invalida os anteriores
    static volatile bool videoStuckWarned;
    static Timer? videoWatchdog;
    const double VideoStuckSecs = 12;

    static double VideoBusySecs()
    {
        long since = Volatile.Read(ref videoBusySince);
        return since == 0 ? 0 : (Stopwatch.GetTimestamp() - since) / (double)Stopwatch.Frequency;
    }

    static string StuckMessage() =>
        $"a placa de vídeo travou ao {videoBusyWhat} (etapa: {VideoStreamer.CurrentStep}); o som continua funcionando, " +
        "mas a captura nativa só volta reiniciando o app";

    static void StartVideoWorker()
    {
        new Thread(() =>
        {
            foreach (var (what, run) in videoQueue.GetConsumingEnumerable())
            {
                videoBusyWhat = what;
                Volatile.Write(ref videoBusySince, Stopwatch.GetTimestamp());
                try { run(); } catch { }
                Volatile.Write(ref videoBusySince, 0);
                if (videoStuckWarned)
                {
                    videoStuckWarned = false;
                    SendJson(new { type = "warn", message = $"A placa de vídeo destravou ({what})" });
                }
            }
        }) { IsBackground = true, Name = "video-cmd" }.Start();
        videoWatchdog = new Timer(_ =>
        {
            if (!videoStuckWarned && VideoBusySecs() > VideoStuckSecs)
            {
                videoStuckWarned = true;
                SendJson(new { type = "video-stuck", message = StuckMessage() });
            }
        }, null, 2000, 2000);
    }

    /// Põe um comando de vídeo na fila. Se a placa já está travada, responde erro na hora
    /// (quiet: comandos sem resposta, como bitrate/keyframe, só são descartados).
    static void VideoCmd(int? id, string what, Action run, bool quiet = false)
    {
        if (VideoBusySecs() > VideoStuckSecs)
        {
            if (!quiet) SendJson(new { id, type = "error", message = StuckMessage() });
            return;
        }
        videoQueue.Add((what, () =>
        {
            try { run(); }
            catch (Exception ex) { if (!quiet) SendJson(new { id, type = "error", message = ex.Message }); }
        }));
    }

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static async Task Main()
    {
        // Coordenadas de tela em pixels de verdade. Sem isto o Windows entrega ao helper as posições
        // de monitores e janelas já divididas pela escala (125%, 150%...): no Windows 10 um monitor
        // 1080p a 125% era transmitido em 1536x864, e o recorte de uma janela num segundo monitor
        // podia sair deslocado. (-4 = "por monitor, versão 2"; antes de qualquer outra chamada.)
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch { try { SetProcessDPIAware(); } catch { } }
        StartWriter();
        StartVideoWorker();
        SendJson(new { type = "ready" });
        // Os comandos chegam em UTF-8 (o JSON do app). Console.In leria na página de código do
        // Windows, e um programa com acento no nome nunca batia com o nome que o mixer mandava (o
        // volume daquele programa não mudava).
        using var stdin = new StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
        string? line;
        while ((line = await stdin.ReadLineAsync()) != null)
        {
            int? id = null;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number) id = idEl.GetInt32();
                var cmd = root.GetProperty("cmd").GetString();
                int selfPid = root.TryGetProperty("selfPid", out var sp) ? sp.GetInt32() : 0;
                switch (cmd)
                {
                    case "list":
                        SendJson(new { id, type = "list", apps = AudioApps.List(selfPid), devices = AudioApps.Devices(selfPid) });
                        break;
                    case "start":
                        mixer?.Dispose();
                        mixer = null;
                        var mode = root.GetProperty("mode").GetString();
                        int pid = root.TryGetProperty("pid", out var p) ? p.GetInt32() : 0;
                        if (mode == "app" && AudioApps.TreeHasForbidden(pid, selfPid))
                            throw new Exception("esse programa abre o Discord/este app: escolha \"Todo o som do PC, exceto Discord\"");
                        string? devId = mode == "device" && root.TryGetProperty("device", out var dv) ? dv.GetString() : null;
                        if (mode == "device" && string.IsNullOrEmpty(devId)) throw new Exception("saída de som não informada");
                        mixer = devId != null
                            ? new Mixer(0, selfPid, deviceId: devId)
                            : new Mixer(mode == "app" ? pid : 0, selfPid);
                        mixer.Start();
                        SendJson(new { id, type = "started" });
                        break;
                    case "stop":
                        mixer?.Dispose();
                        mixer = null;
                        SendJson(new { id, type = "stopped" });
                        break;

                    case "video-start":
                    {
                        var t = root.GetProperty("target");
                        var target = new VideoTarget(
                            t.GetProperty("type").GetString()!,
                            t.TryGetProperty("hwnd", out var h) ? h.GetInt64() : 0,
                            t.TryGetProperty("x", out var x) ? x.GetInt32() : 0,
                            t.TryGetProperty("y", out var y) ? y.GetInt32() : 0);
                        if (t.TryGetProperty("crop", out var cr) && cr.ValueKind == JsonValueKind.Object)
                        {
                            double F(string k, double d) => cr.TryGetProperty(k, out var e) ? Math.Clamp(e.GetDouble(), 0, 1) : d;
                            target = target with { CropX = F("x", 0), CropY = F("y", 0), CropW = Math.Max(0.05, F("w", 1)), CropH = Math.Max(0.05, F("h", 1)) };
                        }
                        string vcodec = root.TryGetProperty("codec", out var vc) ? vc.GetString() ?? "h264" : "h264";
                        int vfps = root.GetProperty("fps").GetInt32(), vkbps = root.GetProperty("kbps").GetInt32();
                        int vmaxW = root.GetProperty("maxWidth").GetInt32(), vmaxH = root.GetProperty("maxHeight").GetInt32();
                        // versão leve (opcional): menor e a menos quadros por segundo, para miniaturas e redes fracas
                        bool wantLight = root.TryGetProperty("light", out var lo) && lo.ValueKind == JsonValueKind.Object;
                        int lW = wantLight && lo.TryGetProperty("maxWidth", out var a1) ? a1.GetInt32() : 960;
                        int lH = wantLight && lo.TryGetProperty("maxHeight", out var a2) ? a2.GetInt32() : 540;
                        int lFps = wantLight && lo.TryGetProperty("fps", out var a3) ? a3.GetInt32() : 30;
                        int lKbps = wantLight && lo.TryGetProperty("kbps", out var a4) ? a4.GetInt32() : 1800;
                        int gen = Interlocked.Increment(ref videoGen);
                        var vid = id;
                        VideoCmd(id, "iniciar a captura", () =>
                        {
                            videoLight?.Dispose();
                            videoLight = null;
                            video?.Dispose();
                            video = null;
                            var v = new VideoStreamer(vfps, vkbps, vcodec);
                            try { v.Start(target, vmaxW, vmaxH); }
                            catch { v.Dispose(); throw; }
                            // demorou e o app já desistiu (pediu outra coisa): não deixa capturando sozinho
                            if (Volatile.Read(ref videoGen) != gen) { v.Dispose(); throw new Exception("início cancelado"); }
                            // a versão leve é um extra: se a placa não abrir um segundo encoder, segue só com a principal
                            VideoStreamer? lv = null;
                            string? lightErr = null;
                            if (wantLight && (lW < v.Width || lH < v.Height))
                            {
                                try { lv = new VideoStreamer(lFps, lKbps, vcodec, light: true); lv.Start(target, lW, lH); }
                                catch (Exception lex) { lv?.Dispose(); lv = null; lightErr = lex.Message; }
                            }
                            if (Volatile.Read(ref videoGen) != gen) { lv?.Dispose(); v.Dispose(); throw new Exception("início cancelado"); }
                            video = v;
                            videoLight = lv;
                            SendJson(new { id = vid, type = "video-started", width = v.Width, height = v.Height, encoder = v.EncoderName, codec = v.Codec, minQp = v.MinQp,
                                light = lv != null, lightWidth = lv?.Width ?? 0, lightHeight = lv?.Height ?? 0, lightError = lightErr });
                        });
                        break;
                    }
                    case "video-stop":
                    {
                        Interlocked.Increment(ref videoGen);
                        var vid = id;
                        VideoCmd(id, "parar a captura", () =>
                        {
                            videoLight?.Dispose();
                            videoLight = null;
                            video?.Dispose();
                            video = null;
                            SendJson(new { id = vid, type = "video-stopped" });
                        });
                        break;
                    }
                    case "sysaudio-start":
                        clipMixer?.Dispose();
                        clipMixer = new Mixer(selfPid, selfPid, ProcessLoopbackMode.ExcludeTargetProcessTree, 4);
                        clipMixer.Start();
                        SendJson(new { id, type = "sysaudio-started" });
                        break;
                    case "sysaudio-stop":
                        clipMixer?.Dispose();
                        clipMixer = null;
                        SendJson(new { id, type = "sysaudio-stopped" });
                        break;
                    case "game-watch":
                        gameWatcher?.Dispose();
                        gameWatcher = root.TryGetProperty("on", out var on) && on.GetBoolean() ? new GameWatcher(selfPid) : null;
                        SendJson(new { id, type = "game-watch", on = gameWatcher != null });
                        break;
                    case "video-diag":
                    {
                        var vid = id;
                        VideoCmd(id, "listar placas/encoders", () => SendJson(new { id = vid, type = "video-diag", info = VideoStreamer.Diagnose() }));
                        break;
                    }
                    case "video-key":
                    {
                        bool lk = root.TryGetProperty("light", out var lkp) && lkp.ValueKind == JsonValueKind.True;
                        VideoCmd(null, "pedir quadro-chave", () => (lk ? videoLight : video)?.RequestKeyFrame(), quiet: true);
                        break;
                    }
                    case "boost":
                    {
                        var pids = new List<int>();
                        if (root.TryGetProperty("pids", out var pl)) foreach (var e in pl.EnumerateArray()) pids.Add(e.GetInt32());
                        bool high = !root.TryGetProperty("on", out var bo) || bo.GetBoolean();
                        var got = Priority.Boost(pids, high);
                        SendJson(new { id, type = "boost", result = got.ToDictionary(k => k.Key.ToString(), k => k.Value) });
                        break;
                    }
                    case "media-key":
                        MediaKeys.Press(root.TryGetProperty("key", out var mk) ? mk.GetString() ?? "playpause" : "playpause");
                        break;
                    case "audio-gain":
                    {
                        var exe = root.GetProperty("exe").GetString() ?? "";
                        float g = (float)Math.Clamp(root.GetProperty("gain").GetDouble(), 0, 2);
                        if (exe.Length > 0) { if (Math.Abs(g - 1) < 0.001) AudioGains.ByExe.TryRemove(exe, out _); else AudioGains.ByExe[exe] = g; }
                        if (id != null) SendJson(new { id, type = "audio-gain" });
                        break;
                    }
                    case "mixer-apps":
                        SendJson(new { id, type = "mixer-apps", apps = mixer?.Apps() ?? new List<object>() });
                        break;
                    case "video-bitrate":
                    {
                        int kb = root.GetProperty("kbps").GetInt32();
                        bool lb = root.TryGetProperty("light", out var lbp) && lbp.ValueKind == JsonValueKind.True;
                        VideoCmd(null, "mudar o bitrate", () => (lb ? videoLight : video)?.SetBitrate(kb), quiet: true);
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                SendJson(new { id, type = "error", message = ex.Message });
            }
        }
        // stdin fechou: o app principal saiu
        mixer?.Dispose();
        clipMixer?.Dispose();
        // vídeo pela fila (se a placa travou, não espera para sempre: o processo sai assim mesmo)
        using var videoDone = new ManualResetEventSlim(false);
        if (VideoBusySecs() < VideoStuckSecs)
        {
            videoQueue.Add(("fechar", () => { try { videoLight?.Dispose(); videoLight = null; video?.Dispose(); video = null; } finally { videoDone.Set(); } }));
            videoDone.Wait(5000);
        }
    }
}

record AudioApp(int pid, string name, bool discord, string exe);

/// Volume de cada app no áudio transmitido (mixer de quem compartilha), pelo nome do .exe:
/// vale de novo quando o app é reaberto (pid novo). 1 = normal, 0 = mudo, até 2 = mais alto.
static class AudioGains
{
    public static readonly System.Collections.Concurrent.ConcurrentDictionary<string, float> ByExe = new(StringComparer.OrdinalIgnoreCase);
    public static float For(string exe) => exe.Length > 0 && ByExe.TryGetValue(exe, out var g) ? g : 1f;
}

static class ProcTree
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    public record Info(int Parent, string Exe);

    public static Dictionary<int, Info> Snapshot()
    {
        var map = new Dictionary<int, Info>();
        var snap = CreateToolhelp32Snapshot(0x2, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
        try
        {
            var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
            if (Process32FirstW(snap, ref e))
                do map[(int)e.th32ProcessID] = new Info((int)e.th32ParentProcessID, e.szExeFile.ToLowerInvariant());
                while (Process32NextW(snap, ref e));
        }
        finally { CloseHandle(snap); }
        return map;
    }

    /// Sobe na árvore enquanto o pai tiver o mesmo executável (ex.: chrome.exe -> chrome.exe raiz).
    public static int Root(int pid, Dictionary<int, Info> map)
    {
        var seen = new HashSet<int>();
        while (map.TryGetValue(pid, out var info) && seen.Add(pid)
               && info.Parent != 0 && map.TryGetValue(info.Parent, out var parent) && parent.Exe == info.Exe)
            pid = info.Parent;
        return pid;
    }

    public static IEnumerable<int> Ancestry(int pid, Dictionary<int, Info> map)
    {
        var seen = new HashSet<int>();
        while (pid != 0 && seen.Add(pid))
        {
            yield return pid;
            if (!map.TryGetValue(pid, out var info)) yield break;
            pid = info.Parent;
        }
    }

    public static bool IsDiscord(int pid, Dictionary<int, Info> map) =>
        Ancestry(pid, map).Any(p => map.TryGetValue(p, out var i) && i.Exe.StartsWith("discord"));

    public static bool IsSelf(int pid, int selfPid, Dictionary<int, Info> map) =>
        selfPid != 0 && Ancestry(pid, map).Contains(selfPid);
}

static class AudioApps
{
    /// Raízes (pid) de todos os processos com sessão de áudio em qualquer saída ativa.
    /// Remove raízes que estão dentro da árvore de outra (ex.: jogo aberto pela Steam), senão o
    /// mesmo áudio seria capturado duas vezes.
    public static List<int> SessionRoots(Dictionary<int, ProcTree.Info> map, int selfPid = 0)
    {
        var roots = new HashSet<int>();
        using var en = new MMDeviceEnumerator();
        foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            try
            {
                var mgr = dev.AudioSessionManager;
                mgr.RefreshSessions();
                var sessions = mgr.Sessions;
                for (int i = 0; i < sessions.Count; i++)
                {
                    var s = sessions[i];
                    if (s.IsSystemSoundsSession) continue;
                    int pid = (int)s.GetProcessID;
                    if (pid == 0 || !map.ContainsKey(pid)) continue;
                    roots.Add(ProcTree.Root(pid, map));
                }
            }
            catch { /* dispositivo pode sumir durante a enumeração */ }
        }
        // fora: raízes que CONTÊM o Discord ou este app (ex.: explorer.exe com sessão de áudio teria
        // todos os apps abertos pelo menu Iniciar como filhos; capturá-lo levaria a voz do Discord)
        var forbidden = map.Keys.Where(p => ProcTree.IsDiscord(p, map) || ProcTree.IsSelf(p, selfPid, map)).ToList();
        roots.RemoveWhere(r => !ProcTree.IsDiscord(r, map) && forbidden.Any(f => f != r && ProcTree.Ancestry(f, map).Contains(r)));
        return roots.Where(r => !ProcTree.Ancestry(r, map).Skip(1).Any(roots.Contains)).ToList();
    }

    /// A árvore deste processo contém o Discord ou este app? (não pode ser capturada inteira)
    public static bool TreeHasForbidden(int pid, int selfPid)
    {
        var map = ProcTree.Snapshot();
        return map.Keys.Any(p => (ProcTree.IsDiscord(p, map) || ProcTree.IsSelf(p, selfPid, map)) && ProcTree.Ancestry(p, map).Contains(pid))
            && !ProcTree.IsDiscord(pid, map);
    }

    /// Árvores que podem ser capturadas no modo "tudo exceto Discord":
    /// nunca uma árvore que contenha o Discord ou este app (ex.: explorer.exe com sessão de áudio
    /// tem quase tudo como filho). Depois remove as que estão dentro de outra já capturada.
    public static HashSet<int> CaptureRoots(Dictionary<int, ProcTree.Info> map, int selfPid)
    {
        var roots = new HashSet<int>();
        using (var en = new MMDeviceEnumerator())
        {
            foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                try
                {
                    var mgr = dev.AudioSessionManager;
                    mgr.RefreshSessions();
                    var sessions = mgr.Sessions;
                    for (int i = 0; i < sessions.Count; i++)
                    {
                        var s = sessions[i];
                        if (s.IsSystemSoundsSession) continue;
                        int pid = (int)s.GetProcessID;
                        if (pid != 0 && map.ContainsKey(pid)) roots.Add(ProcTree.Root(pid, map));
                    }
                }
                catch { }
            }
        }
        // processos proibidos: Discord e este app (e todos os filhos deles)
        var forbidden = map.Keys.Where(p => ProcTree.IsDiscord(p, map) || ProcTree.IsSelf(p, selfPid, map)).ToList();
        var safe = roots.Where(r =>
                !ProcTree.IsDiscord(r, map) && !ProcTree.IsSelf(r, selfPid, map) &&
                !forbidden.Any(f => ProcTree.Ancestry(f, map).Contains(r)))
            .ToHashSet();
        return safe.Where(r => !ProcTree.Ancestry(r, map).Skip(1).Any(safe.Contains)).ToHashSet();
    }

    /// Saídas de som ativas (alto-falante, fone, canais virtuais do Sonar/Voicemeeter...).
    /// self = este app já tocou som nela (capturar essa saída mandaria os amigos de volta: eco)
    public static List<object> Devices(int selfPid)
    {
        var res = new List<object>();
        var map = ProcTree.Snapshot();
        using var en = new MMDeviceEnumerator();
        string defId = "";
        try { defId = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia).ID; } catch { }
        foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            try
            {
                bool self = false;
                try
                {
                    var mgr = dev.AudioSessionManager;
                    mgr.RefreshSessions();
                    var ss = mgr.Sessions;
                    for (int i = 0; i < ss.Count; i++)
                    {
                        var s = ss[i];
                        if (s.IsSystemSoundsSession) continue;
                        int pid = (int)s.GetProcessID;
                        if (pid != 0 && map.ContainsKey(pid) && ProcTree.IsSelf(pid, selfPid, map)) self = true;
                    }
                }
                catch { }
                res.Add(new { id = dev.ID, name = dev.FriendlyName, isDefault = dev.ID == defId, self });
            }
            catch { /* dispositivo sumiu durante a enumeração */ }
        }
        return res;
    }

    public static List<AudioApp> List(int selfPid)
    {
        var map = ProcTree.Snapshot();
        var result = new List<AudioApp>();
        foreach (var pid in SessionRoots(map, selfPid))
        {
            if (ProcTree.IsSelf(pid, selfPid, map)) continue;
            result.Add(new AudioApp(pid, FriendlyName(pid, map), ProcTree.IsDiscord(pid, map), map.TryGetValue(pid, out var inf) ? inf.Exe : ""));
        }
        return result.OrderBy(a => a.name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    static string FriendlyName(int pid, Dictionary<int, ProcTree.Info> map)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            var desc = p.MainModule?.FileVersionInfo.FileDescription;
            if (!string.IsNullOrWhiteSpace(desc)) return desc.Trim();
        }
        catch { }
        var exe = map.TryGetValue(pid, out var i) ? i.Exe : pid.ToString();
        return exe.EndsWith(".exe") ? exe[..^4] : exe;
    }
}

/// Captura de um processo (e filhos) via process loopback. Acumula amostras numa fila.
sealed class ProcessCapture : IDisposable
{
    public readonly int Pid;
    readonly ConcurrentQueue<short[]> chunks = new();
    int buffered; // amostras (intercaladas) na fila
    short[]? partial;
    int partialPos;
    volatile bool running = true;
    Thread? thread;
    public bool Primed;
    public int EmptyBlocks;
    public volatile bool Dead;

    public int Buffered => Volatile.Read(ref buffered);

    public readonly string Exe; // nome do .exe (volume do mixer)
    readonly string? deviceId;  // captura uma saída de som inteira (loopback do dispositivo)
    public ProcessCapture(int pid)
    {
        Pid = pid;
        try { using var p = Process.GetProcessById(pid); Exe = p.ProcessName + ".exe"; } catch { Exe = ""; }
    }
    public ProcessCapture(string deviceId)
    {
        Pid = -1;
        Exe = "";
        this.deviceId = deviceId;
    }

    public async Task StartAsync(ProcessLoopbackMode mode)
    {
        AudioClient client;
        if (deviceId != null)
        {
            using var en = new MMDeviceEnumerator();
            client = en.GetDevice(deviceId).AudioClient;
        }
        else client = await AudioClient.ActivateProcessLoopbackAsync((uint)Pid, mode);
        var ev = new AutoResetEvent(false);
        AudioCaptureClient cap;
        try
        {
            // o mixer pode ter sido encerrado enquanto a ativação acontecia: não liga nada
            if (!running) throw new OperationCanceledException();
            var fmt = new WaveFormat(Program.SampleRate, 16, Program.Channels);
            client.Initialize(AudioClientShareMode.Shared,
                AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback | AudioClientStreamFlags.AutoConvertPcm,
                deviceId != null ? 2_000_000 : 200_000, 0, fmt, Guid.Empty); // saída inteira: buffer maior (o aviso por evento pode não vir)
            client.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle());
            cap = client.AudioCaptureClient;
            client.Start();
        }
        catch
        {
            try { client.Stop(); } catch { }
            try { client.Dispose(); } catch { }
            ev.Dispose();
            throw;
        }
        thread = new Thread(() =>
        {
            try
            {
                while (running)
                {
                    ev.WaitOne(deviceId != null ? 10 : 100);
                    while (running && cap.GetNextPacketSize() > 0)
                    {
                        var ptr = cap.GetBuffer(out int frames, out var flags);
                        var data = new short[frames * Program.Channels];
                        if ((flags & AudioClientBufferFlags.Silent) == 0)
                            Marshal.Copy(ptr, data, 0, data.Length);
                        cap.ReleaseBuffer(frames);
                        chunks.Enqueue(data);
                        Interlocked.Add(ref buffered, data.Length);
                    }
                }
            }
            catch { Dead = true; }
            finally
            {
                try { client.Stop(); } catch { }
                client.Dispose();
                ev.Dispose();
            }
        }) { IsBackground = true, Priority = ThreadPriority.AboveNormal, Name = $"cap-{Pid}" };
        thread.Start();
    }

    /// Soma até `count` amostras no buffer de mixagem. Retorna quantas foram lidas.
    public int MixInto(int[] mix, int count, int offset = 0, float gain = 1f)
    {
        int done = 0;
        while (done < count)
        {
            if (partial == null || partialPos >= partial.Length)
            {
                if (!chunks.TryDequeue(out partial)) { partial = null; break; }
                partialPos = 0;
            }
            int n = Math.Min(count - done, partial.Length - partialPos);
            if (gain == 1f) for (int i = 0; i < n; i++) mix[offset + done + i] += partial[partialPos + i];
            else for (int i = 0; i < n; i++) mix[offset + done + i] += (int)(partial[partialPos + i] * gain);
            partialPos += n;
            done += n;
        }
        Interlocked.Add(ref buffered, -done);
        return done;
    }

    public void Drop(int count)
    {
        var trash = new int[count];
        MixInto(trash, count);
    }

    public void Dispose()
    {
        running = false;
        thread?.Join(500);
    }
}

/// Mistura várias capturas e envia PCM em blocos de 10 ms.
/// Correção de relógio suave: quando sobra áudio, descarta 1 quadro a cada bloco (inaudível);
/// quando falta, toca o que tem e só "re-acumula" se ficar vazio por vários blocos seguidos.
sealed class Mixer : IDisposable
{
    const int BlockFrames = Program.SampleRate / 100;          // 10 ms
    const int BlockSamples = BlockFrames * Program.Channels;
    const int PrimeSamples = BlockSamples * 3;                 // começa com 30 ms em buffer
    const int HighSamples = BlockSamples * 6;                  // > 60 ms: acelera devagar
    const int MaxSamples = BlockSamples * 15;                  // > 150 ms: corta de uma vez (travada do PC)

    readonly int appPid;   // 0 = modo "tudo exceto Discord"
    readonly int selfPid;
    readonly Dictionary<int, ProcessCapture> captures = new();
    readonly object capLock = new();
    readonly List<Task> starting = new();               // ativações em andamento (esperadas no Dispose)
    readonly Dictionary<int, DateTime> failedUntil = new(); // pid que falhou: espera antes de tentar de novo
    volatile bool running = true;
    Thread? mixThread;
    Timer? scanTimer;

    readonly ProcessLoopbackMode captureMode;
    readonly byte packetType;
    readonly string? deviceId; // modo "uma saída de som" (Sonar/Voicemeeter: o canal do jogo)

    /// mode Include + appPid: só aquele app; appPid 0: tudo exceto Discord (várias capturas);
    /// mode Exclude + appPid: o PC inteiro menos aquela árvore (usado nos clipes, pacote tipo 4)
    public Mixer(int appPid, int selfPid, ProcessLoopbackMode mode = ProcessLoopbackMode.IncludeTargetProcessTree, byte packetType = 2, string? deviceId = null)
    {
        this.appPid = appPid; this.selfPid = selfPid; captureMode = mode; this.packetType = packetType; this.deviceId = deviceId;
    }

    void StartCapture(int pid) => StartCapture(new ProcessCapture(pid));
    void StartCapture(ProcessCapture cap)
    {
        var t = AddCapture(cap);
        lock (capLock) { starting.RemoveAll(x => x.IsCompleted); starting.Add(t); }
    }

    public void Start()
    {
        if (deviceId != null) scanTimer = new Timer(_ => CheckDevice(), null, 0, 2000);
        else if (appPid != 0) StartCapture(appPid);
        else scanTimer = new Timer(_ => Scan(), null, 0, 2000);
        mixThread = new Thread(MixLoop) { IsBackground = true, Priority = ThreadPriority.Highest, Name = "mixer" };
        mixThread.Start();
    }

    void Scan()
    {
        if (!running) return;
        try
        {
            var map = ProcTree.Snapshot();
            var wanted = AudioApps.CaptureRoots(map, selfPid);
            var gone = new List<ProcessCapture>();
            lock (capLock)
            {
                // sai quem morreu ou passou a fazer parte da árvore de outro capturado
                foreach (var pid in captures.Keys.ToList())
                    if (!map.ContainsKey(pid) || captures[pid].Dead || !wanted.Contains(pid))
                    {
                        gone.Add(captures[pid]);
                        captures.Remove(pid);
                    }
            }
            // fora do lock: Dispose espera a thread da captura e travaria a mistura
            foreach (var c in gone) c.Dispose();
            foreach (var pid in wanted)
            {
                bool has;
                lock (capLock) has = captures.ContainsKey(pid) || (failedUntil.TryGetValue(pid, out var until) && until > DateTime.UtcNow);
                if (!has) StartCapture(pid);
            }
        }
        catch (Exception ex) { try { Program.SendJson(new { type = "warn", message = ex.Message }); } catch { } }
    }

    // saída de som: liga e religa se cair (fone desconectado e conectado de novo, etc.)
    void CheckDevice()
    {
        if (!running) return;
        bool need;
        ProcessCapture? dead = null;
        lock (capLock)
        {
            if (captures.TryGetValue(-1, out var c) && c.Dead) { captures.Remove(-1); dead = c; }
            need = !captures.ContainsKey(-1) && !(failedUntil.TryGetValue(-1, out var until) && until > DateTime.UtcNow);
        }
        dead?.Dispose(); // fora da trava: o Dispose espera a thread da captura (travaria a mistura)
        if (need) StartCapture(new ProcessCapture(deviceId!));
    }

    async Task AddCapture(ProcessCapture cap)
    {
        int pid = cap.Pid;
        lock (capLock)
        {
            if (!running || captures.ContainsKey(pid)) return;
            captures[pid] = cap;
        }
        try
        {
            await cap.StartAsync(captureMode);
            bool stillWanted;
            lock (capLock) stillWanted = running && captures.TryGetValue(pid, out var c) && c == cap;
            if (!stillWanted) cap.Dispose(); // o mixer foi encerrado enquanto iniciava
        }
        catch (OperationCanceledException) { cap.Dead = true; }
        catch (Exception ex)
        {
            cap.Dead = true;
            lock (capLock) failedUntil[pid] = DateTime.UtcNow.AddSeconds(30); // não insiste a cada 2 s
            Program.SendJson(new { type = "warn", message = pid == -1 ? $"Falha ao capturar a saída de som escolhida: {ex.Message}" : $"Falha ao capturar o som de {(cap.Exe.Length > 0 ? cap.Exe : "?")} (pid {pid}): {ex.Message}" });
        }
    }

    // apps sendo capturados agora (para o mixer da interface)
    public List<object> Apps()
    {
        // Só a lista sai de dentro da trava: achar o nome de cada programa demora (abre o processo e
        // lê o .exe do disco), e a mistura do som pega essa mesma trava a cada 10 ms. Com o mixer
        // aberto na interface (pergunta a cada 3 s), o som transmitido podia falhar nesses instantes.
        (int Pid, string Exe)[] list;
        lock (capLock) list = captures.Values.Where(c => !c.Dead && c.Exe.Length > 0).Select(c => (c.Pid, c.Exe)).ToArray();
        return list.Select(c => (object)new { pid = c.Pid, exe = c.Exe, name = FriendlyName(c.Pid, c.Exe), gain = AudioGains.For(c.Exe) }).ToList();
    }

    static string FriendlyName(int pid, string exe)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            var desc = p.MainModule?.FileVersionInfo.FileDescription;
            if (!string.IsNullOrWhiteSpace(desc)) return desc.Trim();
        }
        catch { }
        return exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe[..^4] : exe;
    }

    void MixLoop()
    {
        var mix = new int[BlockSamples + Program.Channels];
        var outBytes = new byte[BlockSamples * 2];
        var sw = Stopwatch.StartNew();
        long blocksSent = 0;
        try
        {
            while (running)
            {
                long due = sw.ElapsedTicks * 100 / Stopwatch.Frequency;
                if (blocksSent >= due) { Thread.Sleep(1); continue; }
                if (due - blocksSent > 10) blocksSent = due - 1; // atrasou demais (PC travou): pula

                Array.Clear(mix);
                ProcessCapture[] list;
                lock (capLock) list = captures.Values.ToArray();
                foreach (var c in list)
                {
                    int buf = c.Buffered;
                    if (!c.Primed)
                    {
                        if (buf < PrimeSamples) continue;
                        c.Primed = true;
                    }
                    if (buf > MaxSamples) c.Drop(buf - PrimeSamples);
                    else if (buf > HighSamples) c.Drop(Program.Channels); // descarta 1 quadro (~0,2%)
                    int got = c.MixInto(mix, BlockSamples, 0, AudioGains.For(c.Exe));
                    if (got == 0)
                    {
                        if (++c.EmptyBlocks >= 3) { c.Primed = false; c.EmptyBlocks = 0; } // parou de tocar
                    }
                    else c.EmptyBlocks = 0;
                }
                for (int i = 0; i < BlockSamples; i++)
                {
                    int v = Math.Clamp(mix[i], short.MinValue, short.MaxValue);
                    outBytes[i * 2] = (byte)v;
                    outBytes[i * 2 + 1] = (byte)(v >> 8);
                }
                Program.Send(packetType, outBytes);
                blocksSent++;
            }
        }
        catch { /* encerrando */ }
    }

    public void Dispose()
    {
        running = false;
        if (scanTimer != null)
        {
            using var done = new ManualResetEvent(false);
            if (scanTimer.Dispose(done)) done.WaitOne(3000); // espera um Scan em andamento terminar
        }
        // ativações ainda em andamento terminam antes (senão ligariam a captura depois do fim)
        Task[] pend;
        lock (capLock) pend = starting.ToArray();
        try { Task.WaitAll(pend, 3000); } catch { }
        mixThread?.Join(500);
        List<ProcessCapture> all;
        lock (capLock) { all = captures.Values.ToList(); captures.Clear(); }
        foreach (var c in all) c.Dispose();
    }
}
