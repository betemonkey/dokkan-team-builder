using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DokkanTeamBuilder;

/// <summary>One window showing the team builder page. The page's server (Node, bundled in
/// the app folder) starts hidden on a free local port and stops when the window closes.</summary>
sealed class MainForm : Form
{
    readonly WebView2 web = new() { Dock = DockStyle.Fill };
    readonly Label status = new()
    {
        Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Color.FromArgb(154, 160, 170), BackColor = Color.FromArgb(17, 19, 23),
        Font = new Font("Segoe UI", 11f), Text = "Starting…",
    };
    Process? server;

    // Box, cache and the window's browser data live in the user's AppData, never next to the exe.
    static readonly string DataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DokkanTeamBuilder");

    public MainForm()
    {
        Text = "Dokkan Team Builder";
        BackColor = Color.FromArgb(17, 19, 23);
        ClientSize = new Size(1180, 900);
        MinimumSize = new Size(420, 500);
        StartPosition = FormStartPosition.CenterScreen;
        using (var s = typeof(MainForm).Assembly.GetManifestResourceStream("DokkanTeamBuilder.app.ico"))
            if (s != null) Icon = new Icon(s);
        Controls.Add(web);
        Controls.Add(status);
        status.BringToFront();
        Load += async (_, _) => await StartAsync();
        FormClosed += (_, _) => StopServer();
    }

    async Task StartAsync()
    {
        try
        {
            Directory.CreateDirectory(DataDir);
            int port = FreePort();
            StartServer(port);
            await WaitForServer(port);

            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
            var core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            // Links that leave the app open in the normal browser.
            core.NewWindowRequested += (_, e) => { e.Handled = true; OpenInBrowser(e.Uri); };
            core.NavigationStarting += (_, e) =>
            {
                if (!e.Uri.StartsWith($"http://127.0.0.1:{port}/", StringComparison.Ordinal)) { e.Cancel = true; OpenInBrowser(e.Uri); }
            };
            core.NavigationCompleted += (_, _) => status.Visible = false;
            core.Navigate($"http://127.0.0.1:{port}/");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Fail("This app needs Microsoft Edge WebView2, which comes with Windows 10/11.\n" +
                 "Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start the app again.");
        }
        catch (Exception ex)
        {
            Fail("Couldn't start: " + ex.Message);
        }
    }

    void Fail(string msg) { status.Text = msg; status.Visible = true; status.BringToFront(); }

    static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    void StartServer(int port)
    {
        string app = Path.Combine(AppContext.BaseDirectory, "app");
        string node = Path.Combine(app, "node.exe");
        if (!File.Exists(node)) node = "node";   // running from source: use the installed Node
        var psi = new ProcessStartInfo(node, $"\"{Path.Combine(app, "server.js")}\"")
        {
            WorkingDirectory = app,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["PORT"] = port.ToString();
        psi.Environment["DOKKAN_DATA"] = DataDir;
        psi.Environment["DOKKAN_PARENT_PID"] = Environment.ProcessId.ToString();
        server = Process.Start(psi) ?? throw new InvalidOperationException("the server didn't start");
        // Keep a short log next to the data, handy if something goes wrong on a friend's PC.
        var log = Path.Combine(DataDir, "server.log");
        File.WriteAllText(log, "");
        server.OutputDataReceived += (_, e) => { if (e.Data != null) try { File.AppendAllText(log, e.Data + "\n"); } catch { } };
        server.ErrorDataReceived += (_, e) => { if (e.Data != null) try { File.AppendAllText(log, e.Data + "\n"); } catch { } };
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
    }

    async Task WaitForServer(int port)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        for (int i = 0; i < 60; i++)
        {
            if (server is { HasExited: true }) throw new InvalidOperationException("the server stopped; see server.log in " + DataDir);
            try { (await http.GetAsync($"http://127.0.0.1:{port}/api/box")).EnsureSuccessStatusCode(); return; }
            catch { await Task.Delay(250); }
        }
        throw new TimeoutException("the server didn't answer in time");
    }

    void StopServer()
    {
        try { if (server is { HasExited: false }) server.Kill(entireProcessTree: true); } catch { }
    }

    static void OpenInBrowser(string uri)
    {
        if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }
}
