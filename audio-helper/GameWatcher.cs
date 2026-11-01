// Detecta "jogando": a janela em primeiro plano ocupa o monitor inteiro (tela cheia exclusiva ou
// sem bordas) e não é o desktop, este app ou uma janela do próprio Windows.
// Manda {"type":"game-state","playing":bool,"exe":"..."} quando muda.
using System.Runtime.InteropServices;
using System.Text;

sealed class GameWatcher : IDisposable
{
    static readonly HashSet<string> Ignore = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer.exe", "searchhost.exe", "shellexperiencehost.exe", "startmenuexperiencehost.exe",
        "lockapp.exe", "textinputhost.exe", "applicationframehost.exe", "dwm.exe", "taskmgr.exe",
    };

    readonly int selfPid;
    volatile bool running = true;
    readonly Thread thread;
    bool? lastPlaying;
    string lastExe = "";

    public GameWatcher(int selfPid)
    {
        this.selfPid = selfPid;
        thread = new Thread(Loop) { IsBackground = true, Name = "game-watch" };
        thread.Start();
    }

    void Loop()
    {
        while (running)
        {
            try
            {
                var (playing, exe) = Check();
                if (playing != lastPlaying || (playing && exe != lastExe))
                {
                    lastPlaying = playing;
                    lastExe = exe;
                    Program.SendJson(new { type = "game-state", playing, exe });
                }
            }
            catch { }
            for (int i = 0; i < 20 && running; i++) Thread.Sleep(100);
        }
    }

    (bool playing, string exe) Check()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) return (false, "");
        GetWindowThreadProcessId(hwnd, out uint pid);
        var map = ProcTree.Snapshot();
        if (ProcTree.IsSelf((int)pid, selfPid, map)) return (false, "");
        string exe = map.TryGetValue((int)pid, out var info) ? info.Exe : "";
        if (Ignore.Contains(exe)) return (false, "");

        // a janela cobre o monitor inteiro?
        if (!GetWindowRect(hwnd, out RECT r)) return (false, "");
        IntPtr mon = MonitorFromWindow(hwnd, 2);
        var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(mon, ref mi)) return (false, "");
        var m = mi.rcMonitor;
        bool covers = r.Left <= m.Left && r.Top <= m.Top && r.Right >= m.Right && r.Bottom >= m.Bottom;
        if (!covers) return (false, "");

        // a "janela" do desktop tem a classe Progman/WorkerW
        var cls = new StringBuilder(64);
        GetClassName(hwnd, cls, cls.Capacity);
        if (cls.ToString() is "Progman" or "WorkerW") return (false, "");
        return (true, exe);
    }

    public void Dispose() { running = false; }

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
}
