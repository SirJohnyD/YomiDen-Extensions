/* YomiDen plugin generated from lightnovel-crawler (GPL-3.0): sources/en/c/ckandawrites.online.py @ 59b0382d5192
 * template: MangaStreamTemplate -> mangastream. Do not edit; regenerate with ydn/tools/lncrawl-gen. */
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
  function parseList(html) {
    var $ = cheerio.load(html);
    var items = [];
    $(".listupd > article, .listupd .bsx, .listupd .bs").each(function(i, el) {
      var $el = $(el);
      var a = $el.find("a.tip, a[href]").first();
      var href = a.attr("href");
      if (!href) return;
      var name = "";
      $el.find("h2, span.ntitle, .tt, a.tip").each(function(j, t) {
        if (!name) name = textOf($(t));
      });
      name = name || (a.attr("title") || "").trim();
      items.push({ name, path: toPath(href, site), cover: imgSrc($el.find("img").first(), site) });
    });
    return dedupeBy(items, function(x) {
      return x.path;
    });
  }
  function tryListing(order, page) {
    var slugs = ["manga", "series", "comics", "novel", "novels"];
    var i = 0;
    function next() {
      if (i >= slugs.length) return Promise.resolve([]);
      var url = site + slugs[i++] + "/?page=" + page + "&order=" + order;
      return getHtml(url, site).then(parseList).catch(function() {
        return [];
      }).then(function(items) {
        return items.length ? items : next();
      });
    }
    return next();
  }
  function readerBody($) {
    return firstMatch($, sel.chapterBody);
  }
  return {
    id: cfg.id,
    name: cfg.name,
    icon: cfg.icon || "",
    site,
    version: cfg.version,
    contentType: cfg.contentType,
    lncrawl: cfg.lncrawl,
    imageRequestInit: isComic ? { headers: { Referer: site } } : void 0,
    popularNovels: function(pageNo, options) {
      return tryListing(options && options.showLatestNovels ? "update" : "popular", pageNo);
    },
    searchNovels: function(term, pageNo) {
      var url = site + (pageNo > 1 ? "page/" + pageNo + "/" : "") + "?s=" + encodeURIComponent(term);
      return getHtml(url, site).then(parseList);
    },
    parseNovel: function(novelPath) {
      return getHtml(urlFor(novelPath, site), site).then(function(html) {
        var $ = cheerio.load(html);
        var $title = firstMatch($, sel.title).clone();
        $title.find("span").remove();
        var cover = "";
        $(sel.cover).each(function(i, el) {
          if (cover) return;
          var $el = $(el);
          cover = el.tagName === "meta" ? absUrl($el.attr("content"), site) : imgSrc($el, site);
        });
        var $first = $(".eplister li").first();
        var dataNum = $first.attr("data-num") || "0";
        var cls = $first.attr("class") || "";
        var chapters = $(".eplister li a").toArray().map(function(a) {
          var $a = $(a);
          var href = $a.attr("href");
          if (!href) return null;
          var name = textOf($a.find(".chapternum").first()) || textOf($a);
          return { name, path: toPath(href, site), releaseTime: parseDate(textOf($a.find(".chapterdate").first())) };
        }).filter(Boolean);
        chapters = dedupeBy(chapters, function(x) {
          return x.path;
        });
        if (dataNum === "1" || cls.indexOf("tseplsfrst") < 0) chapters.reverse();
        var statusText = "";
        $(".imptdt, .spe span").each(function(i, el) {
          if (/status/i.test(textOf($(el)))) statusText = textOf($(el));
        });
        return {
          path: novelPath,
          name: textOf($title) || ($('meta[property="og:title"]').attr("content") || "").trim(),
          cover,
          author: $(sel.author).toArray().map(function(a) {
            return textOf($(a));
          }).filter(Boolean).join(", "),
          genres: $(".mgen a, " + sel.tags).toArray().map(function(a) {
            return textOf($(a));
          }).filter(Boolean).join(","),
          summary: summaryText($, firstMatch($, "[itemprop='description'], " + sel.synopsis)),
          status: parseStatus(statusText),
          chapters: chapters.map(function(c, i) {
            c.chapterNumber = i + 1;
            return c;
          })
        };
      });
    },
    parseChapter: function(chapterPath) {
      if (isComic) return Promise.resolve("");
      return getHtml(urlFor(chapterPath, site), site).then(function(html) {
        var $ = cheerio.load(html);
        var $body = readerBody($);
        return $body.length ? cleanBody($, $body, cfg) : "";
      });
    },
    parsePages: function(chapterPath) {
      return getHtml(urlFor(chapterPath, site), site).then(function(html) {
        var $ = cheerio.load(html);
        var pages = [];
        var m = html.match(/ts_reader\.run\((\{[\s\S]*?\})\)\s*;/);
        if (m) {
          try {
            var data = JSON.parse(m[1]);
            var src = data.sources && data.sources[0];
            if (src && src.images) pages = src.images.map(function(u) {
              return absUrl(u, site);
            }).filter(Boolean);
          } catch (e) {
          }
        }
        if (!pages.length) {
          pages = readerBody($).find("img").toArray().map(function(img) {
            return imgSrc($(img), site);
          }).filter(Boolean);
        }
        return dedupeBy(pages, function(x) {
          return x;
        });
      });
    }
  };
}

var CONFIG = {
  "id": "lncrawl-ckandawrites.online",
  "name": "Ckandawrites Online",
  "site": "https://ckandawrites.online/",
  "version": "1.0.1785615708",
  "contentType": "novel",
  "icon": "",
  "sel": {
    "title": "h1.entry-title",
    "cover": ".thumbook img, meta[property='og:image'],.sertothumb img",
    "author": ".spe a[href*='/writer/']",
    "tags": ".bottom.tags a[href*='/tag/']",
    "synopsis": ".entry-content",
    "chapterBody": "#readernovel, #readerarea, .entry-content"
  },
  "badTags": [
    "h3"
  ],
  "badCss": [],
  "badTagText": {},
  "lncrawl": {
    "file": "sources/en/c/ckandawrites.online.py",
    "commit": "59b0382d51927953aa8120c5de62dab23ce3f731",
    "template": "MangaStreamTemplate",
    "customized": []
  }
};
exports.default = createPlugin(CONFIG);
