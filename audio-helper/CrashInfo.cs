// O que o Windows anotou quando um processo do auxiliar caiu: o registro de "Erro de Aplicativo" (evento 1000: qual
// peça falhou, o código da exceção e onde) e o do .NET (evento 1026: a exceção e a pilha). Antes a queda aparecia no
// diagnóstico só como "AudioHelper fechou (código 3221225477)", sem nenhuma pista (o Doge, 2026-11-26: o auxiliar caía
// 2 s depois de refazer a captura pelo outro método com o RDR2 aberto).
// Lê com o wevtutil do próprio Windows (o registro "Aplicativo" qualquer usuário pode ler; não precisa de administrador).
using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Xml.Linq;

static class CrashInfo
{
    const string ExeName = "AudioHelper.exe";

    /// Tenta algumas vezes: o Windows leva um instante para escrever o registro depois da queda.
    public static JsonObject? FindWithRetry(int pid, DateTime sinceUtc, int maxWaitMs)
    {
        var sw = Stopwatch.StartNew();
        Thread.Sleep(1200);
        while (true)
        {
            var r = Find(pid, sinceUtc);
            if (r != null && r.ContainsKey("module")) return r; // o 1000 (que diz a peça) às vezes vem depois do 1026
            if (sw.ElapsedMilliseconds > maxWaitMs) return r;
            Thread.Sleep(1500);
        }
    }

    /// pid 0 = qualquer queda do auxiliar desde sinceUtc.
    public static JsonObject? Find(int pid, DateTime sinceUtc)
    {
        string since = sinceUtc.AddSeconds(-5).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        string xml = Wevtutil($"*[System[(EventID=1000 or EventID=1026) and TimeCreated[@SystemTime>='{since}']]]");
        if (xml.Length == 0) return null;
        return Parse(xml, pid);
    }

    static string Wevtutil(string query)
    {
        try
        {
            var psi = new ProcessStartInfo("wevtutil.exe")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
            };
            foreach (var a in new[] { "qe", "Application", "/q:" + query, "/f:xml", "/c:40", "/rd:true" }) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi);
            if (p == null) return "";
            var outTask = p.StandardOutput.ReadToEndAsync();
            _ = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(8000)) { try { p.Kill(); } catch { } return ""; }
            return outTask.Result;
        }
        catch { return ""; }
    }

    /// (público para o teste: AudioHelper.exe --crash-info-parse lê um XML do wevtutil pela entrada)
    public static JsonObject? Parse(string xml, int pid)
    {
        XElement root;
        try { root = XElement.Parse("<r>" + xml + "</r>"); }
        catch { return null; }
        XNamespace ns = "http://schemas.microsoft.com/win/2004/08/events/event";
        JsonObject? result = null;
        foreach (var ev in root.Elements(ns + "Event"))
        {
            var sys = ev.Element(ns + "System");
            if (sys == null) continue;
            string id = sys.Element(ns + "EventID")?.Value ?? "";
            string time = sys.Element(ns + "TimeCreated")?.Attribute("SystemTime")?.Value ?? "";
            var data = ev.Element(ns + "EventData")?.Elements(ns + "Data").ToList() ?? new List<XElement>();
            string D(string name, int index)
            {
                var byName = data.FirstOrDefault(x => (string?)x.Attribute("Name") == name);
                if (byName != null) return byName.Value;
                return index < data.Count && data[index].Attribute("Name") == null ? data[index].Value : "";
            }
            if (id == "1000")
            {
                if (!string.Equals(D("AppName", 0), ExeName, StringComparison.OrdinalIgnoreCase)) continue;
                if (pid != 0 && ParsePid(D("ProcessId", 8)) != pid) continue;
                result ??= new JsonObject();
                if (result.ContainsKey("module")) continue; // (o mais novo vem primeiro)
                result["time"] = time;
                result["module"] = D("ModuleName", 3);
                result["moduleVersion"] = D("ModuleVersion", 4);
                result["exception"] = Hex(D("ExceptionCode", 6));
                result["offset"] = Hex(D("FaultingOffset", 7));
                string mp = D("ModulePath", 11);
                // (só a pasta do sistema/driver: nada do nome de usuário)
                if (mp.Length > 0 && !mp.Contains(@"\Users\", StringComparison.OrdinalIgnoreCase)) result["modulePath"] = mp;
            }
            else if (id == "1026")
            {
                string text = data.Count > 0 ? data[0].Value : "";
                if (!text.Contains(ExeName, StringComparison.OrdinalIgnoreCase)) continue;
                int epid = int.TryParse(sys.Element(ns + "Execution")?.Attribute("ProcessID")?.Value, out var e) ? e : 0;
                if (pid != 0 && epid != 0 && epid != pid) continue;
                result ??= new JsonObject();
                if (result.ContainsKey("dotnet")) continue;
                result["time"] ??= time;
                var lines = text.Replace("\r", "").Split('\n')
                    .Where(l => !l.StartsWith("Application:") && !l.StartsWith("CoreCLR Version") && !l.StartsWith(".NET Version") && l.Trim().Length > 0)
                    .Take(28)
                    .Select(l => l.Length > 240 ? l[..240] : l)
                    // (pastas de usuário na pilha viram "...")
                    .Select(l => System.Text.RegularExpressions.Regex.Replace(l, @"[A-Za-z]:\\Users\\[^\\]+", "..."));
                result["dotnet"] = string.Join("\n", lines);
            }
        }
        return result;
    }

    static int ParsePid(string s)
    {
        s = s.Trim();
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return int.TryParse(s[2..], System.Globalization.NumberStyles.HexNumber, null, out var h) ? h : -1;
        return int.TryParse(s, out var d) ? d : -1;
    }

    static string Hex(string s) => s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || s.Length == 0 ? s : "0x" + s;
}
