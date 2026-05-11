using System.Diagnostics;
using System.Text;
using System.Text.Json;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;

var parsedArgs = CliArgs.Parse(args);
if (parsedArgs.ShowHelp)
{
    CliArgs.PrintUsage();
    return 0;
}

var stopwatch = Stopwatch.StartNew();
try
{
    var result = UabeaPatchPrototype.Patch(parsedArgs);
    Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions.Pretty));
    return result.Ok ? 0 : 1;
}
catch (Exception error)
{
    var result = new PatchResult(false, error.Message, stopwatch.ElapsedMilliseconds, []);
    Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions.Pretty));
    return 1;
}

static class UabeaPatchPrototype
{
    public static PatchResult Patch(CliArgs args)
    {
        var totalTimer = Stopwatch.StartNew();
        var timings = new List<TimingEntry>();
        var changed = new List<ChangedAsset>();
        var jobs = ReadJobs(args.JobManifest);
        var replacements = ReplacementIndex.FromJobs(jobs);

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args.Output)) ?? ".");

        var manager = new AssetsManager();
        var loadTimer = Stopwatch.StartNew();
        var bundleInstance = manager.LoadBundleFile(args.Input, true);
        var bundle = bundleInstance.file;
        var assetsFileIndex = 0;
        var assetsFileInstance = manager.LoadAssetsFileFromBundle(bundleInstance, assetsFileIndex, false);
        var assetsFile = assetsFileInstance.file;
        timings.Add(TimingEntry.From("load_bundle", loadTimer));

        var patchTimer = Stopwatch.StartNew();
        PatchTextAssets(manager, assetsFileInstance, assetsFile, replacements.Text, changed);
        PatchTextures(manager, assetsFileInstance, assetsFile, replacements.Textures, changed);
        timings.Add(TimingEntry.From("patch_assets", patchTimer));

        var missing = replacements.FindMissing(changed);
        if (missing.Count > 0)
        {
            return new PatchResult(false, "Target asset(s) not found.", totalTimer.ElapsedMilliseconds, timings, changed, missing);
        }

        var writeTimer = Stopwatch.StartNew();
        bundle.BlockAndDirInfo.DirectoryInfos[assetsFileIndex].SetNewData(assetsFile);
        WriteBundle(bundle, args.Output, args.Compression);
        timings.Add(TimingEntry.From("write_bundle", writeTimer));

        manager.UnloadAll();
        timings.Add(TimingEntry.From("total", totalTimer));

        return new PatchResult(true, null, totalTimer.ElapsedMilliseconds, timings, changed);
    }

    private static List<PatchJob> ReadJobs(string manifestPath)
    {
        var manifest = JsonSerializer.Deserialize<PatchManifest>(File.ReadAllText(manifestPath), JsonOptions.CaseInsensitive);
        return manifest?.Jobs ?? [];
    }

    private static void PatchTextAssets(
        AssetsManager manager,
        AssetsFileInstance assetsFileInstance,
        AssetsFile assetsFile,
        Dictionary<string, Replacement> replacements,
        List<ChangedAsset> changed)
    {
        foreach (var assetInfo in assetsFile.GetAssetsOfType(AssetClassID.TextAsset))
        {
            var baseField = manager.GetBaseField(assetsFileInstance, assetInfo);
            var assetName = baseField["m_Name"].AsString;
            if (!replacements.TryGetValue(assetName.ToLowerInvariant(), out var replacement))
            {
                continue;
            }

            BackupTextAsset(replacement, baseField, assetName);
            var scriptField = baseField["m_Script"];
            scriptField.AsByteArray = File.ReadAllBytes(replacement.Path);
            assetInfo.SetNewData(baseField);
            changed.Add(new ChangedAsset(replacement.ModName, "TextAsset", assetName, replacement.Action, replacement.Path, replacement.AssetBackupPath(assetName)));
        }
    }

    private static void PatchTextures(
        AssetsManager manager,
        AssetsFileInstance assetsFileInstance,
        AssetsFile assetsFile,
        Dictionary<string, Replacement> replacements,
        List<ChangedAsset> changed)
    {
        foreach (var assetInfo in assetsFile.GetAssetsOfType(AssetClassID.Texture2D))
        {
            var baseField = manager.GetBaseField(assetsFileInstance, assetInfo);
            var assetName = baseField["m_Name"].AsString;
            if (!replacements.TryGetValue(assetName.ToLowerInvariant(), out var replacement))
            {
                continue;
            }

            BackupTexture(replacement, assetsFileInstance, baseField, assetName);
            var texture = TextureFile.ReadTextureFile(baseField);
            try
            {
                if (!CanEncodeNativeFormat(texture.m_TextureFormat))
                {
                    texture.m_TextureFormat = (int)TextureFormat.RGBA32;
                }
                texture.EncodeTextureImage(replacement.Path, replacement.EncodeQuality);
                texture.WriteTo(baseField);
            }
            catch (Exception error)
            {
                var format = Enum.IsDefined(typeof(TextureFormat), texture.m_TextureFormat)
                    ? ((TextureFormat)texture.m_TextureFormat).ToString()
                    : texture.m_TextureFormat.ToString();
                throw new InvalidOperationException($"Texture2D replacement failed for {assetName} ({format}) from {replacement.Path}: {error.Message}", error);
            }
            assetInfo.SetNewData(baseField);
            changed.Add(new ChangedAsset(replacement.ModName, "Texture2D", assetName, replacement.Action, replacement.Path, replacement.AssetBackupPath(assetName)));
        }
    }

    private static bool CanEncodeNativeFormat(int textureFormat)
    {
        return Enum.IsDefined(typeof(TextureFormat), textureFormat) &&
            (TextureFormat)textureFormat is
                TextureFormat.Alpha8 or
                TextureFormat.ARGB4444 or
                TextureFormat.RGB24 or
                TextureFormat.RGBA32 or
                TextureFormat.ARGB32 or
                TextureFormat.RGB565 or
                TextureFormat.R16 or
                TextureFormat.RGBA4444 or
                TextureFormat.BGRA32 or
                TextureFormat.RHalf or
                TextureFormat.RGHalf or
                TextureFormat.RGBAHalf or
                TextureFormat.RFloat or
                TextureFormat.RGFloat or
                TextureFormat.RGBAFloat or
                TextureFormat.RG16;
    }

    private static void BackupTextAsset(Replacement replacement, AssetTypeValueField baseField, string assetName)
    {
        var backupPath = replacement.AssetBackupPath(assetName);
        if (backupPath is null || File.Exists(backupPath))
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(backupPath)!);
        var scriptField = baseField["m_Script"];
        File.WriteAllBytes(backupPath, scriptField.AsByteArray);
    }

    private static void BackupTexture(Replacement replacement, AssetsFileInstance assetsFileInstance, AssetTypeValueField baseField, string assetName)
    {
        var backupPath = replacement.AssetBackupPath(assetName);
        if (backupPath is null || File.Exists(backupPath))
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(backupPath)!);
        var texture = TextureFile.ReadTextureFile(baseField);
        var textureData = texture.FillPictureData(assetsFileInstance);
        texture.DecodeTextureImage(textureData, backupPath, ImageExportType.Png);
    }

    private static void WriteBundle(AssetBundleFile bundle, string outputPath, string compression)
    {
        if (compression.Equals("none", StringComparison.OrdinalIgnoreCase))
        {
            using var writer = new AssetsFileWriter(outputPath);
            bundle.Write(writer);
            return;
        }

        var uncompressedPath = $"{outputPath}.uncompressed";
        using (var writer = new AssetsFileWriter(uncompressedPath))
        {
            bundle.Write(writer);
        }

        using (var writer = new AssetsFileWriter(outputPath))
        {
            var newBundle = new AssetBundleFile();
            newBundle.Read(new AssetsFileReader(File.OpenRead(uncompressedPath)));
            newBundle.Pack(writer, AssetBundleCompressionType.LZ4);
            newBundle.Close();
        }

        File.Delete(uncompressedPath);
    }
}

sealed record PatchManifest(List<PatchJob> Jobs);

sealed record PatchJob(
    string ModName,
    List<string>? Atlases,
    List<string>? Skels,
    List<string>? Pngs,
    string? AssetBackupDir);

sealed record ChangedAsset(
    string? ModName,
    string Type,
    string Name,
    string Action,
    string Source,
    string? AssetBackup);

sealed record MissingAsset(string Type, string Name, string Source, string? ModName);

sealed record TimingEntry(string Name, long Ms)
{
    public static TimingEntry From(string name, Stopwatch stopwatch) => new(name, stopwatch.ElapsedMilliseconds);
}

sealed record PatchResult(
    bool Ok,
    string? Error,
    long ElapsedMs,
    List<TimingEntry> Timings,
    List<ChangedAsset>? Changed = null,
    List<MissingAsset>? Missing = null);

sealed class ReplacementIndex
{
    public Dictionary<string, Replacement> Text { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, Replacement> Textures { get; } = new(StringComparer.OrdinalIgnoreCase);

    public static ReplacementIndex FromJobs(IEnumerable<PatchJob> jobs)
    {
        var index = new ReplacementIndex();
        foreach (var job in jobs)
        {
            foreach (var atlas in job.Atlases ?? [])
            {
                index.Add(index.Text, Path.GetFileName(atlas), new Replacement(job.ModName, atlas, "replace_atlas", job.AssetBackupDir));
            }

            foreach (var skel in job.Skels ?? [])
            {
                index.Add(index.Text, Path.GetFileName(skel), new Replacement(job.ModName, skel, "replace_skel", job.AssetBackupDir));
            }

            foreach (var png in job.Pngs ?? [])
            {
                index.Add(index.Textures, Path.GetFileNameWithoutExtension(png), new Replacement(job.ModName, png, "replace_texture", job.AssetBackupDir));
            }
        }

        return index;
    }

    public List<MissingAsset> FindMissing(List<ChangedAsset> changed)
    {
        var changedKeys = new HashSet<string>(changed.Select(item => $"{item.Type}:{item.Name}".ToLowerInvariant()));
        var missing = new List<MissingAsset>();

        foreach (var (name, replacement) in Text)
        {
            if (!changedKeys.Contains($"textasset:{name}".ToLowerInvariant()))
            {
                missing.Add(new MissingAsset("TextAsset", name, replacement.Path, replacement.ModName));
            }
        }

        foreach (var (name, replacement) in Textures)
        {
            if (!changedKeys.Contains($"texture2d:{name}".ToLowerInvariant()))
            {
                missing.Add(new MissingAsset("Texture2D", name, replacement.Path, replacement.ModName));
            }
        }

        return missing;
    }

    private void Add(Dictionary<string, Replacement> group, string key, Replacement replacement)
    {
        if (group.ContainsKey(key))
        {
            throw new InvalidOperationException($"Duplicate replacement target in one batch: {key}");
        }

        if (!File.Exists(replacement.Path))
        {
            throw new FileNotFoundException(replacement.Path);
        }

        group[key] = replacement;
    }
}

sealed record Replacement(string? ModName, string Path, string Action, string? AssetBackupDir)
{
    public int EncodeQuality => 3;

    public string? AssetBackupPath(string assetName)
    {
        if (string.IsNullOrWhiteSpace(AssetBackupDir))
        {
            return null;
        }

        var extension = System.IO.Path.GetExtension(Path);
        var fileName = extension.Equals(".png", StringComparison.OrdinalIgnoreCase)
            ? $"{assetName}.png"
            : System.IO.Path.GetFileName(Path);
        return System.IO.Path.Combine(AssetBackupDir, fileName);
    }
}

sealed class CliArgs
{
    public string Input { get; private init; } = "";
    public string Output { get; private init; } = "";
    public string JobManifest { get; private init; } = "";
    public string Compression { get; private init; } = "lz4";
    public bool ShowHelp { get; private init; }

    public static CliArgs Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            if (arg is "--help" or "-h")
            {
                return new CliArgs { ShowHelp = true };
            }

            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            if (index + 1 >= args.Length)
            {
                throw new ArgumentException($"Missing value for {arg}");
            }

            values[arg[2..]] = args[++index];
        }

        var parsed = new CliArgs
        {
            Input = Required(values, "input"),
            Output = Required(values, "output"),
            JobManifest = Required(values, "job-manifest"),
            Compression = values.TryGetValue("compression", out var compression) ? compression : "lz4"
        };

        if (parsed.Compression is not ("lz4" or "none"))
        {
            throw new ArgumentException("--compression must be lz4 or none");
        }

        return parsed;
    }

    public static void PrintUsage()
    {
        Console.WriteLine("UabeaPatchPrototype --input __data --output patched.__data --job-manifest __data.patch-jobs.json [--compression lz4|none]");
    }

    private static string Required(Dictionary<string, string> values, string key)
    {
        if (!values.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"Missing --{key}");
        }

        return value;
    }
}

static class JsonOptions
{
    public static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static readonly JsonSerializerOptions CaseInsensitive = new() { PropertyNameCaseInsensitive = true };
}
