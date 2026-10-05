import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '../theme';
import { Onboarding } from '../onboarding';
import { DeviceList, VisibilityRow, type Device } from '../session';

const none = { away: [], saved: [], onForget: () => {} };
const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>); // async since Testing Library 14

test('onboarding walks through every step, then finishes', async () => {
  const done = jest.fn();
  await wrap(<Onboarding onDone={done} />);
  expect(screen.getByText('Send files between your phone and laptop')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Next'));
  expect(screen.getByText('Plug in')).toBeTruthy();
  expect(screen.getByText('npx fshare-cli')).toBeTruthy();
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

test('device list: current device, switching, and nearby phones', async () => {
  const mac: Device = { id: 'laptop-usb', name: 'MacBook Air', base: 'http://127.0.0.1:4747', token: 't', kind: 'laptop', via: 'usb' };
  const pixel: Device = { id: 'cable', name: 'Pixel 8', base: 'http://127.0.0.1:4749', token: 't', kind: 'phone', via: 'usb' };
  const onPick = jest.fn(),
    onPair = jest.fn();
  await wrap(
    <DeviceList
      current={mac}
      others={[pixel]}
      nearby={[{ name: 'Galaxy S23', host: '192.168.1.9', port: 4748, id: 'x', hidden: false }]}
      {...none}
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
  await wrap(<DeviceList current={mac} others={[]} nearby={[]} {...none} onPick={() => {}} onPair={() => {}} />);
  expect(screen.getByText(/To add a device/)).toBeTruthy();
});

test('device list: paired phones that are away can be forgotten; connected ones by long press', async () => {
  const mac: Device = { id: 'laptop-usb', name: 'MacBook Air', base: '', token: '', kind: 'laptop', via: 'usb' };
  const s23 = { id: 'a1', name: 'Galaxy S23', token: 't', base: 'http://192.168.1.9:4748' };
  const pixel = { id: 'b2', name: 'Pixel 8', token: 't', base: 'http://192.168.1.7:4748' };
  const pixelOn: Device = { id: 'phone-b2', name: 'Pixel 8', base: pixel.base, token: 't', kind: 'phone', via: 'wifi' };
  const onForget = jest.fn();
  await wrap(
    <DeviceList
      current={mac}
      others={[pixelOn]}
      nearby={[]}
      {...none}
      away={[s23]}
      saved={[s23, pixel]}
      onForget={onForget}
      onPick={() => {}}
      onPair={() => {}}
    />,
  );
  expect(screen.getByLabelText('Galaxy S23, not nearby')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Forget Galaxy S23'));
  expect(onForget).toHaveBeenCalledWith(s23);
  await fireEvent(screen.getByLabelText('Pixel 8, Phone · Wi-Fi'), 'longPress');
  expect(onForget).toHaveBeenCalledWith(pixel);
});

test('visibility switch reports changes and updates its text', async () => {
  const onChange = jest.fn();
  await wrap(<VisibilityRow visible onChange={onChange} />);
  expect(screen.getByText(/Shown as/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Visible to nearby phones'));
  expect(onChange).toHaveBeenCalledWith(false);
  expect(screen.getByText('Paired phones only')).toBeTruthy();
});
