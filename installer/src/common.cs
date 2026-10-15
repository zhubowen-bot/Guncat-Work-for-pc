// 安装程序与卸载程序共用的基础设施：
//   资源与 XAML 装载、窗口外壳、快捷方式、注册表、日志、格式化。
//
// 语言版本注意：本文件由 Windows 自带的 csc.exe（.NET 4.8，语言版本 C# 5）编译，
// 所以**不能**用字符串内插、?.、表达式体成员、nameof 等新语法。
// 这不是风格选择，是工具链约束 —— 见 installer/README.md「为什么不用 dotnet SDK」。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace GuncatSetup
{
    /// <summary>嵌入资源（XAML、图标、payload、7za、卸载器）的统一入口。</summary>
    static class Res
    {
        static Assembly Asm()
        {
            return Assembly.GetExecutingAssembly();
        }

        public static Stream Open(string name)
        {
            Stream s = Asm().GetManifestResourceStream(name);
            if (s == null) throw new InvalidOperationException("缺少嵌入资源：" + name);
            return s;
        }

        public static bool Has(string name)
        {
            return Asm().GetManifestResourceStream(name) != null;
        }

        /// <summary>解析一段嵌入的 XAML（不再是 x:Class 编译产物，运行时解析）。</summary>
        public static object LoadXaml(string name)
        {
            using (Stream s = Open(name))
            {
                return XamlReader.Load(s);
            }
        }

        /// <summary>从多尺寸 .ico 里挑最接近目标边长的帧，供窗口/标题栏使用。</summary>
        public static BitmapFrame LoadIconFrame(int want)
        {
            using (Stream s = Open("appicon.ico"))
            {
                BitmapDecoder dec = BitmapDecoder.Create(s, BitmapCreateOptions.PreservePixelFormat,
                                                         BitmapCacheOption.OnLoad);
                BitmapFrame best = dec.Frames[0];
                int bestDiff = int.MaxValue;
                foreach (BitmapFrame f in dec.Frames)
                {
                    int diff = Math.Abs(f.PixelWidth - want);
                    if (diff < bestDiff)
                    {
                        bestDiff = diff;
                        best = f;
                    }
                }
                return best;
            }
        }
    }

    /// <summary>把 theme.xaml 挂到 Application 上，各处 XAML 里的 StaticResource 才有得查。</summary>
    static class Theme
    {
        public static void Install(Application app)
        {
            ResourceDictionary dict = (ResourceDictionary)Res.LoadXaml("ThemeXaml");
            app.Resources.MergedDictionaries.Add(dict);
        }
    }

    /// <summary>显示用的格式化。</summary>
    static class Fmt
    {
        public static string Bytes(double b)
        {
            string[] units = new string[] { "B", "KB", "MB", "GB", "TB" };
            int i = 0;
            while (b >= 1024.0 && i < units.Length - 1)
            {
                b /= 1024.0;
                i++;
            }
            string num = b.ToString(i == 0 ? "0" : (b < 10.0 ? "0.0" : "0"), CultureInfo.InvariantCulture);
            return num + " " + units[i];
        }

        public static string Seconds(double s)
        {
            if (double.IsNaN(s) || double.IsInfinity(s) || s < 0 || s > 86400) return "—";
            int v = (int)Math.Round(s);
            if (v < 60) return v.ToString(CultureInfo.InvariantCulture) + " 秒";
            return (v / 60).ToString(CultureInfo.InvariantCulture) + " 分 " +
                   (v % 60).ToString(CultureInfo.InvariantCulture) + " 秒";
        }
    }

    /// <summary>文件系统相关的小工具。</summary>
    static class Fsx
    {
        /// <summary>递归求目录体积；途中出错就跳过，用于进度显示，不值得因此中断安装。</summary>
        public static long DirSize(string dir)
        {
            long total = 0;
            try
            {
                string[] files = Directory.GetFiles(dir);
                for (int i = 0; i < files.Length; i++)
                {
                    try { total += new FileInfo(files[i]).Length; }
                    catch { }
                }
                string[] dirs = Directory.GetDirectories(dir);
                for (int i = 0; i < dirs.Length; i++) total += DirSize(dirs[i]);
            }
            catch { }
            return total;
        }

        public static long FreeSpace(string dir)
        {
            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(dir));
                return new DriveInfo(root).AvailableFreeSpace;
            }
            catch { return -1; }
        }

        public static void TryDeleteDir(string dir)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
            }
            catch { }
        }

        /// <summary>把流写成文件（用于把嵌入的 payload / 7za 释放到临时目录）。</summary>
        public static void CopyStream(Stream src, string dest)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None,
                                                  1024 * 512))
            {
                byte[] buf = new byte[1024 * 512];
                int n;
                while ((n = src.Read(buf, 0, buf.Length)) > 0) fs.Write(buf, 0, n);
            }
        }

        public static void CopyDir(string from, string to)
        {
            Directory.CreateDirectory(to);
            string[] files = Directory.GetFiles(from);
            for (int i = 0; i < files.Length; i++)
            {
                File.Copy(files[i], Path.Combine(to, Path.GetFileName(files[i])), true);
            }
            string[] dirs = Directory.GetDirectories(from);
            for (int i = 0; i < dirs.Length; i++)
            {
                CopyDir(dirs[i], Path.Combine(to, Path.GetFileName(dirs[i])));
            }
        }
    }

    /// <summary>快捷方式：走 WScript.Shell，省掉一整段 IShellLink COM 接口声明。</summary>
    static class Shortcuts
    {
        public static void Create(string lnkPath, string target, string args, string workDir, string iconPath,
                                  string description)
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) throw new InvalidOperationException("系统里没有 WScript.Shell，无法创建快捷方式");
            dynamic shell = Activator.CreateInstance(t);
            dynamic lnk = shell.CreateShortcut(lnkPath);
            lnk.TargetPath = target;
            lnk.Arguments = args == null ? "" : args;
            lnk.WorkingDirectory = workDir == null ? "" : workDir;
            if (iconPath != null) lnk.IconLocation = iconPath;
            if (description != null) lnk.Description = description;
            lnk.Save();
        }

        public static string DesktopDir()
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        }

        public static string StartMenuDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Guncat Work");
        }
    }

    /// <summary>只写 HKCU —— 安装是「当前用户」级的，不该要管理员权限。</summary>
    static class Reg
    {
        public const string UninstallKey =
            @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Guncat Work";

        public const string CompatLayersKey =
            @"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";

        public static void SetString(string subKey, string name, string value)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(subKey))
            {
                k.SetValue(name, value, RegistryValueKind.String);
            }
        }

        public static void SetDword(string subKey, string name, int value)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(subKey))
            {
                k.SetValue(name, value, RegistryValueKind.DWord);
            }
        }

        public static void DeleteTree(string subKey)
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(subKey, false); }
            catch { }
        }

        public static void DeleteValue(string subKey, string name)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(subKey, true))
                {
                    if (k != null) k.DeleteValue(name, false);
                }
            }
            catch { }
        }

        public static string GetString(string subKey, string name)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(subKey))
                {
                    if (k == null) return null;
                    object v = k.GetValue(name);
                    return v == null ? null : v.ToString();
                }
            }
            catch { return null; }
        }
    }

    /// <summary>
    /// 安装/卸载过程的日志。GUI 程序没有控制台，静默安装更是什么都看不见 ——
    /// 出问题时这个文件是唯一的线索，所以从第一行就开始写。
    /// </summary>
    static class Logr
    {
        static readonly object gate = new object();
        static string path;

        public static string Path_
        {
            get
            {
                if (path == null)
                {
                    path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "Guncat-Work-Setup.log");
                }
                return path;
            }
        }

        public static void Write(string message)
        {
            lock (gate)
            {
                try
                {
                    File.AppendAllText(Path_,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) +
                        "  " + message + "\r\n", Encoding.UTF8);
                }
                catch { }
            }
        }

        public static void Reset()
        {
            lock (gate)
            {
                try { File.WriteAllText(Path_, "", Encoding.UTF8); }
                catch { }
            }
        }
    }

    /// <summary>
    /// 窗口外壳：无边框 + 透明 + 圆角，标题栏自绘。
    /// 页面内容由调用方塞进 Host，品牌栏文字由调用方改写。
    /// </summary>
    class ShellWindow
    {
        public Window Win;
        public FrameworkElement Shell;
        public ContentControl Host;
        public Grid TitleBar;
        public Border BrandPanel;
        public ColumnDefinition BrandColumn;
        public Border BrandIcon;
        public Border TitleIcon;
        public TextBlock BrandName;
        public TextBlock BrandTagline;
        public TextBlock BrandVersion;
        public TextBlock TitleText;
        public Button BtnClose;
        public Button BtnMinimize;
        readonly double shadow = 18.0;

        public ShellWindow(bool compact)
        {
            Shell = (FrameworkElement)Res.LoadXaml("ShellXaml");
            Host = (ContentControl)Shell.FindName("PageHost");
            TitleBar = (Grid)Shell.FindName("TitleBar");
            BrandPanel = (Border)Shell.FindName("BrandPanel");
            BrandColumn = (ColumnDefinition)Shell.FindName("BrandColumn");
            BrandIcon = (Border)Shell.FindName("BrandIcon");
            TitleIcon = (Border)Shell.FindName("TitleIcon");
            BrandName = (TextBlock)Shell.FindName("BrandName");
            BrandTagline = (TextBlock)Shell.FindName("BrandTagline");
            BrandVersion = (TextBlock)Shell.FindName("BrandVersion");
            TitleText = (TextBlock)Shell.FindName("TitleText");
            BtnClose = (Button)Shell.FindName("BtnClose");
            BtnMinimize = (Button)Shell.FindName("BtnMinimize");

            // 两个图标用同一张图：品牌栏大图 + 标题栏小图
            BitmapFrame big = Res.LoadIconFrame(256);
            ImageBrush bigBrush = new ImageBrush(big);
            bigBrush.Stretch = Stretch.UniformToFill;
            BrandIcon.Background = bigBrush;

            BitmapFrame small = Res.LoadIconFrame(48);
            ImageBrush smallBrush = new ImageBrush(small);
            smallBrush.Stretch = Stretch.UniformToFill;
            TitleIcon.Background = smallBrush;

            if (compact)
            {
                // 卸载程序的窗口小一号：品牌栏窄一点，底部那三条产品说明也去掉
                BrandColumn.Width = new GridLength(240);
                Shell.Width = 740;
                Shell.Height = 486;
                StackPanel notes = (StackPanel)Shell.FindName("BrandNotes");
                if (notes != null) notes.Visibility = Visibility.Collapsed;
            }

            BtnClose.Click += delegate { OnCloseRequested(); };
            BtnMinimize.Click += delegate { Win.WindowState = WindowState.Minimized; };
            TitleBar.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed) Win.DragMove();
            };
            BrandPanel.MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed) Win.DragMove();
            };

            Grid root = new Grid();
            root.Margin = new Thickness(shadow);
            root.Children.Add(Shell);

            Win = new Window();
            Win.WindowStyle = WindowStyle.None;
            Win.AllowsTransparency = true;
            Win.Background = Brushes.Transparent;
            Win.ResizeMode = ResizeMode.NoResize;
            Win.ShowInTaskbar = true;
            Win.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Win.Width = Shell.Width + shadow * 2;
            Win.Height = Shell.Height + shadow * 2;
            Win.Content = root;
            try { Win.Icon = Res.LoadIconFrame(48); }
            catch { }
        }

        /// <summary>关闭请求：先问一次是否真的要走（安装中不该被误关）。</summary>
        public Func<bool> ConfirmClose { get; set; }

        void OnCloseRequested()
        {
            if (ConfirmClose != null && !ConfirmClose()) return;
            Win.Close();
        }
    }
}
