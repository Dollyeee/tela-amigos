// Ajuste do driver da NVIDIA por jogo: "Método de apresentação Vulkan/OpenGL" (NVAPI DRS).
// O Doge (2026-11-26): RDR2 em Vulkan, placa NVIDIA. Com o jogo na frente cobrindo a tela, o driver mandava a imagem
// direto ao monitor ("apresentação nativa") e o Windows não via nada: todo jeito de capturar congelava (o teste de
// captura da 1.0.75 mostrou isso) e voltava no Alt+Tab. Com "Preferir em camadas no DXGI" o Vulkan apresenta pelo
// caminho normal do Windows e a captura vê o jogo. Vale só para o .exe do jogo (no perfil dele, ou num perfil
// "Tela Amigos - <exe>" se o driver não conhece o jogo), e só no próximo início do jogo. Jogo DirectX não usa o ajuste.
//
// IDs das funções (nvapi_QueryInterface) e estruturas conferidos no NVAPI R525/R545 e em dois projetos que usam o
// mesmo caminho (Godot, osu!); o ajuste: OGL_CPL_PREFER_DXPRESENT_ID 0x20D690F8, 0 = preferir nativo,
// 1 = preferir em camadas no DXGI, 2 = automático (padrão).
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

static unsafe class NvDrs
{
    public const uint PresentMethodId = 0x20D690F8;
    public const uint PreferLayered = 1, PreferNative = 0, Auto = 2;

    const int OK = 0, SETTING_NOT_FOUND = -160, PROFILE_NOT_FOUND = -163, EXECUTABLE_NOT_FOUND = -166,
        INVALID_USER_PRIVILEGE = -137, ACCESS_DENIED = -175;

    [StructLayout(LayoutKind.Sequential)]
    struct Setting
    {
        public uint version;
        public fixed ushort settingName[2048];
        public uint settingId, settingType, settingLocation, isCurrentPredefined, isPredefinedValid;
        public fixed byte predefined[4100]; // união: u32 / binário (4 + 4096) / texto (2048 wchar)
        public fixed byte current[4100];
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Application // V2
    {
        public uint version, isPredefined;
        public fixed ushort appName[2048];
        public fixed ushort userFriendlyName[2048];
        public fixed ushort launcher[2048];
        public fixed ushort fileInFolder[2048];
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Profile // V1
    {
        public uint version;
        public fixed ushort profileName[2048];
        public uint gpuSupport, isPredefined, numOfApps, numOfSettings;
    }

    static uint Ver<T>(int v) where T : unmanaged => (uint)sizeof(T) | (uint)(v << 16);

    [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr QueryInterface(uint id);

    static IntPtr F(uint id)
    {
        IntPtr p = QueryInterface(id);
        if (p == IntPtr.Zero) throw new Exception($"função 0x{id:X8} do driver da NVIDIA não existe");
        return p;
    }

    static void Copy(ushort* dst, string s)
    {
        int n = Math.Min(s.Length, 2047);
        for (int i = 0; i < n; i++) dst[i] = s[i];
        dst[n] = 0;
    }
    static string Str(ushort* s)
    {
        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < 2048 && s[i] != 0; i++) sb.Append((char)s[i]);
        return sb.ToString();
    }

    sealed class Session : IDisposable
    {
        public IntPtr H;
        public Session()
        {
            int r = ((delegate* unmanaged[Cdecl]<int>)F(0x0150E828))(); // Initialize
            if (r != OK) throw new NvException("iniciar o driver da NVIDIA", r);
            IntPtr h;
            r = ((delegate* unmanaged[Cdecl]<IntPtr*, int>)F(0x0694D52E))(&h); // DRS_CreateSession
            if (r != OK) throw new NvException("abrir as configurações da NVIDIA", r);
            H = h;
            r = ((delegate* unmanaged[Cdecl]<IntPtr, int>)F(0x375DBD6B))(H); // DRS_LoadSettings
            if (r != OK) throw new NvException("ler as configurações da NVIDIA", r);
        }
        public void Dispose()
        {
            if (H != IntPtr.Zero) try { ((delegate* unmanaged[Cdecl]<IntPtr, int>)F(0xDAD9CFF8))(H); } catch { } // DRS_DestroySession
            H = IntPtr.Zero;
        }
    }

    sealed class NvException : Exception
    {
        public readonly int Status;
        public NvException(string what, int status) : base($"não deu para {what} (código {status})") { Status = status; }
    }

    /// Perfil do driver em que o jogo está (0 = o driver não conhece o jogo).
    static IntPtr FindApp(Session s, string exe, out string profileName)
    {
        profileName = "";
        var name = stackalloc ushort[2048];
        Copy(name, exe);
        var app = new Application { version = Ver<Application>(2) };
        IntPtr hp;
        int r = ((delegate* unmanaged[Cdecl]<IntPtr, ushort*, IntPtr*, Application*, int>)F(0xEEE566B2))(s.H, name, &hp, &app); // DRS_FindApplicationByName
        if (r == EXECUTABLE_NOT_FOUND || r == PROFILE_NOT_FOUND) return IntPtr.Zero;
        if (r != OK) throw new NvException("procurar o jogo nas configurações da NVIDIA", r);
        var prof = new Profile { version = Ver<Profile>(1) };
        if (((delegate* unmanaged[Cdecl]<IntPtr, IntPtr, Profile*, int>)F(0x61CD6FD6))(s.H, hp, &prof) == OK) profileName = Str(prof.profileName); // DRS_GetProfileInfo
        return hp;
    }

    /// Valor do ajuste no perfil (null = não está definido nele: vale o padrão, automático).
    static uint? GetValue(Session s, IntPtr hp)
    {
        var st = new Setting { version = Ver<Setting>(1) };
        int r = ((delegate* unmanaged[Cdecl]<IntPtr, IntPtr, uint, Setting*, int>)F(0x73BF8338))(s.H, hp, PresentMethodId, &st); // DRS_GetSetting
        if (r == SETTING_NOT_FOUND) return null;
        if (r != OK) throw new NvException("ler o ajuste do Vulkan", r);
        return *(uint*)st.current;
    }

    public static JsonObject Get(string exe)
    {
        var o = new JsonObject { ["exe"] = exe };
        try
        {
            using var s = new Session();
            IntPtr hp = FindApp(s, exe, out string pn);
            o["nvidia"] = true;
            o["profile"] = hp == IntPtr.Zero ? null : pn;
            uint? v = hp == IntPtr.Zero ? null : GetValue(s, hp);
            o["value"] = v is uint vv ? (int)vv : (int?)null;
            o["layered"] = v == PreferLayered;
        }
        catch (DllNotFoundException) { o["nvidia"] = false; }
        catch (Exception ex) { o["error"] = ex.Message; if (ex is NvException ne) o["status"] = ne.Status; }
        return o;
    }

    /// Põe o ajuste no perfil do jogo (cria "Tela Amigos - <exe>" se o driver não conhece o jogo) e salva.
    public static JsonObject Set(string exe, uint value)
    {
        var o = new JsonObject { ["exe"] = exe, ["value"] = (int)value };
        try
        {
            using var s = new Session();
            o["nvidia"] = true;
            IntPtr hp = FindApp(s, exe, out string pn);
            if (hp == IntPtr.Zero)
            {
                string mine = "Tela Amigos - " + exe;
                var pname = stackalloc ushort[2048];
                Copy(pname, mine);
                IntPtr found;
                if (((delegate* unmanaged[Cdecl]<IntPtr, ushort*, IntPtr*, int>)F(0x7E4A9A0B))(s.H, pname, &found) == OK) hp = found; // DRS_FindProfileByName
                else
                {
                    var prof = new Profile { version = Ver<Profile>(1), gpuSupport = 1 /*geforce*/ };
                    Copy(prof.profileName, mine);
                    int cr = ((delegate* unmanaged[Cdecl]<IntPtr, Profile*, IntPtr*, int>)F(0xCC176068))(s.H, &prof, &hp); // DRS_CreateProfile
                    if (cr != OK) throw new NvException("criar o perfil do jogo", cr);
                }
                var app = new Application { version = Ver<Application>(2) };
                Copy(app.appName, exe);
                Copy(app.userFriendlyName, exe);
                int ar = ((delegate* unmanaged[Cdecl]<IntPtr, IntPtr, Application*, int>)F(0x4347A9DE))(s.H, hp, &app); // DRS_CreateApplication
                if (ar != OK && ar != -167 /*já está noutro perfil*/) throw new NvException("pôr o jogo no perfil", ar);
                pn = mine;
                o["created"] = true;
            }
            o["profile"] = pn;
            o["before"] = GetValue(s, hp) is uint b ? (int)b : (int?)null;
            var st = new Setting { version = Ver<Setting>(1), settingId = PresentMethodId, settingType = 0 /*DWORD*/ };
            *(uint*)st.current = value;
            *(uint*)st.predefined = value;
            int r = ((delegate* unmanaged[Cdecl]<IntPtr, IntPtr, Setting*, int>)F(0x577DD202))(s.H, hp, &st); // DRS_SetSetting
            if (r != OK) throw new NvException("mudar o ajuste do Vulkan", r);
            r = ((delegate* unmanaged[Cdecl]<IntPtr, int>)F(0xFCBC7E14))(s.H); // DRS_SaveSettings
            if (r != OK) throw new NvException("salvar as configurações da NVIDIA", r);
            // confere relendo do zero
            using var s2 = new Session();
            IntPtr hp2 = FindApp(s2, exe, out _);
            uint? after = hp2 == IntPtr.Zero ? null : GetValue(s2, hp2);
            o["after"] = after is uint av ? (int)av : (int?)null;
            o["ok"] = after == value;
        }
        catch (DllNotFoundException) { o["nvidia"] = false; o["ok"] = false; }
        catch (Exception ex)
        {
            o["ok"] = false;
            o["error"] = ex.Message;
            if (ex is NvException ne)
            {
                o["status"] = ne.Status;
                o["needAdmin"] = ne.Status == INVALID_USER_PRIVILEGE || ne.Status == ACCESS_DENIED;
            }
        }
        return o;
    }

    /// Só para os testes: apaga um perfil pelo nome (o de teste que o Set criou).
    public static JsonObject DeleteProfile(string name)
    {
        var o = new JsonObject { ["profile"] = name };
        try
        {
            using var s = new Session();
            var pname = stackalloc ushort[2048];
            Copy(pname, name);
            IntPtr hp;
            int r = ((delegate* unmanaged[Cdecl]<IntPtr, ushort*, IntPtr*, int>)F(0x7E4A9A0B))(s.H, pname, &hp);
            if (r != OK) { o["ok"] = r == PROFILE_NOT_FOUND; o["status"] = r; return o; }
            r = ((delegate* unmanaged[Cdecl]<IntPtr, IntPtr, int>)F(0x17093206))(s.H, hp); // DRS_DeleteProfile
            if (r == OK) r = ((delegate* unmanaged[Cdecl]<IntPtr, int>)F(0xFCBC7E14))(s.H);
            o["ok"] = r == OK; o["status"] = r;
        }
        catch (Exception ex) { o["ok"] = false; o["error"] = ex.Message; }
        return o;
    }
}
