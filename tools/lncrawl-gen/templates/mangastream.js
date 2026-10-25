// Port of lncrawl's MangaStreamTemplate (MangaStream / Themesia WordPress theme).
// Comics expose parsePages(); novel-flavoured installs expose parseChapter().
function createPlugin(cfg) {
  var site = normalizeSite(cfg.site);
  var isComic = cfg.contentType === 'comic';
  var sel = cfg.sel;

  function parseList(html) {
    var $ = cheerio.load(html);
    var items = [];
    $('.listupd > article, .listupd .bsx, .listupd .bs').each(function (i, el) {
      var $el = $(el);
      var a = $el.find('a.tip, a[href]').first();
      var href = a.attr('href');
      if (!href) return;
      var name = '';
      $el.find('h2, span.ntitle, .tt, a.tip').each(function (j, t) {
        if (!name) name = textOf($(t));
      });
      name = name || (a.attr('title') || '').trim();
      items.push({ name: name, path: toPath(href, site), cover: imgSrc($el.find('img').first(), site) });
    });
    return dedupeBy(items, function (x) {
      return x.path;
    });
  }

  function tryListing(order, page) {
    var slugs = ['manga', 'series', 'comics', 'novel', 'novels'];
    var i = 0;
    function next() {
      if (i >= slugs.length) return Promise.resolve([]);
      var url = site + slugs[i++] + '/?page=' + page + '&order=' + order;
      return getHtml(url, site)
        .then(parseList)
        .catch(function () {
          return [];
        })
        .then(function (items) {
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
    icon: cfg.icon || '',
    site: site,
    version: cfg.version,
    contentType: cfg.contentType,
    lncrawl: cfg.lncrawl,
    imageRequestInit: isComic ? { headers: { Referer: site } } : undefined,

    popularNovels: function (pageNo, options) {
      return tryListing(options && options.showLatestNovels ? 'update' : 'popular', pageNo);
    },

    searchNovels: function (term, pageNo) {
      var url = site + (pageNo > 1 ? 'page/' + pageNo + '/' : '') + '?s=' + encodeURIComponent(term);
      return getHtml(url, site).then(parseList);
    },

    parseNovel: function (novelPath) {
      return getHtml(urlFor(novelPath, site), site).then(function (html) {
        var $ = cheerio.load(html);
        var $title = firstMatch($, sel.title).clone();
        $title.find('span').remove();
        var cover = '';
        $(sel.cover).each(function (i, el) {
          if (cover) return;
          var $el = $(el);
          cover = el.tagName === 'meta' ? absUrl($el.attr('content'), site) : imgSrc($el, site);
        });
        var $first = $('.eplister li').first();
        var dataNum = $first.attr('data-num') || '0';
        var cls = $first.attr('class') || '';
        var chapters = $('.eplister li a')
          .toArray()
          .map(function (a) {
            var $a = $(a);
            var href = $a.attr('href');
            if (!href) return null;
            var name = textOf($a.find('.chapternum').first()) || textOf($a);
            return { name: name, path: toPath(href, site), releaseTime: parseDate(textOf($a.find('.chapterdate').first())) };
          })
          .filter(Boolean);
        chapters = dedupeBy(chapters, function (x) {
          return x.path;
        });
        if (dataNum === '1' || cls.indexOf('tseplsfrst') < 0) chapters.reverse();
        var statusText = '';
        $('.imptdt, .spe span').each(function (i, el) {
          if (/status/i.test(textOf($(el)))) statusText = textOf($(el));
        });
        return {
          path: novelPath,
          name: textOf($title) || ($('meta[property="og:title"]').attr('content') || '').trim(),
          cover: cover,
          author: $(sel.author)
            .toArray()
            .map(function (a) {
              return textOf($(a));
            })
            .filter(Boolean)
            .join(', '),
          genres: $('.mgen a, ' + sel.tags)
            .toArray()
            .map(function (a) {
              return textOf($(a));
            })
            .filter(Boolean)
            .join(','),
          summary: summaryText($, firstMatch($, "[itemprop='description'], " + sel.synopsis)),
          status: parseStatus(statusText),
          chapters: chapters.map(function (c, i) {
            c.chapterNumber = i + 1;
            return c;
          }),
        };
      });
    },

    parseChapter: function (chapterPath) {
      if (isComic) return Promise.resolve('');
      return getHtml(urlFor(chapterPath, site), site).then(function (html) {
        var $ = cheerio.load(html);
        var $body = readerBody($);
        return $body.length ? cleanBody($, $body, cfg) : '';
      });
    },

    parsePages: function (chapterPath) {
      return getHtml(urlFor(chapterPath, site), site).then(function (html) {
        var $ = cheerio.load(html);
        var pages = [];
        // Themesia readers often ship the page list as JSON: ts_reader.run({...,"sources":[{"images":[...]}]})
        var m = html.match(/ts_reader\.run\((\{[\s\S]*?\})\)\s*;/);
        if (m) {
          try {
            var data = JSON.parse(m[1]);
            var src = data.sources && data.sources[0];
            if (src && src.images) pages = src.images.map(function (u) { return absUrl(u, site); }).filter(Boolean);
          } catch (e) {
            // fall back to the DOM
          }
        }
        if (!pages.length) {
          pages = readerBody($)
            .find('img')
            .toArray()
            .map(function (img) {
              return imgSrc($(img), site);
            })
            .filter(Boolean);
        }
        return dedupeBy(pages, function (x) {
          return x;
        });
      });
    },
  };
}
