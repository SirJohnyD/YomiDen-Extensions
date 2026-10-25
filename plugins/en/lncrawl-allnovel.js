/* YomiDen plugin generated from lightnovel-crawler (GPL-3.0): sources/en/a/allnovel.py @ 59b0382d5192
 * template: NovelFullTemplate -> novelfull. Do not edit; regenerate with ydn/tools/lncrawl-gen. */
var cheerio = require("cheerio");
var fetchLib = require("@libs/fetch");
var NovelStatus = require("@libs/novelStatus").NovelStatus;
function normalizeSite(site) {
  return site.charAt(site.length - 1) === "/" ? site : site + "/";
}
function absUrl(href, base) {
  if (!href) return "";
  href = String(href).trim();
  if (!href || href.indexOf("data:") === 0 || href.indexOf("javascript:") === 0) return "";
  try {
    return new URL(href, base).href;
  } catch (e) {
    return href;
  }
}
function toPath(href, site) {
  var url = absUrl(href, site);
  var root = site.replace(/^(https?:\/\/[^\/]+)\/.*$/, "$1/");
  if (site === root && url.indexOf(root) === 0) return "/" + url.slice(root.length);
  return url;
}
function urlFor(path, site) {
  return absUrl(path, site) || path;
}
function imgSrc($img, base) {
  if (!$img || !$img.length) return "";
  var srcset = $img.attr("data-srcset") || $img.attr("srcset") || "";
  var candidates = [
    $img.attr("data-src"),
    $img.attr("data-lazy-src"),
    $img.attr("data-cfsrc"),
    $img.attr("data-original"),
    srcset.split(",")[0].trim().split(/\s+/)[0],
    $img.attr("src")
  ];
  for (var i = 0; i < candidates.length; i++) {
    var u = absUrl(candidates[i], base);
    if (u) return u;
  }
  return "";
}
function getHtml(url, referer) {
  return fetchLib.fetchApi(url, { headers: { Referer: referer } }).then(function(res) {
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.text();
  });
}
function postHtml(url, referer, body) {
  return fetchLib.fetchApi(url, {
    method: "POST",
    headers: {
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: body || ""
  }).then(function(res) {
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.text();
  });
}
function textOf($el) {
  return ($el.text() || "").replace(/\s+/g, " ").trim();
}
function summaryText($, $el) {
  if (!$el || !$el.length) return "";
  var $c = $el.first().clone();
  $c.find("script,style").remove();
  var paras = $c.find("p").toArray().map(function(p) {
    return textOf($(p));
  }).filter(function(t) {
    return t;
  });
  return paras.length ? paras.join("\n\n") : textOf($c);
}
function parseStatus(text) {
  var t = String(text || "").toLowerCase();
  if (/ongoing|on going|publishing|updating/.test(t)) return NovelStatus.Ongoing;
  if (/complet|finish|ended/.test(t)) return NovelStatus.Completed;
  if (/hiatus|on hold|paused/.test(t)) return NovelStatus.OnHiatus;
  if (/cancel|dropped|discontinued/.test(t)) return NovelStatus.Cancelled;
  return NovelStatus.Unknown;
}
function parseDate(text) {
  text = String(text || "").trim();
  if (!text) return void 0;
  var t = Date.parse(text);
  return isNaN(t) ? text : new Date(t).toISOString();
}
function trySelect($root, selector) {
  try {
    return $root.find(selector);
  } catch (e) {
    return $root.find(".__none__");
  }
}
function cleanBody($, $body, cfg) {
  $body.find("script,style,iframe,ins,noscript,form,.adsbygoogle").remove();
  (cfg.badTags || []).forEach(function(t) {
    trySelect($body, t).remove();
  });
  (cfg.badCss || []).forEach(function(s) {
    trySelect($body, s).remove();
  });
  var pairs = cfg.badTagText || {};
  Object.keys(pairs).forEach(function(tag) {
    var res = [];
    [].concat(pairs[tag]).forEach(function(p) {
      try {
        res.push(new RegExp(p, "i"));
      } catch (e) {
      }
    });
    trySelect($body, tag).each(function(i, el) {
      var txt = $(el).text();
      if (res.some(function(r) {
        return r.test(txt);
      })) {
        $(el).remove();
      }
    });
  });
  return ($body.html() || "").trim();
}
function firstMatch($, selector) {
  try {
    return $(selector).first();
  } catch (e) {
    return $(".__none__");
  }
}
function dedupeBy(list, key) {
  var seen = {};
  return list.filter(function(x) {
    var k = key(x);
    if (!k || seen[k]) return false;
    seen[k] = 1;
    return true;
  });
}
function createPlugin(cfg) {
  var site = normalizeSite(cfg.site);
  var sel = cfg.sel;
  function parseList(html) {
    var $ = cheerio.load(html);
    var items = [];
    $("#list-page .row, .list-truyen .row, .list.list-novel .row, .list .row").each(function(i, el) {
      var $el = $(el);
      var a = $el.find("h3[class*='title'] > a, .truyen-title a, h3 a").first();
      var href = a.attr("href");
      if (!href) return;
      items.push({
        name: (a.attr("title") || textOf(a)).trim(),
        path: toPath(href, site),
        cover: imgSrc($el.find("img").first(), site)
      });
    });
    return dedupeBy(items, function(x) {
      return x.path;
    });
  }
  function tryListing(slugs, page) {
    var i = 0;
    function next() {
      if (i >= slugs.length) return Promise.resolve([]);
      var url = site + slugs[i++] + (slugs[i - 1].indexOf("?") < 0 ? "?" : "&") + "page=" + page;
      return getHtml(url, site).then(parseList).catch(function() {
        return [];
      }).then(function(items) {
        return items.length ? items : next();
      });
    }
    return next();
  }
  function genericChapters(html) {
    var $ = cheerio.load(html);
    var out = [];
    $("ul.list-chapter > li > a[href], select > option[value]").each(function(i, el) {
      var $el = $(el);
      var href = $el.attr("href") || $el.attr("value");
      if (!href || href === "#") return;
      out.push({ name: ($el.attr("title") || textOf($el)).trim(), path: toPath(href, site) });
    });
    return dedupeBy(out, function(x) {
      return x.path;
    });
  }
  function infoValue($, label) {
    var found = [];
    $(".info li, .info-meta li").each(function(i, li) {
      var head = textOf($(li).find("h3").first());
      if (head.toLowerCase().indexOf(label) >= 0) {
        $(li).find("a").each(function(j, a) {
          var t = textOf($(a));
          if (t) found.push(t);
        });
        if (!found.length) found.push(textOf($(li)).replace(new RegExp("^" + label + "\\s*:?", "i"), "").trim());
      }
    });
    return found;
  }
  return {
    id: cfg.id,
    name: cfg.name,
    icon: cfg.icon || "",
    site,
    version: cfg.version,
    contentType: "novel",
    lncrawl: cfg.lncrawl,
    popularNovels: function(pageNo, options) {
      var latest = !!(options && options.showLatestNovels);
      return tryListing(latest ? ["latest-release-novel", "latest-release"] : ["most-popular", "hot-novel", "novel-list/most-popular"], pageNo);
    },
    searchNovels: function(term, pageNo) {
      return getHtml(site + "search?keyword=" + encodeURIComponent(term) + "&page=" + pageNo, site).then(parseList);
    },
    parseNovel: function(novelPath) {
      var url = urlFor(novelPath, site);
      return getHtml(url, site).then(function(html) {
        var $ = cheerio.load(html);
        var author = $(sel.author).toArray().map(function(a) {
          return textOf($(a));
        }).filter(Boolean);
        var statusVals = infoValue($, "status");
        var novel = {
          path: novelPath,
          name: textOf(firstMatch($, ".col-info-desc " + sel.title)) || textOf(firstMatch($, sel.title)),
          cover: imgSrc(firstMatch($, sel.cover), site) || absUrl($('meta[property="og:image"]').attr("content"), site),
          author: dedupeBy(author, function(x) {
            return x;
          }).join(", "),
          genres: infoValue($, "genre").join(","),
          summary: summaryText($, firstMatch($, sel.synopsis)),
          status: parseStatus(statusVals.join(" "))
        };
        var onPage = genericChapters(html);
        if (cfg.chapterListOnNovelPage && onPage.length) {
          novel.chapters = onPage;
          return novel;
        }
        var novelId = $("#rating[data-novel-id]").attr("data-novel-id") || $("[data-novel-id]").first().attr("data-novel-id");
        if (!novelId) {
          novel.chapters = onPage;
          return novel;
        }
        var optionRoute = /ajaxChapterOptionUrl\s*=/.test(html);
        var ajax = site + (optionRoute ? "ajax-chapter-option?novelId=" : "ajax/chapter-archive?novelId=") + encodeURIComponent(novelId);
        return getHtml(ajax, url).then(genericChapters).catch(function() {
          return [];
        }).then(function(chapters) {
          novel.chapters = chapters.length ? chapters : onPage;
          return novel;
        });
      });
    },
    parseChapter: function(chapterPath) {
      return getHtml(urlFor(chapterPath, site), site).then(function(html) {
        var $ = cheerio.load(html);
        var $body = firstMatch($, sel.chapterBody);
        if (!$body.length) return "";
        $body.find("div,h1,h2,h3,h4,h5,h6").each(function(i, el) {
          if (!$(el).find("p").length) $(el).remove();
        });
        return cleanBody($, $body, cfg);
      });
    }
  };
}

var CONFIG = {
  "id": "lncrawl-allnovel",
  "name": "All Novel",
  "site": "https://allnovel.org/",
  "version": "1.0.1774172045",
  "contentType": "novel",
  "icon": "",
  "sel": {
    "title": "h3.title",
    "cover": ".book img",
    "author": ".info a[href*='/a/'], .info a[href*='/au/'], .info a[href*='author']",
    "tags": ".info a[href*='/au/']",
    "synopsis": ".desc-text",
    "chapterBody": "#chr-content, #chapter-content"
  },
  "badTags": [
    "h3"
  ],
  "badCss": [],
  "badTagText": {},
  "lncrawl": {
    "file": "sources/en/a/allnovel.py",
    "commit": "59b0382d51927953aa8120c5de62dab23ce3f731",
    "template": "NovelFullTemplate",
    "customized": []
  }
};
exports.default = createPlugin(CONFIG);
