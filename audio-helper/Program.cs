// AudioHelper: captura de áudio por app (process loopback, Win10 2004+) e de vídeo (WGC + H.264 por hardware).
//
// Protocolo:
//   stdin  -> uma linha JSON por comando; "id" (opcional) volta na resposta:
//             {"id":1,"cmd":"list","selfPid":123}
//             {"id":2,"cmd":"start","mode":"all-except","selfPid":123}   (tudo exceto Discord e o próprio app)
//             {"id":3,"cmd":"start","mode":"app","pid":456,"selfPid":123} (só um app e seus filhos)
//             {"id":4,"cmd":"stop"}
//             {"id":5,"cmd":"video-start", ...} / video-stop / video-key / video-bitrate
//   stdout -> pacotes [tipo:1 byte][tamanho:uint32 LE][dados]
//             1 = JSON, 2 = PCM s16le estéreo 48 kHz, 3 = quadro H.264 ([flags][int64 µs][Annex B])
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
    static VideoStreamer? video;
    static GameWatcher? gameWatcher;
    static Mixer? clipMixer; // áudio do PC inteiro (menos este app) para os clipes

    // ---- saída: fila com escritor próprio; quem captura nunca fica preso esperando o app ler ----
    static readonly BlockingCollection<byte[]> outQueue = new(new ConcurrentQueue<byte[]>(), 400);
    static readonly Stream stdout = Console.OpenStandardOutput();

    /// Chamado quando um quadro de vídeo teve que ser descartado (app não está lendo rápido o bastante).
    public static Action? OnVideoDropped;

    static void StartWriter()
    {
        new Thread(() =>
        {
            try
            {
                foreach (var p in outQueue.GetConsumingEnumerable()) stdout.Write(p);
            }
            catch { Environment.Exit(0); } // o app fechou o pipe
        }) { IsBackground = true, Name = "stdout" }.Start();
    }

    public static void Send(byte type, ReadOnlySpan<byte> data)
    {
        var p = new byte[5 + data.Length];
        p[0] = type;
        BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(1), (uint)data.Length);
        data.CopyTo(p.AsSpan(5));
        if (type == 1) { outQueue.Add(p); return; }       // mensagens nunca são descartadas
        if (!outQueue.TryAdd(p) && type == 3) OnVideoDropped?.Invoke();
    }

    public static void SendJson(object obj) => Send(1, JsonSerializer.SerializeToUtf8Bytes(obj));

    static async Task Main()
    {
        StartWriter();
        SendJson(new { type = "ready" });
        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
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
                        SendJson(new { id, type = "list", apps = AudioApps.List(selfPid) });
                        break;
                    case "start":
                        mixer?.Dispose();
                        mixer = null;
                        var mode = root.GetProperty("mode").GetString();
                        int pid = root.TryGetProperty("pid", out var p) ? p.GetInt32() : 0;
                        mixer = new Mixer(mode == "app" ? pid : 0, selfPid);
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
                        video?.Dispose();
                        video = null;
                        var t = root.GetProperty("target");
                        var target = new VideoTarget(
                            t.GetProperty("type").GetString()!,
                            t.TryGetProperty("hwnd", out var h) ? h.GetInt64() : 0,
                            t.TryGetProperty("x", out var x) ? x.GetInt32() : 0,
                            t.TryGetProperty("y", out var y) ? y.GetInt32() : 0);
                        var v = new VideoStreamer(root.GetProperty("fps").GetInt32(), root.GetProperty("kbps").GetInt32());
                        try
                        {
                            v.Start(target, root.GetProperty("maxWidth").GetInt32(), root.GetProperty("maxHeight").GetInt32());
                        }
                        catch
                        {
                            v.Dispose();
                            throw;
                        }
                        video = v;
                        SendJson(new { id, type = "video-started", width = v.Width, height = v.Height, encoder = v.EncoderName });
                        break;
                    }
                    case "video-stop":
                        video?.Dispose();
                        video = null;
                        SendJson(new { id, type = "video-stopped" });
                        break;
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
                        SendJson(new { id, type = "video-diag", info = VideoStreamer.Diagnose() });
                        break;
                    case "video-key":
                        video?.RequestKeyFrame();
                        break;
                    case "video-bitrate":
                        video?.SetBitrate(root.GetProperty("kbps").GetInt32());
                        break;
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
        video?.Dispose();
    }
}

record AudioApp(int pid, string name, bool discord);

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
    public static List<int> SessionRoots(Dictionary<int, ProcTree.Info> map)
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
        return roots.Where(r => !ProcTree.Ancestry(r, map).Skip(1).Any(roots.Contains)).ToList();
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

    public static List<AudioApp> List(int selfPid)
    {
        var map = ProcTree.Snapshot();
        var result = new List<AudioApp>();
        foreach (var pid in SessionRoots(map))
        {
            if (ProcTree.IsSelf(pid, selfPid, map)) continue;
            result.Add(new AudioApp(pid, FriendlyName(pid, map), ProcTree.IsDiscord(pid, map)));
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

    public ProcessCapture(int pid) { Pid = pid; }

    public async Task StartAsync(ProcessLoopbackMode mode)
    {
        var client = await AudioClient.ActivateProcessLoopbackAsync((uint)Pid, mode);
        var fmt = new WaveFormat(Program.SampleRate, 16, Program.Channels);
        client.Initialize(AudioClientShareMode.Shared,
            AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback | AudioClientStreamFlags.AutoConvertPcm,
            200_000, 0, fmt, Guid.Empty);
        var ev = new AutoResetEvent(false);
        client.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle());
        var cap = client.AudioCaptureClient;
        client.Start();
        thread = new Thread(() =>
        {
            try
            {
                while (running)
                {
                    ev.WaitOne(100);
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
    public int MixInto(int[] mix, int count, int offset = 0)
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
            for (int i = 0; i < n; i++) mix[offset + done + i] += partial[partialPos + i];
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
    volatile bool running = true;
    Thread? mixThread;
    Timer? scanTimer;

    readonly ProcessLoopbackMode captureMode;
    readonly byte packetType;

    /// mode Include + appPid: só aquele app; appPid 0: tudo exceto Discord (várias capturas);
    /// mode Exclude + appPid: o PC inteiro menos aquela árvore (usado nos clipes, pacote tipo 4)
    public Mixer(int appPid, int selfPid, ProcessLoopbackMode mode = ProcessLoopbackMode.IncludeTargetProcessTree, byte packetType = 2)
    {
        this.appPid = appPid; this.selfPid = selfPid; captureMode = mode; this.packetType = packetType;
    }

    public void Start()
    {
        if (appPid != 0) _ = AddCapture(appPid);
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
            lock (capLock)
            {
                // sai quem morreu ou passou a fazer parte da árvore de outro capturado
                foreach (var pid in captures.Keys.ToList())
                    if (!map.ContainsKey(pid) || captures[pid].Dead || !wanted.Contains(pid))
                    {
                        captures[pid].Dispose();
                        captures.Remove(pid);
                    }
            }
            foreach (var pid in wanted)
            {
                bool has;
                lock (capLock) has = captures.ContainsKey(pid);
                if (!has) _ = AddCapture(pid);
            }
        }
        catch (Exception ex) { try { Program.SendJson(new { type = "warn", message = ex.Message }); } catch { } }
    }

    async Task AddCapture(int pid)
    {
        var cap = new ProcessCapture(pid);
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
        catch (Exception ex)
        {
            cap.Dead = true;
            Program.SendJson(new { type = "warn", message = $"Falha ao capturar pid {pid}: {ex.Message}" });
        }
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
                    int got = c.MixInto(mix, BlockSamples);
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
        mixThread?.Join(500);
        lock (capLock)
        {
            foreach (var c in captures.Values) c.Dispose();
            captures.Clear();
        }
    }
}
