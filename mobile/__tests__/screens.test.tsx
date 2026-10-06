import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../theme';
import { Onboarding } from '../onboarding';
import { ConnectScreen } from '../connect';
import type { Device } from '../session';

const base = {
  current: null,
  devices: [],
  nearby: [],
  saved: [],
  phones: true,
  visible: true,
  onVisible: () => {},
  onPick: () => {},
  onPair: () => {},
  onForget: () => {},
  onWifi: () => {},
};
const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>); // async since Testing Library 14

test('onboarding walks through every step, then finishes', async () => {
  const done = jest.fn();
  await wrap(<Onboarding onDone={done} />);
  expect(screen.getByText('Send files between your phone and laptop')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Next'));
  expect(screen.getByText('Plug in')).toBeTruthy();
  expect(screen.getByText('fshare')).toBeTruthy();
  expect(screen.getByText(/github.com\/akdevv\/fshare/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Next'));
  expect(screen.getByText('No cable? Use Wi-Fi')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Get started')); // iOS: no save-folder step
  expect(done).toHaveBeenCalled();
});

test('onboarding can be skipped', async () => {
  const done = jest.fn();
  await wrap(<Onboarding onDone={done} />);
  await fireEvent.press(screen.getByText('Skip'));
  expect(done).toHaveBeenCalled();
});

test('devices screen: current device, switching, and nearby phones', async () => {
  const mac: Device = { id: 'laptop-usb', name: 'MacBook Air', base: 'http://127.0.0.1:4747', token: 't', kind: 'laptop', via: 'usb' };
  const tab: Device = { id: 'laptop-wifi', name: 'Studio', base: 'http://192.168.1.4:4747', token: 't', kind: 'laptop', via: 'wifi' };
  const onPick = jest.fn(),
    onPair = jest.fn();
  await wrap(
    <ConnectScreen
      {...base}
      current={mac}
      devices={[mac, tab]}
      nearby={[{ name: 'Galaxy S23', host: '192.168.1.9', port: 4748, id: 'x', hidden: false }]}
      onPick={onPick}
      onPair={onPair}
      onBack={() => {}}
    />,
  );
  expect(screen.getByText('Devices')).toBeTruthy();
  expect(screen.getByLabelText('MacBook Air, Laptop · USB cable, connected')).toBeTruthy();
  await fireEvent.press(screen.getByText('Switch'));
  expect(onPick).toHaveBeenCalledWith(tab);
  await fireEvent.press(screen.getByText('Connect'));
  expect(onPair).toHaveBeenCalledWith(expect.objectContaining({ name: 'Galaxy S23' }));
});

test('devices screen folds the other ways to connect away', async () => {
  const wifi = jest.fn(),
    skip = jest.fn();
  await wrap(<ConnectScreen {...base} onWifi={wifi} onSkip={skip} />);
  expect(screen.getByText('Connect a device')).toBeTruthy();
  expect(screen.queryByLabelText('Scan QR code, Connect your laptop over Wi-Fi')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Other ways to connect'));
  await fireEvent.press(screen.getByLabelText('Scan QR code, Connect your laptop over Wi-Fi'));
  expect(wifi).toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Skip for now'));
  expect(skip).toHaveBeenCalled();
});

test('devices screen: paired phones are forgotten in place, with two taps', async () => {
  const s23 = { id: 'a1', name: 'Galaxy S23', token: 't', base: 'http://192.168.1.9:4748' };
  const onForget = jest.fn();
  await wrap(<ConnectScreen {...base} saved={[s23]} onForget={onForget} />);
  expect(screen.getByLabelText('Galaxy S23, not nearby')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Forget Galaxy S23'));
  expect(onForget).not.toHaveBeenCalled(); // first tap only arms it
  await fireEvent.press(screen.getByLabelText('Confirm: forget Galaxy S23'));
  expect(onForget).toHaveBeenCalledWith(s23);
});

test('visibility switch reports changes and updates its text', async () => {
  const onVisible = jest.fn();
  await wrap(<ConnectScreen {...base} onVisible={onVisible} />);
  expect(screen.getByText(/Visible as/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Visible to nearby phones'));
  expect(onVisible).toHaveBeenCalledWith(false);
  expect(screen.getByText('Hidden from nearby phones')).toBeTruthy();
});

test('devices screen: phones paired before encryption say to pair again', async () => {
  const old = { id: 'a1', name: 'Old Phone', token: 't', base: 'http://192.168.1.9:4748' };
  const fresh = { id: 'b2', name: 'New Phone', token: 't', base: 'http://192.168.1.7:4748', e2e: true };
  await wrap(<ConnectScreen {...base} saved={[old, fresh]} />);
  expect(screen.getAllByText('Forget and pair again to secure')).toHaveLength(1);
  expect(screen.getByText('Not nearby')).toBeTruthy();
});
