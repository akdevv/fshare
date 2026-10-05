// "Sent 3 files to MacBook" / "Couldn't send photo.jpg": a local notification when a transfer
// ends while fshare is minimized. On screen, the transfer list already says it.
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { readPrefs } from './prefs';

let asked = false;
export async function askToNotify() {
  if (asked) return;
  asked = true;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('done', {
        name: 'Finished transfers',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    await Notifications.requestPermissionsAsync();
  } catch {} // Expo Go and older systems: no notifications, nothing else changes
}

export function notify(title: string, body: string) {
  if (AppState.currentState === 'active' || readPrefs().notify === false) return;
  Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: Platform.OS === 'android' ? { channelId: 'done' } : null,
  }).catch(() => {});
}
