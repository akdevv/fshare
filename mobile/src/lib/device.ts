// Something to send to: a laptop running fshare, or another phone running this app.
export type Device = { id: string; name: string; base: string; token: string; kind: 'laptop' | 'phone'; via: 'usb' | 'wifi' };

// The main screen with nothing connected (Skip on the launch screen): history and the devices
// button work, sending waits for a device.
export const NO_DEVICE: Device = { id: 'none', name: 'Not connected', base: '', token: '', kind: 'phone', via: 'wifi' };

export const linkName = (via: Device['via']) => (via === 'usb' ? 'USB cable' : 'Wi-Fi');

// "Laptop · USB cable"
export const describe = (d: Pick<Device, 'kind' | 'via'>) => `${d.kind === 'laptop' ? 'Laptop' : 'Phone'} · ${linkName(d.via)}`;
