import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../theme';
import { Onboarding } from '../onboarding';
import { DeviceList, type Device } from '../session';

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>); // async since Testing Library 14

test('onboarding walks through every step, then finishes', async () => {
  const done = jest.fn();
  await wrap(<Onboarding onDone={done} />);
  expect(screen.getByText('Welcome to fshare')).toBeTruthy();
  await fireEvent.press(screen.getByText('Continue'));
  expect(screen.getByText('Plug in and go')).toBeTruthy();
  expect(screen.getByText('npx fshare-cli')).toBeTruthy();
  await fireEvent.press(screen.getByText('Continue'));
  expect(screen.getByText('Or go wireless')).toBeTruthy();
  await fireEvent.press(screen.getByText('Get started')); // iOS: no save-folder step
  expect(done).toHaveBeenCalled();
});

test('onboarding can be skipped', async () => {
  const done = jest.fn();
  await wrap(<Onboarding onDone={done} />);
  await fireEvent.press(screen.getByText('Skip'));
  expect(done).toHaveBeenCalled();
});

test('device list: current device, switching, and nearby phones', async () => {
  const mac: Device = { id: 'laptop-usb', name: 'MacBook Air', base: 'http://127.0.0.1:4747', token: 't', kind: 'laptop', via: 'usb' };
  const pixel: Device = { id: 'cable', name: 'Pixel 8', base: 'http://127.0.0.1:4749', token: 't', kind: 'phone', via: 'usb' };
  const onPick = jest.fn(),
    onPair = jest.fn();
  await wrap(
    <DeviceList
      current={mac}
      others={[pixel]}
      nearby={[{ name: 'Galaxy S23', host: '192.168.1.9', port: 4748, id: 'x' }]}
      onPick={onPick}
      onPair={onPair}
    />,
  );
  expect(screen.getByLabelText('MacBook Air, Laptop · USB cable, connected')).toBeTruthy();
  await fireEvent.press(screen.getByText('Switch'));
  expect(onPick).toHaveBeenCalledWith(pixel);
  await fireEvent.press(screen.getByText('Connect'));
  expect(onPair).toHaveBeenCalledWith(expect.objectContaining({ name: 'Galaxy S23' }));
});

test('device list explains how to add a device when there are none', async () => {
  const mac: Device = { id: 'laptop-usb', name: 'MacBook Air', base: '', token: '', kind: 'laptop', via: 'usb' };
  await wrap(<DeviceList current={mac} others={[]} nearby={[]} onPick={() => {}} onPair={() => {}} />);
  expect(screen.getByText(/To add a device/)).toBeTruthy();
});
