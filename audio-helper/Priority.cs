using System.Diagnostics;
using System.Runtime.InteropServices;

// Com um jogo pesado aberto, o Windows dá quase toda a placa de vídeo para ele e o app
// (decodificar e desenhar as telas dos amigos, codificar a própria) fica esperando a vez.
// Aqui sobe a prioridade de GPU dos processos do app (sem privilégio de administrador:
// tenta "alta" e cai para "acima do normal"). A prioridade de CPU o processo principal já ajusta.
static class Priority
{
    // D3DKMT_SCHEDULINGPRIORITYCLASS: 0 idle, 1 abaixo do normal, 2 normal, 3 acima do normal, 4 alta, 5 tempo real
    [DllImport("gdi32.dll")] static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr hProcess, int priority);
    [DllImport("gdi32.dll")] static extern int D3DKMTGetProcessSchedulingPriorityClass(IntPtr hProcess, out int priority);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    const uint PROCESS_SET_INFORMATION = 0x0200, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    // devolve a prioridade de GPU conseguida para cada processo (-1 = falhou)
    public static Dictionary<int, int> Boost(IEnumerable<int> pids, bool high)
    {
        var result = new Dictionary<int, int>();
        foreach (var pid in pids.Append(Environment.ProcessId).Distinct())
        {
            var h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) { result[pid] = -1; continue; }
            try
            {
                int got = -1;
                if (high && D3DKMTSetProcessSchedulingPriorityClass(h, 4) == 0) got = 4;
                else if (D3DKMTSetProcessSchedulingPriorityClass(h, high ? 3 : 2) == 0) got = high ? 3 : 2;
                result[pid] = got;
            }
            finally { CloseHandle(h); }
        }
        // o próprio helper (captura + codificação da sua tela) também fica acima do normal na CPU
        try { Process.GetCurrentProcess().PriorityClass = high ? ProcessPriorityClass.AboveNormal : ProcessPriorityClass.Normal; } catch { }
        return result;
    }
}

// Tecla de mídia (play/pausa) no PC de quem transmite: o Windows manda para o player ativo
// (YouTube no navegador, Spotify, VLC...). Usado no "assistir junto", só com permissão.
static class MediaKeys
{
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    const uint EXTENDED = 0x1, KEYUP = 0x2;

    public static void Press(string key)
    {
        byte vk = key switch { "next" => 0xB0, "prev" => 0xB1, "stop" => 0xB2, _ => 0xB3 }; // 0xB3 = play/pausa
        keybd_event(vk, 0, EXTENDED, UIntPtr.Zero);
        keybd_event(vk, 0, EXTENDED | KEYUP, UIntPtr.Zero);
    }
}
