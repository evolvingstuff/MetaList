// Tracking junk removed from pasted URLs (app/static/js/modules/url-tracking-cleaner.js,
// docs/ui/paste-sanitization.md): known tracking parameters go, everything else
// stays byte for byte.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cleanTrackingFromAnchor,
    cleanTrackingFromUrl,
    cleanTrackingInText,
} from '../../app/static/js/modules/url-tracking-cleaner.js';

test('campaign and click tracking goes on any site, and the ? with it when nothing remains', () => {
    assert.equal(
        cleanTrackingFromUrl('https://example.com/article?utm_source=newsletter&utm_medium=email&fbclid=abc'),
        'https://example.com/article',
    );
    assert.equal(cleanTrackingFromUrl('https://example.com/?gclid=x&msclkid=y&mc_eid=z'), 'https://example.com/');
    assert.equal(cleanTrackingFromUrl('https://example.com/p?UTM_Campaign=Spring&id=7'), 'https://example.com/p?id=7', 'names compare in lower case');
});

test('functional parameters keep their order and spelling; nothing else about the URL changes', () => {
    assert.equal(
        cleanTrackingFromUrl('https://www.youtube.com/watch?v=abc123&si=TrackingToken&feature=share&t=42s'),
        'https://www.youtube.com/watch?v=abc123&t=42s',
    );
    assert.equal(
        cleanTrackingFromUrl('https://Example.com:8443/a%20b/?q=caf%C3%A9+x&utm_term=t&empty=&flag'),
        'https://Example.com:8443/a%20b/?q=caf%C3%A9+x&empty=&flag',
        'no re-encoding, no host rewriting, empty values and bare flags kept',
    );
    const untouched = 'https://example.com/path/?id=12&sort=asc#section';
    assert.equal(cleanTrackingFromUrl(untouched), untouched, 'nothing to remove: byte-identical');
    assert.equal(cleanTrackingFromUrl('ftp://example.com/?utm_source=x'), 'ftp://example.com/?utm_source=x', 'only http(s)');
    assert.equal(cleanTrackingFromUrl('not a url ?utm_source=x'), 'not a url ?utm_source=x');
});

test('fragments stay, text fragments included', () => {
    assert.equal(
        cleanTrackingFromUrl('https://example.com/doc?utm_source=x#:~:text=the%20exact%20words'),
        'https://example.com/doc#:~:text=the%20exact%20words',
    );
    assert.equal(cleanTrackingFromUrl('https://example.com/doc?utm_source=x&a=1#top'), 'https://example.com/doc?a=1#top');
});

test('per-site rules: the path trail on Amazon, share tokens, search bookkeeping', () => {
    assert.equal(
        cleanTrackingFromUrl('https://www.amazon.com/Some-Product-Name/dp/B0ABCDEFG/ref=sr_1_3?crid=2X&keywords=thing&qid=1700000000&sprefix=thi%2Caps%2C100&sr=8-3&th=1'),
        'https://www.amazon.com/Some-Product-Name/dp/B0ABCDEFG',
    );
    assert.equal(cleanTrackingFromUrl('https://amazon.co.uk/dp/B0X?tag=aff-21&pd_rd_r=1&pf_rd_p=2&smid=SELLER'), 'https://amazon.co.uk/dp/B0X?smid=SELLER', 'a seller choice is the page');
    assert.equal(cleanTrackingFromUrl('https://youtu.be/abc123?si=tok'), 'https://youtu.be/abc123');
    assert.equal(cleanTrackingFromUrl('https://open.spotify.com/track/1?si=abc&nd=1'), 'https://open.spotify.com/track/1');
    assert.equal(cleanTrackingFromUrl('https://x.com/someone/status/1?s=20&t=xyz'), 'https://x.com/someone/status/1');
    assert.equal(cleanTrackingFromUrl('https://www.google.com/search?q=metalist&sca_esv=1&sxsrf=AB&ei=xx&ved=2ahU&uact=5&oq=metalist&gs_lp=Eg&sclient=gws-wiz'), 'https://www.google.com/search?q=metalist&sca_esv=1', 'the query stays; unknown names stay too');
    assert.equal(cleanTrackingFromUrl('https://www.reddit.com/r/x/comments/1/t/?share_id=a&rdt=1&sort=top'), 'https://www.reddit.com/r/x/comments/1/t/?sort=top');
    assert.equal(cleanTrackingFromUrl('https://www.ebay.com/itm/123?hash=item1:g:2&_trkparms=x&var=55'), 'https://www.ebay.com/itm/123?var=55', 'a variation id is the page');
    assert.equal(cleanTrackingFromUrl('https://www.nytimes.com/2026/01/01/x.html?smid=nytcore-ios-share&unlocked_article_code=1.KEY'), 'https://www.nytimes.com/2026/01/01/x.html?unlocked_article_code=1.KEY', 'a gift link key stays');
    assert.equal(cleanTrackingFromUrl('https://medium.com/@a/post-1?source=rss&sk=friend-key'), 'https://medium.com/@a/post-1?sk=friend-key');
    assert.equal(cleanTrackingFromUrl('https://notamazon.com/x?tag=keep'), 'https://notamazon.com/x?tag=keep', 'site rules match the site, not a substring');
});

test('URLs inside prose are cleaned in place, the sentence around them untouched', () => {
    assert.equal(
        cleanTrackingInText('Read this: https://example.com/a?utm_source=x. Then https://b.com/?id=1&fbclid=y, ok?'),
        'Read this: https://example.com/a. Then https://b.com/?id=1, ok?',
    );
    assert.equal(
        cleanTrackingInText('[title](https://example.com/a?utm_source=x) and (see https://b.com/?gclid=1)'),
        '[title](https://example.com/a) and (see https://b.com/)',
        'closing brackets after a URL belong to the text',
    );
    assert.equal(
        cleanTrackingInText('https://en.wikipedia.org/wiki/Foo_(bar)?utm_source=x'),
        'https://en.wikipedia.org/wiki/Foo_(bar)',
        'a balanced parenthesis is part of the URL',
    );
    assert.equal(cleanTrackingInText('no links here, utm_source=x is just words'), 'no links here, utm_source=x is just words');
    assert.equal(cleanTrackingInText('two lines\nhttps://a.com/?utm_medium=m\nhttps://b.com/?v=1'), 'two lines\nhttps://a.com/\nhttps://b.com/?v=1');
});

test('a pasted link: the href is cleaned, and its text only when the text is that URL', () => {
    const url = 'https://example.com/a?utm_source=x&id=1';
    assert.deepEqual(cleanTrackingFromAnchor(url, url), { href: 'https://example.com/a?id=1', text: 'https://example.com/a?id=1' });
    assert.deepEqual(cleanTrackingFromAnchor(url, ` ${url} `), { href: 'https://example.com/a?id=1', text: ' https://example.com/a?id=1 ' });
    assert.deepEqual(cleanTrackingFromAnchor(url, 'the article'), { href: 'https://example.com/a?id=1', text: 'the article' });
    assert.deepEqual(cleanTrackingFromAnchor('https://example.com/a?id=1', 'https://example.com/a?id=1'), { href: 'https://example.com/a?id=1', text: 'https://example.com/a?id=1' });
});
