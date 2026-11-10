// Captura de tela + conversão na GPU + H.264 por hardware (Media Foundation).
// Tudo fica na placa de vídeo: textura capturada -> VideoProcessor (escala + BGRA->NV12) -> encoder.
// Saída: quadros H.264 Annex B num ritmo fixo (ex.: 60 fps), enviados ao app pelo stdout.
// Captura: Windows Graphics Capture (WGC) no Windows 11; DXGI Desktop Duplication no Windows 10,
// porque lá o WGC desenha uma borda amarela ao redor da tela transmitida que não dá para tirar
// (IsBorderRequired só existe a partir do Windows 11).
using System.Diagnostics;
using System.Runtime.InteropServices;
using SharpGen.Runtime;
using Vortice;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using Vortice.MediaFoundation;
using Windows.Foundation.Metadata;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

// Crop*: área da tela a transmitir, em frações (0..1) da imagem capturada (padrão: tudo)
record VideoTarget(string Type, long Hwnd, int X, int Y, double CropX = 0, double CropY = 0, double CropW = 1, double CropH = 1);

sealed unsafe class VideoStreamer : IDisposable
{
    // ---------------------------------------------------------------- GUIDs de Media Foundation
    static readonly Guid MT_MAJOR_TYPE = new("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    static readonly Guid MT_SUBTYPE = new("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    static readonly Guid MT_AVG_BITRATE = new("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
    static readonly Guid MT_FRAME_SIZE = new("1652c33d-d6b2-4012-b834-72030849a37d");
    static readonly Guid MT_FRAME_RATE = new("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
    static readonly Guid MT_INTERLACE_MODE = new("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    static readonly Guid MT_PIXEL_ASPECT_RATIO = new("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
    static readonly Guid MT_MPEG2_PROFILE = new("ad76a80b-2d5c-4e0b-b375-64e520137036");
    static readonly Guid MT_MPEG_SEQUENCE_HEADER = new("3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3");
    static readonly Guid MT_YUV_MATRIX = new("3e23d450-2c75-4d25-a00e-b91670d12327");
    static readonly Guid MT_VIDEO_NOMINAL_RANGE = new("c21b8ee5-b956-4071-8daf-325edf5cab11");
    static readonly Guid MT_VIDEO_PRIMARIES = new("dbfbe4d7-0740-4ee0-8192-850ab0e21935");
    static readonly Guid MT_TRANSFER_FUNCTION = new("5fb0fce9-be5c-4935-a811-ec838f8eed93");
    static readonly Guid MediaType_Video = new("73646976-0000-0010-8000-00AA00389B71");
    static readonly Guid VideoFormat_NV12 = new("3231564E-0000-0010-8000-00AA00389B71");
    static readonly Guid VideoFormat_H264 = new("34363248-0000-0010-8000-00AA00389B71");
    static readonly Guid VideoFormat_HEVC = new("43564548-0000-0010-8000-00AA00389B71"); // 'HEVC'
    static readonly Guid VideoFormat_AV1 = new("31305641-0000-0010-8000-00AA00389B71");  // 'AV01'
    static readonly Guid MFT_CATEGORY_VIDEO_ENCODER = new("f79eac7d-e545-4387-bdee-d647d7bde42a");
    static readonly Guid TRANSFORM_ASYNC_UNLOCK = new("e5666d6b-3422-4eb6-a421-da7db1f8e207");
    static readonly Guid MFT_ENUM_ADAPTER_LUID = new("1d39518c-e220-4da8-a07f-ba172552d6b1");
    static readonly Guid MFT_FRIENDLY_NAME = new("314ffbae-5b41-4c95-9c19-4e7d586face3");
    static readonly Guid SampleExtension_CleanPoint = new("9cdf01d8-a0f0-43ba-b077-eaa06cbd728a");

    static readonly Guid CODECAPI_RateControlMode = new("1c0608e9-370c-4710-8a58-cb6181c42423");
    static readonly Guid CODECAPI_MeanBitRate = new("f7222374-2144-4815-b550-a37f8e12ee52");
    static readonly Guid CODECAPI_BufferSize = new("0db96574-b6a4-4c8b-8106-3773de0310cd");
    static readonly Guid CODECAPI_GOPSize = new("95f31b26-95a4-41aa-9303-246a7fc6eef1");
    static readonly Guid CODECAPI_BPictureCount = new("8d390aac-dc5c-4200-b57f-814d04babab2");
    static readonly Guid CODECAPI_LowLatencyMode = new("9c27891a-ed7a-40e1-88e8-b22727a024ee");
    static readonly Guid CODECAPI_ForceKeyFrame = new("398c1b98-8353-475a-9ef2-8f265d260345");
    static readonly Guid CODECAPI_QualityVsSpeed = new("98332df8-03cd-476b-89fa-3f9e442dec9f");
    static readonly Guid CODECAPI_VideoMinQP = new("0ee22c6a-a37c-4568-b5f1-9d4c2b3ab886");
    static readonly Guid IID_ICodecAPI = new("901db4c7-31ce-41a2-85dc-8fa0bf41b8da");

    const int MF_E_TRANSFORM_STREAM_CHANGE = unchecked((int)0xC00D6D61);
    const int MF_E_TRANSFORM_NEED_MORE_INPUT = unchecked((int)0xC00D6D72);

    // ---------------------------------------------------------------- estado
    readonly int fps;
    int bitrateKbps;
    public int Width { get; private set; }
    public int Height { get; private set; }
    public string EncoderName { get; private set; } = "";
    /// <summary>Piso de QP aceito pelo encoder (0 = sem piso).</summary>
    public int MinQp { get; private set; }

    ID3D11Device device = null!;
    ID3D11DeviceContext context = null!;
    ID3D11VideoDevice videoDevice = null!;
    ID3D11VideoContext videoContext = null!;
    readonly object gpuLock = new();

    // captura
    GraphicsCaptureItem item = null!;
    Direct3D11CaptureFramePool framePool = null!;
    GraphicsCaptureSession session = null!;
    IDirect3DDevice winrtDevice = null!;
    Windows.Graphics.SizeInt32 poolSize;
    ID3D11Texture2D? latest;            // última tela capturada (BGRA)
    int latestW, latestH;               // tamanho da textura
    int contentW, contentH;             // área útil (janela pode ser menor que a textura)
    VideoTarget? tgt;                   // alvo atual (com o recorte de área, se houver)
    long capturedFrames;

    // captura por DXGI Desktop Duplication (Windows 10, ou TELA_CAPTURE=dxgi)
    bool useDd;
    IDXGIOutputDuplication? dup;
    Thread? ddThread;
    volatile bool ddRunning;
    RawRect ddDesktop;                  // posição do monitor na área de trabalho (pixels)
    IntPtr ddMonitor;
    IntPtr ddHwnd;                      // janela transmitida: captura o monitor dela e recorta
    RECT ddWinRect;                     // último retângulo válido da janela
    bool windowGone;
    CursorOverlay? cursor;              // a duplicação não inclui o mouse: desenhamos nós
    const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x887A0027);
    const int DXGI_ERROR_ACCESS_LOST = unchecked((int)0x887A0026);

    /// Windows 11+: dá para pedir ao WGC que não desenhe a borda. No Windows 10 a propriedade não existe.
    public static readonly bool BorderRemovable = CheckBorderRemovable();
    static bool CheckBorderRemovable()
    {
        try { return ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "IsBorderRequired"); }
        catch { return false; }
    }
    public string CaptureMode => useDd ? "dxgi" : "wgc";

    // conversão
    ID3D11VideoProcessorEnumerator? vpEnum;
    ID3D11VideoProcessor? vp;
    ID3D11VideoProcessorInputView? vpIn;
    const int Ring = 6;
    readonly ID3D11Texture2D[] nv12 = new ID3D11Texture2D[Ring];
    readonly ID3D11VideoProcessorOutputView[] vpOut = new ID3D11VideoProcessorOutputView[Ring];
    int ringIndex;

    // encoder
    IMFTransform encoder = null!;
    IMFMediaEventGenerator events = null!;
    IMFDXGIDeviceManager deviceManager = null!;
    IntPtr codecApi;
    byte[]? sequenceHeader;
    int needInput;
    int inFlight;   // quadros entregues ao encoder que ele ainda não devolveu

    // HDR
    bool hdr;
    HdrToneMapper? toneMapper;
    DirectXPixelFormat poolFormat = DirectXPixelFormat.B8G8R8A8UIntNormalized;
    volatile bool forceKey = true;
    volatile bool running;
    Thread? tickThread, eventThread;

    // estatísticas
    long statFrames, statBytes, statDropped, statCaptured, statKeys;
    double statLatency;
    readonly Dictionary<long, long> submitTicks = new();
    readonly Stopwatch clock = Stopwatch.StartNew();

    // o app não deu conta de ler um quadro (fila de saída cheia): os próximos quadros dependem
    // dele, então pula tudo até o próximo keyframe (e pede um)
    volatile bool dropUntilKey;

    // H.265 (HEVC): mesma imagem com bem menos bits; só quando todos que assistem decodificam.
    // AV1: ainda melhor (placas RTX 40 / RX 7000 / Intel Arc codificam); idem
    readonly string codec;
    bool hevc => codec == "hevc";
    bool av1 => codec == "av1";
    Guid OutSubtype => av1 ? VideoFormat_AV1 : hevc ? VideoFormat_HEVC : VideoFormat_H264;
    public string Codec => codec;
    string CodecLabel => av1 ? "AV1" : hevc ? "H.265" : "H.264";

    public VideoStreamer(int fps, int bitrateKbps, string codec = "h264")
    {
        this.fps = fps;
        this.bitrateKbps = bitrateKbps;
        this.codec = codec == "hevc" || codec == "av1" ? codec : "h264";
    }
    Action? droppedHandler;

    // ================================================================ início
    public void Start(VideoTarget target, int maxW, int maxH)
    {
        // cada etapa com nome: "erro não especificado" sozinho não ajuda a descobrir o problema
        Step("iniciar Media Foundation", () => MediaFactory.MFStartup(false).CheckError());

        // Tenta cada combinação (encoder, placa) até uma funcionar. Em PCs com vídeo integrado
        // ativo, a "primeira placa" do Windows pode ser a integrada enquanto o encoder é o da
        // NVIDIA/AMD: misturar as duas dá E_FAIL ("erro não especificado").
        var attempts = BuildAttempts();
        if (attempts.Count == 0) throw new Exception($"Nenhum encoder {CodecLabel} por hardware encontrado na placa de vídeo");
        var errors = new List<string>();
        foreach (var (encIndex, adapter) in attempts)
        {
            try
            {
                // teste: simula a primeira combinação falhando (como a placa errada no PC do amigo)
                if (errors.Count == 0 && Environment.GetEnvironmentVariable("TELA_TEST_FAILFIRST") == "1")
                    throw new Exception("falha simulada (teste)");
                StartWith(encIndex, adapter, target, maxW, maxH);
                // só agora (o diagnóstico cria instâncias temporárias que não podem roubar o aviso)
                droppedHandler = () => { dropUntilKey = true; forceKey = true; };
                Program.OnVideoDropped = droppedHandler;
                if (errors.Count > 0) Program.SendJson(new { type = "warn", message = $"Captura nativa funcionou na tentativa {errors.Count + 1}: {adapter.Desc}" });
                return;
            }
            catch (Exception ex)
            {
                errors.Add($"[{adapter.Desc}] {ex.Message}");
                ReleaseAll();
            }
        }
        throw new Exception(string.Join(" | ", errors));
    }

    /// Diagnóstico: placas, encoders e a ordem em que seriam tentados.
    public static object Diagnose()
    {
        MediaFactory.MFStartup(false).CheckError();
        var v = new VideoStreamer(60, 1000);
        var adapters = ListAdapters();
        var encoders = v.ListEncoders();
        return new
        {
            adapters = adapters.Select(a => new { a.Desc, vendor = $"{a.VendorId:X4}", vramMB = a.Vram / 1048576, luid = a.Luid }),
            encoders = encoders.Select(e => new { e.Index, e.Name, vendor = $"{e.VendorId:X4}", luid = e.Luid }),
            attempts = v.BuildAttempts().Select(t => $"{encoders[t.encIndex].Name} + {t.adapter.Desc}"),
            hevcEncoders = new VideoStreamer(60, 1000, "hevc").ListEncoders().Select(e => e.Name),
            av1Encoders = new VideoStreamer(60, 1000, "av1").ListEncoders().Select(e => e.Name),
        };
    }

    record AdapterInfo(long Luid, uint VendorId, string Desc, ulong Vram);
    record EncoderInfo(int Index, string Name, long Luid, uint VendorId);

    static readonly Guid MFT_ENUM_HARDWARE_VENDOR_ID = new("3aecb0cc-035b-4bcc-8185-2b8d551ef3af");

    static List<AdapterInfo> ListAdapters()
    {
        var list = new List<AdapterInfo>();
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        for (uint i = 0; factory.EnumAdapters1(i, out var a).Success; i++)
        {
            using (a)
            {
                var d = a.Description1;
                if (d.VendorId == 0x1414) continue; // "Microsoft Basic Render Driver" (software)
                long l = ((long)d.Luid.HighPart << 32) | d.Luid.LowPart;
                list.Add(new AdapterInfo(l, d.VendorId, d.Description.Trim(), (ulong)d.DedicatedVideoMemory));
            }
        }
        return list;
    }

    List<EncoderInfo> ListEncoders()
    {
        var result = new List<EncoderInfo>();
        var arr = EnumEncoderActivates(OutSubtype, out uint count);
        for (int i = 0; i < count; i++)
        {
            using var a = new IMFActivate(Marshal.ReadIntPtr(arr, i * IntPtr.Size));
            long luid = 0; uint vendor = 0; string name = "H.264 HW";
            try { luid = (long)a.GetUInt64(MFT_ENUM_ADAPTER_LUID); } catch { }
            try { name = a.GetAllocatedString(MFT_FRIENDLY_NAME); } catch { }
            try
            {
                var v = a.GetAllocatedString(MFT_ENUM_HARDWARE_VENDOR_ID); // ex.: "VEN_10DE"
                if (v.StartsWith("VEN_")) vendor = Convert.ToUInt32(v[4..], 16);
            }
            catch { }
            result.Add(new EncoderInfo(i, name, luid, vendor));
        }
        Marshal.FreeCoTaskMem(arr);
        return result;
    }

    static IntPtr EnumEncoderActivates(Guid subtype, out uint count)
    {
        var input = new RegisterTypeInfo { GuidMajorType = MediaType_Video, GuidSubtype = VideoFormat_NV12 };
        var output = new RegisterTypeInfo { GuidMajorType = MediaType_Video, GuidSubtype = subtype };
        MediaFactory.MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
            (uint)(EnumFlag.EnumFlagHardware | EnumFlag.EnumFlagSortandfilter),
            input, output, out IntPtr arr, out count);
        return arr;
    }

    /// Ordem das tentativas: encoder + placa com o mesmo LUID; depois placas do mesmo fabricante
    /// (a com mais memória primeiro); por último qualquer combinação.
    List<(int encIndex, AdapterInfo adapter)> BuildAttempts()
    {
        var adapters = ListAdapters().OrderByDescending(a => a.Vram).ToList();
        var encoders = ListEncoders();
        var attempts = new List<(int, AdapterInfo)>();
        void Add(int e, AdapterInfo a) { if (!attempts.Any(x => x.Item1 == e && x.Item2.Luid == a.Luid)) attempts.Add((e, a)); }
        foreach (var e in encoders.Where(e => e.Luid != 0))
            foreach (var a in adapters.Where(a => a.Luid == e.Luid)) Add(e.Index, a);
        foreach (var e in encoders.Where(e => e.VendorId != 0))
            foreach (var a in adapters.Where(a => a.VendorId == e.VendorId)) Add(e.Index, a);
        foreach (var e in encoders)
            foreach (var a in adapters) Add(e.Index, a);
        return attempts;
    }

    void StartWith(int encIndex, AdapterInfo adapter, VideoTarget target, int maxW, int maxH)
    {
        IMFActivate activate = null!;
        Step($"abrir o encoder {CodecLabel}", () =>
        {
            var arr = EnumEncoderActivates(OutSubtype, out uint count);
            for (int i = 0; i < count; i++)
            {
                var a = new IMFActivate(Marshal.ReadIntPtr(arr, i * IntPtr.Size));
                if (i == encIndex)
                {
                    activate = a;
                    try { EncoderName = a.GetAllocatedString(MFT_FRIENDLY_NAME); } catch { EncoderName = "H.264 HW"; }
                }
                else a.Dispose();
            }
            Marshal.FreeCoTaskMem(arr);
            if (activate == null) throw new Exception("encoder sumiu da lista");
        });
        Step($"abrir a placa de vídeo ({adapter.Desc})", () => CreateDevice(adapter.Luid));
        tgt = target;
        Step("iniciar a captura da tela/janela", () => StartCapture(target));

        // tamanho de saída: cabe em maxW x maxH mantendo proporção, sempre par (só a área escolhida)
        double srcW = Math.Max(64, poolSize.Width * target.CropW), srcH = Math.Max(64, poolSize.Height * target.CropH);
        double scale = Math.Min(1.0, Math.Min(maxW / srcW, maxH / srcH));
        Width = Math.Max(64, (int)(srcW * scale) & ~1);
        Height = Math.Max(64, (int)(srcH * scale) & ~1);

        Step("criar texturas de conversão", CreateOutputTextures);
        Step("configurar o encoder da placa de vídeo (se estiver no limite de sessões de codificação, " +
             "feche OBS, gravação da NVIDIA ou outros apps que gravam a tela)", () => CreateEncoder(activate));

        running = true;
        eventThread = new Thread(EventLoop) { IsBackground = true, Priority = ThreadPriority.Highest, Name = "enc-events" };
        eventThread.Start();
        tickThread = new Thread(TickLoop) { IsBackground = true, Priority = ThreadPriority.Highest, Name = "enc-tick" };
        tickThread.Start();
    }

    (IMFActivate activate, long luid) FindHardwareEncoder()
    {
        var input = new RegisterTypeInfo { GuidMajorType = MediaType_Video, GuidSubtype = VideoFormat_NV12 };
        var output = new RegisterTypeInfo { GuidMajorType = MediaType_Video, GuidSubtype = VideoFormat_H264 };
        MediaFactory.MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
            (uint)(EnumFlag.EnumFlagHardware | EnumFlag.EnumFlagSortandfilter),
            input, output, out IntPtr arr, out uint count);
        if (count == 0) throw new Exception("Nenhum encoder H.264 por hardware encontrado");
        IMFActivate? chosen = null;
        long luid = 0;
        for (int i = 0; i < count; i++)
        {
            var a = new IMFActivate(Marshal.ReadIntPtr(arr, i * IntPtr.Size));
            if (chosen == null)
            {
                chosen = a;
                try { luid = (long)a.GetUInt64(MFT_ENUM_ADAPTER_LUID); } catch { luid = 0; }
                try { EncoderName = a.GetAllocatedString(MFT_FRIENDLY_NAME); } catch { EncoderName = "H.264 HW"; }
            }
            else a.Dispose();
        }
        Marshal.FreeCoTaskMem(arr);
        return (chosen!, luid);
    }

    void CreateDevice(long luid)
    {
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        IDXGIAdapter1? adapter = null;
        for (uint i = 0; factory.EnumAdapters1(i, out var a).Success; i++)
        {
            var d = a.Description1;
            long l = ((long)d.Luid.HighPart << 32) | d.Luid.LowPart;
            if (luid == 0 || l == luid) { adapter = a; break; }
            a.Dispose();
        }
        var levels = new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 };
        D3D11.D3D11CreateDevice(adapter, adapter == null ? DriverType.Hardware : DriverType.Unknown,
            DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
            levels, out device!, out context!).CheckError();
        adapter?.Dispose();
        using (var mt = device.QueryInterface<ID3D11Multithread>()) mt.SetMultithreadProtected(true);
        videoDevice = device.QueryInterface<ID3D11VideoDevice>();
        videoContext = context.QueryInterface<ID3D11VideoContext>();

        using var dxgiDevice = device.QueryInterface<IDXGIDevice>();
        // Com um jogo pesado aberto a placa atende o jogo e a conversão/cópia da captura fica na fila
        // (o encoder chegava a esperar 30 ms por quadro). Pede prioridade máxima para os comandos
        // deste dispositivo (o trabalho dele é mínimo: uma cópia e uma conversão por quadro) e não
        // deixa a placa enfileirar quadros dele. Sem permissão o Windows só recusa: segue normal.
        try
        {
            var hr = dxgiDevice.SetGPUThreadPriority(7);
            if (hr.Failure) hr = dxgiDevice.SetGPUThreadPriority(5);
            Log($"prioridade de GPU da captura: {(hr.Success ? "alta" : $"normal (0x{hr.Code:X8})")}");
        }
        catch (Exception ex) { Log("prioridade de GPU da captura: " + ex.Message); }
        try { using var d1 = device.QueryInterfaceOrNull<IDXGIDevice1>(); d1?.SetMaximumFrameLatency(1); } catch { }
        CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.NativePointer, out IntPtr inspectable).CheckHr("CreateDirect3D11DeviceFromDXGIDevice");
        winrtDevice = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
        Marshal.Release(inspectable);
    }

    // ================================================================ captura
    void StartCapture(VideoTarget target)
    {
        IntPtr hwnd = target.Type == "window" ? new IntPtr(target.Hwnd) : IntPtr.Zero;
        IntPtr hmon = hwnd != IntPtr.Zero
            ? MonitorFromWindow(hwnd, 2)
            : MonitorFromPoint(new POINT { x = target.X, y = target.Y }, 2);

        // teste: em vez de capturar, gera uma imagem com movimento (o que está na tela de quem roda o
        // teste não muda o resultado). TELA_TEST_PATTERN = blocos novos por quadro (mais = mais pesado)
        if (testPatternBlocks > 0) { StartPattern(); Log("captura: padrão de teste"); return; }

        // Monitor em HDR: captura em ponto flutuante (scRGB) e converte para SDR na placa.
        // Capturar HDR direto em 8 bits deixava as cores lavadas/estouradas para quem assiste.
        hdr = false;
        try
        {
            if (HdrInfo.IsHdr(hmon, out var monName) && Environment.GetEnvironmentVariable("TELA_NO_HDR") != "1")
            {
                float white = HdrInfo.SdrWhiteScale(monName);
                toneMapper = new HdrToneMapper(device, context, white);
                hdr = true;
                Program.SendJson(new { type = "video-hdr", sdrWhiteNits = Math.Round(white * 80) });
            }
        }
        catch (Exception ex)
        {
            toneMapper?.Dispose(); toneMapper = null; hdr = false;
            Program.SendJson(new { type = "warn", message = $"HDR detectado mas a conversão falhou ({ex.Message}); capturando em 8 bits." });
        }

        // Windows 10: o WGC desenha uma borda amarela ao redor do que é transmitido e não há como
        // tirar (IsBorderRequired só existe no Windows 11). A duplicação de área de trabalho (DXGI)
        // não desenha nada. TELA_CAPTURE=wgc ou =dxgi força um dos dois.
        string forced = Environment.GetEnvironmentVariable("TELA_CAPTURE") ?? "";
        useDd = forced == "dxgi" || (forced != "wgc" && !BorderRemovable);
        if (useDd)
        {
            try
            {
                StartDuplication(hmon, hwnd);
                Log("captura: DXGI Desktop Duplication (sem borda)");
                return;
            }
            catch (Exception ex)
            {
                ReleaseDd();
                useDd = false;
                Program.SendJson(new { type = "warn", message = $"Captura sem borda (DXGI) falhou ({ex.Message}); usando a captura do Windows." });
            }
        }
        StartWgc(hwnd, hmon);
        Log("captura: Windows Graphics Capture");
    }

    // ---------------------------------------------------------------- padrão de teste
    static readonly int testPatternBlocks = int.TryParse(Environment.GetEnvironmentVariable("TELA_TEST_PATTERN"), out var tp) ? tp : 0;
    Thread? patThread;
    volatile bool patRunning;
    ID3D11Texture2D? patTex;

    /// 1920x1080 de blocos coloridos descendo 6 pixels por quadro (movimento que o encoder prevê em
    /// parte) com alguns blocos trocados a cada quadro (detalhe novo): parecido com um jogo em movimento.
    void StartPattern()
    {
        const int W = 1920, H = 1080, B = 24;
        poolSize = new Windows.Graphics.SizeInt32 { Width = W, Height = H };
        patTex = device.CreateTexture2D(new Texture2DDescription
        {
            Width = W, Height = H, MipLevels = 1, ArraySize = 1, Format = Format.B8G8R8A8_UNorm,
            SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Default, BindFlags = BindFlags.ShaderResource,
        });
        int pitch = W * 4, rows = H * 2;
        var buf = new byte[pitch * rows];
        var rnd = new Random(7);
        void Block(int bx, int by)
        {
            byte b = (byte)rnd.Next(256), g = (byte)rnd.Next(256), r = (byte)rnd.Next(256);
            for (int y = by * B; y < Math.Min(rows, (by + 1) * B); y++)
                for (int x = bx * B; x < Math.Min(W, (bx + 1) * B); x++)
                {
                    int o = y * pitch + x * 4;
                    buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = 255;
                }
        }
        int bw = W / B, bh = rows / B;
        for (int by = 0; by < bh; by++) for (int bx = 0; bx < bw; bx++) Block(bx, by);
        patRunning = true;
        patThread = new Thread(() =>
        {
            var handle = GCHandle.Alloc(buf, GCHandleType.Pinned);
            try
            {
                // TELA_TEST_PATFPS: imagens novas por segundo (menos que o fps da transmissão = quadros repetidos)
                int patFps = int.TryParse(Environment.GetEnvironmentVariable("TELA_TEST_PATFPS"), out var pf) && pf > 0 ? pf : fps;
                long period = Stopwatch.Frequency / patFps, next = clock.ElapsedTicks;
                int off = 0;
                while (patRunning)
                {
                    next += period;
                    while (patRunning && clock.ElapsedTicks < next) Thread.Sleep(1);
                    off = (off + 6) % H;
                    for (int k = 0; k < testPatternBlocks; k++) Block(rnd.Next(bw), rnd.Next(bh));
                    lock (gpuLock)
                    {
                        if (device == null || patTex == null) break;
                        context.UpdateSubresource(patTex, 0, null, handle.AddrOfPinnedObject() + off * pitch, (uint)pitch, 0);
                        OnCapturedTexture(patTex, W, H);
                    }
                }
            }
            catch (Exception ex) { Log("padrão de teste: " + ex.Message); }
            finally { handle.Free(); }
        }) { IsBackground = true, Name = "pattern" };
        patThread.Start();
    }

    // ---------------------------------------------------------------- WGC
    void StartWgc(IntPtr hwnd, IntPtr hmon)
    {
        Log("request access");
        try { GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless).AsTask().Wait(1500); } catch { }

        if (hwnd != IntPtr.Zero)
        {
            try
            {
                item = CreateItem(window: hwnd, monitor: IntPtr.Zero);
            }
            catch (Exception ex)
            {
                // algumas janelas (jogos em tela cheia exclusiva, anticheat) não deixam capturar:
                // captura o monitor onde a janela está
                item = CreateItem(window: IntPtr.Zero, monitor: hmon);
                Program.SendJson(new { type = "warn", message = $"Não deu para capturar só a janela ({ex.Message}); capturando o monitor dela." });
            }
        }
        else
        {
            item = CreateItem(window: IntPtr.Zero, monitor: hmon);
        }
        Log("item ok");
        poolSize = item.Size;

        poolFormat = hdr ? DirectXPixelFormat.R16G16B16A16Float : DirectXPixelFormat.B8G8R8A8UIntNormalized;
        framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(winrtDevice, poolFormat, 3, poolSize);
        framePool.FrameArrived += OnFrameArrived;
        session = framePool.CreateCaptureSession(item);
        try { session.IsBorderRequired = false; } catch { }
        try { session.IsCursorCaptureEnabled = true; } catch { }
        // Monitor de 144/240 Hz com um jogo acima de 100 fps: o Windows entregava (e a placa copiava)
        // cada um desses quadros, e só 60 por segundo são usados. No Windows 11 24H2+ dá para pedir um
        // intervalo mínimo entre capturas: um pouco mais que metade do intervalo da transmissão (nunca
        // chega a faltar quadro novo na hora de codificar).
        try
        {
            long ticks = (long)(10_000_000.0 / fps * 0.55);
            if (TrySetMinUpdateInterval(session, ticks)) Log($"captura: no máximo um quadro a cada {ticks / 10000.0:0.0} ms");
        }
        catch { }
        closedItem = item;
        item.Closed += OnItemClosed;
        session.StartCapture();
    }

    // ---------------------------------------------------------------- DXGI Desktop Duplication
    void StartDuplication(IntPtr hmon, IntPtr hwnd)
    {
        ddMonitor = hmon;
        ddHwnd = hwnd;
        windowGone = false;
        CreateDuplication();
        if (hwnd != IntPtr.Zero)
        {
            // a saída fica do tamanho da janela (como no WGC); o recorte segue a janela a cada quadro
            ddWinRect = WindowRect(hwnd);
            poolSize = new Windows.Graphics.SizeInt32
            {
                Width = Math.Max(64, ddWinRect.Right - ddWinRect.Left),
                Height = Math.Max(64, ddWinRect.Bottom - ddWinRect.Top),
            };
        }
        else
        {
            poolSize = new Windows.Graphics.SizeInt32 { Width = ddDesktop.Right - ddDesktop.Left, Height = ddDesktop.Bottom - ddDesktop.Top };
        }
        cursor = new CursorOverlay(device, context);
        ddRunning = true;
        ddThread = new Thread(DdLoop) { IsBackground = true, Priority = ThreadPriority.AboveNormal, Name = "dd-capture" };
        ddThread.Start();
    }

    /// Abre (ou reabre) a duplicação do monitor na placa de vídeo do encoder.
    void CreateDuplication()
    {
        dup?.Dispose(); dup = null;
        using var dxgiDevice = device.QueryInterface<IDXGIDevice>();
        using var adapter = dxgiDevice.GetAdapter();
        for (uint i = 0; adapter.EnumOutputs(i, out IDXGIOutput? output).Success; i++)
        {
            using (output)
            {
                var d = output!.Description;
                if (d.Monitor != ddMonitor) continue;
                ddDesktop = d.DesktopCoordinates;
                // DuplicateOutput1 (Windows 10 1703+) deixa pedir ponto flutuante quando o monitor está em HDR
                using var o5 = output.QueryInterfaceOrNull<IDXGIOutput5>();
                if (o5 != null)
                {
                    var formats = hdr
                        ? new[] { Format.R16G16B16A16_Float, Format.B8G8R8A8_UNorm }
                        : new[] { Format.B8G8R8A8_UNorm };
                    try { dup = o5.DuplicateOutput1(device, 0, formats); } catch { dup = null; }
                }
                if (dup == null)
                {
                    using var o1 = output.QueryInterface<IDXGIOutput1>();
                    dup = o1.DuplicateOutput(device);
                }
                return;
            }
        }
        throw new Exception("o monitor não está ligado na placa de vídeo do encoder");
    }

    void DdLoop()
    {
        int lost = 0;
        timeBeginPeriod(1); // Thread.Sleep(1) de verdade (senão são ~15 ms)
        try { DdLoopInner(ref lost); }
        finally { timeEndPeriod(1); }
    }

    void DdLoopInner(ref int lost)
    {
        // no máximo uma cópia da tela a cada ~metade do intervalo da transmissão (como no WGC): num
        // monitor de 144 Hz, ou só mexendo o mouse, a duplicação entregava 100+ telas por segundo e
        // cada uma era copiada inteira. Sem buscar, o Windows só acumula as mudanças: nada se perde.
        long minTicks = (long)(Stopwatch.Frequency / (double)fps * 0.55);
        long lastAcquire = 0;
        while (ddRunning)
        {
            if (lastAcquire != 0 && clock.ElapsedTicks - lastAcquire < minTicks) { Thread.Sleep(1); continue; }
            var d = dup;
            if (d == null)
            {
                // refazer a duplicação falhou (tela de bloqueio, UAC, troca de modo de vídeo...):
                // tenta de novo a cada ~1 s até voltar. Antes ficava parado aqui para sempre.
                Thread.Sleep(1000);
                try { lock (gpuLock) { if (ddRunning && device != null && dup == null) CreateDuplication(); } }
                catch (Exception ex) { Log("refazer a duplicação: " + ex.Message); }
                continue;
            }
            // timeout 0: esperar dentro do AcquireNextFrame segura a trava do device D3D11 e deixa o
            // encoder e o VideoProcessor parados (a transmissão caía para ~12 fps). Perguntar a cada
            // ~1 ms custa quase nada e o quadro chega com até 1-2 ms de atraso.
            var res = d.AcquireNextFrame(0, out OutduplFrameInfo info, out IDXGIResource? resource);
            if (res.Code == DXGI_ERROR_WAIT_TIMEOUT) { Thread.Sleep(1); continue; }
            if (res.Failure)
            {
                // modo de vídeo mudou, jogo em tela cheia exclusiva, tela de bloqueio...: refaz a duplicação
                if (res.Code == DXGI_ERROR_ACCESS_LOST && lost++ < 100)
                {
                    Thread.Sleep(100);
                    try { lock (gpuLock) { if (ddRunning && device != null) CreateDuplication(); } }
                    catch (Exception ex) { Log("refazer a duplicação: " + ex.Message); }
                    continue;
                }
                if (ddRunning) Fail($"captura DXGI parou (0x{res.Code:X8})");
                return;
            }
            lost = 0;
            lastAcquire = clock.ElapsedTicks;
            try
            {
                using var tex = resource!.QueryInterface<ID3D11Texture2D>();
                lock (gpuLock)
                {
                    if (device == null) return;
                    if (info.LastMouseUpdateTime != 0 && cursor != null) cursor.Update(d, info);
                    var desc = tex.Description;
                    OnCapturedTexture(tex, (int)desc.Width, (int)desc.Height);
                }
            }
            catch (Exception ex) { Log("quadro DXGI: " + ex.Message); }
            finally
            {
                resource?.Dispose();
                try { d.ReleaseFrame(); } catch { }
            }
        }
    }

    void ReleaseDd()
    {
        patRunning = false;
        var pt = patThread;
        if (pt != null && pt != Thread.CurrentThread) pt.Join(1500);
        patThread = null;
        lock (gpuLock) { try { patTex?.Dispose(); } catch { } patTex = null; }
        ddRunning = false;
        var t = ddThread;
        if (t != null && t != Thread.CurrentThread) t.Join(2000);
        ddThread = null;
        try { dup?.Dispose(); } catch { }
        dup = null;
        lock (gpuLock) { try { cursor?.Dispose(); } catch { } cursor = null; }
        ddHwnd = IntPtr.Zero;
    }

    /// Retângulo da janela em pixels da tela (bordas visíveis, sem a sombra). Minimizada: o último válido.
    RECT WindowRect(IntPtr hwnd)
    {
        if (IsIconic(hwnd)) return ddWinRect;
        RECT r;
        if (DwmGetWindowAttribute(hwnd, 9 /*DWMWA_EXTENDED_FRAME_BOUNDS*/, out r, Marshal.SizeOf<RECT>()) != 0 || r.Right - r.Left < 2 || r.Bottom - r.Top < 2)
            if (!GetWindowRect(hwnd, out r)) return ddWinRect;
        if (r.Right - r.Left < 2 || r.Bottom - r.Top < 2) return ddWinRect;
        ddWinRect = r;
        return r;
    }

    GraphicsCaptureItem? closedItem;
    void OnItemClosed(GraphicsCaptureItem sender, object _)
    {
        if (running && ReferenceEquals(sender, closedItem)) Program.SendJson(new { type = "video-ended" });
    }

    void OnFrameArrived(Direct3D11CaptureFramePool pool, object _)
    {
        using var frame = pool.TryGetNextFrame();
        if (frame == null) return;
        var cs = frame.ContentSize;
        IntPtr surface = MarshalInterface<IDirect3DSurface>.FromManaged(frame.Surface);
        try
        {
            IntPtr texPtr = GetDxgiInterface(surface, typeof(ID3D11Texture2D).GUID);
            using var tex = new ID3D11Texture2D(texPtr);
            lock (gpuLock) OnCapturedTexture(tex, cs.Width, cs.Height);
        }
        finally { Marshal.Release(surface); }

        // janela mudou de tamanho: recria o pool (a saída continua do mesmo tamanho, com bordas)
        if (cs.Width != poolSize.Width || cs.Height != poolSize.Height)
        {
            poolSize = cs;
            pool.Recreate(winrtDevice, poolFormat, 3, cs);
        }
    }

    /// Guarda a textura capturada (WGC ou DXGI) como "última tela". Chamar com gpuLock.
    void OnCapturedTexture(ID3D11Texture2D tex, int cw, int ch)
    {
        if (device == null || nv12[0] == null) return; // já foi encerrado (ou ainda iniciando)
        var desc = tex.Description;
        if (toneMapper != null && desc.Format != Format.R16G16B16A16_Float)
        {
            // a captura veio em 8 bits (duplicação sem ponto flutuante): não há o que converter
            toneMapper.Dispose(); toneMapper = null; hdr = false;
            latest?.Dispose(); latest = null;
        }
        if (latest == null || latestW != (int)desc.Width || latestH != (int)desc.Height)
        {
            vpIn?.Dispose(); vpIn = null;
            latest?.Dispose();
            latest = device.CreateTexture2D(new Texture2DDescription
            {
                Width = desc.Width, Height = desc.Height, MipLevels = 1, ArraySize = 1,
                Format = desc.Format, SampleDescription = new SampleDescription(1, 0), // BGRA 8 bits ou FP16 (HDR)
                Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
            });
            latestW = (int)desc.Width;
            latestH = (int)desc.Height;
            cursor?.ResetTarget();
            if (toneMapper != null)
            {
                toneMapper.ResetSource();
                toneMapper.Process(latest, latestW, latestH); // cria a textura SDR do novo tamanho
            }
            CreateProcessor();
        }
        context.CopyResource(latest, tex);
        contentW = Math.Min(cw, latestW);
        contentH = Math.Min(ch, latestH);
        // DXGI em 8 bits: o mouse entra aqui (a cada quadro novo ou movimento do mouse a duplicação
        // entrega a tela inteira, então nunca sobra rastro). No HDR ele entra depois da conversão.
        if (useDd && toneMapper == null) cursor?.Draw(latest, latestW, latestH);
        capturedFrames++;
        statCaptured++;
    }

    // ================================================================ conversão (VideoProcessor)
    void CreateOutputTextures()
    {
        for (int i = 0; i < Ring; i++)
        {
            nv12[i] = device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)Width, Height = (uint)Height, MipLevels = 1, ArraySize = 1,
                Format = Format.NV12, SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget,
            });
        }
    }

    void CreateProcessor()
    {
        vpIn?.Dispose(); vp?.Dispose(); vpEnum?.Dispose();
        vpIn = null; vp = null; vpEnum = null;
        for (int i = 0; i < vpOut.Length; i++) { vpOut[i]?.Dispose(); vpOut[i] = null!; }
        var content = new VideoProcessorContentDescription
        {
            InputFrameFormat = VideoFrameFormat.Progressive,
            InputWidth = (uint)latestW, InputHeight = (uint)latestH,
            OutputWidth = (uint)Width, OutputHeight = (uint)Height,
            InputFrameRate = new Rational((uint)fps, 1), OutputFrameRate = new Rational((uint)fps, 1),
            Usage = VideoUsage.PlaybackNormal,
        };
        videoDevice.CreateVideoProcessorEnumerator(content, out vpEnum).CheckError();
        videoDevice.CreateVideoProcessor(vpEnum, 0, out vp).CheckError();
        // no HDR, o VideoProcessor lê a versão já convertida para SDR
        videoDevice.CreateVideoProcessorInputView(toneMapper?.Output ?? latest!, vpEnum,
            new VideoProcessorInputViewDescription { FourCC = 0, ViewDimension = VideoProcessorInputViewDimension.Texture2D, Texture2D = new Texture2DVideoProcessorInputView { MipSlice = 0 } },
            out vpIn).CheckError();
        for (int i = 0; i < Ring; i++)
            videoDevice.CreateVideoProcessorOutputView(nv12[i], vpEnum,
                new VideoProcessorOutputViewDescription { ViewDimension = VideoProcessorOutputViewDimension.Texture2D, Texture2D = new Texture2DVideoProcessorOutputView { MipSlice = 0 } },
                out vpOut[i]).CheckError();

        // cores: RGB cheio -> YUV BT.709 faixa limitada (o que o decodificador espera)
        try
        {
            using var vc1 = videoContext.QueryInterface<ID3D11VideoContext1>();
            vc1.VideoProcessorSetStreamColorSpace1(vp, 0, ColorSpaceType.RgbFullG22NoneP709);
            vc1.VideoProcessorSetOutputColorSpace1(vp, ColorSpaceType.YcbcrStudioG22LeftP709);
        }
        catch { }
        videoContext.VideoProcessorSetStreamAutoProcessingMode(vp, 0, false);
        videoContext.VideoProcessorSetStreamFrameFormat(vp, 0, VideoFrameFormat.Progressive);
    }

    // escala mantendo a proporção, com faixas pretas se precisar
    void SetRects()
    {
        int fullW = Math.Max(1, contentW), fullH = Math.Max(1, contentH);
        int sx = 0, sy = 0, cw = fullW, ch = fullH;
        if (ddHwnd != IntPtr.Zero && fullW >= 4 && fullH >= 4)
        {
            // duplicação do monitor inteiro: recorta a janela onde ela está agora
            var r = WindowRect(ddHwnd);
            int l = Math.Clamp(r.Left - ddDesktop.Left, 0, fullW - 2);
            int tp = Math.Clamp(r.Top - ddDesktop.Top, 0, fullH - 2);
            int rr = Math.Clamp(r.Right - ddDesktop.Left, l + 2, fullW);
            int bt = Math.Clamp(r.Bottom - ddDesktop.Top, tp + 2, fullH);
            sx = l; sy = tp; cw = rr - l; ch = bt - tp;
        }
        // área escolhida (frações) -> pixels da captura (dentro da janela, se for o caso)
        var t = tgt;
        if (t != null && (t.CropW < 1 || t.CropH < 1) && cw >= 4 && ch >= 4)
        {
            int ox = sx, oy = sy, ow = cw, oh = ch;
            sx = ox + Math.Clamp((int)Math.Round(t.CropX * ow), 0, ow - 2);
            sy = oy + Math.Clamp((int)Math.Round(t.CropY * oh), 0, oh - 2);
            cw = Math.Clamp((int)Math.Round(t.CropW * ow), 2, ox + ow - sx);
            ch = Math.Clamp((int)Math.Round(t.CropH * oh), 2, oy + oh - sy);
        }
        double s = Math.Min((double)Width / cw, (double)Height / ch);
        int dw = Math.Max(2, Math.Min(Width, (int)Math.Round(cw * s)) & ~1), dh = Math.Max(2, Math.Min(Height, (int)Math.Round(ch * s)) & ~1);
        int dx = ((Width - dw) / 2) & ~1, dy = ((Height - dh) / 2) & ~1;
        videoContext.VideoProcessorSetStreamSourceRect(vp!, 0, true, new RawRect(sx, sy, sx + cw, sy + ch));
        videoContext.VideoProcessorSetStreamDestRect(vp!, 0, true, new RawRect(dx, dy, dx + dw, dy + dh));
        videoContext.VideoProcessorSetOutputTargetRect(vp!, true, new RawRect(0, 0, Width, Height));
    }

    // ================================================================ encoder (Media Foundation, async HW MFT)
    void CreateEncoder(IMFActivate activate)
    {
        Step("criar o encoder", () =>
        {
            encoder = activate.ActivateObject<IMFTransform>(typeof(IMFTransform).GUID);
            activate.Dispose();
            using var attrs = encoder.Attributes;
            attrs.Set(TRANSFORM_ASYNC_UNLOCK, 1u);
        });

        Step("ligar o encoder à placa de vídeo", () =>
        {
            deviceManager = MediaFactory.MFCreateDXGIDeviceManager();
            deviceManager.ResetDevice(device).CheckError();
            encoder.ProcessMessage(TMessageType.MessageSetD3DManager, (UIntPtr)(ulong)deviceManager.NativePointer);
        });

        Guid iid = IID_ICodecAPI;
        if (Marshal.QueryInterface(encoder.NativePointer, ref iid, out codecApi) != 0) codecApi = IntPtr.Zero;
        // taxa constante (sem picos na rede), baixa latência, sem B-frames, keyframe a cada 30 s
        SetCodec(CODECAPI_RateControlMode, 0u);               // CBR
        SetCodec(CODECAPI_MeanBitRate, (uint)bitrateKbps * 1000);
        // VBV de ~8 quadros (133 ms a 60 fps). Com 4 quadros cada quadro tinha um orçamento rígido:
        // keyframes e cenas pesadas saíam borrados e os bits não usados se perdiam (o Discord
        // mediu o mesmo: janela maior = imagem melhor e bitrate médio mais perto do alvo)
        SetCodec(CODECAPI_BufferSize, (uint)bitrateKbps * 1000 / (uint)fps * 8);
        SetCodecBool(CODECAPI_LowLatencyMode, true);
        SetCodec(CODECAPI_BPictureCount, 0u);
        // keyframe custa 6 a 10 quadros normais: com um a cada 4 s a imagem "respirava" (borrava) a
        // cada 4 s. Quem entra ou perde a imagem pede um na hora (PLI), então quase não precisa dos
        // automáticos (o Discord usa ~1 por minuto)
        SetCodec(CODECAPI_GOPSize, (uint)fps * 30);
        SetCodec(CODECAPI_QualityVsSpeed, 75u); // preset de mais qualidade (NVENC aguenta folgado a 1080p60)
        // Piso de qualidade (QP mínimo). Sem ele, com a imagem quase parada, a taxa constante ia
        // baixando o QP até quase "sem perdas" e gastava 1,5 a 3 Mb/s codificando ruído que ninguém
        // vê. Medido na tela de verdade (NVIDIA, 1080p60 a 12 Mb/s): o quadro típico caiu de ~2,7 KB
        // para ~0,3 KB em H.264, de ~2 KB para ~0,6 KB em H.265 e de ~0,7 KB para ~0,09 KB em AV1.
        // QP 16-18 já é visualmente sem perdas; em movimento o QP fica bem acima e nada muda. Sobra
        // upload para o jogo de quem transmite e economiza o limite mensal do servidor de vídeo.
        // (escala 0-51 nos três encoders da NVIDIA; encoder que recusar continua como antes)
        // TELA_TEST_MINQP: outro valor para medir (0 = sem piso)
        int minQp = hevc ? 18 : 16;
        if (int.TryParse(Environment.GetEnvironmentVariable("TELA_TEST_MINQP"), out var tq)) minQp = Math.Clamp(tq, 0, 51);
        MinQp = minQp > 0 && CallSetValue(CODECAPI_VideoMinQP, new VARIANT { vt = 19, ui4 = (uint)minQp }, true) >= 0 ? minQp : 0;

        // Formato de saída: tenta o completo (High + cores BT.709); se o encoder recusar,
        // tenta versões mais simples antes de desistir.
        var outErrors = new List<string>();
        // H.264: 100 High, 77 Main. H.265: 1 = Main (8 bits 4:2:0). AV1: 1 = Main 4:2:0 8 bits
        var profiles = hevc || av1
            ? new[] { (1u, true), (1u, false), (0u, true), (0u, false) }
            : new[] { (100u, true), (100u, false), (77u, false), (0u, false) };
        foreach (var (profile, colors) in profiles)
        {
            try
            {
                using var outType = MediaFactory.MFCreateMediaType();
                outType.Set(MT_MAJOR_TYPE, MediaType_Video);
                outType.Set(MT_SUBTYPE, OutSubtype);
                outType.Set(MT_AVG_BITRATE, (uint)bitrateKbps * 1000);
                outType.Set(MT_FRAME_SIZE, ((ulong)Width << 32) | (uint)Height);
                outType.Set(MT_FRAME_RATE, ((ulong)fps << 32) | 1u);
                outType.Set(MT_PIXEL_ASPECT_RATIO, (1UL << 32) | 1u);
                outType.Set(MT_INTERLACE_MODE, 2u);                       // progressivo
                if (profile != 0) outType.Set(MT_MPEG2_PROFILE, profile);
                if (colors)
                {
                    outType.Set(MT_YUV_MATRIX, 1u);                       // BT.709
                    outType.Set(MT_VIDEO_NOMINAL_RANGE, 2u);              // 16-235
                    outType.Set(MT_VIDEO_PRIMARIES, 2u);
                    outType.Set(MT_TRANSFER_FUNCTION, 5u);
                }
                encoder.SetOutputType(0, outType, 0);
                outErrors.Clear();
                break;
            }
            catch (Exception ex) { outErrors.Add($"perfil {profile}{(colors ? "+cores" : "")}: {ex.Message}"); }
        }
        if (outErrors.Count > 0)
            throw new Exception($"Falha ao definir o formato de saída {Width}x{Height}@{fps} ({string.Join("; ", outErrors)})");

        Step($"definir o formato de entrada NV12 {Width}x{Height}", () =>
        {
            using var inType = MediaFactory.MFCreateMediaType();
            inType.Set(MT_MAJOR_TYPE, MediaType_Video);
            inType.Set(MT_SUBTYPE, VideoFormat_NV12);
            inType.Set(MT_FRAME_SIZE, ((ulong)Width << 32) | (uint)Height);
            inType.Set(MT_FRAME_RATE, ((ulong)fps << 32) | 1u);
            inType.Set(MT_PIXEL_ASPECT_RATIO, (1UL << 32) | 1u);
            inType.Set(MT_INTERLACE_MODE, 2u);
            encoder.SetInputType(0, inType, 0);
        });
        ReadSequenceHeader();

        Step("iniciar o encoder", () =>
        {
            events = encoder.QueryInterface<IMFMediaEventGenerator>();
            encoder.ProcessMessage(TMessageType.MessageNotifyBeginStreaming, UIntPtr.Zero);
            encoder.ProcessMessage(TMessageType.MessageNotifyStartOfStream, UIntPtr.Zero);
        });
    }

    void ReadSequenceHeader()
    {
        try
        {
            using var t = encoder.GetOutputCurrentType(0);
            sequenceHeader = t.GetBlob(MT_MPEG_SEQUENCE_HEADER);
        }
        catch { sequenceHeader = null; }
        // AV1: o MF pode entregar no formato "av1C" (4 bytes de cabeçalho + OBUs). Só usa se o
        // que sobrar for mesmo um sequence header OBU válido; senão não injeta nada
        av1SeqObus = null;
        if (av1 && sequenceHeader != null)
        {
            var h = sequenceHeader.Length >= 4 && (sequenceHeader[0] & 0x80) != 0 ? sequenceHeader[4..] : sequenceHeader;
            if (h.Length > 0 && HasObu(h, 1)) av1SeqObus = h;
        }
    }
    byte[]? av1SeqObus;

    // tamanho total do primeiro OBU se ele for do tipo pedido (cabeçalho + extensão + leb128 + dados); senão 0
    static int ObuLength(ReadOnlySpan<byte> d, int obuType)
    {
        if (d.Length < 1 || ((d[0] >> 3) & 0xF) != obuType || (d[0] & 2) == 0) return 0;
        int p = 1 + ((d[0] & 4) != 0 ? 1 : 0);
        long size = 0; int shift = 0;
        while (p < d.Length) { byte b = d[p++]; size |= (long)(b & 0x7F) << shift; shift += 7; if ((b & 0x80) == 0 || shift > 56) break; }
        long total = p + size;
        return total <= d.Length ? (int)total : 0;
    }

    static void Log(string m) => Console.Error.WriteLine("[video] " + m);

    /// Etapa atual da placa (aparece no aviso quando a placa trava).
    public static volatile string CurrentStep = "-";

    static void Step(string what, Action action)
    {
        CurrentStep = what;
        try { action(); }
        catch (Exception ex) { throw new Exception($"Falha ao {what}: {ex.Message}", ex); }
    }

    public void SetBitrate(int kbps)
    {
        if (kbps == bitrateKbps) return;
        bitrateKbps = kbps;
        // só o bitrate médio: mudar o buffer (VBV) faz o encoder reiniciar e gerar um keyframe
        // (medido na NVIDIA: com o bitrate menor os quadros-chave já saem menores sem mexer no buffer)
        SetCodec(CODECAPI_MeanBitRate, (uint)kbps * 1000);
    }

    public void RequestKeyFrame() => forceKey = true;

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct VARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public uint ui4; [FieldOffset(8)] public short boolVal; }

    void SetCodec(Guid api, uint value)
    {
        var v = new VARIANT { vt = 19, ui4 = value }; // VT_UI4
        CallSetValue(api, v);
    }
    void SetCodecBool(Guid api, bool value)
    {
        var v = new VARIANT { vt = 11, boolVal = (short)(value ? -1 : 0) }; // VT_BOOL
        CallSetValue(api, v);
    }
    int CallSetValue(Guid api, VARIANT v, bool quiet = false)
    {
        if (codecApi == IntPtr.Zero) return unchecked((int)0x80004002);
        var vtbl = *(IntPtr**)codecApi;
        var setValue = (delegate* unmanaged[Stdcall]<IntPtr, Guid*, VARIANT*, int>)vtbl[9];
        int hr = setValue(codecApi, &api, &v);
        // (o encoder da NVIDIA recusa "0 quadros B" porque já não usa nenhum no modo de baixa latência:
        //  não é problema e o aviso só enchia o registro a cada início de transmissão)
        if (hr < 0 && !quiet && api != CODECAPI_BPictureCount) Program.SendJson(new { type = "warn", message = $"Encoder não aceitou {api}: 0x{hr:X8}" });
        return hr;
    }

    void EventLoop()
    {
        try
        {
            while (running)
            {
                using var ev = events.GetEvent(0);
                var type = ev.EventType;
                if (type == MediaEventTypes.TransformNeedInput)
                {
                    // teste: encoder lento (placa disputada por um jogo), o tempo todo ou só nos primeiros segundos
                    if (testSlowEncMs > 0 && (testSlowForMs == 0 || clock.ElapsedMilliseconds < testSlowForMs)) Thread.Sleep(testSlowEncMs);
                    Interlocked.Increment(ref needInput);
                }
                else if (type == MediaEventTypes.TransformHaveOutput) DrainOutput();
                else if (type == MediaEventTypes.Error || ev.Status.Failure)
                {
                    // ex.: a placa de vídeo foi resetada (driver atualizado, jogo trocou o modo de tela)
                    Fail($"encoder parou (0x{ev.Status.Code:X8})");
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            Fail("encoder: " + ex.Message);
        }
    }

    /// Para tudo e avisa o app uma única vez (ele reinicia a captura sozinho).
    int failed;
    void Fail(string message)
    {
        if (!running || Interlocked.Exchange(ref failed, 1) == 1) return;
        running = false;
        Program.SendJson(new { type = "video-error", message });
    }

    int outputErrors;
    void DrainOutput()
    {
        var odb = new OutputDataBuffer { StreamID = 0 };
        var res = encoder.ProcessOutput(ProcessOutputFlags.None, 1, ref odb, out _);
        if (res.Code == MF_E_TRANSFORM_STREAM_CHANGE)
        {
            using var t = encoder.GetOutputAvailableType(0, 0);
            encoder.SetOutputType(0, t, 0);
            ReadSequenceHeader();
            return;
        }
        if (res.Code == MF_E_TRANSFORM_NEED_MORE_INPUT) return;
        if (res.Failure)
        {
            odb.Events?.Dispose();
            try { odb.Sample?.Dispose(); } catch { }
            if (Interlocked.Decrement(ref inFlight) < 0) Interlocked.Exchange(ref inFlight, 0);
            if (++outputErrors >= 30) { Fail($"encoder falhando (0x{res.Code:X8})"); return; }
            Program.SendJson(new { type = "warn", message = $"ProcessOutput 0x{res.Code:X8}" });
            return;
        }
        outputErrors = 0;

        using var sample = odb.Sample;
        odb.Events?.Dispose();
        if (sample == null) return;
        bool key = false;
        try { key = sample.GetUInt32(SampleExtension_CleanPoint) != 0; } catch { }
        long time100ns = sample.SampleTime;
        Interlocked.Decrement(ref inFlight); // o encoder terminou de usar uma textura de entrada
        if (dropUntilKey)
        {
            if (!key) return;
            dropUntilKey = false;
        }

        using var buffer = sample.ConvertToContiguousBuffer();
        buffer.Lock(out IntPtr ptr, out _, out int len);
        try
        {
            var data = new ReadOnlySpan<byte>((void*)ptr, len);
            // keyframe sem os parâmetros (SPS no H.264, VPS no H.265, sequence header no AV1): coloca na frente
            byte[]? header = av1 ? av1SeqObus : sequenceHeader;
            bool needHeader = key && header != null && !(av1 ? HasObu(data, 1) : hevc ? HasHevcNal(data, 32) : HasNal(data, 7));
            int total = 1 + 8 + (needHeader ? header!.Length : 0) + len;
            byte[] packet = new byte[total];
            packet[0] = (byte)(key ? 1 : 0);
            BitConverter.TryWriteBytes(packet.AsSpan(1), time100ns / 10); // microssegundos
            int off = 9;
            if (needHeader)
            {
                // AV1: o "temporal delimiter" (se houver) tem que continuar sendo o primeiro OBU
                int td = av1 ? ObuLength(data, 2) : 0;
                data[..td].CopyTo(packet.AsSpan(off)); off += td;
                header!.CopyTo(packet, off); off += header.Length;
                data[td..].CopyTo(packet.AsSpan(off));
            }
            else data.CopyTo(packet.AsSpan(off));
            Program.Send(3, packet);

            Interlocked.Increment(ref statFrames);
            Interlocked.Add(ref statBytes, total);
            if (key) Interlocked.Increment(ref statKeys);
            lock (submitTicks)
            {
                if (submitTicks.Remove(time100ns, out long t0))
                    statLatency += (clock.ElapsedTicks - t0) * 1000.0 / Stopwatch.Frequency;
            }
        }
        finally { buffer.Unlock(); }
    }

    // AV1 (formato "low overhead": cada OBU com tamanho): procura um OBU do tipo pedido
    static bool HasObu(ReadOnlySpan<byte> d, int obuType)
    {
        int i = 0;
        for (int n = 0; n < 16 && i < d.Length; n++)
        {
            byte h = d[i];
            int type = (h >> 3) & 0xF;
            if (type == obuType) return true;
            bool ext = (h & 4) != 0, hasSize = (h & 2) != 0;
            if (!hasSize) return false;
            int p = i + 1 + (ext ? 1 : 0);
            long size = 0; int shift = 0;
            while (p < d.Length) { byte b = d[p++]; size |= (long)(b & 0x7F) << shift; shift += 7; if ((b & 0x80) == 0 || shift > 56) break; }
            i = (int)Math.Min(int.MaxValue, p + size);
        }
        return false;
    }

    static bool HasHevcNal(ReadOnlySpan<byte> d, int nalType)
    {
        for (int i = 0; i + 3 < d.Length && i < 512; i++)
            if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1 && ((d[i + 3] >> 1) & 0x3F) == nalType) return true;
        return false;
    }

    static bool HasNal(ReadOnlySpan<byte> d, int nalType)
    {
        for (int i = 0; i + 3 < d.Length && i < 512; i++)
            if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1 && (d[i + 3] & 0x1F) == nalType) return true;
        return false;
    }

    // ================================================================ ritmo fixo
    long lastSubmitCaptured = -1;   // capturedFrames quando o último quadro foi entregue ao encoder
    long lastSubmitTicks;           // quando foi
    long lastTime100ns = -1;        // horário do último quadro entregue
    double lateScore;               // > 2: o encoder não está acompanhando o ritmo (placa disputada)
    long statLate, statSkipped;
    // testes: TELA_TEST_SLOWENC=ms simula o encoder demorando; TELA_TEST_NOLATE=1 volta ao ritmo antigo
    // (quadro descartado quando o encoder está ocupado), para comparar
    static readonly int testSlowEncMs = int.TryParse(Environment.GetEnvironmentVariable("TELA_TEST_SLOWENC"), out var ms) ? ms : 0;
    static readonly bool testNoLate = Environment.GetEnvironmentVariable("TELA_TEST_NOLATE") == "1";
    static readonly int testSlowForMs = int.TryParse(Environment.GetEnvironmentVariable("TELA_TEST_SLOWFOR"), out var sf) ? sf * 1000 : 0;

    void TickLoop()
    {
        timeBeginPeriod(1);
        IntPtr timer = CreateWaitableTimerExW(IntPtr.Zero, null, 0x2 /*HIGH_RESOLUTION*/, 0x1F0003);
        long periodTicks = Stopwatch.Frequency / fps;
        long start = clock.ElapsedTicks;
        long n = 0;
        long lastStats = start;
        bool warnedNoFrames = false;
        try
        {
            while (running)
            {
                n++;
                long due = start + n * periodTicks;
                long now = clock.ElapsedTicks;
                if (now > due + periodTicks * 4) { n = (now - start) / periodTicks; continue; } // travou: pula
                WaitUntil(timer, due);

                // estatísticas e verificação da placa uma vez por segundo (antes de qualquer "continue")
                if (clock.ElapsedTicks - lastStats >= Stopwatch.Frequency)
                {
                    SendStats((clock.ElapsedTicks - lastStats) / (double)Stopwatch.Frequency);
                    lastStats = clock.ElapsedTicks;
                    var removed = device.DeviceRemovedReason;
                    if (removed.Failure) { Fail($"a placa de vídeo foi reiniciada (0x{removed.Code:X8})"); break; }
                    if (!warnedNoFrames && Interlocked.Read(ref capturedFrames) == 0 && clock.ElapsedTicks - start > Stopwatch.Frequency * 4)
                    {
                        warnedNoFrames = true;
                        Program.SendJson(new { type = "video-warn", message = "Nenhuma imagem capturada ainda. A janela está minimizada?" });
                    }
                    // janela transmitida pela duplicação fechou (no WGC o próprio item avisa)
                    if (ddHwnd != IntPtr.Zero && !windowGone && !IsWindow(ddHwnd))
                    {
                        windowGone = true;
                        Program.SendJson(new { type = "video-ended" });
                    }
                }

                if (Interlocked.Read(ref capturedFrames) == 0) continue;                  // nada capturado ainda

                // Até 1 ms antes do próximo intervalo este quadro ainda pode sair (com o horário real).
                long deadline = testNoLate ? 0 : due + periodTicks - Stopwatch.Frequency / 1000;
                bool offGrid = false, encSlow = false;

                // Placa disputada por um jogo pesado (o encoder leva mais que um intervalo por quadro):
                // não gasta a vez dele repetindo uma imagem que já foi. Espera a próxima captura e manda
                // assim que ela chega; sem captura nova, só ~2 quadros/s para a transmissão não parecer morta.
                if (lateScore > 2 && !testNoLate && !forceKey && clock.ElapsedTicks - lastSubmitTicks < Stopwatch.Frequency / 2)
                {
                    while (running && Interlocked.Read(ref capturedFrames) == lastSubmitCaptured && clock.ElapsedTicks < deadline)
                    {
                        offGrid = true;
                        Thread.Sleep(1);
                    }
                    if (!running) break;
                    if (Interlocked.Read(ref capturedFrames) == lastSubmitCaptured) { statSkipped++; lateScore *= 0.97; continue; }
                }
                // o quadro anterior saiu fora do ritmo há pouco: não manda outro colado nele
                while (running && !testNoLate && clock.ElapsedTicks - lastSubmitTicks < periodTicks * 6 / 10 && clock.ElapsedTicks < deadline)
                {
                    offGrid = true;
                    Thread.Sleep(1);
                }

                // Encoder ainda ocupado com o quadro anterior (ou todas as texturas em uso: nunca
                // reescrever uma que ele ainda está lendo). Antes este quadro era descartado e só o
                // próximo intervalo tentava de novo: com o encoder levando 30 ms num jogo pesado, de
                // 30 quadros/s saíam 19. Agora espera ele liberar e manda na hora: saem tantos quadros
                // quanto a placa consegue.
                while (running && (Volatile.Read(ref needInput) <= 0 || Volatile.Read(ref inFlight) >= Ring - 1))
                {
                    if (clock.ElapsedTicks >= deadline) break;
                    offGrid = true;
                    // "não está dando conta" = o quadro anterior já teve um intervalo inteiro e não ficou
                    // pronto (esperar porque o anterior saiu atrasado não conta: senão um soluço passageiro
                    // prendia a captura no modo de placa disputada para sempre)
                    if (clock.ElapsedTicks - lastSubmitTicks > periodTicks) encSlow = true;
                    Thread.Sleep(1);
                }
                if (!running) break;
                if (Volatile.Read(ref needInput) <= 0 || Volatile.Read(ref inFlight) >= Ring - 1)
                {
                    statDropped++;
                    if (clock.ElapsedTicks - lastSubmitTicks > periodTicks) lateScore = Math.Min(20, lateScore + 1);
                    continue;
                }
                long t100 = n * 10_000_000L / fps;
                if (offGrid) t100 = (clock.ElapsedTicks - start) * 10_000_000L / Stopwatch.Frequency;
                if (encSlow) { statLate++; lateScore = Math.Min(20, lateScore + 1); }
                else lateScore *= 0.9;
                if (t100 <= lastTime100ns) t100 = lastTime100ns + 1000; // sempre crescente
                Interlocked.Decrement(ref needInput);
                long capturedNow = Interlocked.Read(ref capturedFrames);
                if (SubmitFrame(t100))
                {
                    lastTime100ns = t100;
                    lastSubmitCaptured = capturedNow;
                    lastSubmitTicks = clock.ElapsedTicks;
                }
                else Interlocked.Increment(ref needInput); // devolve o crédito
            }
        }
        catch (Exception ex)
        {
            Fail("captura: " + ex.Message);
        }
        finally
        {
            if (timer != IntPtr.Zero) CloseHandle(timer);
            timeEndPeriod(1);
        }
    }

    void WaitUntil(IntPtr timer, long dueTicks)
    {
        long remaining = dueTicks - clock.ElapsedTicks;
        long ms2 = Stopwatch.Frequency / 500;
        if (timer != IntPtr.Zero && remaining > ms2)
        {
            long rel100ns = -(long)((remaining - ms2) * 10_000_000.0 / Stopwatch.Frequency);
            if (SetWaitableTimer(timer, ref rel100ns, 0, IntPtr.Zero, IntPtr.Zero, false))
                WaitForSingleObject(timer, 1000);
        }
        while (clock.ElapsedTicks < dueTicks) Thread.SpinWait(50);
    }

    bool SubmitFrame(long time100ns)
    {
        int idx = ringIndex;
        lock (gpuLock)
        {
            if (vp == null || vpIn == null || vpOut[idx] == null) return false;
            ringIndex = (ringIndex + 1) % Ring;
            if (toneMapper != null && latest != null)
            {
                toneMapper.Process(latest, latestW, latestH); // HDR -> SDR
                if (useDd && toneMapper.Output != null) cursor?.Draw(toneMapper.Output, latestW, latestH);
            }
            SetRects();
            var stream = new VideoProcessorStream { Enable = true, InputSurface = vpIn };
            videoContext.VideoProcessorBlt(vp, vpOut[idx], 0, 1, new[] { stream }).CheckError();
            // manda os comandos para a placa já (senão ficam na fila do D3D até alguém precisar deles
            // e o encoder espera à toa: com a placa disputada cada milissegundo de fila conta)
            context.Flush();
        }

        using var buffer = MediaFactory.MFCreateDXGISurfaceBuffer(typeof(ID3D11Texture2D).GUID, nv12[idx], 0, false);
        using (var b2 = buffer.QueryInterface<IMF2DBuffer>()) buffer.CurrentLength = (int)b2.ContiguousLength;
        using var sample = MediaFactory.MFCreateSample();
        sample.AddBuffer(buffer);
        sample.SampleTime = time100ns;
        sample.SampleDuration = 10_000_000L / fps;
        if (forceKey)
        {
            forceKey = false;
            SetCodec(CODECAPI_ForceKeyFrame, 1u);
        }
        lock (submitTicks) submitTicks[time100ns] = clock.ElapsedTicks;
        Interlocked.Increment(ref inFlight);
        encoder.ProcessInput(0, sample, 0);
        return true;
    }

    void SendStats(double seconds)
    {
        long frames = Interlocked.Exchange(ref statFrames, 0);
        long bytes = Interlocked.Exchange(ref statBytes, 0);
        long captured = Interlocked.Exchange(ref statCaptured, 0);
        long keys = Interlocked.Exchange(ref statKeys, 0);
        long dropped = statDropped; statDropped = 0;
        long late = statLate; statLate = 0;
        long skipped = statSkipped; statSkipped = 0;
        double lat;
        lock (submitTicks) { lat = statLatency; statLatency = 0; if (submitTicks.Count > 100) submitTicks.Clear(); }
        Program.SendJson(new
        {
            type = "video-stats",
            fps = Math.Round(frames / seconds, 1),
            captureFps = Math.Round(captured / seconds, 1),
            kbps = (int)(bytes * 8 / 1000 / seconds),
            dropped,
            late,      // quadros que esperaram o encoder liberar (saíram fora do ritmo, mas saíram)
            skipped,   // imagens repetidas que não foram codificadas (encoder sem folga)
            keys,
            encodeMs = frames > 0 ? Math.Round(lat / frames, 2) : 0,
            width = Width,
            height = Height,
        });
    }

    // ================================================================ fim
    public void Dispose()
    {
        running = false;
        if (droppedHandler != null && Program.OnVideoDropped == droppedHandler) Program.OnVideoDropped = null;
        CurrentStep = "parar o encoder";
        bool tickDone = tickThread == null || tickThread.Join(3000);
        try
        {
            encoder?.ProcessMessage(TMessageType.MessageNotifyEndOfStream, UIntPtr.Zero);
            encoder?.ProcessMessage(TMessageType.MessageNotifyEndStreaming, UIntPtr.Zero);
            using var shutdown = encoder?.QueryInterfaceOrNull<IMFShutdown>();
            shutdown?.Shutdown();
        }
        catch { }
        bool eventDone = eventThread == null || eventThread.Join(3000);
        if (!tickDone || !eventDone)
        {
            // uma thread ainda está presa numa chamada da placa (ex.: placa resetando): liberar
            // agora faria ela usar objetos já destruídos e o helper cair (levando o áudio junto).
            // Melhor vazar esses objetos do que derrubar o processo.
            Log("threads do vídeo não pararam a tempo: objetos da placa não foram liberados");
            try { if (framePool != null) framePool.FrameArrived -= OnFrameArrived; } catch { }
            try { session?.Dispose(); } catch { }
            ddRunning = false;
            return;
        }
        CurrentStep = "liberar a placa de vídeo";
        ReleaseAll();
        CurrentStep = "-";
    }

    /// Libera tudo o que uma tentativa de início criou (também usado entre tentativas que falham).
    void ReleaseAll()
    {
        ReleaseDd();
        try { if (framePool != null) framePool.FrameArrived -= OnFrameArrived; } catch { }
        try { if (closedItem != null) closedItem.Closed -= OnItemClosed; } catch { }
        closedItem = null;
        try { session?.Dispose(); } catch { }
        try { framePool?.Dispose(); } catch { }
        session = null!; framePool = null!; item = null!;
        if (codecApi != IntPtr.Zero) { Marshal.Release(codecApi); codecApi = IntPtr.Zero; }
        lock (gpuLock)
        {
            try { vpIn?.Dispose(); vp?.Dispose(); vpEnum?.Dispose(); } catch { }
            for (int i = 0; i < Ring; i++)
            {
                try { vpOut[i]?.Dispose(); nv12[i]?.Dispose(); } catch { }
                vpOut[i] = null!; nv12[i] = null!;
            }
            try { latest?.Dispose(); } catch { }
            try { toneMapper?.Dispose(); } catch { }
            toneMapper = null; hdr = false;
            vpIn = null; vp = null; vpEnum = null; latest = null; latestW = latestH = 0;
        }
        try { events?.Dispose(); } catch { }
        try { using var sd = encoder?.QueryInterfaceOrNull<IMFShutdown>(); sd?.Shutdown(); } catch { }
        try { encoder?.Dispose(); } catch { }
        try { deviceManager?.Dispose(); } catch { }
        events = null!; encoder = null!; deviceManager = null!;
        try { (winrtDevice as IDisposable)?.Dispose(); } catch { }
        winrtDevice = null!;
        try { videoContext?.Dispose(); videoDevice?.Dispose(); } catch { }
        try { context?.Dispose(); device?.Dispose(); } catch { }
        videoContext = null!; videoDevice = null!; context = null!; device = null!;
        sequenceHeader = null;
        Volatile.Write(ref capturedFrames, 0);
        Volatile.Write(ref inFlight, 0);
        Volatile.Write(ref needInput, 0);
    }

    // ================================================================ interop
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWaitableTimerExW(IntPtr attrs, string? name, uint flags, uint access);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetWaitableTimer(IntPtr timer, ref long due, int period, IntPtr cb, IntPtr arg, bool resume);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    static readonly Guid IID_IGraphicsCaptureItemInterop = new("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");
    static readonly Guid IID_GraphicsCaptureItem = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    static readonly Guid IID_IDirect3DDxgiInterfaceAccess = new("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1");

    static GraphicsCaptureItem CreateItem(IntPtr window, IntPtr monitor)
    {
        var factory = ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem");
        Guid iidInterop = IID_IGraphicsCaptureItemInterop;
        Marshal.QueryInterface(factory.ThisPtr, ref iidInterop, out IntPtr interop).CheckHr("IGraphicsCaptureItemInterop");
        try
        {
            var vtbl = *(IntPtr**)interop;
            Guid iidItem = IID_GraphicsCaptureItem;
            IntPtr result;
            int hr = window != IntPtr.Zero
                ? ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, Guid*, IntPtr*, int>)vtbl[3])(interop, window, &iidItem, &result)
                : ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, Guid*, IntPtr*, int>)vtbl[4])(interop, monitor, &iidItem, &result);
            hr.CheckHr(window != IntPtr.Zero ? "CreateForWindow" : "CreateForMonitor");
            var item = GraphicsCaptureItem.FromAbi(result);
            Marshal.Release(result);
            return item;
        }
        finally { Marshal.Release(interop); }
    }

    // GraphicsCaptureSession.MinUpdateInterval (Windows 11 24H2+). O projeto compila com a descrição
    // do Windows 11 22H2, que ainda não tem essa propriedade: chama pela interface direto. Lê antes e
    // confere depois: só vale se a propriedade guardou exatamente o intervalo pedido.
    static readonly Guid IID_IGraphicsCaptureSession5 = new("67C0EA62-1F85-5061-925A-239BE0AC09CB");
    static bool TrySetMinUpdateInterval(GraphicsCaptureSession s, long ticks100ns)
    {
        if (!ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "MinUpdateInterval")) return false;
        IntPtr unk = MarshalInspectable<GraphicsCaptureSession>.FromManaged(s);
        try
        {
            Guid iid = IID_IGraphicsCaptureSession5;
            if (Marshal.QueryInterface(unk, ref iid, out IntPtr p5) != 0) return false;
            try
            {
                var vtbl = *(IntPtr**)p5;
                var get = (delegate* unmanaged[Stdcall]<IntPtr, long*, int>)vtbl[6];
                var put = (delegate* unmanaged[Stdcall]<IntPtr, long, int>)vtbl[7];
                long before = -1, after = -1;
                if (get(p5, &before) < 0 || before < 0 || before > 10_000_000) return false;
                if (put(p5, ticks100ns) < 0) return false;
                return get(p5, &after) >= 0 && after == ticks100ns;
            }
            finally { Marshal.Release(p5); }
        }
        finally { Marshal.Release(unk); }
    }

    static IntPtr GetDxgiInterface(IntPtr surface, Guid iid)
    {
        Guid iidAccess = IID_IDirect3DDxgiInterfaceAccess;
        Marshal.QueryInterface(surface, ref iidAccess, out IntPtr access).CheckHr("IDirect3DDxgiInterfaceAccess");
        try
        {
            var vtbl = *(IntPtr**)access;
            IntPtr result;
            ((delegate* unmanaged[Stdcall]<IntPtr, Guid*, IntPtr*, int>)vtbl[3])(access, &iid, &result).CheckHr("GetInterface");
            return result;
        }
        finally { Marshal.Release(access); }
    }
}

static class HrExtensions
{
    public static void CheckHr(this int hr, string what)
    {
        if (hr < 0) throw new Exception($"{what} falhou: 0x{hr:X8}");
    }
}
