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
    if (parsedArgs.Mode.Equals("scan", StringComparison.OrdinalIgnoreCase))
    {
        var result = UabeaPatchPrototype.Scan(parsedArgs);
        Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions.Pretty));
        return result.Ok ? 0 : 1;
    }
    else if (parsedArgs.Mode.Equals("inspect", StringComparison.OrdinalIgnoreCase))
    {
        var result = UabeaPatchPrototype.Inspect(parsedArgs);
        Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions.Pretty));
        return result.Ok ? 0 : 1;
    }
    else
    {
        var result = UabeaPatchPrototype.Patch(parsedArgs);
        Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions.Pretty));
        return result.Ok ? 0 : 1;
    }
}
catch (Exception error)
{
    if (parsedArgs.Mode.Equals("scan", StringComparison.OrdinalIgnoreCase))
    {
        Console.WriteLine(JsonSerializer.Serialize(new ScanResult(false, error.Message, stopwatch.ElapsedMilliseconds, []), JsonOptions.Pretty));
    }
    else if (parsedArgs.Mode.Equals("inspect", StringComparison.OrdinalIgnoreCase))
    {
        Console.WriteLine(JsonSerializer.Serialize(new InspectResult(false, error.Message, stopwatch.ElapsedMilliseconds, [], [], [], [], []), JsonOptions.Pretty));
    }
    else
    {
        Console.WriteLine(JsonSerializer.Serialize(new PatchResult(false, error.Message, stopwatch.ElapsedMilliseconds, []), JsonOptions.Pretty));
    }
    return 1;
}

static class UabeaPatchPrototype
{
    private static readonly System.Text.RegularExpressions.Regex CandidatePattern = new(
        @"(?:cutscene_char\d+|char\d+|illust_dating[\w\d_]*)",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    public static ScanResult Scan(CliArgs args)
    {
        var totalTimer = Stopwatch.StartNew();
        var timings = new List<TimingEntry>();
        var assets = new List<ScannedAsset>();
        var skipped = 0;

        var manager = new AssetsManager();
        var loadTimer = Stopwatch.StartNew();
        var bundleInstance = manager.LoadBundleFile(args.Input, true);
        var assetsFileInstance = manager.LoadAssetsFileFromBundle(bundleInstance, 0, false);
        var assetsFile = assetsFileInstance.file;
        timings.Add(TimingEntry.From("load_bundle", loadTimer));

        var scanTimer = Stopwatch.StartNew();
        ScanTextAssets(manager, assetsFileInstance, assetsFile, assets, ref skipped);
        ScanTextures(manager, assetsFileInstance, assetsFile, assets, ref skipped);
        timings.Add(TimingEntry.From("scan_assets", scanTimer));

        manager.UnloadAll();
        assets.Sort((a, b) =>
            string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase) is var nameCompare && nameCompare != 0
                ? nameCompare
                : string.Compare(a.Type, b.Type, StringComparison.OrdinalIgnoreCase));
        timings.Add(TimingEntry.From("total", totalTimer));

        return new ScanResult(true, null, totalTimer.ElapsedMilliseconds, assets, skipped, timings);
    }

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
        var insertedTextures = InsertTextures(manager, assetsFileInstance, assetsFile, replacements.InsertTextures, changed);
        InsertMaterialsForTextures(manager, assetsFileInstance, assetsFile, insertedTextures, changed);
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

    public static InspectResult Inspect(CliArgs args)
    {
        var totalTimer = Stopwatch.StartNew();
        var manager = new AssetsManager();
        var bundleInstance = manager.LoadBundleFile(args.Input, true);
        var assetsFileInstance = manager.LoadAssetsFileFromBundle(bundleInstance, 0, false);
        var assetsFile = assetsFileInstance.file;
        var target = args.Target?.Trim() ?? "";
        var assets = new List<InspectAsset>();
        var allAssets = new List<InspectAsset>();
        var containers = new List<InspectContainerEntry>();
        var preload = new List<InspectPPtr>();
        var references = new List<InspectReference>();
        var directories = bundleInstance.file.BlockAndDirInfo.DirectoryInfos
            .Select((entry, index) => new InspectDirectory(index, entry.Name, entry.Offset, entry.DecompressedSize))
            .ToList();

        foreach (var assetInfo in assetsFile.AssetInfos)
        {
            var typeName = GetTypeName(assetInfo, assetsFile);
            var name = TryGetAssetName(manager, assetsFileInstance, assetInfo);
            var asset = ReadInspectAsset(manager, assetsFileInstance, assetsFile, assetInfo, typeName, name);
            allAssets.Add(asset);
            if (target.Length > 0 && !name.Contains(target, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            assets.Add(asset);
        }

        var assetNameByPathId = allAssets.ToDictionary(asset => asset.PathId, asset => asset.Name);

        foreach (var assetInfo in assetsFile.GetAssetsOfType(AssetClassID.AssetBundle).Concat(assetsFile.GetAssetsOfType(AssetClassID.ResourceManager)))
        {
            var ownerName = TryGetAssetName(manager, assetsFileInstance, assetInfo);
            var ownerType = GetTypeName(assetInfo, assetsFile);
            var baseField = manager.GetBaseField(assetsFileInstance, assetInfo);
            AddContainerEntries(baseField, ownerType, ownerName, target, containers);
            AddPreloadEntries(baseField, ownerType, ownerName, preload);
        }

        foreach (var assetInfo in assetsFile.AssetInfos)
        {
            var ownerName = TryGetAssetName(manager, assetsFileInstance, assetInfo);
            if (target.Length > 0 && !ownerName.Contains(target, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var ownerType = GetTypeName(assetInfo, assetsFile);
            var baseField = manager.GetBaseField(assetsFileInstance, assetInfo);
            AddReferences(baseField, ownerType, ownerName, "", assetNameByPathId, references);
        }

        manager.UnloadAll();
        return new InspectResult(true, null, totalTimer.ElapsedMilliseconds, assets, containers, preload, directories, references);
    }

    private static void ScanTextAssets(
        AssetsManager manager,
        AssetsFileInstance assetsFileInstance,
        AssetsFile assetsFile,
        List<ScannedAsset> assets,
        ref int skipped)
    {
        foreach (var assetInfo in assetsFile.GetAssetsOfType(AssetClassID.TextAsset))
        {
            try
            {
                var baseField = manager.GetBaseField(assetsFileInstance, assetInfo);
                var assetName = baseField["m_Name"].AsString;
                if (!CandidatePattern.IsMatch(assetName))
                {
                    continue;
                }

                assets.Add(new ScannedAsset(assetName, "TextAsset", assetInfo.PathId));
            }
            catch
            {
                skipped += 1;
            }
        }
    }

    private static void ScanTextures(
        AssetsManager manager,
        AssetsFileInstance assetsFileInstance,
        AssetsFile assetsFile,
        List<ScannedAsset> assets,
        ref int skipped)
    {
        foreach (var assetInfo in assetsFile.GetAssetsOfType(AssetClassID.Texture2D))
        {
            try
            {
                var baseField = manager.GetBaseField(assetsFileInstance, assetInfo);
                var assetName = baseField["m_Name"].AsString;
                if (!CandidatePattern.IsMatch(assetName))
                {
                    continue;
                }

                assets.Add(new ScannedAsset(
                    assetName,
                    "Texture2D",
                    assetInfo.PathId,
                    baseField["m_Width"].AsInt,
                    baseField["m_Height"].AsInt));
            }
            catch
            {
                skipped += 1;
            }
        }
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

    private static List<InsertedTexture> InsertTextures(
        AssetsManager manager,
        AssetsFileInstance assetsFileInstance,
        AssetsFile assetsFile,
        Dictionary<string, Replacement> replacements,
        List<ChangedAsset> changed)
    {
        var inserted = new List<InsertedTexture>();
        if (replacements.Count == 0)
        {
            return inserted;
        }

        var existingTextureNames = new HashSet<string>(
            assetsFile.GetAssetsOfType(AssetClassID.Texture2D)
                .Select(assetInfo => manager.GetBaseField(assetsFileInstance, assetInfo)["m_Name"].AsString),
            StringComparer.OrdinalIgnoreCase);
        var templateInfo = assetsFile.GetAssetsOfType(AssetClassID.Texture2D).FirstOrDefault();
        if (templateInfo is null)
        {
            throw new InvalidOperationException("Cannot insert Texture2D because this __data has no Texture2D template asset.");
        }

        var nextPathId = assetsFile.AssetInfos.Count == 0 ? 1 : assetsFile.AssetInfos.Max(asset => asset.PathId) + 1;
        foreach (var (assetName, replacement) in replacements)
        {
            if (existingTextureNames.Contains(assetName))
            {
                continue;
            }

            var baseField = manager.GetBaseField(assetsFileInstance, templateInfo).Clone();
            baseField["m_Name"].AsString = assetName;
            var texture = TextureFile.ReadTextureFile(baseField);
            texture.m_TextureFormat = (int)TextureFormat.RGBA32;
            texture.EncodeTextureImage(replacement.Path, replacement.EncodeQuality);
            texture.WriteTo(baseField);

            var assetInfo = AssetFileInfo.Create(assetsFile, nextPathId++, (int)AssetClassID.Texture2D, null, false);
            if (assetInfo is null)
            {
                throw new InvalidOperationException($"Cannot create Texture2D asset info for {assetName}.");
            }

            assetInfo.SetNewData(baseField);
            assetsFile.Metadata.AddAssetInfo(assetInfo);
            existingTextureNames.Add(assetName);
            changed.Add(new ChangedAsset(replacement.ModName, "Texture2D", assetName, replacement.Action, replacement.Path, null));
            inserted.Add(new InsertedTexture(replacement.ModName, assetName, assetInfo.PathId, replacement.Path));
        }

        return inserted;
    }

    private static void InsertMaterialsForTextures(
        AssetsManager manager,
        AssetsFileInstance assetsFileInstance,
        AssetsFile assetsFile,
        List<InsertedTexture> insertedTextures,
        List<ChangedAsset> changed)
    {
        if (insertedTextures.Count == 0)
        {
            return;
        }

        var assetBundleInfo = assetsFile.GetAssetsOfType(AssetClassID.AssetBundle).FirstOrDefault();
        var assetBundleField = assetBundleInfo is null ? null : manager.GetBaseField(assetsFileInstance, assetBundleInfo);
        var nextPathId = assetsFile.AssetInfos.Count == 0 ? 1 : assetsFile.AssetInfos.Max(asset => asset.PathId) + 1;
        foreach (var texture in insertedTextures)
        {
            var rootName = SpineAtlasRootName(texture.Name);
            var atlasInfo = FindNamedAsset(manager, assetsFileInstance, assetsFile, AssetClassID.MonoBehaviour, $"{rootName}_Atlas");
            if (atlasInfo is null)
            {
                continue;
            }

            var atlasField = manager.GetBaseField(assetsFileInstance, atlasInfo);
            var materialsArray = atlasField["materials"]["Array"];
            if (materialsArray.IsDummy || materialsArray.Children.Count == 0)
            {
                continue;
            }

            var templateMaterialPathId = materialsArray.Children[^1]["m_PathID"].AsLong;
            var templateMaterialInfo = assetsFile.Metadata.GetAssetInfo(templateMaterialPathId);
            if (templateMaterialInfo is null)
            {
                continue;
            }

            var materialName = $"{rootName}_{texture.Name}";
            var materialField = manager.GetBaseField(assetsFileInstance, templateMaterialInfo).Clone();
            materialField["m_Name"].AsString = materialName;
            SetFirstMaterialTexture(materialField, texture.PathId);

            var materialInfo = AssetFileInfo.Create(assetsFile, nextPathId++, (int)AssetClassID.Material, null, false);
            if (materialInfo is null)
            {
                throw new InvalidOperationException($"Cannot create Material asset info for {materialName}.");
            }

            materialInfo.SetNewData(materialField);
            assetsFile.Metadata.AddAssetInfo(materialInfo);

            var materialPointer = materialsArray.Children[^1].Clone();
            SetPPtr(materialPointer, 0, materialInfo.PathId);
            materialsArray.Children.Add(materialPointer);
            atlasInfo.SetNewData(atlasField);

            if (assetBundleField is not null)
            {
                AddAssetBundleEntry(assetBundleField, rootName, $"{texture.Name}.png", texture.PathId);
                AddAssetBundleEntry(assetBundleField, rootName, $"{materialName}.mat", materialInfo.PathId);
                assetBundleInfo!.SetNewData(assetBundleField);
            }

            changed.Add(new ChangedAsset(texture.ModName, "Material", materialName, "insert_material", texture.Source, null));
        }
    }

    private static AssetFileInfo? FindNamedAsset(
        AssetsManager manager,
        AssetsFileInstance assetsFileInstance,
        AssetsFile assetsFile,
        AssetClassID type,
        string name)
    {
        return assetsFile.GetAssetsOfType(type).FirstOrDefault(assetInfo =>
            TryGetAssetName(manager, assetsFileInstance, assetInfo).Equals(name, StringComparison.OrdinalIgnoreCase));
    }

    private static string SpineAtlasRootName(string textureName)
    {
        var match = System.Text.RegularExpressions.Regex.Match(textureName, @"^(.*)_\d+$");
        return match.Success ? match.Groups[1].Value : textureName;
    }

    private static void SetFirstMaterialTexture(AssetTypeValueField materialField, long texturePathId)
    {
        var texEnvs = materialField["m_SavedProperties"]["m_TexEnvs"]["Array"];
        if (texEnvs.IsDummy)
        {
            return;
        }

        foreach (var texEnv in texEnvs.Children)
        {
            var texture = texEnv["second"]["m_Texture"];
            if (SetPPtr(texture, 0, texturePathId))
            {
                return;
            }
        }
    }

    private static void AddAssetBundleEntry(AssetTypeValueField assetBundleField, string rootName, string fileName, long pathId)
    {
        AddPreloadEntry(assetBundleField, pathId);
        AddContainerEntry(assetBundleField, rootName, fileName, pathId);
    }

    private static void AddPreloadEntry(AssetTypeValueField assetBundleField, long pathId)
    {
        var preloadArray = assetBundleField["m_PreloadTable"]["Array"];
        if (preloadArray.IsDummy || preloadArray.Children.Any(item => GetPPtrPathId(item) == pathId))
        {
            return;
        }

        var template = preloadArray.Children.FirstOrDefault(item => GetPPtrFileId(item) == 0)?.Clone();
        if (template is null)
        {
            return;
        }

        SetPPtr(template, 0, pathId);
        preloadArray.Children.Add(template);
    }

    private static void AddContainerEntry(AssetTypeValueField assetBundleField, string rootName, string fileName, long pathId)
    {
        var containerArray = assetBundleField["m_Container"]["Array"];
        if (containerArray.IsDummy)
        {
            return;
        }

        var path = $"Assets/AddressableResources/BundleCommon/SkeletonData/{SpineFamilyName(rootName)}/{fileName}";
        if (containerArray.Children.Any(item => item["first"].AsString.Equals(path, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        var template = containerArray.Children
            .FirstOrDefault(item => item["first"].AsString.Contains($"/{SpineFamilyName(rootName)}/", StringComparison.OrdinalIgnoreCase))
            ?.Clone();
        if (template is null)
        {
            return;
        }

        template["first"].AsString = path;
        SetPPtr(template["second"], 0, pathId);
        containerArray.Children.Add(template);
    }

    private static string SpineFamilyName(string rootName)
    {
        var match = System.Text.RegularExpressions.Regex.Match(rootName, @"^(cutscene_char\d+|char\d+|illust_dating\d+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return match.Success ? match.Groups[1].Value : rootName;
    }

    private static bool SetPPtr(AssetTypeValueField field, int fileId, long pathId)
    {
        var fileIdField = field["m_FileID"];
        var pathIdField = field["m_PathID"];
        if (!fileIdField.IsDummy && !pathIdField.IsDummy)
        {
            fileIdField.AsInt = fileId;
            pathIdField.AsLong = pathId;
            return true;
        }

        foreach (var child in field.Children)
        {
            if (SetPPtr(child, fileId, pathId))
            {
                return true;
            }
        }

        return false;
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

    private static InspectAsset ReadInspectAsset(
        AssetsManager manager,
        AssetsFileInstance assetsFileInstance,
        AssetsFile assetsFile,
        AssetFileInfo assetInfo,
        string typeName,
        string name)
    {
        int? width = null;
        int? height = null;
        if (assetInfo.GetTypeId(assetsFile) == (int)AssetClassID.Texture2D)
        {
            var baseField = manager.GetBaseField(assetsFileInstance, assetInfo);
            width = baseField["m_Width"].AsInt;
            height = baseField["m_Height"].AsInt;
        }

        return new InspectAsset(name, typeName, assetInfo.PathId, assetInfo.GetTypeId(assetsFile), assetInfo.ByteSize, width, height);
    }

    private static void AddContainerEntries(
        AssetTypeValueField baseField,
        string ownerType,
        string ownerName,
        string target,
        List<InspectContainerEntry> entries)
    {
        var container = baseField["m_Container"];
        if (container.IsDummy)
        {
            return;
        }

        foreach (var item in container["Array"].Children)
        {
            var path = item["first"].AsString;
            if (target.Length > 0 && !path.Contains(target, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var pointer = item["second"];
            entries.Add(new InspectContainerEntry(ownerType, ownerName, path, GetPPtrFileId(pointer), GetPPtrPathId(pointer)));
        }
    }

    private static void AddPreloadEntries(
        AssetTypeValueField baseField,
        string ownerType,
        string ownerName,
        List<InspectPPtr> entries)
    {
        var preload = baseField["m_PreloadTable"];
        if (preload.IsDummy)
        {
            return;
        }

        foreach (var item in preload["Array"].Children)
        {
            entries.Add(new InspectPPtr(ownerType, ownerName, GetPPtrFileId(item), GetPPtrPathId(item)));
        }
    }

    private static void AddReferences(
        AssetTypeValueField field,
        string ownerType,
        string ownerName,
        string fieldPath,
        Dictionary<long, string> assetNameByPathId,
        List<InspectReference> references)
    {
        var fileId = field["m_FileID"];
        var pathId = field["m_PathID"];
        if (!fileId.IsDummy && !pathId.IsDummy)
        {
            var id = pathId.AsLong;
            references.Add(new InspectReference(
                ownerType,
                ownerName,
                fieldPath,
                fileId.AsInt,
                id,
                assetNameByPathId.TryGetValue(id, out var targetName) ? targetName : null));
            return;
        }

        for (var index = 0; index < field.Children.Count; index++)
        {
            var child = field.Children[index];
            var childName = child.TemplateField.Name;
            var childPath = string.IsNullOrEmpty(fieldPath)
                ? childName
                : $"{fieldPath}.{childName}";
            AddReferences(child, ownerType, ownerName, childPath, assetNameByPathId, references);
        }
    }

    private static int GetPPtrFileId(AssetTypeValueField field)
    {
        var fileId = field["m_FileID"];
        return fileId.IsDummy ? 0 : fileId.AsInt;
    }

    private static long GetPPtrPathId(AssetTypeValueField field)
    {
        var pathId = field["m_PathID"];
        return pathId.IsDummy ? 0 : pathId.AsLong;
    }

    private static string TryGetAssetName(AssetsManager manager, AssetsFileInstance assetsFileInstance, AssetFileInfo assetInfo)
    {
        try
        {
            var baseField = manager.GetBaseField(assetsFileInstance, assetInfo);
            var name = baseField["m_Name"];
            return name.IsDummy ? "" : name.AsString;
        }
        catch
        {
            return "";
        }
    }

    private static string GetTypeName(AssetFileInfo assetInfo, AssetsFile assetsFile)
    {
        var typeId = assetInfo.GetTypeId(assetsFile);
        return Enum.IsDefined(typeof(AssetClassID), typeId)
            ? ((AssetClassID)typeId).ToString()
            : typeId.ToString();
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

sealed record ScannedAsset(
    string Name,
    string Type,
    long PathId,
    int? Width = null,
    int? Height = null);

sealed record ScanResult(
    bool Ok,
    string? Error,
    long ElapsedMs,
    List<ScannedAsset> Assets,
    int Skipped = 0,
    List<TimingEntry>? Timings = null);

sealed record PatchJob(
    string ModName,
    List<string>? Atlases,
    List<string>? Skels,
    List<string>? Pngs,
    List<string>? InsertPngs,
    string? AssetBackupDir);

sealed record ChangedAsset(
    string? ModName,
    string Type,
    string Name,
    string Action,
    string Source,
    string? AssetBackup);

sealed record MissingAsset(string Type, string Name, string Source, string? ModName);

sealed record InsertedTexture(string? ModName, string Name, long PathId, string Source);

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

sealed record InspectResult(
    bool Ok,
    string? Error,
    long ElapsedMs,
    List<InspectAsset> Assets,
    List<InspectContainerEntry> Containers,
    List<InspectPPtr> Preload,
    List<InspectDirectory> Directories,
    List<InspectReference> References);

sealed record InspectAsset(
    string Name,
    string Type,
    long PathId,
    int TypeId,
    uint ByteSize,
    int? Width = null,
    int? Height = null);

sealed record InspectContainerEntry(
    string OwnerType,
    string OwnerName,
    string Path,
    int FileId,
    long PathId);

sealed record InspectPPtr(
    string OwnerType,
    string OwnerName,
    int FileId,
    long PathId);

sealed record InspectDirectory(
    int Index,
    string Name,
    long Offset,
    long DecompressedSize);

sealed record InspectReference(
    string OwnerType,
    string OwnerName,
    string FieldPath,
    int FileId,
    long PathId,
    string? TargetName);

sealed class ReplacementIndex
{
    public Dictionary<string, Replacement> Text { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, Replacement> Textures { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, Replacement> InsertTextures { get; } = new(StringComparer.OrdinalIgnoreCase);

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

            foreach (var png in job.InsertPngs ?? [])
            {
                index.Add(index.InsertTextures, Path.GetFileNameWithoutExtension(png), new Replacement(job.ModName, png, "insert_texture", job.AssetBackupDir));
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

        foreach (var (name, replacement) in InsertTextures)
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
    public string Mode { get; private init; } = "patch";
    public string Input { get; private init; } = "";
    public string Output { get; private init; } = "";
    public string JobManifest { get; private init; } = "";
    public string Compression { get; private init; } = "lz4";
    public string? Target { get; private init; }
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
            Mode = values.TryGetValue("mode", out var mode) ? mode : "patch",
            Input = Required(values, "input"),
            Output = values.TryGetValue("output", out var output) ? output : "",
            JobManifest = values.TryGetValue("job-manifest", out var jobManifest) ? jobManifest : "",
            Compression = values.TryGetValue("compression", out var compression) ? compression : "lz4",
            Target = values.TryGetValue("target", out var target) ? target : null
        };

        if (parsed.Mode is not ("patch" or "scan" or "inspect"))
        {
            throw new ArgumentException("--mode must be patch, scan, or inspect");
        }

        if (parsed.Mode == "patch" && (string.IsNullOrWhiteSpace(parsed.Output) || string.IsNullOrWhiteSpace(parsed.JobManifest)))
        {
            throw new ArgumentException("Patch mode requires --output and --job-manifest");
        }

        if (parsed.Compression is not ("lz4" or "none"))
        {
            throw new ArgumentException("--compression must be lz4 or none");
        }

        return parsed;
    }

    public static void PrintUsage()
    {
        Console.WriteLine("UabeaPatchPrototype --mode scan --input __data");
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
