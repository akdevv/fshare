import { eta, fileIcon, fmt, rate } from '../src/theme';
import { summary } from '../src/hooks/use-transfers';
import { mimeOf } from '../src/lib/open';

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

test('file lists summarize to one line', () => {
  expect(summary(['a.jpg'])).toBe('a.jpg');
  expect(summary(['a.jpg', 'b.jpg'])).toBe('a.jpg and b.jpg');
  expect(summary(['a.jpg', 'b.jpg', 'c.mov', 'd.pdf'])).toBe('a.jpg and 3 more');
});

test('received files open with the right app type', () => {
  expect(mimeOf('IMG_20.JPG')).toBe('image/jpeg');
  expect(mimeOf('clip.mov')).toBe('video/quicktime');
  expect(mimeOf('notes.pdf')).toBe('application/pdf');
  expect(mimeOf('mystery.xyz')).toBe('*/*');
});
