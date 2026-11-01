// Informações de HDR de um monitor: se está em HDR e qual o "nível de branco SDR" escolhido
// no Windows (Configurações > Tela > HDR > brilho do conteúdo SDR).
using System.Runtime.InteropServices;
using Vortice.DXGI;

static class HdrInfo
{
    /// HDR ligado no monitor? (espaço de cor PQ / BT.2020)
    public static bool IsHdr(IntPtr hmonitor, out string deviceName)
    {
        deviceName = "";
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        for (uint a = 0; factory.EnumAdapters1(a, out var adapter).Success; a++)
        {
            using (adapter)
            {
                for (uint o = 0; adapter.EnumOutputs(o, out var output).Success; o++)
                {
                    using (output)
                    {
                        using var o6 = output.QueryInterfaceOrNull<IDXGIOutput6>();
                        if (o6 == null) continue;
                        var d = o6.Description1;
                        if (d.Monitor != hmonitor) continue;
                        deviceName = d.DeviceName;
                        return d.ColorSpace == ColorSpaceType.RgbFullG2084NoneP2020;
                    }
                }
            }
        }
        return false;
    }

    /// Branco do conteúdo SDR em unidades scRGB (1,0 = 80 nits). Ex.: 240 nits -> 3,0.
    public static float SdrWhiteScale(string gdiDeviceName)
    {
        try
        {
            if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out uint np, out uint nm) != 0) return 2.5f;
            var paths = new DISPLAYCONFIG_PATH_INFO[np];
            var modes = new DISPLAYCONFIG_MODE_INFO[nm];
            if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return 2.5f;
            for (int i = 0; i < np; i++)
            {
                var src = new DISPLAYCONFIG_SOURCE_DEVICE_NAME();
                src.header.type = 1; // GET_SOURCE_NAME
                src.header.size = (uint)Marshal.SizeOf<DISPLAYCONFIG_SOURCE_DEVICE_NAME>();
                src.header.adapterId = paths[i].sourceInfo.adapterId;
                src.header.id = paths[i].sourceInfo.id;
                if (DisplayConfigGetDeviceInfo(ref src) != 0) continue;
                if (!string.Equals(src.viewGdiDeviceName, gdiDeviceName, StringComparison.OrdinalIgnoreCase)) continue;

                var white = new DISPLAYCONFIG_SDR_WHITE_LEVEL();
                white.header.type = 11; // GET_SDR_WHITE_LEVEL
                white.header.size = (uint)Marshal.SizeOf<DISPLAYCONFIG_SDR_WHITE_LEVEL>();
                white.header.adapterId = paths[i].targetInfo.adapterId;
                white.header.id = paths[i].targetInfo.id;
                if (DisplayConfigGetDeviceInfo(ref white) != 0) return 2.5f;
                return Math.Clamp(white.SDRWhiteLevel / 1000f, 1f, 6f); // 1000 = 80 nits
            }
        }
        catch { }
        return 2.5f; // ~200 nits, padrão razoável
    }

    const uint QDC_ONLY_ACTIVE_PATHS = 2;

    [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct DISPLAYCONFIG_PATH_SOURCE_INFO { public LUID adapterId; public uint id, modeInfoIdx, statusFlags; }
    [StructLayout(LayoutKind.Sequential)] struct DISPLAYCONFIG_RATIONAL { public uint Numerator, Denominator; }
    [StructLayout(LayoutKind.Sequential)]
    struct DISPLAYCONFIG_PATH_TARGET_INFO
    {
        public LUID adapterId; public uint id, modeInfoIdx, outputTechnology, rotation, scaling;
        public DISPLAYCONFIG_RATIONAL refreshRate; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct DISPLAYCONFIG_PATH_INFO { public DISPLAYCONFIG_PATH_SOURCE_INFO sourceInfo; public DISPLAYCONFIG_PATH_TARGET_INFO targetInfo; public uint flags; }
    [StructLayout(LayoutKind.Sequential, Size = 64)] struct DISPLAYCONFIG_MODE_INFO { public uint infoType, id; public LUID adapterId; }
    [StructLayout(LayoutKind.Sequential)] struct DISPLAYCONFIG_DEVICE_INFO_HEADER { public uint type, size; public LUID adapterId; public uint id; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DISPLAYCONFIG_SOURCE_DEVICE_NAME
    {
        public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName;
    }
    [StructLayout(LayoutKind.Sequential)] struct DISPLAYCONFIG_SDR_WHITE_LEVEL { public DISPLAYCONFIG_DEVICE_INFO_HEADER header; public uint SDRWhiteLevel; }

    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPath, out uint numMode);
    [DllImport("user32.dll")]
    static extern int QueryDisplayConfig(uint flags, ref uint numPath, [Out] DISPLAYCONFIG_PATH_INFO[] paths,
        ref uint numMode, [Out] DISPLAYCONFIG_MODE_INFO[] modes, IntPtr topologyId);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_SOURCE_DEVICE_NAME info);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_SDR_WHITE_LEVEL info);
}
