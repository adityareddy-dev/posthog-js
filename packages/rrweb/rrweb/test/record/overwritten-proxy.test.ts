import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Browser, Page } from 'puppeteer';
import { EventType, IncrementalSource } from '@posthog/rrweb-types';
import type { eventWithTime } from '@posthog/rrweb-types';
import { launchPuppeteer } from '../utils';

describe('recording with an overwritten Proxy', () => {
  let browser: Browser;
  let page: Page;
  const code = readFileSync(
    resolve(__dirname, '../../dist/rrweb.umd.cjs'),
    'utf8',
  );
  const utilsCode = readFileSync(
    resolve(__dirname, '../../../utils/dist/rrweb-utils.umd.cjs'),
    'utf8',
  );

  beforeAll(async () => {
    browser = await launchPuppeteer();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(
      '<!DOCTYPE html><html><head><style></style></head><body></body></html>',
    );
  });
  afterEach(async () => {
    await page.close();
  });
  afterAll(async () => {
    await browser.close();
  });

  it.each(['plain', 'bound', 'custom toString', 'after loading'])(
    'records stylesheet changes with a %s replacement',
    async (replacement) => {
      if (replacement === 'after loading') await page.evaluate(code);
      await page.evaluate((kind) => {
        const brokenProxy = function () {
          throw new Error('overwritten Proxy');
        };
        if (kind === 'custom toString') {
          brokenProxy.toString = () => {
            throw new Error('overwritten toString');
          };
        }
        window.Proxy = (kind === 'bound'
          ? brokenProxy.bind(null)
          : brokenProxy) as unknown as ProxyConstructor;
      }, replacement);
      if (replacement !== 'after loading') await page.evaluate(code);

      const events = await page.evaluate(() => {
        const events: eventWithTime[] = [];
        const stop = (window as any).rrweb.record({
          emit: (event: eventWithTime) => events.push(event),
        });
        const sheet = document.querySelector('style')!.sheet!;
        sheet.insertRule('body { color: red; }', 0);
        (sheet.cssRules[0] as CSSStyleRule).style.setProperty('color', 'blue');
        stop();
        return events;
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: EventType.IncrementalSnapshot,
            data: expect.objectContaining({
              source: IncrementalSource.StyleSheetRule,
              adds: [{ rule: 'body { color: red; }', index: 0 }],
            }),
          }),
          expect.objectContaining({
            type: EventType.IncrementalSnapshot,
            data: expect.objectContaining({
              source: IncrementalSource.StyleDeclaration,
              set: { property: 'color', value: 'blue' },
            }),
          }),
        ]),
      );
      expect(await page.$$('iframe')).toHaveLength(0);
    },
  );

  it('reuses the native constructor without creating an iframe', async () => {
    await page.evaluate(utilsCode);
    expect(
      await page.evaluate(() => {
        const getProxy = (window as any).rrwebUtils.getUntaintedProxy;
        return getProxy() === window.Proxy && getProxy() === getProxy();
      }),
    ).toBe(true);
    expect(await page.$$('iframe')).toHaveLength(0);
  });

  it('retries recovery after iframe creation fails and caches the clean constructor', async () => {
    await page.evaluate(utilsCode);
    expect(
      await page.evaluate(() => {
        const getProxy = (window as any).rrwebUtils.getUntaintedProxy;
        const brokenProxy = function () {
          throw new Error('overwritten Proxy');
        } as unknown as ProxyConstructor;
        window.Proxy = brokenProxy;
        const createElement = document.createElement;
        document.createElement = () => {
          throw new Error('iframe unavailable');
        };
        const fallback = getProxy();
        document.createElement = createElement;
        const recovered = getProxy();
        const proxy = new recovered({ value: 42 }, {});
        document.createElement = () => {
          throw new Error('must use cached Proxy');
        };
        const cached = getProxy();
        document.createElement = createElement;
        return (
          fallback === brokenProxy &&
          recovered !== brokenProxy &&
          cached === recovered &&
          proxy.value === 42
        );
      }),
    ).toBe(true);
    expect(await page.$$('iframe')).toHaveLength(0);
  });
});
