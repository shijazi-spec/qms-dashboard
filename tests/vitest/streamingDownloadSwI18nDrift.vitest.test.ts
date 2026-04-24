/**
 * Guards the bilingual fallback strings in `dashboard/streaming-download-sw.js`
 * against drift from the dashboard's main i18n catalogues.
 *
 * The streaming-download service worker carries its own copy of the
 * "download link expired" wording (`SW_STRINGS`) because a service worker
 * cannot reach into the dashboard's runtime i18n bundles. A comment in the
 * SW source already begs maintainers to keep that dictionary in sync with
 * `downloads.sw_expired_*` in `dashboard/i18n/{en,ar}.json` — but until
 * this test landed nothing actually enforced it. A translator updating
 * `en.json` / `ar.json` and forgetting the SW would only be caught by an
 * end user on Firefox/Safari hitting the fallback page.
 *
 * Strategy: evaluate the SW source inside `new Function` with a hand-rolled
 * `self` shim (matching the pattern used by
 * `streamingDownloadSwFallback.vitest.test.ts`) and have the wrapper
 * return the `SW_STRINGS` dictionary. Then assert each of the four
 * `title`/`heading`/`body`/`retry_hint` keys, for both languages, matches
 * the corresponding `downloads.sw_expired_*` entry in the JSON catalogue.
 * Failures name the language and key so the fix is obvious.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SW_PATH = resolve(__dirname, '..', '..', 'dashboard', 'streaming-download-sw.js');
const EN_PATH = resolve(__dirname, '..', '..', 'dashboard', 'i18n', 'en.json');
const AR_PATH = resolve(__dirname, '..', '..', 'dashboard', 'i18n', 'ar.json');

type LangKey = 'en' | 'ar';
type StringKey = 'title' | 'heading' | 'body' | 'retry_hint';

interface SwStrings {
    en: Record<string, string>;
    ar: Record<string, string>;
}

function loadSwStrings(): SwStrings {
    const source = readFileSync(SW_PATH, 'utf8');
    const fakeSelf: any = {
        location: { origin: 'http://localhost' },
        addEventListener: () => {},
        skipWaiting: () => {},
        clients: { claim: async () => {} },
    };
    // Wrap the SW so its top-level `var SW_STRINGS` is hoisted into this
    // function's scope and we can return it. Using `new Function` keeps the
    // SW source untouched — the production file is loaded byte-for-byte.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function('self', source + '\nreturn SW_STRINGS;');
    return factory(fakeSelf) as SwStrings;
}

function loadCatalogue(path: string): Record<string, string> {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const downloads = json && json.downloads;
    if (!downloads || typeof downloads !== 'object') {
        throw new Error(`Missing "downloads" namespace in ${path}`);
    }
    return downloads as Record<string, string>;
}

const KEYS: StringKey[] = ['title', 'heading', 'body', 'retry_hint'];
const LANGS: { lang: LangKey; path: string; label: string }[] = [
    { lang: 'en', path: EN_PATH, label: 'dashboard/i18n/en.json' },
    { lang: 'ar', path: AR_PATH, label: 'dashboard/i18n/ar.json' },
];

describe('streaming-download SW strings stay in sync with i18n catalogues', () => {
    const swStrings = loadSwStrings();

    for (const { lang, path, label } of LANGS) {
        describe(`${lang} (${label})`, () => {
            const catalogue = loadCatalogue(path);
            const swLang = swStrings[lang];

            it('SW dictionary defines the expected language block', () => {
                expect(swLang, `SW_STRINGS.${lang} is missing`).toBeTruthy();
            });

            for (const key of KEYS) {
                const catalogueKey = `sw_expired_${key}`;
                it(`SW_STRINGS.${lang}.${key} matches downloads.${catalogueKey}`, () => {
                    const swValue = swLang?.[key];
                    const catalogueValue = catalogue[catalogueKey];
                    expect(
                        swValue,
                        `SW_STRINGS.${lang}.${key} is missing in dashboard/streaming-download-sw.js`,
                    ).toBeTypeOf('string');
                    expect(
                        catalogueValue,
                        `downloads.${catalogueKey} is missing in ${label}`,
                    ).toBeTypeOf('string');
                    expect(
                        swValue,
                        `Drift detected: SW_STRINGS.${lang}.${key} in dashboard/streaming-download-sw.js does not match downloads.${catalogueKey} in ${label}. ` +
                            `Update the SW dictionary (or the i18n catalogue) so both copies of the "download link expired" wording stay aligned.`,
                    ).toBe(catalogueValue);
                });
            }
        });
    }
});
