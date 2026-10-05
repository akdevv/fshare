import { eta, fileIcon, fmt, rate } from '../theme';
import { group, type Remote } from '../session';

test('sizes read naturally', () => {
  expect(fmt(512)).toBe('1 KB');
  expect(fmt(1_500_000)).toBe('1.5 MB');
  expect(fmt(2_340_000_000)).toBe('2.34 GB');
  expect(rate(34_100_000)).toBe('34.1 MB/s');
});

test('time left: hidden until it means something', () => {
  expect(eta(Infinity)).toBe('');
  expect(eta(0)).toBe('');
  expect(eta(12.2)).toBe('13s left');
  expect(eta(150)).toBe('3 min left');
  expect(eta(5400)).toBe('1.5 h left');
});

test('file icons by type', () => {
  expect(fileIcon('IMG_1.HEIC')).toBe('image-outline');
  expect(fileIcon('clip.mov')).toBe('film-outline');
  expect(fileIcon('notes.pdf')).toBe('document-text-outline');
  expect(fileIcon('backup.zip')).toBe('archive-outline');
  expect(fileIcon('Makefile')).toBe('document-outline');
});

test('shared folders collapse into one row and expand on demand', () => {
  const remote: Remote[] = [
    { id: 0, path: 'a.txt', size: 1 },
    { id: 1, path: 'trip/1.jpg', size: 10 },
    { id: 2, path: 'trip/day2/2.jpg', size: 20 },
  ];
  const closed = group(remote, new Set());
  expect(closed.map((r) => r.kind)).toEqual(['file', 'folder']);
  expect(closed[1]).toMatchObject({ name: 'trip', size: 30, open: false });
  const open = group(remote, new Set(['trip']));
  expect(open.map((r) => r.kind)).toEqual(['file', 'folder', 'file', 'file']);
});
