/**
 * public/js/api.js - the screenshot loader.
 *
 * The one thing that must never happen: the API key being sent to a URL that a
 * workflow's output merely NAMED. Output items are data from the web (an
 * extract step can put any string in `image.url`), so only the exact shape the
 * server itself produces is fetched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface Api {
  isArtifactUrl: (u: unknown) => boolean;
  loadArtifactImage: (u: string) => Promise<string>;
}

let api: Api;
let fetchMock: ReturnType<typeof vi.fn>;
let created: string[];

beforeEach(() => {
  fetchMock = vi.fn();
  created = [];
  const store: Record<string, string> = { ab_api_key: 'KEY123' };
  const sandbox: any = {
    window: {},
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem() {}, removeItem() {} },
    fetch: fetchMock,
    URL: { createObjectURL: (b: unknown) => { const u = `blob:mock/${created.length}`; created.push(u); void b; return u; } },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(__dirname, '..', '..', 'public', 'js', 'api.js'), 'utf8'), sandbox, { filename: 'api.js' });
  api = sandbox.window.API;
});

describe('isArtifactUrl', () => {
  it.each([
    '/job/local/42/artifact/step-1.png',
    '/job/u%40x/repeat%3Aabc/artifact/step-12.jpg',
  ])('accepts %s', (u) => expect(api.isArtifactUrl(u)).toBe(true));

  it.each([
    'https://evil.example/job/local/42/artifact/step-1.png',
    '//evil.example/job/local/42/artifact/step-1.png',
    'http://localhost/job/local/42/artifact/step-1.png',
    '/job/local/42/artifact/step-1.svg',
    '/job/local/42/artifact/../../x.png',
    '/job/local/42/artifact/step-1.png?x=1',
    '/job/local/42/artifact/step-1.png#frag',
    '/job/local/artifact/step-1.png',
    '/other/local/42/artifact/step-1.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '', null, undefined, 42, {},
  ])('rejects %j', (u) => expect(api.isArtifactUrl(u as never)).toBe(false));
});

describe('loadArtifactImage', () => {
  it('fetches with the key and returns a blob url', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    const url = await api.loadArtifactImage('/job/local/42/artifact/step-1.png');
    expect(url).toBe('blob:mock/0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe('/job/local/42/artifact/step-1.png');
    expect(init.headers.Authorization).toBe('Bearer KEY123');
  });

  it('never sends a request (or the key) for a foreign url', async () => {
    await expect(api.loadArtifactImage('https://evil.example/x.png')).rejects.toThrow();
    await expect(api.loadArtifactImage('//evil.example/job/a/b/artifact/step-1.png')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads each image once', async () => {
    fetchMock.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    const u = '/job/local/42/artifact/step-1.png';
    const [a, b] = await Promise.all([api.loadArtifactImage(u), api.loadArtifactImage(u)]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed load is not cached: a retry can succeed', async () => {
    const u = '/job/local/42/artifact/step-1.png';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(api.loadArtifactImage(u)).rejects.toThrow(/404/);
    fetchMock.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) });
    await expect(api.loadArtifactImage(u)).resolves.toMatch(/^blob:/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
