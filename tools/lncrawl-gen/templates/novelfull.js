// Port of lncrawl's NovelFullTemplate (NovelFull / ReadNovelFull style sites). Novels only.
function createPlugin(cfg) {
  var site = normalizeSite(cfg.site);
  var sel = cfg.sel;

  function parseList(html) {
    var $ = cheerio.load(html);
    var items = [];
    $('#list-page .row, .list-truyen .row, .list.list-novel .row, .list .row').each(function (i, el) {
      var $el = $(el);
      var a = $el.find("h3[class*='title'] > a, .truyen-title a, h3 a").first();
      var href = a.attr('href');
      if (!href) return;
      items.push({
        name: (a.attr('title') || textOf(a)).trim(),
        path: toPath(href, site),
        cover: imgSrc($el.find('img').first(), site),
      });
    });
    return dedupeBy(items, function (x) {
      return x.path;
    });
  }

  function tryListing(slugs, page) {
    var i = 0;
    function next() {
      if (i >= slugs.length) return Promise.resolve([]);
      var url = site + slugs[i++] + (slugs[i - 1].indexOf('?') < 0 ? '?' : '&') + 'page=' + page;
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

  function genericChapters(html) {
    var $ = cheerio.load(html);
    var out = [];
    $('ul.list-chapter > li > a[href], select > option[value]').each(function (i, el) {
      var $el = $(el);
      var href = $el.attr('href') || $el.attr('value');
      if (!href || href === '#') return;
      out.push({ name: ($el.attr('title') || textOf($el)).trim(), path: toPath(href, site) });
    });
    return dedupeBy(out, function (x) {
      return x.path;
    });
  }

  function infoValue($, label) {
    var found = [];
    $('.info li, .info-meta li').each(function (i, li) {
      var head = textOf($(li).find('h3').first());
      if (head.toLowerCase().indexOf(label) >= 0) {
        $(li)
          .find('a')
          .each(function (j, a) {
            var t = textOf($(a));
            if (t) found.push(t);
          });
        if (!found.length) found.push(textOf($(li)).replace(new RegExp('^' + label + '\\s*:?', 'i'), '').trim());
      }
    });
    return found;
  }

  return {
    id: cfg.id,
    name: cfg.name,
    icon: cfg.icon || '',
    site: site,
    version: cfg.version,
    contentType: 'novel',
    lncrawl: cfg.lncrawl,

    popularNovels: function (pageNo, options) {
      var latest = !!(options && options.showLatestNovels);
      return tryListing(latest ? ['latest-release-novel', 'latest-release'] : ['most-popular', 'hot-novel', 'novel-list/most-popular'], pageNo);
    },

    searchNovels: function (term, pageNo) {
      return getHtml(site + 'search?keyword=' + encodeURIComponent(term) + '&page=' + pageNo, site).then(parseList);
    },

    parseNovel: function (novelPath) {
      var url = urlFor(novelPath, site);
      return getHtml(url, site).then(function (html) {
        var $ = cheerio.load(html);
        var author = $(sel.author)
          .toArray()
          .map(function (a) {
            return textOf($(a));
          })
          .filter(Boolean);
        var statusVals = infoValue($, 'status');
        var novel = {
          path: novelPath,
          name: textOf(firstMatch($, '.col-info-desc ' + sel.title)) || textOf(firstMatch($, sel.title)),
          cover: imgSrc(firstMatch($, sel.cover), site) || absUrl($('meta[property="og:image"]').attr('content'), site),
          author: dedupeBy(author, function (x) {
            return x;
          }).join(', '),
          genres: infoValue($, 'genre').join(','),
          summary: summaryText($, firstMatch($, sel.synopsis)),
          status: parseStatus(statusVals.join(' ')),
        };
        var onPage = genericChapters(html);
        if (cfg.chapterListOnNovelPage && onPage.length) {
          novel.chapters = onPage;
          return novel;
        }
        var novelId = $('#rating[data-novel-id]').attr('data-novel-id') || $('[data-novel-id]').first().attr('data-novel-id');
        if (!novelId) {
          novel.chapters = onPage;
          return novel;
        }
        var optionRoute = /ajaxChapterOptionUrl\s*=/.test(html);
        var ajax = site + (optionRoute ? 'ajax-chapter-option?novelId=' : 'ajax/chapter-archive?novelId=') + encodeURIComponent(novelId);
        return getHtml(ajax, url)
          .then(genericChapters)
          .catch(function () {
            return [];
          })
          .then(function (chapters) {
            novel.chapters = chapters.length ? chapters : onPage;
            return novel;
          });
      });
    },

    parseChapter: function (chapterPath) {
      return getHtml(urlFor(chapterPath, site), site).then(function (html) {
        var $ = cheerio.load(html);
        var $body = firstMatch($, sel.chapterBody);
        if (!$body.length) return '';
        $body.find('div,h1,h2,h3,h4,h5,h6').each(function (i, el) {
          if (!$(el).find('p').length) $(el).remove();
        });
        return cleanBody($, $body, cfg);
      });
    },
  };
}
