// Teste de captura com jogo ("Testar a captura com jogo", pedido por um amigo ou pela própria pessoa).
// O Doge (2026-11-26): "imediatamente quando eu clico no jogo a tela trava no frame q tava, dou alt tab ela volta",
// em tela cheia e em janela, e compartilhando a tela ou só a janela. Com o jogo na frente, este teste tenta cada jeito
// de capturar por alguns segundos e mede se a imagem anda:
//   wgc-monitor        a tela pelo Windows (o que o app usa)
//   wgc-window         só a janela do jogo pelo Windows
//   wgc-monitor+tiny   a tela, com uma janelinha quase invisível do app num canto, por cima do jogo
//   wgc-monitor+full   a tela, com uma janela transparente do tamanho da tela por cima do jogo
//   dxgi               a tela pela duplicação da área de trabalho (o "outro método")
// As duas com janela por cima respondem se é a otimização do Windows que entrega a imagem do jogo direto ao monitor
// quando ele está sozinho na tela (qualquer janela por cima desliga essa otimização).
// Cada um roda num processo separado (AudioHelper.exe --captest-step ...): se a placa ou o Windows derrubarem um deles
// (o "outro método" derrubou o auxiliar do Doge), o teste continua e anota o registro de falha do Windows.
// Nenhuma imagem sai daqui: só contagens, nomes de configuração e de programas conhecidos.
//
// Testes sem jogo e sem capturar a tela de quem roda (scripts/captest-test.js):
//   TELA_CAPTEST_HWND=<janela>  usa essa janela como "jogo" (sem esperar ela ficar na frente)
//   TELA_CAPTEST_NOMONITOR=1    os passos "da tela" capturam só a janela, e as janelas por cima ficam só sobre ela
//   TELA_CAPTEST_CRASH=<passo>  esse passo sai como se tivesse caído (código 0xC0000005)
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

static unsafe class CaptureTest
{
    public static readonly (string method, string label)[] Steps =
    {
        ("wgc-monitor", "tela pelo Windows (o que o app usa)"),
        ("wgc-window", "só a janela do jogo pelo Windows"),
        ("wgc-monitor+tiny", "tela, com uma janelinha do app num canto por cima do jogo"),
        ("wgc-monitor+full", "tela, com uma janela transparente do app cobrindo o jogo"),
        ("dxgi", "tela pela duplicação da área de trabalho (DXGI, o outro método)"),
    };

    static volatile bool running;
    public static bool Running => running;

    // ================================================================ o teste inteiro (no auxiliar de sempre)
    /// Espera o jogo ficar na frente, roda cada passo num processo separado e junta tudo. progress: mensagens
    /// {type:"captest-progress"} para o app mostrar em que pé está.
    public static JsonObject Run(int selfPid, int secs, Action<object> progress)
    {
        if (running) throw new Exception("o teste de captura já está rodando");
        running = true;
        try { return RunInner(selfPid, Math.Clamp(secs, 2, 15), progress); }
        finally { running = false; }
    }

    static JsonObject RunInner(int selfPid, int secs, Action<object> progress)
    {
        var report = new JsonObject
        {
            ["startedAt"] = DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss zzz"),
            ["secsPerStep"] = secs,
        };
        long fake = long.TryParse(Environment.GetEnvironmentVariable("TELA_CAPTEST_HWND"), out var fh) ? fh : 0;
        GameInfo? game;
        if (fake != 0) game = Describe(new IntPtr(fake));
        else
        {
            progress(new { type = "captest-progress", phase = "wait-game" });
            game = WaitForGame(selfPid, 180);
        }
        if (game == null)
        {
            report["ok"] = false;
            report["error"] = "nenhum jogo ficou na frente em 3 minutos";
        }
        else
        {
            report["game"] = game.ToJson();
            progress(new { type = "captest-progress", phase = "game", exe = game.Exe });
            var steps = new JsonArray();
            for (int i = 0; i < Steps.Length; i++)
            {
                var (method, label) = Steps[i];
                if (fake == 0 && !WaitFront(game.Pid, 25, () => progress(new { type = "captest-progress", phase = "back-to-game", exe = game.Exe })))
                {
                    steps.Add(new JsonObject { ["method"] = method, ["label"] = label, ["skipped"] = "o jogo não estava na frente" });
                    continue;
                }
                progress(new { type = "captest-progress", phase = "step", i = i + 1, n = Steps.Length, method, label });
                var r = RunChild(method, game, secs);
                r["label"] = label;
                steps.Add(r);
            }
            report["steps"] = steps;
            report["ok"] = true;
        }
        progress(new { type = "captest-progress", phase = "system" });
        try { report["system"] = Snapshot.System(game?.Path ?? ""); } catch (Exception ex) { report["systemError"] = ex.Message; }
        try { report["monitors"] = Snapshot.Monitors(game?.Hmon ?? IntPtr.Zero); } catch (Exception ex) { report["monitorsError"] = ex.Message; }
        try { report["programs"] = Snapshot.Programs(); } catch (Exception ex) { report["programsError"] = ex.Message; }
        return report;
    }

    static JsonObject RunChild(string method, GameInfo game, int secs)
    {
        var psi = new ProcessStartInfo(Environment.ProcessPath!)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in new[] { "--captest-step", method, game.Hwnd.ToInt64().ToString(), secs.ToString(), game.Pid.ToString() }) psi.ArgumentList.Add(a);
        var started = DateTime.UtcNow;
        using var p = Process.Start(psi) ?? throw new Exception("não deu para abrir o teste");
        var tail = new ConcurrentQueue<string>();
        p.ErrorDataReceived += (sender, e) => { if (e.Data == null) return; tail.Enqueue(e.Data); while (tail.Count > 12) tail.TryDequeue(out string? old); };
        p.BeginErrorReadLine();
        var outTask = p.StandardOutput.ReadToEndAsync();
        if (!p.WaitForExit((secs + 25) * 1000))
        {
            // preso dentro da placa/do Windows (este processo não captura som: encerrar não atrapalha nada)
            try { p.Kill(true); } catch { }
            return new JsonObject { ["method"] = method, ["stuck"] = true, ["error"] = $"não respondeu em {secs + 25} s (travou)", ["stderr"] = Tail(tail) };
        }
        p.WaitForExit();
        string output = "";
        try { output = outTask.Result; } catch { }
        var line = output.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.StartsWith("CAPTEST "));
        if (line != null)
        {
            try { if (JsonNode.Parse(line[8..]) is JsonObject o) return o; } catch { }
        }
        // caiu (ou saiu sem resultado): o registro de falha do Windows diz onde
        int code = p.ExitCode;
        var r = new JsonObject
        {
            ["method"] = method,
            ["crashed"] = true,
            ["exitCode"] = $"0x{code:X8}",
            ["stderr"] = Tail(tail),
        };
        var crash = CrashInfo.FindWithRetry(p.Id, started, 7000);
        if (crash != null) r["crash"] = crash;
        return r;
    }

    static JsonArray Tail(ConcurrentQueue<string> q) => new(q.Select(s => (JsonNode?)JsonValue.Create(s.Length > 300 ? s[..300] : s)).ToArray());

    // ================================================================ o jogo
    record GameInfo(IntPtr Hwnd, int Pid, string Exe, string Path, IntPtr Hmon, RECT Rect, RECT Mon, bool Covers, bool Borderless)
    {
        public JsonObject ToJson() => new()
        {
            ["exe"] = Exe,
            ["width"] = Rect.Right - Rect.Left,
            ["height"] = Rect.Bottom - Rect.Top,
            ["monitorWidth"] = Mon.Right - Mon.Left,
            ["monitorHeight"] = Mon.Bottom - Mon.Top,
            ["coversMonitor"] = Covers,
            ["borderless"] = Borderless,
        };
    }

    static readonly HashSet<string> NotGames = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer.exe", "searchhost.exe", "shellexperiencehost.exe", "startmenuexperiencehost.exe", "lockapp.exe",
        "textinputhost.exe", "applicationframehost.exe", "dwm.exe", "taskmgr.exe", "audiohelper.exe", "tela amigos.exe",
    };

    static GameInfo? Describe(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return null;
        GetWindowThreadProcessId(hwnd, out uint pid);
        var map = ProcTree.Snapshot();
        string exe = map.TryGetValue((int)pid, out var info) ? info.Exe : "";
        if (!GetWindowRect(hwnd, out RECT r)) return null;
        IntPtr mon = MonitorFromWindow(hwnd, 2);
        var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        GetMonitorInfo(mon, ref mi);
        var m = mi.rcMonitor;
        bool covers = r.Left <= m.Left && r.Top <= m.Top && r.Right >= m.Right && r.Bottom >= m.Bottom;
        long style = GetWindowLongPtrW(hwnd, -16 /*GWL_STYLE*/).ToInt64();
        bool borderless = (style & 0x00C00000 /*WS_CAPTION*/) != 0x00C00000;
        return new GameInfo(hwnd, (int)pid, exe, ProcessPath((int)pid), mon, r, m, covers, borderless);
    }

    /// Janela em primeiro plano que pode ser o jogo: visível, de tamanho de jogo, que não é do app, do Windows nem a área de
    /// trabalho. Precisa ficar 2,5 s na frente (a pessoa ainda está clicando por aí).
    static GameInfo? WaitForGame(int selfPid, int timeoutSecs)
    {
        var sw = Stopwatch.StartNew();
        int candPid = 0; long since = 0;
        while (sw.Elapsed.TotalSeconds < timeoutSecs)
        {
            var g = Candidate(selfPid);
            if (g != null && g.Pid == candPid)
            {
                if (sw.ElapsedMilliseconds - since >= 2500) return g;
            }
            else { candPid = g?.Pid ?? 0; since = sw.ElapsedMilliseconds; }
            Thread.Sleep(250);
        }
        return null;
    }

    static GameInfo? Candidate(int selfPid)
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return null;
        IntPtr root = GetAncestor(fg, 2 /*GA_ROOT*/);
        if (root != IntPtr.Zero) fg = root;
        if (!IsWindowVisible(fg) || IsIconic(fg)) return null;
        GetWindowThreadProcessId(fg, out uint pid);
        var map = ProcTree.Snapshot();
        if (ProcTree.IsSelf((int)pid, selfPid, map) || pid == Environment.ProcessId) return null;
        string exe = map.TryGetValue((int)pid, out var info) ? info.Exe : "";
        if (NotGames.Contains(exe)) return null;
        var cls = new System.Text.StringBuilder(64);
        GetClassNameW(fg, cls, cls.Capacity);
        if (cls.ToString() is "Progman" or "WorkerW" or "Shell_TrayWnd") return null;
        if (!GetWindowRect(fg, out RECT r) || r.Right - r.Left < 640 || r.Bottom - r.Top < 360) return null;
        return Describe(fg);
    }

    static bool GameInFront(int gamePid)
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return false;
        GetWindowThreadProcessId(fg, out uint pid);
        return (int)pid == gamePid;
    }

    static bool WaitFront(int gamePid, int secs, Action onWaiting)
    {
        if (GameInFront(gamePid)) return true;
        onWaiting();
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed.TotalSeconds < secs)
        {
            Thread.Sleep(250);
            if (GameInFront(gamePid)) { Thread.Sleep(1000); return GameInFront(gamePid); }
        }
        return false;
    }

    static string ProcessPath(int pid)
    {
        // só o nome do arquivo do processo (o mesmo acesso que o Gerenciador de Tarefas usa: nada de mexer no jogo)
        IntPtr h = OpenProcess(0x1000 /*PROCESS_QUERY_LIMITED_INFORMATION*/, false, (uint)pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            var sb = new System.Text.StringBuilder(1024);
            int n = sb.Capacity;
            return QueryFullProcessImageNameW(h, 0, sb, ref n) ? sb.ToString() : "";
        }
        finally { CloseHandle(h); }
    }

    // ================================================================ um passo (processo separado)
    /// AudioHelper.exe --captest-step <método> <janela> <segundos> <pid do jogo>: imprime "CAPTEST {json}" e sai.
    public static void RunStepMain(string[] args)
    {
        string method = args.Length > 1 ? args[1] : "";
        IntPtr hwnd = new IntPtr(args.Length > 2 && long.TryParse(args[2], out var h) ? h : 0);
        int secs = args.Length > 3 && int.TryParse(args[3], out var s) ? Math.Clamp(s, 1, 30) : 5;
        int gamePid = args.Length > 4 && int.TryParse(args[4], out var gp) ? gp : 0;
        if (string.Equals(Environment.GetEnvironmentVariable("TELA_CAPTEST_CRASH"), method, StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine($"[captest] {method}: queda simulada (teste)");
            Environment.Exit(unchecked((int)0xC0000005));
        }
        var result = new JsonObject { ["method"] = method };
        try { new StepRunner(method, hwnd, secs, gamePid).Run(result); }
        catch (Exception ex) { result["error"] = ex.Message; }
        Console.Out.WriteLine("CAPTEST " + result.ToJsonString());
        Console.Out.Flush();
        Environment.Exit(0);
    }

    sealed class StepRunner
    {
        readonly string method;
        readonly IntPtr hwnd;
        readonly int secs, gamePid;
        readonly bool noMonitor = Environment.GetEnvironmentVariable("TELA_CAPTEST_NOMONITOR") == "1";
        ID3D11Device device = null!;
        ID3D11DeviceContext context = null!;
        readonly object gpuLock = new();
        readonly Stopwatch clock = Stopwatch.StartNew();
        // contagens
        long frames, changed, firstMs = -1, lastChangeMs = -1, maxGapMs;
        ulong lastHash;
        string size = "";
        ID3D11Texture2D? staging;
        Format stagingFormat;
        int stagingW, stagingH;

        public StepRunner(string method, IntPtr hwnd, int secs, int gamePid)
        {
            this.method = method; this.hwnd = hwnd; this.secs = secs; this.gamePid = gamePid;
        }

        public void Run(JsonObject result)
        {
            if (!IsWindow(hwnd)) throw new Exception("a janela do jogo não existe mais");
            IntPtr hmon = MonitorFromWindow(hwnd, 2);
            long luid = VideoStreamer.MonitorOwnerLuid(hmon);
            CreateDevice(luid);
            result["adapter"] = AdapterName;
            bool window = method == "wgc-window" || (noMonitor && method.StartsWith("wgc-monitor"));
            if (noMonitor && method == "dxgi") throw new Exception("pulado no teste sem monitor (capturaria a tela de quem roda)");

            // janela por cima do jogo (ou só da janela, no teste sem monitor)
            Overlay? overlay = null;
            if (method.EndsWith("+tiny") || method.EndsWith("+full"))
            {
                RECT area;
                if (noMonitor) GetWindowRect(hwnd, out area);
                else
                {
                    var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
                    GetMonitorInfo(hmon, ref mi);
                    area = mi.rcMonitor;
                }
                if (method.EndsWith("+tiny")) area = new RECT { Left = area.Left, Top = area.Top, Right = area.Left + 4, Bottom = area.Top + 4 };
                overlay = new Overlay(area);
                Thread.Sleep(300); // o Windows recompõe a tela com ela
            }
            int frontHits = 0, frontSamples = 0;
            try
            {
                if (method == "dxgi") RunDxgi(hmon, ref frontHits, ref frontSamples);
                else RunWgc(window ? hwnd : IntPtr.Zero, hmon, ref frontHits, ref frontSamples);
            }
            finally { overlay?.Dispose(); }
            result["frames"] = Interlocked.Read(ref frames);
            result["changed"] = Interlocked.Read(ref changed);
            result["fps"] = Math.Round(Interlocked.Read(ref changed) / (double)secs, 1);
            result["firstMs"] = firstMs;
            // maior tempo sem imagem nova (até o fim do passo, se ela parou)
            long end = (long)(secs * 1000.0);
            long gap = lastChangeMs < 0 ? end : Math.Max(maxGapMs, end - lastChangeMs);
            result["maxGapMs"] = gap;
            result["size"] = size;
            if (frontSamples > 0) result["frontPct"] = (int)Math.Round(100.0 * frontHits / frontSamples);
            if (overlay != null) result["overlay"] = overlay.Error ?? "ok";
            try { staging?.Dispose(); context.Dispose(); device.Dispose(); } catch { }
        }

        string AdapterName = "";

        void CreateDevice(long luid)
        {
            using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
            IDXGIAdapter1? adapter = null;
            for (uint i = 0; factory.EnumAdapters1(i, out var a).Success; i++)
            {
                var d = a.Description1;
                long l = ((long)d.Luid.HighPart << 32) | d.Luid.LowPart;
                if (luid == 0 || l == luid) { adapter = a; AdapterName = d.Description.Trim(); break; }
                a.Dispose();
            }
            var levels = new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 };
            D3D11.D3D11CreateDevice(adapter, adapter == null ? DriverType.Hardware : DriverType.Unknown,
                DeviceCreationFlags.BgraSupport, levels, out device!, out context!).CheckError();
            adapter?.Dispose();
            using (var mt = device.QueryInterface<ID3D11Multithread>()) mt.SetMultithreadProtected(true);
        }

        void Sample(ref int hits, ref int samples)
        {
            samples++;
            if (gamePid == 0 || GameInFront(gamePid)) hits++;
        }

        // ---- WGC (tela ou janela)
        void RunWgc(IntPtr window, IntPtr hmon, ref int hits, ref int samples)
        {
            try { GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless).AsTask().Wait(1500); } catch { }
            var item = VideoStreamer.CreateItem(window, window == IntPtr.Zero ? hmon : IntPtr.Zero);
            using var dxgiDevice = device.QueryInterface<IDXGIDevice>();
            CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.NativePointer, out IntPtr inspectable).CheckHr("CreateDirect3D11DeviceFromDXGIDevice");
            var winrtDevice = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
            Marshal.Release(inspectable);
            var poolSize = item.Size;
            size = $"{poolSize.Width}x{poolSize.Height}";
            using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, poolSize);
            pool.FrameArrived += (p, _) =>
            {
                using var frame = p.TryGetNextFrame();
                if (frame == null) return;
                IntPtr surface = MarshalInterface<IDirect3DSurface>.FromManaged(frame.Surface);
                try
                {
                    IntPtr texPtr = VideoStreamer.GetDxgiInterface(surface, typeof(ID3D11Texture2D).GUID);
                    using var tex = new ID3D11Texture2D(texPtr);
                    OnFrame(tex);
                }
                catch (Exception ex) { Console.Error.WriteLine("[captest] quadro: " + ex.Message); }
                finally { Marshal.Release(surface); }
            };
            using var session = pool.CreateCaptureSession(item);
            try { session.IsBorderRequired = false; } catch { }
            try { session.IsCursorCaptureEnabled = false; } catch { } // o mouse mexendo não conta como imagem nova
            clock.Restart();
            session.StartCapture();
            while (clock.Elapsed.TotalSeconds < secs)
            {
                Thread.Sleep(200);
                Sample(ref hits, ref samples);
            }
        }

        // ---- DXGI Desktop Duplication
        void RunDxgi(IntPtr hmon, ref int hits, ref int samples)
        {
            IDXGIOutputDuplication? dup = null;
            Vortice.RawRect desk = default;
            void Open()
            {
                dup?.Dispose(); dup = null;
                using var dxgiDevice = device.QueryInterface<IDXGIDevice>();
                using var adapter = dxgiDevice.GetAdapter();
                for (uint i = 0; adapter.EnumOutputs(i, out IDXGIOutput? output).Success; i++)
                {
                    using (output)
                    {
                        if (output!.Description.Monitor != hmon) continue;
                        desk = output.Description.DesktopCoordinates;
                        using var o5 = output.QueryInterfaceOrNull<IDXGIOutput5>();
                        if (o5 != null) { try { dup = o5.DuplicateOutput1(device, 0, new[] { Format.B8G8R8A8_UNorm }); } catch { dup = null; } }
                        if (dup == null) { using var o1 = output.QueryInterface<IDXGIOutput1>(); dup = o1.DuplicateOutput(device); }
                        return;
                    }
                }
                throw new Exception("o monitor do jogo não está ligado na placa de vídeo dele");
            }
            Open();
            size = $"{desk.Right - desk.Left}x{desk.Bottom - desk.Top}";
            int lost = 0;
            long nextSample = 0;
            clock.Restart();
            while (clock.Elapsed.TotalSeconds < secs)
            {
                if (clock.ElapsedMilliseconds >= nextSample) { nextSample = clock.ElapsedMilliseconds + 200; Sample(ref hits, ref samples); }
                var d = dup;
                if (d == null) { Thread.Sleep(200); try { Open(); } catch { } continue; }
                var res = d.AcquireNextFrame(50, out OutduplFrameInfo info, out IDXGIResource? resource);
                if (res.Code == unchecked((int)0x887A0027)) continue; // WAIT_TIMEOUT
                if (res.Failure)
                {
                    if (res.Code == unchecked((int)0x887A0026) /*ACCESS_LOST*/) { lost++; Thread.Sleep(100); try { Open(); } catch (Exception ex) { Console.Error.WriteLine("[captest] reabrir: " + ex.Message); dup = null; } continue; }
                    throw new Exception($"a duplicação parou (0x{res.Code:X8})");
                }
                try
                {
                    if (info.LastPresentTime != 0 && resource != null)
                    {
                        using var tex = resource.QueryInterface<ID3D11Texture2D>();
                        OnFrame(tex);
                    }
                }
                finally
                {
                    resource?.Dispose();
                    try { d.ReleaseFrame(); } catch { }
                }
            }
            dup?.Dispose();
            if (lost > 0) Console.Error.WriteLine($"[captest] dxgi: acesso perdido {lost} vezes");
        }

        /// Conta o quadro e se a imagem mudou (um pedaço do meio da imagem, 320x180, comparado com o anterior).
        void OnFrame(ID3D11Texture2D tex)
        {
            lock (gpuLock)
            {
                long now = clock.ElapsedMilliseconds;
                Interlocked.Increment(ref frames);
                if (firstMs < 0) firstMs = now;
                var d = tex.Description;
                int rw = (int)Math.Min(320u, d.Width), rh = (int)Math.Min(180u, d.Height);
                if (rw < 2 || rh < 2) return;
                if (staging == null || stagingFormat != d.Format || stagingW != rw || stagingH != rh)
                {
                    staging?.Dispose();
                    staging = device.CreateTexture2D(new Texture2DDescription
                    {
                        Width = (uint)rw, Height = (uint)rh, MipLevels = 1, ArraySize = 1, Format = d.Format,
                        SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Staging,
                        BindFlags = BindFlags.None, CPUAccessFlags = CpuAccessFlags.Read,
                    });
                    stagingFormat = d.Format; stagingW = rw; stagingH = rh;
                }
                int x0 = ((int)d.Width - rw) / 2, y0 = ((int)d.Height - rh) / 2;
                context.CopySubresourceRegion(staging, 0, 0, 0, 0, tex, 0, new Box(x0, y0, 0, x0 + rw, y0 + rh, 1));
                context.Map(staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None, out MappedSubresource ms).CheckError();
                ulong hash = 14695981039346656037UL;
                try
                {
                    int bpp = d.Format == Format.R16G16B16A16_Float ? 8 : 4;
                    for (int y = 0; y < rh; y++)
                    {
                        var row = new ReadOnlySpan<ulong>((byte*)ms.DataPointer + (long)y * ms.RowPitch, rw * bpp / 8);
                        foreach (var v in row) { hash ^= v; hash *= 1099511628211UL; }
                    }
                }
                finally { context.Unmap(staging, 0); }
                if (Interlocked.Read(ref frames) == 1 || hash != lastHash)
                {
                    lastHash = hash;
                    Interlocked.Increment(ref changed);
                    if (lastChangeMs >= 0) maxGapMs = Math.Max(maxGapMs, now - lastChangeMs);
                    lastChangeMs = now;
                }
            }
        }
    }

    // ================================================================ janela por cima do jogo
    /// Janela quase invisível (opacidade 1/255), sempre por cima, que não pega clique nem foco: o jogo continua na frente.
    sealed class Overlay : IDisposable
    {
        readonly Thread thread;
        IntPtr hwnd;
        uint threadId;
        public string? Error;
        readonly ManualResetEventSlim ready = new(false);

        public Overlay(RECT r)
        {
            thread = new Thread(() =>
            {
                try
                {
                    threadId = GetCurrentThreadId();
                    IntPtr inst = GetModuleHandleW(null);
                    string cls = "TelaAmigosCapTest" + Environment.ProcessId;
                    var wc = new WNDCLASSEXW
                    {
                        cbSize = (uint)Marshal.SizeOf<WNDCLASSEXW>(),
                        lpfnWndProc = GetProcAddress(GetModuleHandleW("user32.dll"), "DefWindowProcW"),
                        hInstance = inst,
                        hbrBackground = GetStockObject(4 /*BLACK_BRUSH*/),
                        lpszClassName = cls,
                    };
                    if (RegisterClassExW(ref wc) == 0) throw new Exception($"RegisterClassEx: {Marshal.GetLastWin32Error()}");
                    const uint WS_EX = 0x00000008 /*TOPMOST*/ | 0x00080000 /*LAYERED*/ | 0x00000020 /*TRANSPARENT*/ | 0x00000080 /*TOOLWINDOW*/ | 0x08000000 /*NOACTIVATE*/;
                    hwnd = CreateWindowExW(WS_EX, cls, "", 0x80000000 /*WS_POPUP*/, r.Left, r.Top, Math.Max(1, r.Right - r.Left), Math.Max(1, r.Bottom - r.Top),
                        IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
                    if (hwnd == IntPtr.Zero) throw new Exception($"CreateWindowEx: {Marshal.GetLastWin32Error()}");
                    SetLayeredWindowAttributes(hwnd, 0, 1, 0x2 /*LWA_ALPHA*/);
                    ShowWindow(hwnd, 4 /*SW_SHOWNOACTIVATE*/);
                    SetWindowPos(hwnd, new IntPtr(-1) /*HWND_TOPMOST*/, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040 /*NOSIZE|NOMOVE|NOACTIVATE|SHOWWINDOW*/);
                }
                catch (Exception ex) { Error = ex.Message; }
                finally { ready.Set(); }
                if (hwnd == IntPtr.Zero) return;
                while (GetMessageW(out MSG m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessageW(ref m); }
                DestroyWindow(hwnd);
            }) { IsBackground = true, Name = "captest-overlay" };
            thread.Start();
            ready.Wait(3000);
        }

        public void Dispose()
        {
            if (threadId != 0) PostThreadMessageW(threadId, 0x0012 /*WM_QUIT*/, IntPtr.Zero, IntPtr.Zero);
            thread.Join(2000);
        }
    }

    // ================================================================ janela de teste ("jogo" de mentira)
    /// AudioHelper.exe --captest-fakegame <segundos>: uma janelinha que muda de cor sem parar, no canto da tela, sem pegar o
    /// foco. Imprime "FAKEGAME <janela>". Sai depois dos segundos ou quando o stdin fecha.
    public static void RunFakeGame(string[] args)
    {
        int secs = args.Length > 1 && int.TryParse(args[1], out var s) ? s : 60;
        IntPtr inst = GetModuleHandleW(null);
        string cls = "TelaAmigosFakeGame" + Environment.ProcessId;
        var wc = new WNDCLASSEXW
        {
            cbSize = (uint)Marshal.SizeOf<WNDCLASSEXW>(),
            lpfnWndProc = GetProcAddress(GetModuleHandleW("user32.dll"), "DefWindowProcW"),
            hInstance = inst,
            lpszClassName = cls,
        };
        RegisterClassExW(ref wc);
        var area = new RECT();
        SystemParametersInfoW(0x0030 /*SPI_GETWORKAREA*/, 0, ref area, 0);
        int w = 320, h = 200;
        IntPtr hwnd = CreateWindowExW(0x00000080 /*TOOLWINDOW*/ | 0x08000000 /*NOACTIVATE*/, cls, "Tela Amigos - jogo de teste", 0x80000000 | 0x00800000 /*POPUP|BORDER*/,
            area.Right - w - 8, area.Bottom - h - 8, w, h, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
        ShowWindow(hwnd, 4 /*SW_SHOWNOACTIVATE*/);
        Console.Out.WriteLine("FAKEGAME " + hwnd.ToInt64());
        Console.Out.Flush();
        bool stdinOpen = true;
        new Thread(() => { try { Console.In.ReadToEnd(); } catch { } stdinOpen = false; }) { IsBackground = true }.Start();
        var sw = Stopwatch.StartNew();
        int n = 0;
        while (stdinOpen && sw.Elapsed.TotalSeconds < secs)
        {
            while (PeekMessageW(out MSG m, IntPtr.Zero, 0, 0, 1 /*PM_REMOVE*/)) { TranslateMessage(ref m); DispatchMessageW(ref m); }
            IntPtr dc = GetDC(hwnd);
            n++;
            IntPtr brush = CreateSolidBrush((uint)((n * 7) & 0xFF | ((n * 3) & 0xFF) << 8 | ((255 - n) & 0xFF) << 16));
            var rc = new RECT { Left = 0, Top = 0, Right = w, Bottom = h };
            FillRect(dc, ref rc, brush);
            var bar = new RECT { Left = (n * 4) % w, Top = 0, Right = (n * 4) % w + 20, Bottom = h };
            FillRect(dc, ref bar, GetStockObject(0 /*WHITE_BRUSH*/));
            DeleteObject(brush);
            ReleaseDC(hwnd, dc);
            Thread.Sleep(16);
        }
        DestroyWindow(hwnd);
    }

    // ================================================================ interop
    [StructLayout(LayoutKind.Sequential)] internal struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASSEXW
    {
        public uint cbSize, style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public IntPtr hInstance, hIcon, hCursor, hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtrW(IntPtr h, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int max);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, System.Text.StringBuilder s, ref int size);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string? name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr mod, string name);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern ushort RegisterClassExW(ref WNDCLASSEXW wc);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PeekMessageW(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
    [DllImport("user32.dll")] static extern bool PostThreadMessageW(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool SystemParametersInfoW(uint action, uint param, ref RECT r, uint winIni);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("user32.dll")] static extern int FillRect(IntPtr dc, ref RECT r, IntPtr brush);
    [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")] static extern IntPtr GetStockObject(int i);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
}

// ==================================================================== configurações que mexem na captura
static class Snapshot
{
    public static JsonObject System(string gamePath)
    {
        var o = new JsonObject();
        using (var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
        {
            o["windows"] = $"{k?.GetValue("DisplayVersion")} build {k?.GetValue("CurrentBuild")}.{k?.GetValue("UBR")}";
        }
        // MPO (sobreposição de planos): OverlayTestMode = 5 desliga
        o["mpoOverlayTestMode"] = Val(Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\Dwm", "OverlayTestMode");
        o["mpoOverlayMinFps"] = Val(Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\Dwm", "OverlayMinFPS");
        // agendamento de GPU acelerado por hardware: 2 = ligado, 1 = desligado
        o["hagsHwSchMode"] = Val(Registry.LocalMachine, @"SYSTEM\CurrentControlSet\Control\GraphicsDrivers", "HwSchMode");
        // "Otimizações para jogos em janela", VRR, HDR automático
        o["directxUserGlobal"] = Val(Registry.CurrentUser, @"Software\Microsoft\DirectX\UserGpuPreferences", "DirectXUserGlobalSettings");
        if (gamePath.Length > 0)
        {
            // placa escolhida para o jogo nas configurações de gráficos do Windows
            o["gameGpuPreference"] = Val(Registry.CurrentUser, @"Software\Microsoft\DirectX\UserGpuPreferences", gamePath);
            // "Desativar otimizações de tela inteira" na compatibilidade do .exe
            o["gameCompatUser"] = Val(Registry.CurrentUser, @"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers", gamePath);
            o["gameCompatMachine"] = Val(Registry.LocalMachine, @"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers", gamePath);
        }
        foreach (var n in new[] { "GameDVR_Enabled", "GameDVR_FSEBehaviorMode", "GameDVR_FSEBehavior", "GameDVR_HonorUserFSEBehaviorMode", "GameDVR_DXGIHonorFSEWindowsCompatible" })
            o[n] = Val(Registry.CurrentUser, @"System\GameConfigStore", n);
        o["gameModeAuto"] = Val(Registry.CurrentUser, @"Software\Microsoft\GameBar", "AutoGameModeEnabled");
        return o;
    }

    static JsonNode? Val(RegistryKey root, string path, string name)
    {
        try
        {
            using var k = root.OpenSubKey(path);
            var v = k?.GetValue(name);
            return v switch { null => null, int i => JsonValue.Create(i), long l => JsonValue.Create(l), string s => JsonValue.Create(s), _ => JsonValue.Create(v.ToString()) };
        }
        catch { return null; }
    }

    public static JsonArray Monitors(IntPtr gameMon)
    {
        var list = new JsonArray();
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        for (uint i = 0; factory.EnumAdapters1(i, out var a).Success; i++)
        {
            using (a)
            {
                var ad = a.Description1;
                if (ad.VendorId == 0x1414) continue;
                for (uint j = 0; a.EnumOutputs(j, out IDXGIOutput? o).Success; j++)
                {
                    using (o)
                    {
                        var d = o!.Description;
                        var m = new JsonObject
                        {
                            ["name"] = d.DeviceName,
                            ["adapter"] = ad.Description.Trim(),
                            ["width"] = d.DesktopCoordinates.Right - d.DesktopCoordinates.Left,
                            ["height"] = d.DesktopCoordinates.Bottom - d.DesktopCoordinates.Top,
                            ["game"] = d.Monitor == gameMon,
                        };
                        var dm = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
                        if (EnumDisplaySettingsW(d.DeviceName, -1, ref dm)) m["hz"] = dm.dmDisplayFrequency;
                        try { using var o2 = o.QueryInterfaceOrNull<IDXGIOutput2>(); if (o2 != null) m["mpo"] = (bool)o2.SupportsOverlays(); } catch { }
                        try
                        {
                            using var o6 = o.QueryInterfaceOrNull<IDXGIOutput6>();
                            if (o6 != null)
                            {
                                var d1 = o6.Description1;
                                m["hdr"] = d1.ColorSpace == ColorSpaceType.RgbFullG2084NoneP2020;
                                m["bits"] = d1.BitsPerColor;
                                m["hwComposition"] = o6.CheckHardwareCompositionSupport().ToString();
                            }
                        }
                        catch { }
                        list.Add(m);
                    }
                }
            }
        }
        return list;
    }

    // Programas que costumam mexer em como o jogo chega à tela (sobreposições, gravadores, geração de quadros, tela virtual).
    // Só os nomes desta lista vão no relatório (nada dos outros programas abertos).
    static readonly string[] Known =
    {
        "rtss", "msiafterburner", "losslessscaling", "virtualdesktop.streamer", "virtualdesktop.service", "nvidia overlay", "nvsphelper64",
        "nvidia app", "gamebar", "gamebarftserver", "obs64", "obs32", "medal", "overwolf", "gameoverlayui", "gameoverlayui64",
        "wallpaper32", "wallpaper64", "lively", "displayfusion", "sunshine", "parsecd", "rainmeter", "skif", "flux", "cortex",
        "radeonsoftware", "amdrsserv", "amdow", "steelseriesgg", "xsplit.core", "streamlabs obs", "nzxt cam", "hwinfo64",
        "spacedeskservice", "duet", "discord", "steam", "upc", "battle.net", "eadesktop", "galaxyclient", "magnify", "fpsmonitor",
    };

    public static JsonArray Programs()
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in Process.GetProcesses()) { try { names.Add(p.ProcessName); } catch { } finally { p.Dispose(); } }
        return new JsonArray(Known.Where(names.Contains).Select(n => (JsonNode?)JsonValue.Create(n)).ToArray());
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettingsW(string device, int mode, ref DEVMODE dm);
}
