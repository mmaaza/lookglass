/**
 * @vitest-environment jsdom
 *
 * jsdom, not the happy-dom default: happy-dom *executes* script elements as
 * it parses a document, so feeding it the very markup these tests exist to
 * neutralise runs that markup inside the test process. jsdom does not run
 * scripts unless explicitly asked, which is the correct environment for
 * exercising a sanitiser.
 */
import { describe, expect, it } from 'vitest';
import { readSvgSize, sanitizeSvg } from '../src/renderers/svg/sanitize.js';

/**
 * SVG is markup, so an untrusted one is an XSS vector against whatever app
 * embeds the viewer. These are the vectors that matter in practice; each
 * assertion is about what must *not* survive, not about exact output markup.
 */
describe('sanitizeSvg', () => {
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

  it('keeps ordinary drawing markup', () => {
    const { html } = sanitizeSvg(svg('<rect x="1" y="2" width="10" height="10" fill="#f00"/>'));
    expect(html).toContain('<rect');
    expect(html).toContain('fill="#f00"');
  });

  it('strips script elements', () => {
    const { html } = sanitizeSvg(svg('<script>alert(1)</script><circle r="5"/>'));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert');
    expect(html).toContain('<circle');
  });

  it('strips event handler attributes', () => {
    const { html } = sanitizeSvg(svg('<rect width="10" height="10" onload="alert(1)" onclick="alert(2)"/>'));
    expect(html).not.toContain('onload');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('alert');
  });

  it('strips javascript: URLs', () => {
    const { html } = sanitizeSvg(svg('<a href="javascript:alert(1)"><text>x</text></a>'));
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('removes foreignObject entirely', () => {
    // Even sanitised it embeds arbitrary HTML, which is a large surface for
    // no real benefit in a viewer.
    const { html } = sanitizeSvg(svg('<foreignObject><body><iframe src="x"></iframe></body></foreignObject>'));
    expect(html.toLowerCase()).not.toContain('foreignobject');
    expect(html.toLowerCase()).not.toContain('iframe');
  });

  it('neutralises remote references in href and xlink:href', () => {
    const { html, blockedRemote } = sanitizeSvg(
      svg('<image href="https://evil.example/pixel.png" width="1" height="1"/><use xlink:href="//evil.example/x"/>'),
    );
    expect(blockedRemote).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('evil.example');
  });

  it('neutralises remote url() references inside inline styles', () => {
    const { html, blockedRemote } = sanitizeSvg(
      svg('<rect width="10" height="10" style="fill:url(https://evil.example/a.svg#g)"/>'),
    );
    expect(blockedRemote).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain('evil.example');
  });

  it('keeps local fragment references, which gradients depend on', () => {
    const { html } = sanitizeSvg(
      svg('<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" width="9" height="9"/>'),
    );
    expect(html).toContain('url(#g)');
    expect(html).toContain('linearGradient');
  });

  it('reports what it removed', () => {
    const { removed } = sanitizeSvg(svg('<script>1</script>'));
    expect(removed).toContain('script');
  });

  it('survives markup that is not SVG at all', () => {
    const { html } = sanitizeSvg('<html><body onload="alert(1)">hi</body></html>');
    expect(html).not.toContain('onload');
  });
});

describe('readSvgSize', () => {
  it('prefers the viewBox', () => {
    const { html } = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"></svg>');
    expect(readSvgSize(html)).toEqual({ width: 640, height: 480 });
  });

  it('falls back to width and height attributes', () => {
    const { html } = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"></svg>');
    expect(readSvgSize(html)).toEqual({ width: 200, height: 120 });
  });

  it('handles comma-separated viewBox values', () => {
    const { html } = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0,0,50,25"></svg>');
    expect(readSvgSize(html)).toEqual({ width: 50, height: 25 });
  });

  it('returns undefined when there is no usable size', () => {
    const { html } = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(readSvgSize(html)).toBeUndefined();
  });
});
