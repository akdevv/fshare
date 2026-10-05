// The app's signed requests and sealed replies, checked against the laptop's implementation of
// the spec (cli/seal.ts) standing in for the native module.
import { client, me, openList, signed } from '../identity';

const laptop: typeof import('../../cli/seal') = jest.requireActual('../../cli/seal.ts');

jest.mock('../modules/fshare-peer', () => {
  const s = jest.requireActual('../../cli/seal.ts');
  return {
    myName: 'Test Phone',
    Peer: {
      sign: s.sign,
      seal: (token: string, text: string) => s.seal(token, text),
      open: (token: string, sealed: string) => s.open(token, sealed)?.toString() ?? null,
    },
  };
});

const mac = { base: 'http://127.0.0.1:4747', token: 'tok' };

test('requests are signed the way the laptop checks them', () => {
  const url = signed(mac, '/upload?id=u1&offset=0', 'PUT');
  const target = url.slice(mac.base.length);
  expect(target).toMatch(new RegExp(`^/upload\\?id=u1&offset=0&c=${me.id}&s=[0-9a-f]{32}$`));
  expect(laptop.verify('tok', 'PUT', target)).toBe(true);
  expect(laptop.verify('tok', 'GET', target)).toBe(false); // signed for PUT only
  expect(laptop.verify('other', 'PUT', target)).toBe(false);
  expect(signed(mac, '/list')).toMatch(/\/list\?c=[^&]+&s=/); // a path with no query gets one
});

test("the laptop's sealed list opens, and only with its token", () => {
  const files = [{ id: 0, path: 'trip/a.jpg', size: 12 }];
  const body = laptop.seal('tok', JSON.stringify({ name: 'MacBook Air', kind: 'laptop', files }));
  expect(openList('tok', body)).toEqual({ name: 'MacBook Air', kind: 'laptop', files });
  expect(openList('other', body)).toBeNull();
  expect(openList('tok', 'not sealed')).toBeNull();
});

test('who is asking travels sealed', () => {
  const h = client('tok')['x-fshare-client'];
  expect(h).not.toContain(me.name);
  expect(laptop.open('tok', h)?.toString()).toBe(me.name);
});
