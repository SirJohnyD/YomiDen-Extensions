// Port of lncrawl's MadaraTemplate / WordpressTemplate / WordpressMangaTemplate (Madara WordPress theme).
// Used for both novels (parseChapter) and comics (parsePages).
function createPlugin(cfg) {
  var site = normalizeSite(cfg.site);
  var isComic = cfg.contentType === 'comic';
  var sel = cfg.sel;

  function listUrl(page, query, latest) {
    var s = query === undefined ? '' : cfg.searchQuoteMode === 'quote' ? encodeURIComponent(query.toLowerCase()) : encodeURIComponent(query.toLowerCase()).replace(/%20/g, '+');
    var url = site + (page > 1 ? 'page/' + page + '/' : '') + '?s=' + s + '&post_type=wp-manga&op=&author=&artist=&release=&adult=';
    if (query === undefined) url += '&m_orderby=' + (latest ? 'latest' : 'views');
    return url;
  }

  function parseList(html) {
    var $ = cheerio.load(html);
    var items = [];
    $('.c-tabs-item__content, .page-item-detail').each(function (i, el) {
      var $el = $(el);
      var a = $el.find('.post-title h3 a, .post-title h4 a, .post-title a, h3 a, h5 a').first();
      var href = a.attr('href');
      if (!href) return;
      items.push({
        name: (a.attr('title') || textOf(a)).trim(),
        path: toPath(href, site),
        cover: imgSrc($el.find('img').first(), site),
      });
    });
    items = dedupeBy(items, function (x) {
      return x.path;
    });
    if (cfg.searchMax > 0) items = items.slice(0, cfg.searchMax);
    return items;
  }

  function chapterName($, $a) {
    var $c = $a.clone();
    $c.children('span,i').remove();
    return textOf($c) || textOf($a);
  }

  function parseChapterAnchors(html) {
    var $ = cheerio.load(html);
    var selector = cfg.sel.chapterList || 'li.wp-manga-chapter > a';
    var out = [];
    $(selector).each(function (i, a) {
      var $a = $(a);
      var href = $a.attr('href');
      if (!href || href === '#') return;
      var $li = $a.closest('li');
      out.push({
        name: chapterName($, $a),
        path: toPath(href, site),
        releaseTime: parseDate(textOf($li.find('.chapter-release-date').first())),
      });
    });
    return dedupeBy(out, function (x) {
      return x.path;
    });
  }

  function loadChapters(novelUrl, $page) {
    var clean = novelUrl.split('?')[0].replace(/\/+$/, '');
    return postHtml(clean + '/ajax/chapters/', novelUrl, '')
      .then(function (h) {
        return parseChapterAnchors(h);
      })
      .catch(function () {
        return [];
      })
      .then(function (chapters) {
        if (chapters.length) return chapters;
        var id = $page('#manga-chapters-holder').attr('data-id');
        if (!id) return [];
        return postHtml(site + 'wp-admin/admin-ajax.php', novelUrl, 'action=manga_get_chapters&manga=' + encodeURIComponent(id))
          .then(function (h) {
            return parseChapterAnchors(h);
          })
          .catch(function () {
            return [];
          });
      })
      .then(function (chapters) {
        if (chapters.length) return chapters;
        return parseChapterAnchors($page.html());
      });
  }

  function readerBody($) {
    var $body = firstMatch($, sel.chapterBody || 'div.reading-content');
    if (!$body.length) $body = firstMatch($, '.reading-content, .text-left, .entry-content');
    return $body;
  }

  var plugin = {
    id: cfg.id,
    name: cfg.name,
    icon: cfg.icon || '',
    site: site,
    version: cfg.version,
    contentType: cfg.contentType,
    lncrawl: cfg.lncrawl,
    imageRequestInit: isComic ? { headers: { Referer: site } } : undefined,

    popularNovels: function (pageNo, options) {
      var latest = !!(options && options.showLatestNovels);
      return getHtml(listUrl(pageNo, undefined, latest), site).then(parseList);
    },

    searchNovels: function (term, pageNo) {
      return getHtml(listUrl(pageNo, term), site).then(parseList);
    },

    parseNovel: function (novelPath) {
      var url = urlFor(novelPath, site);
      return getHtml(url, site).then(function (html) {
        var $ = cheerio.load(html);
        var $title = firstMatch($, sel.title).clone();
        $title.find('span,.manga-title-badges').remove();
        var name = textOf($title) || ($('meta[property="og:title"]').attr('content') || '').trim();
        var cover = imgSrc(firstMatch($, sel.cover), site) || absUrl($('meta[property="og:image"]').attr('content'), site);
        var status = '';
        $('.post-content_item, .post-status .post-content_item').each(function (i, el) {
          if (/status/i.test(textOf($(el).find('.summary-heading')))) status = textOf($(el).find('.summary-content'));
        });
        var novel = {
          path: novelPath,
          name: name,
          cover: cover,
          author: $(sel.author)
            .toArray()
            .map(function (a) {
              return textOf($(a));
            })
            .filter(Boolean)
            .join(', '),
          genres: $(sel.tags)
            .toArray()
            .map(function (a) {
              return textOf($(a));
            })
            .filter(Boolean)
            .join(','),
          summary: summaryText($, firstMatch($, sel.synopsis)),
          status: parseStatus(status),
        };
        return loadChapters(url, $).then(function (chapters) {
          chapters.reverse();
          novel.chapters = chapters.map(function (c, i) {
            c.chapterNumber = i + 1;
            return c;
          });
          return novel;
        });
      });
    },

    parseChapter: function (chapterPath) {
      if (isComic) return Promise.resolve('');
      return getHtml(urlFor(chapterPath, site), site).then(function (html) {
        var $ = cheerio.load(html);
        if (cfg.bodyFromParagraphs) {
          var parts = $('.reading-content p')
            .toArray()
            .map(function (p) {
              return $.html(p);
            });
          return parts.join('');
        }
        var $body = readerBody($);
        return $body.length ? cleanBody($, $body, cfg) : '';
      });
    },

    parsePages: function (chapterPath) {
      var url = urlFor(chapterPath, site);
      if (url.indexOf('?') < 0) url += '?style=list';
      return getHtml(url, site).then(function (html) {
        var $ = cheerio.load(html);
        var $body = readerBody($);
        var pages = $body
          .find('img')
          .toArray()
          .map(function (img) {
            return imgSrc($(img), site);
          })
          .filter(Boolean);
        return dedupeBy(pages, function (x) {
          return x;
        });
      });
    },
  };
  return plugin;
}
