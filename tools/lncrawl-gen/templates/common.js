// Shared helpers for the lncrawl-derived YomiDen plugins. Concatenated in front of every template by
// generate.mjs, then lowered to ES2016 so the host runtime (which has no native async) can run it.
var cheerio = require('cheerio');
var fetchLib = require('@libs/fetch');
var NovelStatus = require('@libs/novelStatus').NovelStatus;

function normalizeSite(site) {
  return site.charAt(site.length - 1) === '/' ? site : site + '/';
}

function absUrl(href, base) {
  if (!href) return '';
  href = String(href).trim();
  if (!href || href.indexOf('data:') === 0 || href.indexOf('javascript:') === 0) return '';
  try {
    return new URL(href, base).href;
  } catch (e) {
    return href;
  }
}

/** Site-relative path when the URL lives under a root-level site, otherwise the absolute URL. */
function toPath(href, site) {
  var url = absUrl(href, site);
  var root = site.replace(/^(https?:\/\/[^\/]+)\/.*$/, '$1/');
  if (site === root && url.indexOf(root) === 0) return '/' + url.slice(root.length);
  return url;
}

function urlFor(path, site) {
  return absUrl(path, site) || path;
}

function imgSrc($img, base) {
  if (!$img || !$img.length) return '';
  var srcset = $img.attr('data-srcset') || $img.attr('srcset') || '';
  var candidates = [
    $img.attr('data-src'),
    $img.attr('data-lazy-src'),
    $img.attr('data-cfsrc'),
    $img.attr('data-original'),
    srcset.split(',')[0].trim().split(/\s+/)[0],
    $img.attr('src'),
  ];
  for (var i = 0; i < candidates.length; i++) {
    var u = absUrl(candidates[i], base);
    if (u) return u;
  }
  return '';
}

function getHtml(url, referer) {
  return fetchLib.fetchApi(url, { headers: { Referer: referer } }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.text();
  });
}

function postHtml(url, referer, body) {
  return fetchLib
    .fetchApi(url, {
      method: 'POST',
      headers: {
        Referer: referer,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: body || '',
    })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.text();
    });
}

function textOf($el) {
  return ($el.text() || '').replace(/\s+/g, ' ').trim();
}

/** Plain-text summary that keeps paragraph breaks. */
function summaryText($, $el) {
  if (!$el || !$el.length) return '';
  var $c = $el.first().clone();
  $c.find('script,style').remove();
  var paras = $c
    .find('p')
    .toArray()
    .map(function (p) {
      return textOf($(p));
    })
    .filter(function (t) {
      return t;
    });
  return paras.length ? paras.join('\n\n') : textOf($c);
}

function parseStatus(text) {
  var t = String(text || '').toLowerCase();
  if (/ongoing|on going|publishing|updating/.test(t)) return NovelStatus.Ongoing;
  if (/complet|finish|ended/.test(t)) return NovelStatus.Completed;
  if (/hiatus|on hold|paused/.test(t)) return NovelStatus.OnHiatus;
  if (/cancel|dropped|discontinued/.test(t)) return NovelStatus.Cancelled;
  return NovelStatus.Unknown;
}

function parseDate(text) {
  text = String(text || '').trim();
  if (!text) return undefined;
  var t = Date.parse(text);
  return isNaN(t) ? text : new Date(t).toISOString();
}

function trySelect($root, selector) {
  try {
    return $root.find(selector);
  } catch (e) {
    return $root.find('.__none__');
  }
}

/**
 * Strips scripts/ads plus the crawler's cleanup rules (cfg.badTags, cfg.badCss, cfg.badTagText) and returns HTML.
 */
function cleanBody($, $body, cfg) {
  $body.find('script,style,iframe,ins,noscript,form,.adsbygoogle').remove();
  (cfg.badTags || []).forEach(function (t) {
    trySelect($body, t).remove();
  });
  (cfg.badCss || []).forEach(function (s) {
    trySelect($body, s).remove();
  });
  var pairs = cfg.badTagText || {};
  Object.keys(pairs).forEach(function (tag) {
    var res = [];
    [].concat(pairs[tag]).forEach(function (p) {
      try {
        res.push(new RegExp(p, 'i'));
      } catch (e) {
        // unsupported python-only regex syntax
      }
    });
    trySelect($body, tag).each(function (i, el) {
      var txt = $(el).text();
      if (
        res.some(function (r) {
          return r.test(txt);
        })
      ) {
        $(el).remove();
      }
    });
  });
  return ($body.html() || '').trim();
}

function firstMatch($, selector) {
  try {
    return $(selector).first();
  } catch (e) {
    return $('.__none__');
  }
}

function dedupeBy(list, key) {
  var seen = {};
  return list.filter(function (x) {
    var k = key(x);
    if (!k || seen[k]) return false;
    seen[k] = 1;
    return true;
  });
}
