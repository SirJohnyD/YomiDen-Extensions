/* YomiDen plugin generated from lightnovel-crawler (GPL-3.0): sources/en/c/coffeemanga.py @ 59b0382d5192
 * template: WordpressMangaTemplate -> madara. Do not edit; regenerate with ydn/tools/lncrawl-gen. */
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
  var isComic = cfg.contentType === "comic";
  var sel = cfg.sel;
  function listUrl(page, query, latest) {
    var s = query === void 0 ? "" : cfg.searchQuoteMode === "quote" ? encodeURIComponent(query.toLowerCase()) : encodeURIComponent(query.toLowerCase()).replace(/%20/g, "+");
    var url = site + (page > 1 ? "page/" + page + "/" : "") + "?s=" + s + "&post_type=wp-manga&op=&author=&artist=&release=&adult=";
    if (query === void 0) url += "&m_orderby=" + (latest ? "latest" : "views");
    return url;
  }
  function parseList(html) {
    var $ = cheerio.load(html);
    var items = [];
    $(".c-tabs-item__content, .page-item-detail").each(function(i, el) {
      var $el = $(el);
      var a = $el.find(".post-title h3 a, .post-title h4 a, .post-title a, h3 a, h5 a").first();
      var href = a.attr("href");
      if (!href) return;
      items.push({
        name: (a.attr("title") || textOf(a)).trim(),
        path: toPath(href, site),
        cover: imgSrc($el.find("img").first(), site)
      });
    });
    items = dedupeBy(items, function(x) {
      return x.path;
    });
    if (cfg.searchMax > 0) items = items.slice(0, cfg.searchMax);
    return items;
  }
  function chapterName($, $a) {
    var $c = $a.clone();
    $c.children("span,i").remove();
    return textOf($c) || textOf($a);
  }
  function parseChapterAnchors(html) {
    var $ = cheerio.load(html);
    var selector = cfg.sel.chapterList || "li.wp-manga-chapter > a";
    var out = [];
    $(selector).each(function(i, a) {
      var $a = $(a);
      var href = $a.attr("href");
      if (!href || href === "#") return;
      var $li = $a.closest("li");
      out.push({
        name: chapterName($, $a),
        path: toPath(href, site),
        releaseTime: parseDate(textOf($li.find(".chapter-release-date").first()))
      });
    });
    return dedupeBy(out, function(x) {
      return x.path;
    });
  }
  function loadChapters(novelUrl, $page) {
    var clean = novelUrl.split("?")[0].replace(/\/+$/, "");
    return postHtml(clean + "/ajax/chapters/", novelUrl, "").then(function(h) {
      return parseChapterAnchors(h);
    }).catch(function() {
      return [];
    }).then(function(chapters) {
      if (chapters.length) return chapters;
      var id = $page("#manga-chapters-holder").attr("data-id");
      if (!id) return [];
      return postHtml(site + "wp-admin/admin-ajax.php", novelUrl, "action=manga_get_chapters&manga=" + encodeURIComponent(id)).then(function(h) {
        return parseChapterAnchors(h);
      }).catch(function() {
        return [];
      });
    }).then(function(chapters) {
      if (chapters.length) return chapters;
      return parseChapterAnchors($page.html());
    });
  }
  function readerBody($) {
    var $body = firstMatch($, sel.chapterBody || "div.reading-content");
    if (!$body.length) $body = firstMatch($, ".reading-content, .text-left, .entry-content");
    return $body;
  }
  var plugin = {
    id: cfg.id,
    name: cfg.name,
    icon: cfg.icon || "",
    site,
    version: cfg.version,
    contentType: cfg.contentType,
    lncrawl: cfg.lncrawl,
    imageRequestInit: isComic ? { headers: { Referer: site } } : void 0,
    popularNovels: function(pageNo, options) {
      var latest = !!(options && options.showLatestNovels);
      return getHtml(listUrl(pageNo, void 0, latest), site).then(parseList);
    },
    searchNovels: function(term, pageNo) {
      return getHtml(listUrl(pageNo, term), site).then(parseList);
    },
    parseNovel: function(novelPath) {
      var url = urlFor(novelPath, site);
      return getHtml(url, site).then(function(html) {
        var $ = cheerio.load(html);
        var $title = firstMatch($, sel.title).clone();
        $title.find("span,.manga-title-badges").remove();
        var name = textOf($title) || ($('meta[property="og:title"]').attr("content") || "").trim();
        var cover = imgSrc(firstMatch($, sel.cover), site) || absUrl($('meta[property="og:image"]').attr("content"), site);
        var status = "";
        $(".post-content_item, .post-status .post-content_item").each(function(i, el) {
          if (/status/i.test(textOf($(el).find(".summary-heading")))) status = textOf($(el).find(".summary-content"));
        });
        var novel = {
          path: novelPath,
          name,
          cover,
          author: $(sel.author).toArray().map(function(a) {
            return textOf($(a));
          }).filter(Boolean).join(", "),
          genres: $(sel.tags).toArray().map(function(a) {
            return textOf($(a));
          }).filter(Boolean).join(","),
          summary: summaryText($, firstMatch($, sel.synopsis)),
          status: parseStatus(status)
        };
        return loadChapters(url, $).then(function(chapters) {
          chapters.reverse();
          novel.chapters = chapters.map(function(c, i) {
            c.chapterNumber = i + 1;
            return c;
          });
          return novel;
        });
      });
    },
    parseChapter: function(chapterPath) {
      if (isComic) return Promise.resolve("");
      return getHtml(urlFor(chapterPath, site), site).then(function(html) {
        var $ = cheerio.load(html);
        if (cfg.bodyFromParagraphs) {
          var parts = $(".reading-content p").toArray().map(function(p) {
            return $.html(p);
          });
          return parts.join("");
        }
        var $body = readerBody($);
        return $body.length ? cleanBody($, $body, cfg) : "";
      });
    },
    parsePages: function(chapterPath) {
      var url = urlFor(chapterPath, site);
      if (url.indexOf("?") < 0) url += "?style=list";
      return getHtml(url, site).then(function(html) {
        var $ = cheerio.load(html);
        var $body = readerBody($);
        var pages = $body.find("img").toArray().map(function(img) {
          return imgSrc($(img), site);
        }).filter(Boolean);
        return dedupeBy(pages, function(x) {
          return x;
        });
      });
    }
  };
  return plugin;
}

var CONFIG = {
  "id": "lncrawl-coffeemanga",
  "name": "Coffee Manga",
  "site": "https://coffeemanga.io/",
  "version": "1.0.1775456139",
  "contentType": "comic",
  "icon": "",
  "sel": {
    "title": ".post-title h1",
    "cover": ".summary_image a img",
    "author": ".author-content a[href*=\"manga-author\"]",
    "tags": ".genres-content a[rel=\"tag\"]",
    "synopsis": ".description-summary",
    "chapterBody": "div.reading-content"
  },
  "badTags": [
    "h3"
  ],
  "badCss": [
    "a[href=\"javascript:void(0)\"]"
  ],
  "badTagText": {},
  "lncrawl": {
    "file": "sources/en/c/coffeemanga.py",
    "commit": "59b0382d51927953aa8120c5de62dab23ce3f731",
    "template": "WordpressMangaTemplate",
    "customized": []
  }
};
exports.default = createPlugin(CONFIG);
