// Captura de tela (Windows Graphics Capture) + conversão na GPU + H.264 por hardware (Media Foundation).
// Tudo fica na placa de vídeo: textura capturada -> VideoProcessor (escala + BGRA->NV12) -> encoder.
// Saída: quadros H.264 Annex B num ritmo fixo (ex.: 60 fps), enviados ao app pelo stdout.
using System.Diagnostics;
using System.Runtime.InteropServices;
using SharpGen.Runtime;
using Vortice;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using Vortice.MediaFoundation;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

record VideoTarget(string Type, long Hwnd, int X, int Y);

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
    static readonly Guid IID_ICodecAPI = new("901db4c7-31ce-41a2-85dc-8fa0bf41b8da");

    const int MF_E_TRANSFORM_STREAM_CHANGE = unchecked((int)0xC00D6D61);
    const int MF_E_TRANSFORM_NEED_MORE_INPUT = unchecked((int)0xC00D6D72);

    // ---------------------------------------------------------------- estado
    readonly int fps;
    int bitrateKbps;
    public int Width { get; private set; }
    public int Height { get; private set; }
    public string EncoderName { get; private set; } = "";

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
    long capturedFrames;

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
    volatile bool forceKey = true;
    volatile bool running;
    Thread? tickThread, eventThread;

    // estatísticas
    long statFrames, statBytes, statDropped, statCaptured, statKeys;
    double statLatency;
    readonly Dictionary<long, long> submitTicks = new();
    readonly Stopwatch clock = Stopwatch.StartNew();

    public VideoStreamer(int fps, int bitrateKbps)
    {
        this.fps = fps;
        this.bitrateKbps = bitrateKbps;
    }

    // ================================================================ início
    public void Start(VideoTarget target, int maxW, int maxH)
    {
        MediaFactory.MFStartup(false).CheckError();
        Log("mfstartup ok");
        var (activate, luid) = FindHardwareEncoder();
        Log($"encoder {EncoderName} luid {luid}");
        CreateDevice(luid);
        Log("device ok");
        StartCapture(target);
        Log($"capture ok {poolSize.Width}x{poolSize.Height}");

        // tamanho de saída: cabe em maxW x maxH mantendo proporção, sempre par
        double scale = Math.Min(1.0, Math.Min((double)maxW / poolSize.Width, (double)maxH / poolSize.Height));
        Width = Math.Max(64, (int)(poolSize.Width * scale) & ~1);
        Height = Math.Max(64, (int)(poolSize.Height * scale) & ~1);

        CreateOutputTextures();
        CreateEncoder(activate);
        Log("encoder ok");

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
        CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.NativePointer, out IntPtr inspectable).CheckHr("CreateDirect3D11DeviceFromDXGIDevice");
        winrtDevice = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
        Marshal.Release(inspectable);
    }

    // ================================================================ captura (WGC)
    void StartCapture(VideoTarget target)
    {
        Log("request access");
        try { GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless).AsTask().Wait(1500); } catch { }

        item = target.Type == "window"
            ? CreateItem(window: new IntPtr(target.Hwnd), monitor: IntPtr.Zero)
            : CreateItem(window: IntPtr.Zero, monitor: MonitorFromPoint(new POINT { x = target.X, y = target.Y }, 2));
        Log("item ok");
        poolSize = item.Size;
        framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 3, poolSize);
        framePool.FrameArrived += OnFrameArrived;
        session = framePool.CreateCaptureSession(item);
        try { session.IsBorderRequired = false; } catch { }
        try { session.IsCursorCaptureEnabled = true; } catch { }
        item.Closed += (_, _) => Program.SendJson(new { type = "video-ended" });
        session.StartCapture();
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
            var desc = tex.Description;
            lock (gpuLock)
            {
                if (latest == null || latestW != (int)desc.Width || latestH != (int)desc.Height)
                {
                    vpIn?.Dispose(); vpIn = null;
                    latest?.Dispose();
                    latest = device.CreateTexture2D(new Texture2DDescription
                    {
                        Width = desc.Width, Height = desc.Height, MipLevels = 1, ArraySize = 1,
                        Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
                        Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
                    });
                    latestW = (int)desc.Width;
                    latestH = (int)desc.Height;
                    CreateProcessor();
                }
                context.CopyResource(latest, tex);
                contentW = Math.Min(cs.Width, latestW);
                contentH = Math.Min(cs.Height, latestH);
                capturedFrames++;
                statCaptured++;
            }
        }
        finally { Marshal.Release(surface); }

        // janela mudou de tamanho: recria o pool (a saída continua do mesmo tamanho, com bordas)
        if (cs.Width != poolSize.Width || cs.Height != poolSize.Height)
        {
            poolSize = cs;
            pool.Recreate(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 3, cs);
        }
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
        foreach (var v in vpOut) v?.Dispose();
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
        videoDevice.CreateVideoProcessorInputView(latest!, vpEnum,
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
        int cw = Math.Max(1, contentW), ch = Math.Max(1, contentH);
        double s = Math.Min((double)Width / cw, (double)Height / ch);
        int dw = Math.Min(Width, (int)Math.Round(cw * s)) & ~1, dh = Math.Min(Height, (int)Math.Round(ch * s)) & ~1;
        int dx = ((Width - dw) / 2) & ~1, dy = ((Height - dh) / 2) & ~1;
        videoContext.VideoProcessorSetStreamSourceRect(vp!, 0, true, new RawRect(0, 0, cw, ch));
        videoContext.VideoProcessorSetStreamDestRect(vp!, 0, true, new RawRect(dx, dy, dx + dw, dy + dh));
        videoContext.VideoProcessorSetOutputTargetRect(vp!, true, new RawRect(0, 0, Width, Height));
    }

    // ================================================================ encoder (Media Foundation, async HW MFT)
    void CreateEncoder(IMFActivate activate)
    {
        encoder = activate.ActivateObject<IMFTransform>(typeof(IMFTransform).GUID);
        activate.Dispose();
        using (var attrs = encoder.Attributes) attrs.Set(TRANSFORM_ASYNC_UNLOCK, 1u);

        deviceManager = MediaFactory.MFCreateDXGIDeviceManager();
        deviceManager.ResetDevice(device).CheckError();
        encoder.ProcessMessage(TMessageType.MessageSetD3DManager, (UIntPtr)(ulong)deviceManager.NativePointer);

        Guid iid = IID_ICodecAPI;
        if (Marshal.QueryInterface(encoder.NativePointer, ref iid, out codecApi) != 0) codecApi = IntPtr.Zero;
        // taxa constante (sem picos na rede), baixa latência, sem B-frames, keyframe a cada 4 s
        SetCodec(CODECAPI_RateControlMode, 0u);               // CBR
        SetCodec(CODECAPI_MeanBitRate, (uint)bitrateKbps * 1000);
        SetCodec(CODECAPI_BufferSize, (uint)bitrateKbps * 1000 / (uint)fps * 2); // VBV de ~2 quadros
        SetCodecBool(CODECAPI_LowLatencyMode, true);
        SetCodec(CODECAPI_BPictureCount, 0u);
        SetCodec(CODECAPI_GOPSize, (uint)fps * 4);
        SetCodec(CODECAPI_QualityVsSpeed, 50u);

        using (var outType = MediaFactory.MFCreateMediaType())
        {
            outType.Set(MT_MAJOR_TYPE, MediaType_Video);
            outType.Set(MT_SUBTYPE, VideoFormat_H264);
            outType.Set(MT_AVG_BITRATE, (uint)bitrateKbps * 1000);
            outType.Set(MT_FRAME_SIZE, ((ulong)Width << 32) | (uint)Height);
            outType.Set(MT_FRAME_RATE, ((ulong)fps << 32) | 1u);
            outType.Set(MT_PIXEL_ASPECT_RATIO, (1UL << 32) | 1u);
            outType.Set(MT_INTERLACE_MODE, 2u);                 // progressivo
            outType.Set(MT_MPEG2_PROFILE, 100u);                // High
            outType.Set(MT_YUV_MATRIX, 1u);                     // BT.709
            outType.Set(MT_VIDEO_NOMINAL_RANGE, 2u);            // 16-235
            outType.Set(MT_VIDEO_PRIMARIES, 2u);
            outType.Set(MT_TRANSFER_FUNCTION, 5u);
            encoder.SetOutputType(0, outType, 0);
        }
        using (var inType = MediaFactory.MFCreateMediaType())
        {
            inType.Set(MT_MAJOR_TYPE, MediaType_Video);
            inType.Set(MT_SUBTYPE, VideoFormat_NV12);
            inType.Set(MT_FRAME_SIZE, ((ulong)Width << 32) | (uint)Height);
            inType.Set(MT_FRAME_RATE, ((ulong)fps << 32) | 1u);
            inType.Set(MT_PIXEL_ASPECT_RATIO, (1UL << 32) | 1u);
            inType.Set(MT_INTERLACE_MODE, 2u);
            encoder.SetInputType(0, inType, 0);
        }
        ReadSequenceHeader();

        events = encoder.QueryInterface<IMFMediaEventGenerator>();
        encoder.ProcessMessage(TMessageType.MessageNotifyBeginStreaming, UIntPtr.Zero);
        encoder.ProcessMessage(TMessageType.MessageNotifyStartOfStream, UIntPtr.Zero);
    }

    void ReadSequenceHeader()
    {
        try
        {
            using var t = encoder.GetOutputCurrentType(0);
            sequenceHeader = t.GetBlob(MT_MPEG_SEQUENCE_HEADER);
        }
        catch { sequenceHeader = null; }
    }

    static void Log(string m) => Console.Error.WriteLine("[video] " + m);

    public void SetBitrate(int kbps)
    {
        bitrateKbps = kbps;
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
    void CallSetValue(Guid api, VARIANT v)
    {
        if (codecApi == IntPtr.Zero) return;
        var vtbl = *(IntPtr**)codecApi;
        var setValue = (delegate* unmanaged[Stdcall]<IntPtr, Guid*, VARIANT*, int>)vtbl[9];
        int hr = setValue(codecApi, &api, &v);
        if (hr < 0) Program.SendJson(new { type = "warn", message = $"Encoder não aceitou {api}: 0x{hr:X8}" });
    }

    void EventLoop()
    {
        try
        {
            while (running)
            {
                using var ev = events.GetEvent(0);
                var type = ev.EventType;
                if (type == MediaEventTypes.TransformNeedInput) Interlocked.Increment(ref needInput);
                else if (type == MediaEventTypes.TransformHaveOutput) DrainOutput();
            }
        }
        catch (Exception ex)
        {
            if (running) Program.SendJson(new { type = "video-error", message = "encoder: " + ex.Message });
        }
    }

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
            Program.SendJson(new { type = "warn", message = $"ProcessOutput 0x{res.Code:X8}" });
            return;
        }

        using var sample = odb.Sample;
        odb.Events?.Dispose();
        if (sample == null) return;
        bool key = false;
        try { key = sample.GetUInt32(SampleExtension_CleanPoint) != 0; } catch { }
        long time100ns = sample.SampleTime;

        using var buffer = sample.ConvertToContiguousBuffer();
        buffer.Lock(out IntPtr ptr, out _, out int len);
        try
        {
            var data = new ReadOnlySpan<byte>((void*)ptr, len);
            bool needHeader = key && sequenceHeader != null && !HasNal(data, 7);
            int total = 1 + 8 + (needHeader ? sequenceHeader!.Length : 0) + len;
            byte[] packet = new byte[total];
            packet[0] = (byte)(key ? 1 : 0);
            BitConverter.TryWriteBytes(packet.AsSpan(1), time100ns / 10); // microssegundos
            int off = 9;
            if (needHeader) { sequenceHeader!.CopyTo(packet, off); off += sequenceHeader.Length; }
            data.CopyTo(packet.AsSpan(off));
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

    static bool HasNal(ReadOnlySpan<byte> d, int nalType)
    {
        for (int i = 0; i + 3 < d.Length && i < 512; i++)
            if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1 && (d[i + 3] & 0x1F) == nalType) return true;
        return false;
    }

    // ================================================================ ritmo fixo
    void TickLoop()
    {
        timeBeginPeriod(1);
        IntPtr timer = CreateWaitableTimerExW(IntPtr.Zero, null, 0x2 /*HIGH_RESOLUTION*/, 0x1F0003);
        long periodTicks = Stopwatch.Frequency / fps;
        long start = clock.ElapsedTicks;
        long n = 0;
        long lastStats = start;
        try
        {
            while (running)
            {
                n++;
                long due = start + n * periodTicks;
                long now = clock.ElapsedTicks;
                if (now > due + periodTicks * 4) { n = (now - start) / periodTicks; continue; } // travou: pula
                WaitUntil(timer, due);

                if (Interlocked.CompareExchange(ref capturedFrames, 0, 0) == 0) continue; // nada capturado ainda
                if (Volatile.Read(ref needInput) <= 0) { statDropped++; continue; }        // encoder ocupado
                Interlocked.Decrement(ref needInput);
                SubmitFrame(n * 10_000_000L / fps);

                if (clock.ElapsedTicks - lastStats >= Stopwatch.Frequency)
                {
                    SendStats((clock.ElapsedTicks - lastStats) / (double)Stopwatch.Frequency);
                    lastStats = clock.ElapsedTicks;
                }
            }
        }
        catch (Exception ex)
        {
            if (running) Program.SendJson(new { type = "video-error", message = "captura: " + ex.Message });
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

    void SubmitFrame(long time100ns)
    {
        int idx = ringIndex;
        ringIndex = (ringIndex + 1) % Ring;
        lock (gpuLock)
        {
            if (vp == null || vpIn == null) return;
            SetRects();
            var stream = new VideoProcessorStream { Enable = true, InputSurface = vpIn };
            videoContext.VideoProcessorBlt(vp, vpOut[idx], 0, 1, new[] { stream }).CheckError();
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
        encoder.ProcessInput(0, sample, 0);
    }

    void SendStats(double seconds)
    {
        long frames = Interlocked.Exchange(ref statFrames, 0);
        long bytes = Interlocked.Exchange(ref statBytes, 0);
        long captured = Interlocked.Exchange(ref statCaptured, 0);
        long keys = Interlocked.Exchange(ref statKeys, 0);
        long dropped = statDropped; statDropped = 0;
        double lat;
        lock (submitTicks) { lat = statLatency; statLatency = 0; if (submitTicks.Count > 100) submitTicks.Clear(); }
        Program.SendJson(new
        {
            type = "video-stats",
            fps = Math.Round(frames / seconds, 1),
            captureFps = Math.Round(captured / seconds, 1),
            kbps = (int)(bytes * 8 / 1000 / seconds),
            dropped,
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
        tickThread?.Join(1000);
        try { session?.Dispose(); } catch { }
        try { framePool?.Dispose(); } catch { }
        try
        {
            encoder?.ProcessMessage(TMessageType.MessageNotifyEndOfStream, UIntPtr.Zero);
            encoder?.ProcessMessage(TMessageType.MessageNotifyEndStreaming, UIntPtr.Zero);
            using var shutdown = encoder?.QueryInterfaceOrNull<IMFShutdown>();
            shutdown?.Shutdown();
        }
        catch { }
        eventThread?.Join(1000);
        if (codecApi != IntPtr.Zero) { Marshal.Release(codecApi); codecApi = IntPtr.Zero; }
        lock (gpuLock)
        {
            vpIn?.Dispose(); vp?.Dispose(); vpEnum?.Dispose();
            foreach (var v in vpOut) v?.Dispose();
            foreach (var t in nv12) t?.Dispose();
            latest?.Dispose();
        }
        try { events?.Dispose(); } catch { }
        try { encoder?.Dispose(); } catch { }
        deviceManager?.Dispose();
        videoContext?.Dispose(); videoDevice?.Dispose();
        context?.Dispose(); device?.Dispose();
    }

    // ================================================================ interop
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
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
