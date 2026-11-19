using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using LiteDB;

namespace PlayniteReader
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("Usage: PlayniteReader <library-dir-or-games.db> [query]");
                return 1;
            }

            var input = args[0];
            var query = args.Length > 1 ? args[1].Trim() : "";
            string libraryDir;
            string gamesDbPath;

            if (input.EndsWith(".db", StringComparison.OrdinalIgnoreCase))
            {
                gamesDbPath = input;
                libraryDir = System.IO.Path.GetDirectoryName(input);
            }
            else
            {
                libraryDir = input;
                gamesDbPath = System.IO.Path.Combine(libraryDir, "games.db");
            }

            var lookups = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
            LoadLookup(lookups, libraryDir, "tags.db", "Tag", "tags");
            LoadLookup(lookups, libraryDir, "genres.db", "Genre", "genres");
            LoadLookup(lookups, libraryDir, "categories.db", "Category", "categories");
            LoadLookup(lookups, libraryDir, "platforms.db", "Platform", "platforms");
            LoadLookup(lookups, libraryDir, "companies.db", "Company", "companies");
            LoadLookup(lookups, libraryDir, "completionstatuses.db", "CompletionStatus", "completionStatuses");
            LoadLookup(lookups, libraryDir, "regions.db", "Region", "regions");
            LoadLookup(lookups, libraryDir, "series.db", "Series", "series");
            LoadLookup(lookups, libraryDir, "sources.db", "GameSource", "sources");
            LoadLookup(lookups, libraryDir, "features.db", "GameFeature", "features");
            LoadLookup(lookups, libraryDir, "ageratings.db", "AgeRating", "ageRatings");

            using (var db = new LiteDatabase("Filename=" + gamesDbPath + ";Mode=ReadOnly"))
            {
                string collectionName = null;
                foreach (var name in db.GetCollectionNames())
                {
                    if (string.Equals(name, "games", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(name, "game", StringComparison.OrdinalIgnoreCase))
                    {
                        collectionName = name;
                        break;
                    }
                }

                if (collectionName == null)
                {
                    Console.Error.WriteLine("No games collection. " + string.Join(", ", db.GetCollectionNames()));
                    return 2;
                }

                var col = db.GetCollection(collectionName);
                var games = new List<Dictionary<string, object>>();

                foreach (var doc in col.FindAll())
                {
                    var name = GetString(doc, "Name") ?? "";
                    if (!string.IsNullOrEmpty(query) &&
                        name.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }

                    var id = GetId(doc);
                    var tagIds = GetIdList(doc, "TagIds");
                    var genreIds = GetIdList(doc, "GenreIds");
                    var categoryIds = GetIdList(doc, "CategoryIds");
                    var platformIds = GetIdList(doc, "PlatformIds");
                    var developerIds = GetIdList(doc, "DeveloperIds");
                    var publisherIds = GetIdList(doc, "PublisherIds");
                    var featureIds = GetIdList(doc, "FeatureIds");
                    var regionIds = GetIdList(doc, "RegionIds");

                    var installDir = GetString(doc, "InstallDirectory");
                    string installRoot = null;
                    if (!string.IsNullOrWhiteSpace(installDir))
                    {
                        try { installRoot = System.IO.Path.GetPathRoot(installDir); }
                        catch { installRoot = null; }
                    }

                    games.Add(new Dictionary<string, object>
                    {
                        ["id"] = id,
                        ["name"] = name,
                        ["sortingName"] = GetString(doc, "SortingName"),
                        ["isInstalled"] = GetBool(doc, "IsInstalled"),
                        ["installDirectory"] = installDir,
                        ["installRoot"] = installRoot,
                        ["installSize"] = GetDouble(doc, "InstallSize"),
                        ["coverImage"] = GetString(doc, "CoverImage"),
                        ["icon"] = GetString(doc, "Icon"),
                        ["backgroundImage"] = GetString(doc, "BackgroundImage"),
                        ["description"] = GetString(doc, "Description"),
                        ["notes"] = GetString(doc, "Notes"),
                        ["version"] = GetString(doc, "Version"),
                        ["playtime"] = GetDouble(doc, "Playtime"),
                        ["lastActivity"] = GetDateIso(doc, "LastActivity"),
                        ["added"] = GetDateIso(doc, "Added"),
                        ["modified"] = GetDateIso(doc, "Modified"),
                        ["releaseDate"] = GetReleaseDate(doc),
                        ["hidden"] = GetBool(doc, "Hidden"),
                        ["favorite"] = GetBool(doc, "Favorite"),
                        ["communityScore"] = GetNullableDouble(doc, "CommunityScore"),
                        ["criticScore"] = GetNullableDouble(doc, "CriticScore"),
                        ["userScore"] = GetNullableDouble(doc, "UserScore"),
                        ["completionStatus"] = ResolveOne(lookups, "completionStatuses", GetIdRef(doc, "CompletionStatusId")),
                        ["series"] = ResolveOne(lookups, "series", GetIdRef(doc, "SeriesId")),
                        ["source"] = ResolveOne(lookups, "sources", GetIdRef(doc, "SourceId")),
                        ["ageRating"] = ResolveOne(lookups, "ageRatings", GetIdRef(doc, "AgeRatingId")),
                        ["tags"] = ResolveMany(lookups, "tags", tagIds),
                        ["genres"] = ResolveMany(lookups, "genres", genreIds),
                        ["categories"] = ResolveMany(lookups, "categories", categoryIds),
                        ["platforms"] = ResolveMany(lookups, "platforms", platformIds),
                        ["developers"] = ResolveMany(lookups, "companies", developerIds),
                        ["publishers"] = ResolveMany(lookups, "companies", publisherIds),
                        ["features"] = ResolveMany(lookups, "features", featureIds),
                        ["regions"] = ResolveMany(lookups, "regions", regionIds),
                        ["playActions"] = GetPlayActions(doc),
                    });
                }

                games.Sort((a, b) =>
                {
                    var an = (string)(a["name"] ?? "");
                    var bn = (string)(b["name"] ?? "");
                    return string.Compare(an, bn, StringComparison.CurrentCultureIgnoreCase);
                });

                var payload = new Dictionary<string, object>
                {
                    ["count"] = games.Count,
                    ["games"] = games,
                    ["lookups"] = lookups.ToDictionary(
                        kv => kv.Key,
                        kv => kv.Value.OrderBy(x => x.Value, StringComparer.CurrentCultureIgnoreCase)
                                      .Select(x => new Dictionary<string, string> { ["id"] = x.Key, ["name"] = x.Value })
                                      .ToList()),
                    ["collection"] = collectionName,
                };

                var opts = new System.Text.Json.JsonSerializerOptions { WriteIndented = false };
                Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(payload, opts));
            }

            return 0;
        }

        private static void LoadLookup(
            Dictionary<string, Dictionary<string, string>> lookups,
            string libraryDir,
            string fileName,
            string preferredCollection,
            string key)
        {
            var path = System.IO.Path.Combine(libraryDir, fileName);
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            lookups[key] = map;
            if (!System.IO.File.Exists(path)) return;

            try
            {
                using (var db = new LiteDatabase("Filename=" + path + ";Mode=ReadOnly"))
                {
                    string colName = null;
                    foreach (var n in db.GetCollectionNames())
                    {
                        if (string.Equals(n, preferredCollection, StringComparison.OrdinalIgnoreCase))
                        {
                            colName = n;
                            break;
                        }
                    }
                    if (colName == null)
                    {
                        var names = db.GetCollectionNames().ToList();
                        if (names.Count == 1) colName = names[0];
                        else return;
                    }

                    foreach (var doc in db.GetCollection(colName).FindAll())
                    {
                        var id = GetId(doc);
                        var name = GetString(doc, "Name");
                        if (!string.IsNullOrEmpty(id) && !string.IsNullOrEmpty(name))
                            map[id] = name;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("lookup " + fileName + ": " + ex.Message);
            }
        }

        private static List<string> ResolveMany(
            Dictionary<string, Dictionary<string, string>> lookups,
            string key,
            List<string> ids)
        {
            var map = lookups.ContainsKey(key) ? lookups[key] : null;
            var list = new List<string>();
            if (ids == null || map == null) return list;
            foreach (var id in ids)
            {
                string name;
                if (map.TryGetValue(id, out name)) list.Add(name);
            }
            return list;
        }

        private static string ResolveOne(
            Dictionary<string, Dictionary<string, string>> lookups,
            string key,
            string id)
        {
            if (string.IsNullOrEmpty(id)) return null;
            Dictionary<string, string> map;
            if (!lookups.TryGetValue(key, out map)) return null;
            string name;
            return map.TryGetValue(id, out name) ? name : null;
        }

        private static string GetId(BsonDocument doc)
        {
            if (!doc.ContainsKey("_id") || doc["_id"].IsNull) return "";
            var idVal = doc["_id"];
            if (idVal.IsGuid) return idVal.AsGuid.ToString();
            return idVal.ToString();
        }

        private static string GetIdRef(BsonDocument doc, string key)
        {
            if (!doc.ContainsKey(key) || doc[key].IsNull) return null;
            var v = doc[key];
            if (v.IsGuid) return v.AsGuid.ToString();
            if (v.IsString) return v.AsString;
            return v.ToString();
        }

        private static List<string> GetIdList(BsonDocument doc, string key)
        {
            var list = new List<string>();
            if (!doc.ContainsKey(key) || doc[key].IsNull) return list;
            var v = doc[key];
            if (!v.IsArray) return list;
            foreach (var item in v.AsArray)
            {
                if (item.IsGuid) list.Add(item.AsGuid.ToString());
                else if (item.IsString) list.Add(item.AsString);
                else if (!item.IsNull) list.Add(item.ToString());
            }
            return list;
        }

        private static List<Dictionary<string, object>> GetPlayActions(BsonDocument doc)
        {
            var list = new List<Dictionary<string, object>>();
            if (!doc.ContainsKey("GameActions") || doc["GameActions"].IsNull || !doc["GameActions"].IsArray)
                return list;

            foreach (var item in doc["GameActions"].AsArray)
            {
                if (!item.IsDocument) continue;
                var a = item.AsDocument;
                var isPlay = GetBool(a, "IsPlayAction");
                if (!isPlay && a.ContainsKey("IsPlayAction") && !a["IsPlayAction"].IsNull)
                {
                    // keep only play actions when flag present
                }
                // Include all actions but mark play
                list.Add(new Dictionary<string, object>
                {
                    ["name"] = GetString(a, "Name"),
                    ["path"] = GetString(a, "Path"),
                    ["arguments"] = GetString(a, "Arguments"),
                    ["workingDir"] = GetString(a, "WorkingDir"),
                    ["isPlay"] = isPlay || !a.ContainsKey("IsPlayAction"),
                    ["type"] = a.ContainsKey("Type") && !a["Type"].IsNull ? a["Type"].RawValue : null,
                });
            }
            return list;
        }

        private static string GetReleaseDate(BsonDocument doc)
        {
            if (!doc.ContainsKey("ReleaseDate") || doc["ReleaseDate"].IsNull) return null;
            var v = doc["ReleaseDate"];
            if (v.IsDateTime) return v.AsDateTime.ToUniversalTime().ToString("o");
            if (v.IsDocument)
            {
                var d = v.AsDocument;
                // Playnite ReleaseDate often { Year, Month, Day }
                int year = 0, month = 1, day = 1;
                if (d.ContainsKey("Year") && d["Year"].IsInt32) year = d["Year"].AsInt32;
                if (d.ContainsKey("Month") && !d["Month"].IsNull)
                {
                    if (d["Month"].IsInt32) month = d["Month"].AsInt32;
                }
                if (d.ContainsKey("Day") && !d["Day"].IsNull && d["Day"].IsInt32) day = d["Day"].AsInt32;
                if (year > 0)
                {
                    try
                    {
                        return new DateTime(year, Math.Max(1, month), Math.Max(1, day), 0, 0, 0, DateTimeKind.Utc)
                            .ToString("o");
                    }
                    catch { return year.ToString(CultureInfo.InvariantCulture); }
                }
            }
            if (v.IsString) return v.AsString;
            return null;
        }

        private static string GetString(BsonDocument doc, string key)
        {
            if (!doc.ContainsKey(key) || doc[key].IsNull) return null;
            if (doc[key].IsString) return doc[key].AsString;
            return doc[key].ToString();
        }

        private static bool GetBool(BsonDocument doc, string key)
        {
            if (!doc.ContainsKey(key) || doc[key].IsNull) return false;
            return doc[key].AsBoolean;
        }

        private static double GetDouble(BsonDocument doc, string key)
        {
            if (!doc.ContainsKey(key) || doc[key].IsNull) return 0;
            var v = doc[key];
            if (v.IsDouble) return v.AsDouble;
            if (v.IsInt32) return v.AsInt32;
            if (v.IsInt64) return v.AsInt64;
            return 0;
        }

        private static object GetNullableDouble(BsonDocument doc, string key)
        {
            if (!doc.ContainsKey(key) || doc[key].IsNull) return null;
            return GetDouble(doc, key);
        }

        private static string GetDateIso(BsonDocument doc, string key)
        {
            if (!doc.ContainsKey(key) || doc[key].IsNull) return null;
            if (!doc[key].IsDateTime) return null;
            return doc[key].AsDateTime.ToUniversalTime().ToString("o");
        }
    }
}
